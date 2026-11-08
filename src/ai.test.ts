import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SimpleGit } from "simple-git";
import { checkAiProviderStatus, generateAiCommitMessage, parseAiCommitMessage } from "./ai";
import { defaultAiConfig, mergeAiConfig } from "./config";
import * as aiContext from "./ai-context";
import type { AppConfig } from "./types";

describe("AI retry config", () => {
    test("defaults to two retries and lets projects override global settings", () => {
        expect(mergeAiConfig(null, null).maxRetries).toBe(2);
        expect(mergeAiConfig({ ai: { maxRetries: 4 } }, null).maxRetries).toBe(4);
        expect(mergeAiConfig({ ai: { maxRetries: 4 } }, { ai: { maxRetries: 0 } }).maxRetries).toBe(0);
        expect(mergeAiConfig({ ai: { maxRetries: 4 } }, { ai: { enabled: true } }).maxRetries).toBe(4);
    });

    test("warns and preserves the inherited value for invalid retry counts", () => {
        for (const maxRetries of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null, true]) {
            const warnings: string[] = [];
            const invalidConfig = { ai: { maxRetries } } as AppConfig;
            expect(mergeAiConfig({ ai: { maxRetries: 4 } }, invalidConfig, undefined,
                (message) => warnings.push(message)).maxRetries).toBe(4);
            expect(warnings).toHaveLength(1);
            expect(mergeAiConfig(invalidConfig, null).maxRetries).toBe(2);
            expect(mergeAiConfig(invalidConfig, { ai: { maxRetries: 1 } }).maxRetries).toBe(1);
        }
    });
});

describe("AI commit JSON parsing", () => {
    const message = { title: "fix: handle {braces} and quotes", description: 'Explain "why".\nKeep detail.' };

    test("accepts valid JSON, Markdown fences, and surrounding commentary", () => {
        const json = JSON.stringify(message);
        for (const content of [json, ` \n${json}\n `, `\`\`\`json\n${json}\n\`\`\``,
            `Here is the message:\n\`\`\`JSON\n${json}\n\`\`\`\nDone.`, `Here is the message:\n${json}\nDone.`]) {
            expect(parseAiCommitMessage(content)).toEqual(message);
        }
    });

    test("normalizes whitespace and optional descriptions", () => {
        expect(parseAiCommitMessage('{"title":"  fix: retries  ","description":"  detail  "}'))
            .toEqual({ title: "fix: retries", description: "detail" });
        for (const description of [undefined, null, "", "  "]) {
            expect(parseAiCommitMessage(JSON.stringify({ title: "fix: retries", description })))
                .toEqual({ title: "fix: retries", description: undefined });
        }
        expect(parseAiCommitMessage(JSON.stringify({ title: "fix: fences", description: "Use ```json snippets." })))
            .toEqual({ title: "fix: fences", description: "Use ```json snippets." });
    });

    test("rejects malformed JSON and invalid fields instead of returning raw JSON as a title", () => {
        for (const content of ["", "  ", "fix: plain text", '{"title": "truncated', '{"title":"fix: retries",}',
            "{title: 'fix: retries'}", '{}', 'null', '42', 'true', '"a title"', '[]', '[{"title":"fix: retries"}]',
            '{"title":""}', '{"title":"   "}', '{"title":12}', '{"title":null}',
            '{"title":"bad\\nline"}', '{"title":"bad\\rline"}', '{"title":"bad\\u0000line"}',
            '{"title":"fix: retries","description":42}', '{"title":"fix: retries","description":{}}',
            '```json\n{"title":"truncated\n```']) {
            expect(parseAiCommitMessage(content)).toBeNull();
        }
    });
});

