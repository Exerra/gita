import { formatStatusSummary } from "./git";
import { buildKnowledgeSection } from "./knowledge";
import { createTimeoutSignal, limitText, normalizeBaseUrl } from "./utils";
import type { AiCommitMessage, AiRuntimeConfig, KnowledgeBase } from "./types";
import type { SimpleGit, StatusResult } from "simple-git";

const buildAiHeaders = (ai: AiRuntimeConfig): /*HeadersInit*/ Record<string, string> => {
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
    files: string[], // Phase 3b: accept files array
    useConventionalCommits: boolean,
    knowledgeBase?: KnowledgeBase
) => {
    const scopeLine = commitAll ? "Scope: all changes" : `Scope: ${files.join(", ")}`;
    const statusSummary = status ? formatStatusSummary(status) : "";
    const diffStatText = diffStat.trim().length > 0 ? diffStat.trim() : "(none)";
    const diffText = diff.trim().length > 0 ? limitText(diff.trim(), 12000) : "(none)";

    const sections = [
        "Generate a concise git commit message for the following changes.",
        "Make sure to include relevant information and be specific in the title to understand the purpose of the commit.",
        scopeLine
    ];

    if (useConventionalCommits) {
        sections[0] += " Use conventional commits format (e.g. feat:, chore:, fix:, etc).";
    } else {
        sections[0] += " DO NOT use conventional commits format (do not use feat:, chore:, fix:, etc). Start directly with the commit message.";
    }

    if (statusSummary) sections.push(`Status:\n${statusSummary}`);

    if (knowledgeBase) sections.push(buildKnowledgeSection(knowledgeBase));

    sections.push(
        `Diffstat:\n${diffStatText}`,
        `Diff:\n${diffText}`,
        "Return ONLY JSON with keys title and description. Title <= 72 chars. Description optional."
    );

    return sections.join("\n\n");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const parseAiCommitMessage = (content: string): AiCommitMessage | null => {
    let text = content.trim();
    if (!text) return null;

    const fenced = text.match(/(?:^|\r?\n)[ \t]*```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) text = fenced[1].trim();

    try {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            // Tolerate surrounding commentary, while keeping malformed JSON out of commit titles.
            if (text.startsWith("[") || text.startsWith('"')) return null;
            const objectStart = text.indexOf("{");
            const objectEnd = text.lastIndexOf("}");
            if (objectStart < 0 || objectEnd < objectStart) return null;
            parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
        }
        if (!isRecord(parsed) || typeof parsed.title !== "string") return null;
        const title = parsed.title.trim();
        if (!title || /[\r\n\0]/.test(title)) return null;
        if (parsed.description != null && typeof parsed.description !== "string") return null;
        const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
        return { title, description: description || undefined };
    } catch {
        return null;
    }
};

const describeAiError = (error: unknown): string => {
    if (!(error instanceof Error)) return "Unknown error.";
    if (error.name === "AbortError" || error.name === "TimeoutError") {
        return "Request timed out. Check your connection.";
    }
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)) {
        return "Network error. Check your connection and base URL.";
    }
    return error.message;
};

const aiHttpError = (status: number): Error => {
    if (status === 401) return new Error("Authentication failed (401). Check your API key.");
    if (status === 403) return new Error("Access forbidden (403). Check your API key permissions.");
    if (status === 429) return new Error("Rate limited (429). Try again later.");
    if (status >= 500) return new Error(`Provider error (HTTP ${status}). The service may be down.`);
    return new Error(`Request failed (HTTP ${status}).`);
};

const withAiRetries = async <T>(
    ai: AiRuntimeConfig,
    label: string,
    operation: () => Promise<T>,
    logVerbose: (message: string) => void,
    warn: (message: string) => void
): Promise<T | null> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            logVerbose(`${label}: attempt ${attempt + 1}/${ai.maxRetries + 1}.`);
            return await operation();
        } catch (error) {
            const message = `${label} failed: ${describeAiError(error)}`;
            logVerbose(message);
            if (attempt >= ai.maxRetries) {
                warn(`${message} Failed after ${attempt + 1} attempt(s). Falling back to manual commit messages.`);
                return null;
            }
            const delayMs = 500 * 2 ** Math.min(attempt, 3);
            warn(`${message} Retrying (${attempt + 1}/${ai.maxRetries}) in ${delayMs}ms.`);
            await Bun.sleep(delayMs);
        }
    }
};

export const checkAiProviderStatus = async (
    ai: AiRuntimeConfig,
    logVerbose: (message: string) => void,
    warn: (message: string) => void
): Promise<boolean> => {
    const { baseUrl } = ai;
    if (!baseUrl) {
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

    return (await withAiRetries(ai, "AI provider check", async () => {
        const requestUrl = `${normalizeBaseUrl(baseUrl)}/models`;
        logVerbose(
            `AI provider check request: GET ${requestUrl} | timeout=4000ms | auth=${ai.apiKey ? "yes" : "no"}`
        );
        const response = await fetch(requestUrl, {
            method: "GET",
            headers: buildAiHeaders(ai),
            signal: createTimeoutSignal(4000)
        });

        if (!response.ok) throw aiHttpError(response.status);

        logVerbose("AI provider check succeeded.");
        return true;
    }, logVerbose, warn)) ?? false;
};

export const generateAiCommitMessage = async (
    gitInstance: SimpleGit,
    ai: AiRuntimeConfig,
    commitAll: boolean,
    files: string[], // Phase 3b: accept files array
    status: StatusResult | null,
    logVerbose: (message: string) => void,
    warn: (message: string) => void, // Phase 5: specific error reporting
    knowledgeBase?: KnowledgeBase
): Promise<AiCommitMessage | null> => {
    const { baseUrl, model } = ai;
    if (!baseUrl || !model) return null;

    let prompt: string | undefined;
    return withAiRetries(ai, "AI commit generation", async () => {
        if (prompt === undefined) {
            const diffArgs = commitAll ? [] : ["--", ...files];
            const diffStat = await gitInstance.diff(["--stat", ...diffArgs]);
            const diff = await gitInstance.diff(diffArgs);
            prompt = buildAiPrompt(status, diffStat, diff, commitAll, files, ai.useConventionalCommits, knowledgeBase);
        }

        const requestUrl = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
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

        if (!response.ok) throw aiHttpError(response.status);

        const data: unknown = await response.json();
        const choice: unknown = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
        const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
        const content = typeof message?.content === "string" ? message.content.trim() : "";
        if (content) logVerbose(`AI raw output:\n${content}`);
        if (!content) {
            throw new Error("AI returned an empty or invalid response.");
        }

        const parsed = parseAiCommitMessage(content);
        if (!parsed) {
            throw new Error("AI response could not be parsed into a valid JSON title/description.");
        }
        return parsed;
    }, logVerbose, warn);
};
