import { clampTemperature } from "./utils";
import type { AiMode, AiRuntimeConfig, AppConfig } from "./types";

export const defaultAiConfig: AiRuntimeConfig = {
    enabled: false,
    mode: "none",
    temperature: 0.2,
    baseUrl: "https://api.openai.com/v1",
    skipProviderCheck: false
};

export const parseAiMode = (value?: string): AiMode | undefined => {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (normalized === "always" || normalized === "ask" || normalized === "none") return normalized;
    return undefined;
};

export const parseCliAiMode = (args: string[]): AiMode | undefined => {
    for (let index = args.length - 1; index >= 0; index -= 1) {
        const arg = args[index];
        if (arg === "--ai") return "always";
        if (arg === "--no-ai") return "none";
    }
    return undefined;
};

export const mergeAiConfig = (
    globalConfig: AppConfig | null,
    projectConfig: AppConfig | null,
    cliMode?: AiMode
): AiRuntimeConfig => {
    const merged: AiRuntimeConfig = { ...defaultAiConfig };
    const globalAi = globalConfig?.ai ?? {};
    let enabledExplicit = false;

    if (typeof globalAi.enabled === "boolean") {
        merged.enabled = globalAi.enabled;
        enabledExplicit = true;
    }
    if (typeof globalAi.mode === "string") merged.mode = parseAiMode(globalAi.mode) ?? merged.mode;
    if (typeof globalAi.temperature === "number" && Number.isFinite(globalAi.temperature)) {
        merged.temperature = clampTemperature(globalAi.temperature);
    }
    if (typeof globalAi.apiKey === "string") merged.apiKey = globalAi.apiKey;
    if (typeof globalAi.model === "string") merged.model = globalAi.model;
    if (typeof globalAi.baseUrl === "string") merged.baseUrl = globalAi.baseUrl;
    if (typeof globalAi.skipProviderCheck === "boolean") merged.skipProviderCheck = globalAi.skipProviderCheck;

    const projectAi = projectConfig?.ai ?? {};
    if (typeof projectAi.enabled === "boolean") {
        merged.enabled = projectAi.enabled;
        enabledExplicit = true;
    }
    if (typeof projectAi.mode === "string") merged.mode = parseAiMode(projectAi.mode) ?? merged.mode;
    if (typeof projectAi.temperature === "number" && Number.isFinite(projectAi.temperature)) {
        merged.temperature = clampTemperature(projectAi.temperature);
    }
    if (typeof projectAi.skipProviderCheck === "boolean") merged.skipProviderCheck = projectAi.skipProviderCheck;

    if (!merged.apiKey) merged.apiKey = Bun.env.GITA_AI_API_KEY ?? Bun.env.OPENAI_API_KEY;
    if (!merged.model) merged.model = Bun.env.GITA_AI_MODEL ?? Bun.env.OPENAI_MODEL;
    if (!merged.baseUrl) {
        merged.baseUrl = Bun.env.GITA_AI_BASE_URL ?? Bun.env.OPENAI_BASE_URL ?? merged.baseUrl;
    }

    if (cliMode) {
        merged.mode = cliMode;
        merged.enabled = cliMode !== "none";
        enabledExplicit = true;
    }

    if (!enabledExplicit && merged.mode !== "none") merged.enabled = true;

    return merged;
};

export const warnOnConflictingAiFlags = (args: string[], onWarn: (message: string) => void) => {
    if (args.includes("--ai") && args.includes("--no-ai")) {
        onWarn("Both --ai and --no-ai passed. Using the last flag.");
    }
};
