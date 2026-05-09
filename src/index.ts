#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, tasks, Task, log, isCancel } from "@clack/prompts";
import chalk from "chalk";
import simpleGit, { GitResponseError, PushResult } from "simple-git";
import type { SimpleGit, StatusResult } from "simple-git";
import { relative, resolve } from "node:path";

const currentDir = import.meta.dir;
const packageJsonPath = resolve(currentDir, "../package.json");
const packageJson = JSON.parse(await Bun.file(packageJsonPath).text()) as { version?: string };
const version = packageJson.version ?? "0.0.0";
const cliArgs = Bun.argv.slice(2);

type AiMode = "always" | "ask" | "none";
type AiConfig = {
    enabled?: boolean;
    mode?: AiMode;
    temperature?: number;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
};

type AppConfig = {
    ai?: AiConfig;
};

type AiRuntimeConfig = {
    enabled: boolean;
    mode: AiMode;
    temperature: number;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
};

const defaultAiConfig: AiRuntimeConfig = {
    enabled: false,
    mode: "none",
    temperature: 0.2,
    baseUrl: "https://api.openai.com/v1"
};

const resolveHomeDir = (): string | null => {
    const home = Bun.env.HOME ?? Bun.env.USERPROFILE;
    if (home) return home;
    const homeDrive = Bun.env.HOMEDRIVE;
    const homePath = Bun.env.HOMEPATH;
    if (homeDrive && homePath) return `${homeDrive}${homePath}`;
    return null;
};

const parseAiMode = (value?: string): AiMode | undefined => {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (normalized === "always" || normalized === "ask" || normalized === "none") return normalized;
    return undefined;
};

const parseCliAiMode = (args: string[]): AiMode | undefined => {
    for (let index = args.length - 1; index >= 0; index -= 1) {
        const arg = args[index];
        if (arg === "--ai") return "always";
        if (arg === "--no-ai") return "none";
    }
    return undefined;
};

const warnOnConflictingAiFlags = (args: string[]) => {
    if (args.includes("--ai") && args.includes("--no-ai")) {
        log.warn("Both --ai and --no-ai passed. Using the last flag.");
    }
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
    try {
        const raw = await Bun.file(filePath).text();
        return JSON.parse(raw) as T;
    } catch (error) {
        const err = error as { code?: string };
        if (err.code !== "ENOENT") log.warn(`Failed to read config at ${filePath}. Using defaults.`);
        return null;
    }
};

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

const clampTemperature = (value: number) => Math.min(2, Math.max(0, value));

