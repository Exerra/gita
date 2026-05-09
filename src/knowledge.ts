import { readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { limitText } from "./utils";
import type { KnowledgeBase, KnowledgeBaseConfig } from "./types";

const defaultKnowledgeConfig: Required<KnowledgeBaseConfig> = {
    enabled: true,
    paths: [".gita/knowledge"],
    maxChars: 6000,
    includeExtensions: [
        ".md",
        ".txt",
        ".markdown",
        ".mdx",
        ".json",
        ".yml",
        ".yaml"
    ]
};

export const mergeKnowledgeConfig = (config?: KnowledgeBaseConfig): Required<KnowledgeBaseConfig> => {
    const merged = { ...defaultKnowledgeConfig };
    if (!config) return merged;
    if (typeof config.enabled === "boolean") merged.enabled = config.enabled;
    if (Array.isArray(config.paths) && config.paths.length > 0) merged.paths = config.paths;
    if (typeof config.maxChars === "number" && Number.isFinite(config.maxChars)) merged.maxChars = config.maxChars;
    if (Array.isArray(config.includeExtensions) && config.includeExtensions.length > 0) {
        merged.includeExtensions = config.includeExtensions;
    }
    return merged;
};

const collectFiles = async (root: string, includeExtensions: string[]) => {
    const entries: string[] = [];
    const queue: string[] = [root];

    while (queue.length) {
        const current = queue.shift();
        if (!current) continue;
        let stats: Awaited<ReturnType<typeof stat>>;
        try {
            stats = await stat(current);
        } catch {
            continue;
        }

        if (stats.isDirectory()) {
            let children: string[] = [];
            try {
                children = await readdir(current);
            } catch {
                continue;
            }
            for (const child of children) queue.push(resolve(current, child));
            continue;
        }

        const extension = extname(current).toLowerCase();
        if (includeExtensions.includes(extension)) entries.push(current);
    }

    return entries;
};

const readKnowledgeFiles = async (paths: string[], includeExtensions: string[]) => {
    const entries: { source: string; content: string }[] = [];
    for (const root of paths) {
        const absoluteRoot = resolve(process.cwd(), root);
        const files = await collectFiles(absoluteRoot, includeExtensions);
        for (const filePath of files) {
            try {
                const content = await Bun.file(filePath).text();
                if (content.trim().length === 0) continue;
                entries.push({ source: filePath, content });
            } catch {
                continue;
            }
        }
    }

    return entries;
};

export const loadKnowledgeBase = async (config?: KnowledgeBaseConfig): Promise<KnowledgeBase | null> => {
    const merged = mergeKnowledgeConfig(config);
    if (!merged.enabled) return null;

    const entries = await readKnowledgeFiles(merged.paths, merged.includeExtensions);
    if (entries.length === 0) return null;

    const combined = entries
        .map((entry) => `Source: ${entry.source}\n${entry.content.trim()}`)
        .join("\n\n");
    const truncatedText = limitText(combined, merged.maxChars);

    return {
        entries,
        text: truncatedText,
        truncated: truncatedText !== combined
    };
};

export const buildKnowledgeSection = (knowledge: KnowledgeBase) => {
    const header = "Knowledge Base:";
    const trimmed = knowledge.text.trim();
    if (!trimmed) return header;
    return `${header}\n${trimmed}`;
};
