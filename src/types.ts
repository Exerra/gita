export type AiMode = "always" | "ask" | "none";

export type AiConfig = {
    enabled?: boolean;
    mode?: AiMode;
    temperature?: number;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    skipProviderCheck?: boolean;
    useConventionalCommits?: boolean;
};

export type KnowledgeBaseConfig = {
    enabled?: boolean;
    paths?: string[];
    maxChars?: number;
    includeExtensions?: string[];
};

export type AppConfig = {
    ai?: AiConfig;
    knowledgeBase?: KnowledgeBaseConfig;
};

export type AiRuntimeConfig = {
    enabled: boolean;
    mode: AiMode;
    temperature: number;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    skipProviderCheck: boolean;
    useConventionalCommits: boolean;
};

export type AiCommitMessage = {
    title: string;
    description?: string;
};

export type KnowledgeEntry = {
    source: string;
    content: string;
};

export type KnowledgeBase = {
    entries: KnowledgeEntry[];
    text: string;
    truncated: boolean;
};