const mergeAiConfig = (
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

    const projectAi = projectConfig?.ai ?? {};
    if (typeof projectAi.enabled === "boolean") {
        merged.enabled = projectAi.enabled;
        enabledExplicit = true;
    }
    if (typeof projectAi.mode === "string") merged.mode = parseAiMode(projectAi.mode) ?? merged.mode;
    if (typeof projectAi.temperature === "number" && Number.isFinite(projectAi.temperature)) {
        merged.temperature = clampTemperature(projectAi.temperature);
    }

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

const buildAiHeaders = (ai: AiRuntimeConfig): HeadersInit => {
    const headers: Record<string, string> = {
        "Content-Type": "application/json"
    };

    if (ai.apiKey) headers.Authorization = `Bearer ${ai.apiKey}`;
    return headers;
};

const createTimeoutSignal = (ms: number): AbortSignal | undefined => {
    if (typeof AbortSignal === "undefined") return undefined;
    if (typeof AbortSignal.timeout !== "function") return undefined;
    return AbortSignal.timeout(ms);
};

const formatStatusSummary = (status: StatusResult): string => {
    const lines: string[] = [];

    if (status.modified.length) lines.push(`modified: ${status.modified.join(", ")}`);
    if (status.created.length) lines.push(`created: ${status.created.join(", ")}`);
    if (status.deleted.length) lines.push(`deleted: ${status.deleted.join(", ")}`);
    if (status.not_added.length) lines.push(`untracked: ${status.not_added.join(", ")}`);
    if (status.renamed.length) {
        const renamed = status.renamed.map(({ from, to }) => `${from} -> ${to}`);
        lines.push(`renamed: ${renamed.join(", ")}`);
    }

    return lines.join("\n");
};

const limitText = (value: string, maxChars: number) => {
    if (value.length <= maxChars) return value;
    const sliced = value.slice(0, maxChars);
    return `${sliced}\n[truncated ${value.length - maxChars} chars]`;
};

const buildAiPrompt = (
    status: StatusResult | null,
    diffStat: string,
    diff: string,
    commitAll: boolean,
    file: string
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

    sections.push(
        `Diffstat:\n${diffStatText}`,
        `Diff:\n${diffText}`,
        "Return ONLY JSON with keys title and description. Title <= 72 chars. Description optional."
    );

    return sections.join("\n\n");
};

const parseAiCommitMessage = (content: string): { title: string; description?: string } | null => {
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

const checkAiProviderStatus = async (ai: AiRuntimeConfig): Promise<boolean> => {
    if (!ai.baseUrl) {
        log.warn("AI base URL missing. Falling back to manual commit messages.");
        return false;
    }

    if (!ai.model) {
        log.warn("AI model missing. Falling back to manual commit messages.");
        return false;
    }

    try {
        const response = await fetch(`${normalizeBaseUrl(ai.baseUrl)}/models`, {
            method: "GET",
            headers: buildAiHeaders(ai),
            signal: createTimeoutSignal(4000)
        });

        if (!response.ok) {
            log.warn(`AI provider check failed (${response.status}). Falling back to manual commit messages.`);
            return false;
        }

        return true;
    } catch {
        log.warn("AI provider check failed. Falling back to manual commit messages.");
        return false;
    }
};

const generateAiCommitMessage = async (
    gitInstance: SimpleGit,
    ai: AiRuntimeConfig,
    commitAll: boolean,
    file: string,
    status: StatusResult | null
): Promise<{ title: string; description?: string } | null> => {
    if (!ai.baseUrl || !ai.model) return null;

    const diffArgs = commitAll ? [] : ["--", file];
    const diffStat = await gitInstance.diff(["--stat", ...diffArgs]);
    const diff = await gitInstance.diff(diffArgs);
    const prompt = buildAiPrompt(status, diffStat, diff, commitAll, file);

    try {
        const response = await fetch(`${normalizeBaseUrl(ai.baseUrl)}/chat/completions`, {
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
            log.warn(`AI commit message generation failed (${response.status}).`);
            return null;
        }

        const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) return null;

        return parseAiCommitMessage(content);
    } catch {
        log.warn("AI commit message generation failed.");
        return null;
    }
};

const baseDir = process.cwd()
const cancelMessage = "Gita stopped by user action. No commit has been made."

const git = simpleGit({
    baseDir: baseDir,
    binary: "git",
    maxConcurrentProcesses: 6,
    trimmed: false
})

intro(`${chalk.bold.green("Gita")} ${chalk.gray("(v" + version + ")")} by ${chalk.bold("Exerra")}`)

if (!(await git.checkIsRepo())) {
    const initRepo = await confirm({
        message: chalk.yellow("Warning: No git repository found. Initialize one here?")
    })

    if (isCancel(initRepo)) {
        cancel(cancelMessage)
        process.exit(0)
    }

    if (initRepo) {
        await git.init()
        log.warn("Initialized a new git repository here.")
    } else {
        cancel("Gita can only run inside a git repository.")
        process.exit(1)
    }
}

const repoRoot = (await git.revparse(["--show-toplevel"])).trim()
const homeDir = resolveHomeDir()
if (!homeDir) {
    log.warn("Home directory not detected. Skipping global config.")
}
const globalConfigPath = homeDir ? resolve(homeDir, ".config", "gita", "config.json") : null
const projectConfigPath = resolve(repoRoot, ".gita", "config.json")
const globalConfig = globalConfigPath ? await readJsonFile<AppConfig>(globalConfigPath) : null
const projectConfig = await readJsonFile<AppConfig>(projectConfigPath)
warnOnConflictingAiFlags(cliArgs)
const cliAiMode = parseCliAiMode(cliArgs)
const aiConfig = mergeAiConfig(globalConfig, projectConfig, cliAiMode)

let file = ""
let status: StatusResult | null = null

const commitAll = await confirm({ message: "Commit all?" })

if (isCancel(commitAll)) {
    cancel(cancelMessage)
    process.exit(0)
}

if (commitAll) file = "."
else {
    status = await git.status()
    const statusFiles = Array.from(new Set([
        ...status.not_added,
        ...status.modified,
        ...status.created,
        ...status.deleted,
        ...status.renamed.map(({ to }) => to)
    ]))

    if (statusFiles.length === 0) {
        cancel("No changed files found. Nothing to commit.")
        process.exit(0)
    }

    const fileOptions = statusFiles.map((statusFile) => {
        const absolutePath = resolve(repoRoot, statusFile)
        const relativeToBase = relative(baseDir, absolutePath)
        const displayLabel = relativeToBase.startsWith("..")
            ? statusFile
            : relativeToBase.startsWith(".")
                ? relativeToBase
                : `./${relativeToBase}`

        return {
            label: displayLabel,
            value: relativeToBase
        }
    })

    const selectedFile = await select({
        message: "Select a file:",
        options: fileOptions
    })

    if (isCancel(selectedFile)) {
        cancel(cancelMessage)
        process.exit(0)
    }

    file = selectedFile as string
}

const shouldUseAiPrompt = async (mode: AiMode): Promise<boolean> => {
    if (mode === "always") return true;
    if (mode === "none") return false;
    const useAi = await confirm({
        message: chalk.bold("Use AI to draft the commit message?"),
        initialValue: true
    })

    if (isCancel(useAi)) {
        cancel(cancelMessage)
        process.exit(0)
    }

    return useAi
}

let aiCommitMessage: { title: string; description?: string } | null = null
let shouldUseAi = false

if (aiConfig.enabled && aiConfig.mode !== "none") {
    shouldUseAi = await shouldUseAiPrompt(aiConfig.mode)
}

if (shouldUseAi) {
    const providerReady = await checkAiProviderStatus(aiConfig)
    if (!providerReady) {
        shouldUseAi = false
    } else {
        if (!status) status = await git.status()
        aiCommitMessage = await generateAiCommitMessage(git, aiConfig, commitAll, file, status)
        if (!aiCommitMessage) {
            log.warn("AI commit message unavailable. Falling back to manual input.")
            shouldUseAi = false
        }
    }
}

const questions = await group(
    {
        title: () => text({
            message: chalk.bold("What will be the title?"),
            defaultValue: aiCommitMessage?.title,
            validate(value) {
                if (!value || value.length === 0) return "You must write a title!"
            }
        }),
        description: () => text({
            message: chalk.bold("What will be the description? (leave blank for no desc.)"),
            defaultValue: aiCommitMessage?.description
        }),
        push: () => confirm({
            message: chalk.bold("Do you want to push?")
        })
    },
    {
        onCancel: ({ results }) => {
            cancel(cancelMessage)
            process.exit(0)
        }
    }
)

let { title, description, push } = questions

if (push) {
    const remotes = await git.getRemotes()
    if (remotes.length === 0) {
        log.warn("No remotes configured. Skipping push.")
        push = false
    }
}

try {
    let taskList: Task[] = [
        {
            title: "Staging",
            task: async () => {
                if (commitAll) await git.add(["--all"])
                else await git.add(file)

                return "Staging complete";
            },
        },
        {
            title: "Committing",
            task: async () => {
                if (commitAll) await git.commit(description ? [title, description] : title)
                else await git.commit(description ? [title, description] : title, file)

                return 'Commit complete';
            },
        }
    ]

    if (push) taskList.push({
        title: "Pushing",
        task: async () => {
            await git.push()
            return 'Push complete';
        },
    })

    await tasks(taskList);
} catch (e) {
    const err = e as GitResponseError<PushResult>

    if (err.message.includes("No configured push destination")) {
        cancel("No remotes available. Cancelling push. Commit is saved. Add a remote, then run git push.")
        process.exit(1)
    }
    // usually happens when a new git repo is made
    else if (err.message.toLowerCase().includes("no upstream branch")) {
        try {
            const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
            log.warn(`There is no upstream branch. Making ${currentBranch} the upstream branch.`);
            const remotes = await git.getRemotes()

            const remote = await select({
                message: "What remote to push to?",
                options: remotes.map(remote => ({ label: remote.name, value: remote.name }))
            })

            await git.push(remote as string, currentBranch, ["--set-upstream"])
        } catch (e) {
            const err2 = e as GitResponseError<PushResult>

            log.error(err2.message)
            cancel("Gita stopped due to an error.")
        }
    } else {
        log.error(err.message)
        cancel("Gita stopped due to an error.")
    }
}

outro(chalk.gray("Thanks for using Gita!"))
