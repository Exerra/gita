import { formatStatusSummary } from "./git";
import { buildKnowledgeSection } from "./knowledge";
import { createTimeoutSignal, limitText, normalizeBaseUrl } from "./utils";
import type { AiCommitMessage, AiRuntimeConfig, KnowledgeBase } from "./types";
import type { SimpleGit, StatusResult } from "simple-git";

const buildAiHeaders = (ai: AiRuntimeConfig): HeadersInit => {
    const headers: Record<string, string> = {
        "Content-Type": "application/json"
    };

    if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
    return headers;
};

const buildAiPrompt = (
    status: StatusResult | null,
    diffStat: string,
    diff: string,
    commitAll: boolean,
    file: string,
    knowledgeBase?: KnowledgeBase
) => {
    const scopeLine = commitAll ? "Scope: all changes" : `Scope: ${file}`;
    const statusSummary = status ? formatStatusSummary(status) : "";
    const diffStatText = diffStat.trim().length > 0 ? diffStat.trim() : "(none)";
    const diffText = diff.trim().length > 0 ? limitText(diff.trim(), 12000) : "(none)";

    const sections = [
        "Generate a concise git commit message for the following changes.",
        scopeLine
    ];

    if (statusSummary) sections.push(`Status:\n${statusSummary}`);

    if (knowledgeBase) sections.push(buildKnowledgeSection(knowledgeBase));

    sections.push(
        `Diffstat:\n${diffStatText}`,
        `Diff:\n${diffText}`,
        "Return ONLY JSON with keys title and description. Title <= 72 chars. Description optional."
    );

    return sections.join("\n\n");
};

export const parseAiCommitMessage = (content: string): AiCommitMessage | null => {
    let text = content.trim();
    if (!text) return null;

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) text = fenced[1].trim();

    if (text.startsWith("{") && text.endsWith("}")) {
        try {
            const parsed = JSON.parse(text) as { title?: string; description?: string };
            const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
            const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
            if (!title) return null;
            return { title, description: description || undefined };
        } catch {
        }
    }

    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return null;

    const title = lines[0];
    const description = lines.slice(1).join(" ").trim();
    return { title, description: description || undefined };
};

export const checkAiProviderStatus = async (
    ai: AiRuntimeConfig,
    logVerbose: (message: string) => void,
    warn: (message: string) => void
): Promise<boolean> => {
    if (!ai.baseUrl) {
        logVerbose("AI provider check: missing base URL.");
        warn("AI base URL missing. Falling back to manual commit messages.");
        return false;
    }

    if (!ai.model) {
        logVerbose("AI provider check: missing model.");
        warn("AI model missing. Falling back to manual commit messages.");
        return false;
    }

    if (ai.skipProviderCheck) {
        logVerbose("AI provider check skipped by config.");
        return true;
    }

    try {
        const requestUrl = `${normalizeBaseUrl(ai.baseUrl)}/models`;
        logVerbose(
            `AI provider check request: GET ${requestUrl} | timeout=4000ms | auth=${ai.apiKey ? "yes" : "no"}`
        );
        const response = await fetch(requestUrl, {
            method: "GET",
            headers: buildAiHeaders(ai),
            signal: createTimeoutSignal(4000)
        });

        if (!response.ok) {
            logVerbose(`AI provider check failed with status ${response.status}.`);
            warn(`AI provider check failed (${response.status}). Falling back to manual commit messages.`);
            return false;
        }

        logVerbose("AI provider check succeeded.");
        return true;
    } catch {
        logVerbose("AI provider check failed: request error.");
        warn("AI provider check failed. Falling back to manual commit messages.");
        return false;
    }
};

export const generateAiCommitMessage = async (
    gitInstance: SimpleGit,
    ai: AiRuntimeConfig,
    commitAll: boolean,
    file: string,
    status: StatusResult | null,
    logVerbose: (message: string) => void,
    knowledgeBase?: KnowledgeBase
): Promise<AiCommitMessage | null> => {
    if (!ai.baseUrl || !ai.model) return null;

    const diffArgs = commitAll ? [] : ["--", file];
    const diffStat = await gitInstance.diff(["--stat", ...diffArgs]);
    const diff = await gitInstance.diff(diffArgs);
    const prompt = buildAiPrompt(status, diffStat, diff, commitAll, file, knowledgeBase);

    try {
        const requestUrl = `${normalizeBaseUrl(ai.baseUrl)}/chat/completions`;
        logVerbose(`AI commit request: POST ${requestUrl}`);
        logVerbose(
            `AI commit request meta: model=${ai.model} | temperature=${ai.temperature} | max_tokens=180 | timeout=15000ms | prompt_chars=${prompt.length} | auth=${ai.apiKey ? "yes" : "no"}`
        );
        const response = await fetch(requestUrl, {
            method: "POST",
            headers: buildAiHeaders(ai),
            signal: createTimeoutSignal(15000),
            body: JSON.stringify({
                model: ai.model,
                temperature: ai.temperature,
                max_tokens: 180,
                messages: [
                    {
                        role: "system",
                        content: "You are a git commit message generator. Respond with JSON only."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ]
            })
        });

        if (!response.ok) {
            logVerbose(`AI response status: ${response.status}`);
            return null;
        }

        const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content) logVerbose(`AI raw output:\n${content}`);
        if (!content) return null;

        const parsed = parseAiCommitMessage(content);
        if (!parsed) logVerbose("AI output could not be parsed into title/description.");
        return parsed;
    } catch (error) {
        logVerbose(`AI request failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return null;
    }
};