describe("AI retries", () => {
    const ai = { ...defaultAiConfig, enabled: true, model: "test-model", baseUrl: "https://ai.example/v1" };
    const validResponse = () => Response.json({ choices: [{ message: { content: '{"title":"fix: retries"}' } }] });
    const git = {} as SimpleGit;
    let contextMock: ReturnType<typeof spyOn<typeof aiContext, "collectAiContext">>;
    let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
    let sleepMock: ReturnType<typeof spyOn<typeof Bun, "sleep">>;
    let warnings: string[];
    const warn = (message: string) => warnings.push(message);
    const generate = (maxRetries = ai.maxRetries, gitInstance = git) => generateAiCommitMessage(
        gitInstance, { ...ai, maxRetries }, false, ["src/ai.ts"], null, () => {}, warn
    );

    beforeEach(() => {
        warnings = [];
        contextMock = spyOn(aiContext, "collectAiContext").mockResolvedValue({
            statusSummary: "M\tsrc/ai.ts", diffStat: "changes", diff: "changes"
        });
        fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected AI request"));
        sleepMock = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    });

    afterEach(() => {
        contextMock.mockRestore();
        fetchMock.mockRestore();
        sleepMock.mockRestore();
    });

    test("recovers from malformed commit JSON then a non-JSON HTTP body", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"title":"broken' } }] }))
            .mockResolvedValueOnce(new Response("not JSON"))
            .mockResolvedValueOnce(validResponse());

        expect(await generate()).toEqual({ title: "fix: retries", description: undefined });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleepMock.mock.calls).toEqual([[500], [1000]]);
        expect(warnings).toHaveLength(2);
        expect(warnings.join(" ")).not.toContain("Falling back");
        const signals = fetchMock.mock.calls.map(([, options]) => options?.signal);
        expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
        expect(new Set(signals).size).toBe(3);
    });

    test("returns null for manual input after exactly N retries", async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"title":' } }] }));
        }
        expect(await generate(3)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(warnings).toHaveLength(4);
        expect(warnings[0]).toContain("Retrying (1/3)");
        expect(warnings[3]).toContain("Falling back to manual commit messages");
        expect(warnings.slice(0, -1).join(" ")).not.toContain("Falling back");
    });

    test("zero retries falls back on the first failure without waiting", async () => {
        fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
        expect(await generate(0)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleepMock).not.toHaveBeenCalled();
        expect(warnings[0]).toContain("Authentication failed (401)");
        expect(warnings[0]).toContain("Falling back");
    });

    test("success needs no retries and keeps the same diff and request on retry", async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(validResponse());
        expect(await generate(2)).toEqual({ title: "fix: retries", description: undefined });
        expect(contextMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
        warnings = [];
        sleepMock.mockClear();
        fetchMock.mockResolvedValueOnce(validResponse());
        expect(await generate()).not.toBeNull();
        expect(sleepMock).not.toHaveBeenCalled();
        expect(warnings).toEqual([]);
    });

    for (const status of [400, 401, 403, 429, 500, 503]) {
        test(`retries HTTP ${status} errors in both AI operations`, async () => {
            fetchMock.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(validResponse());
            expect(await generate()).not.toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(2);
            fetchMock.mockClear();
            fetchMock.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(new Response());
            expect(await checkAiProviderStatus(ai, () => {}, warn)).toBe(true);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    }

    for (const error of [new TypeError("fetch failed"), new DOMException("timeout", "TimeoutError"),
        new DOMException("aborted", "AbortError"), new Error("unexpected failure"), "unknown failure"]) {
        test(`retries thrown errors in both AI operations: ${String(error)}`, async () => {
            fetchMock.mockRejectedValueOnce(error).mockResolvedValueOnce(validResponse());
            expect(await generate()).not.toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(2);
            fetchMock.mockClear();
            fetchMock.mockRejectedValueOnce(error).mockResolvedValueOnce(new Response());
            expect(await checkAiProviderStatus(ai, () => {}, warn)).toBe(true);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    }

    for (const body of [null, {}, { choices: null }, { choices: [] }, { choices: [null] },
        { choices: [{ message: null }] }, { choices: [{ message: { content: 42 } }] },
        { choices: [{ message: { content: "  " } }] }, { choices: [{ message: { content: '{"title":42}' } }] }]) {
        test(`retries empty or invalid response shapes: ${JSON.stringify(body)}`, async () => {
            fetchMock.mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(validResponse());
            expect(await generate()).not.toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    }

    test("provider check falls back after exhausting retries and caps retry delays", async () => {
        for (let attempt = 0; attempt < 6; attempt += 1) {
            fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
        }
        expect(await checkAiProviderStatus({ ...ai, maxRetries: 5 }, () => {}, warn)).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(6);
        expect(sleepMock.mock.calls).toEqual([[500], [1000], [2000], [4000], [4000]]);
        expect(warnings.at(-1)).toContain("Falling back");
    });

    test("missing config falls back immediately and skipped provider checks do not request", async () => {
        expect(await checkAiProviderStatus({ ...ai, model: undefined }, () => {}, warn)).toBe(false);
        expect(await checkAiProviderStatus({ ...ai, baseUrl: "" }, () => {}, warn)).toBe(false);
        expect(await checkAiProviderStatus({ ...ai, skipProviderCheck: true }, () => {}, warn)).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sleepMock).not.toHaveBeenCalled();
    });

    test("AI context preparation failures retry and then fall back without crashing", async () => {
        contextMock.mockRejectedValue(new Error("diff unavailable"));
        expect(await generate(1)).toBeNull();
        expect(contextMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(warnings.at(-1)).toContain("Falling back");
    });
});
