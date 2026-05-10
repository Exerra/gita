import { log } from "@clack/prompts";

export const resolveHomeDir = (): string | null => {
    const home = Bun.env.HOME ?? Bun.env.USERPROFILE;
    if (home) return home;
    const homeDrive = Bun.env.HOMEDRIVE;
    const homePath = Bun.env.HOMEPATH;
    if (homeDrive && homePath) return `${homeDrive}${homePath}`;
    return null;
};

export const logVerbose = (enabled: boolean, message: string) => {
    if (enabled) log.info(message);
};

export const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
    try {
        const raw = await Bun.file(filePath).text();
        return JSON.parse(raw) as T;
    } catch (error) {
        const err = error as { code?: string };
        if (err.code !== "ENOENT") log.warn(`Failed to read config at ${filePath}. Using defaults.`);
        return null;
    }
};

export const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

export const clampTemperature = (value: number) => Math.min(2, Math.max(0, value));

export const createTimeoutSignal = (ms: number): AbortSignal | undefined => {
    if (typeof AbortSignal === "undefined") return undefined;
    if (typeof AbortSignal.timeout !== "function") return undefined;
    return AbortSignal.timeout(ms);
};

export const limitText = (value: string, maxChars: number) => {
    if (value.length <= maxChars) return value;
    const sliced = value.slice(0, maxChars);
    return `${sliced}\n[truncated ${value.length - maxChars} chars]`;
};
