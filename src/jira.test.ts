import { describe, expect, test } from "bun:test";
import type { SimpleGit, StatusResult } from "simple-git";
import { generateAiCommitMessage } from "./ai";
import { defaultAiConfig, defaultJiraConfig, mergeJiraConfig } from "./config";
import { extractJiraIssueIds, formatCommitTitle } from "./jira";

describe("Jira config", () => {
    test("is opt-in, even when only a template is configured", () => {
        expect(mergeJiraConfig(null, null)).toEqual(defaultJiraConfig);
        expect(mergeJiraConfig(null, { jira: { template: "[%ticket%] %title%" } }).enabled).toBe(false);
    });

    test("merges project settings over global settings field by field", () => {
        expect(mergeJiraConfig(
            { jira: { enabled: true, template: "%title% [%ticket%]" } },
            { jira: { enabled: false } }
        )).toEqual({ enabled: false, template: "%title% [%ticket%]" });
        expect(mergeJiraConfig(
            { jira: { enabled: true } },
            { jira: { template: "[%ticket%] %title%" } }
        )).toEqual({ enabled: true, template: "[%ticket%] %title%" });
    });

    test("rejects templates that lose the title or contain line breaks", () => {
        for (const template of ["", "%ticket%", "%title%", "%ticket%\n%title%", "%ticket%\r%title%", "%ticket%\0%title%"]) {
            const warnings: string[] = [];
            const config = mergeJiraConfig(
                { jira: { enabled: true, template: "[%ticket%] %title%" } },
                { jira: { template } },
                (message) => warnings.push(message)
            );
            expect(config.template).toBe("[%ticket%] %title%");
            expect(warnings).toHaveLength(1);
        }
    });
});

describe("Jira issue extraction", () => {
    test("finds IDs at different positions and deduplicates them in branch order", () => {
        expect(extractJiraIssueIds("feature/scaffold/AI-100")).toEqual(["AI-100"]);
        expect(extractJiraIssueIds("AI-100-fix/WEB2-42/AI-100")).toEqual(["AI-100", "WEB2-42"]);
        expect(extractJiraIssueIds("feature/MY_PROJECT-123")).toEqual(["MY_PROJECT-123"]);
    });

    test("does not extract partial IDs or lowercase keys", () => {
        for (const branch of ["main", "HEAD", "feature/ai-100", "feature/fooAI-100", "feature/AI-100abc", "feature/123AI-100"]) {
            expect(extractJiraIssueIds(branch)).toEqual([]);
        }
    });
});

describe("commit title formatting", () => {
    const enabledConfig = { ...defaultJiraConfig, enabled: true };

    test("preserves the input when disabled or there are no tickets", () => {
        expect(formatCommitTitle("add scaffold", "AI-100", defaultJiraConfig)).toBe("add scaffold");
        expect(formatCommitTitle("add scaffold", "main", enabledConfig)).toBe("add scaffold");
        expect(formatCommitTitle("add scaffold", "HEAD", enabledConfig)).toBe("add scaffold");
    });

    test("supports prefixes, suffixes, and multiple tickets", () => {
        expect(formatCommitTitle("feat: add scaffold", "feature/scaffold/AI-100", enabledConfig))
            .toBe("AI-100 - feat: add scaffold");
        expect(formatCommitTitle("add scaffold", "AI-100/WEB-42/AI-100", {
            enabled: true,
            template: "%title% [%ticket%]"
        })).toBe("add scaffold [AI-100, WEB-42]");
    });

    test("substitutes repeated placeholders without interpreting title contents", () => {
        const title = "handle %ticket%, %title%, and $& literally";
        expect(formatCommitTitle(title, "AI-100", {
            enabled: true,
            template: "%ticket%: %title% (%ticket%) %title%"
        })).toBe(`AI-100: ${title} (AI-100) ${title}`);
    });

    test("formats AI output locally without including branch metadata in the request", async () => {
        let requestBody = "";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requestBody = await request.text();
                return Response.json({
                    choices: [{ message: { content: JSON.stringify({ title: "feat: add scaffold", description: "Set up the scaffold." }) } }]
                });
            }
        });

        try {
            const branch = "feature/scaffold/AI-100";
            const git = { diff: async () => "scaffold changes" } as unknown as SimpleGit;
            const status = {
                current: branch,
                modified: ["scaffold.ts"],
                created: [],
                deleted: [],
                not_added: [],
                renamed: []
            } as unknown as StatusResult;
            const message = await generateAiCommitMessage(
                git,
                { ...defaultAiConfig, enabled: true, model: "test-model", baseUrl: server.url.href },
                true,
                ["."],
                status,
                () => {},
                () => {}
            );

            expect(message).toEqual({ title: "feat: add scaffold", description: "Set up the scaffold." });
            expect(requestBody).not.toBe("");
            expect(requestBody).not.toContain(branch);
            expect(requestBody).not.toContain("AI-100");
            expect(requestBody).not.toContain("%ticket%");
            expect(requestBody).not.toContain("%title%");
            expect(formatCommitTitle(message!.title, branch, enabledConfig)).toBe("AI-100 - feat: add scaffold");
        } finally {
            server.stop(true);
        }
    });
});
