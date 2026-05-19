#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, tasks, Task, log, isCancel, spinner, multiselect, note } from "@clack/prompts";
import chalk from "chalk";
import simpleGit, { GitResponseError, PushResult } from "simple-git";
import type { StatusResult } from "simple-git";
import { relative, resolve } from "node:path";
import { checkAiProviderStatus, generateAiCommitMessage } from "./ai";
import { mergeAiConfig, parseCliAiMode, warnOnConflictingAiFlags } from "./config";
import { loadKnowledgeBase, mergeKnowledgeConfig } from "./knowledge";
import type { AppConfig, AiMode } from "./types";
import { logVerbose as logVerboseBase, readJsonFile, resolveHomeDir } from "./utils";

const currentDir = import.meta.dir;
const packageJsonPath = resolve(currentDir, "../package.json");
const packageJson = JSON.parse(await Bun.file(packageJsonPath).text()) as { version?: string };
const version = packageJson.version ?? "0.0.0";
const cliArgs = Bun.argv.slice(2);
const verboseEnabled = cliArgs.includes("--verbose");

// Phase 2: --version / --help before intro so output is clean and pipeable
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
    console.log(version);
    process.exit(0);
}

if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    console.log([
        `${chalk.bold.green("Gita")} ${chalk.gray("v" + version)} — interactive git commit & push`,
        "",
        `${chalk.bold("Usage:")}  gita [flags]`,
        "",
        `${chalk.bold("Flags:")}`,
        `  ${chalk.cyan("--ai")}            Always use AI to draft commit messages`,
        `  ${chalk.cyan("--no-ai")}         Disable AI, use manual input only`,
        `  ${chalk.cyan("--verbose")}       Enable debug logging`,
        `  ${chalk.cyan("-v, --version")}   Print version and exit`,
        `  ${chalk.cyan("-h, --help")}      Show this help`,
        "",
        `${chalk.bold("Config files:")}`,
        `  Global:  ${chalk.gray("~/.config/gita/config.json")}`,
        `  Project: ${chalk.gray(".gita/config.json")}`,
        "",
        `${chalk.bold("Environment variables:")}`,
        `  ${chalk.cyan("GITA_AI_API_KEY")}   or  ${chalk.cyan("OPENAI_API_KEY")}`,
        `  ${chalk.cyan("GITA_AI_MODEL")}     or  ${chalk.cyan("OPENAI_MODEL")}`,
        `  ${chalk.cyan("GITA_AI_BASE_URL")}  or  ${chalk.cyan("OPENAI_BASE_URL")}`,
    ].join("\n"));
    process.exit(0);
}

const baseDir = process.cwd();
const cancelMessage = "Gita stopped by user action. No commit has been made.";
const logVerbose = (message: string) => logVerboseBase(verboseEnabled, message);

const git = simpleGit({
    baseDir: baseDir,
    binary: "git",
    maxConcurrentProcesses: 6,
    trimmed: false
});

intro(`${chalk.bold.green("Gita")} ${chalk.gray("(v" + version + ")")} by ${chalk.bold("Exerra")}`);

const ensureGitRepo = async () => {
    if (await git.checkIsRepo()) return;

    const initRepo = await confirm({
        message: chalk.yellow("Warning: No git repository found. Initialize one here?")
    });

    if (isCancel(initRepo)) {
        cancel(cancelMessage);
        process.exit(0);
    }

    if (initRepo) {
        await git.init();
        log.warn("Initialized a new git repository here.");
    } else {
        cancel("Gita can only run inside a git repository.");
        process.exit(1);
    }
};

const loadConfigs = async (repoRoot: string) => {
    const homeDir = resolveHomeDir();
    if (!homeDir) {
        log.warn("Home directory not detected. Skipping global config.");
    }
    const globalConfigPath = homeDir ? resolve(homeDir, ".config", "gita", "config.json") : null;
    const projectConfigPath = resolve(repoRoot, ".gita", "config.json");
    const globalConfig = globalConfigPath ? await readJsonFile<AppConfig>(globalConfigPath) : null;
    const projectConfig = await readJsonFile<AppConfig>(projectConfigPath);
    return { globalConfig, projectConfig };
};

const loadAiConfig = (globalConfig: AppConfig | null, projectConfig: AppConfig | null) => {
    warnOnConflictingAiFlags(cliArgs, (message) => log.warn(message));
    const cliAiMode = parseCliAiMode(cliArgs);
    return mergeAiConfig(globalConfig, projectConfig, cliAiMode, (message) => log.warn(message));
};

// Phase 3a: color-coded file status display
const formatFileStatus = (status: StatusResult): string => {
    const lines: string[] = [];
    for (const f of status.created) lines.push(`${chalk.green("A")}  ${f}`);
    for (const f of status.modified) lines.push(`${chalk.yellow("M")}  ${f}`);
    for (const f of status.deleted) lines.push(`${chalk.red("D")}  ${f}`);
    for (const r of status.renamed) lines.push(`${chalk.cyan("R")}  ${r.from} → ${r.to}`);
    for (const f of status.not_added) lines.push(`${chalk.gray("?")}  ${f}`);
    return lines.join("\n");
};

const selectCommitTarget = async (repoRoot: string) => {
    // Fetch status first so we can preview before confirming
    const status = await git.status();
    const statusFiles = Array.from(new Set([
        ...status.not_added,
        ...status.modified,
        ...status.created,
        ...status.deleted,
        ...status.renamed.map(({ to }) => to)
    ]));

    if (statusFiles.length === 0) {
        cancel("No changed files found. Nothing to commit.");
        process.exit(0);
    }

    // Phase 3a: show file list before the confirm prompt
    log.info(`Changed files (${statusFiles.length}):\n${formatFileStatus(status)}`);

    const commitAll = await confirm({ message: "Stage all changed files?" });

    if (isCancel(commitAll)) {
        cancel(cancelMessage);
        process.exit(0);
    }

    if (commitAll) return { commitAll, files: ["."] as string[], status };

    const fileOptions = statusFiles.map((statusFile) => {
        const absolutePath = resolve(repoRoot, statusFile);
        const relativeToBase = relative(baseDir, absolutePath);
        const displayLabel = relativeToBase.startsWith("..")
            ? statusFile
            : relativeToBase.startsWith(".")
                ? relativeToBase
                : `./${relativeToBase}`;

        return {
            label: displayLabel,
            value: relativeToBase
        };
    });

    // Phase 3b: multiselect instead of single select
    const selectedFiles = await multiselect({
        message: "Select files to stage:",
        options: fileOptions,
        required: true
    });

    if (isCancel(selectedFiles)) {
        cancel(cancelMessage);
        process.exit(0);
    }

    return { commitAll, files: selectedFiles as string[], status };
};

const shouldUseAiPrompt = async (mode: AiMode): Promise<boolean> => {
    if (mode === "always") return true;
    if (mode === "none") return false;
    const useAi = await confirm({
        message: chalk.bold("Use AI to draft the commit message?"),
        initialValue: true
    });

    if (isCancel(useAi)) {
        cancel(cancelMessage);
        process.exit(0);
    }

    return useAi;
};

const resolveAiCommitMessage = async (
    aiConfig: ReturnType<typeof loadAiConfig>,
    commitAll: boolean,
    files: string[],
    status: StatusResult | null,
    knowledgeBase: Awaited<ReturnType<typeof loadKnowledgeBase>>
) => {
    if (!aiConfig.enabled || aiConfig.mode === "none") return null;

    const shouldUseAi = await shouldUseAiPrompt(aiConfig.mode);
    if (!shouldUseAi) return null;

    const providerReady = await checkAiProviderStatus(aiConfig, logVerbose, (message) => log.warn(message));
    if (!providerReady) return null;

    const resolvedStatus = status ?? (await git.status());
    const aiSpinner = spinner();
    aiSpinner.start("Generating AI commit message");
    // Phase 5: pass warn callback for specific error messages
    const aiCommitMessage = await generateAiCommitMessage(
        git,
        aiConfig,
        commitAll,
        files,
        resolvedStatus,
        logVerbose,
        (message) => log.warn(message),
        knowledgeBase ?? undefined
    );
    if (aiCommitMessage) aiSpinner.stop("AI commit message ready");
    else aiSpinner.stop("AI commit message unavailable. Falling back to manual input.");
    return aiCommitMessage;
};

await ensureGitRepo();

const repoRoot = (await git.revparse(["--show-toplevel"])).trim();
const { globalConfig, projectConfig } = await loadConfigs(repoRoot);
const aiConfig = loadAiConfig(globalConfig, projectConfig);
const knowledgeBaseConfig = mergeKnowledgeConfig({
    ...(globalConfig?.knowledgeBase ?? {}),
    ...(projectConfig?.knowledgeBase ?? {})
});
// Phase 7b: pass info callback (verbose-only since it's non-essential)
const knowledgeBase = await loadKnowledgeBase(knowledgeBaseConfig, (msg) => logVerbose(msg));
const { commitAll, files, status } = await selectCommitTarget(repoRoot);
const aiCommitMessage = await resolveAiCommitMessage(aiConfig, commitAll, files, status, knowledgeBase);

// Phase 6a: clearer prompt wording; push moved out of group for context
const questions = await group(
    {
        title: () => text({
            message: chalk.bold("Commit title:"),
            initialValue: aiCommitMessage?.title,
            validate(value) {
                if (!value || value.length === 0) return "You must write a title!"
            }
        }),
        description: () => text({
            message: chalk.bold("Commit description (optional):"),
            initialValue: aiCommitMessage?.description
        }),
    },
    {
        onCancel: () => {
            cancel(cancelMessage)
            process.exit(0)
        }
    }
)

const { title, description } = questions;

// Phase 6b: title length warning (non-blocking)
if (title.length > 72) {
    log.warn(`Commit title is ${title.length} chars (convention: ≤72). Consider shortening.`);
}

// Phase 6c: push confirm with branch/remote context + detached HEAD check
const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
const remotes = await git.getRemotes();

let push = false;

if (remotes.length > 0) {
    if (branch === "HEAD") {
        log.warn("You are in detached HEAD state. Pushing may fail or produce unexpected results.");
        const proceedWithPush = await confirm({ message: "Continue and attempt push?" });
        if (!isCancel(proceedWithPush) && proceedWithPush) {
            push = true;
        }
    } else {
        const pushConfirm = await confirm({
            message: chalk.bold(`Push to ${remotes[0].name}/${branch}?`)
        });
        if (isCancel(pushConfirm)) {
            cancel(cancelMessage);
            process.exit(0);
        }
        push = pushConfirm;
    }
}

// Phase 1b: track current phase for contextual error messages
let currentPhase: "staging" | "committing" | "pushing" = "staging";
let pushSucceeded = false;

// Proactively check for missing upstream before running tasks to avoid
// tasks() rendering a "Canceled" state during error recovery.
let pushRemote: string | null = null;
let needsUpstream = false;

if (push) {
    try {
        await git.revparse(["--abbrev-ref", "@{u}"]);
    } catch {
        needsUpstream = true;
        log.warn(`There is no upstream branch. Making ${branch} the upstream branch.`);
        const selectedRemote = await select({
            message: "What remote to push to?",
            options: remotes.map(r => ({ label: r.name, value: r.name }))
        });
        if (isCancel(selectedRemote)) {
            cancel(cancelMessage);
            process.exit(0);
        }
        pushRemote = selectedRemote as string;
    }
}

try {
    const taskList: Task[] = [
        {
            title: "Staging",
            task: async () => {
                currentPhase = "staging";
                if (commitAll) await git.add(["--all"]);
                else await git.add(files);
                return "Staging complete";
            },
        },
        {
            title: "Committing",
            task: async () => {
                currentPhase = "committing";
                const msg = description ? [title, description] : title;
                if (commitAll) await git.commit(msg);
                else await git.commit(msg, files);
                return "Commit complete";
            },
        }
    ];

    if (push) taskList.push({
        title: "Pushing",
        task: async () => {
            currentPhase = "pushing";
            if (needsUpstream && pushRemote) {
                await git.push(pushRemote, branch, ["--set-upstream"]);
            } else {
                await git.push();
            }
            pushSucceeded = true;
            return "Push complete";
        },
    });

    await tasks(taskList);
} catch (e) {
    const err = e as GitResponseError<PushResult>;

    // Phase 1b: contextual errors for staging/committing
    if (currentPhase === "staging") {
        log.error(`Staging failed: ${err.message}`);
        cancel("Gita stopped due to a staging error.");
        process.exit(1);
    } else if (currentPhase === "committing") {
        log.error(`Commit failed: ${err.message}`);
        cancel("Gita stopped due to a commit error.");
        process.exit(1);
    } else if (err.message.includes("No configured push destination")) {
        cancel("No remotes available. Cancelling push. Commit is saved. Add a remote, then run git push.");
        process.exit(1); // Phase 1a
    } else {
        log.error(err.message);
        cancel("Gita stopped due to an error.");
        process.exit(1); // Phase 1a
    }
}

// Phase 4: commit summary
try {
    const commitLog = await git.log({ maxCount: 1 });
    const latest = commitLog.latest;
    if (latest) {
        const shortHash = latest.hash.slice(0, 7);
        const summaryLines = [
            `${chalk.green(shortHash)} on ${chalk.cyan(branch)}`,
            latest.message.trim(),
        ];
        if (push && pushSucceeded) {
            summaryLines.push(`Pushed to ${chalk.cyan(remotes[0].name)}`);
        }
        note(summaryLines.join("\n"), "Committed");
    }
} catch {
    // Non-critical — summary display failure should not affect exit
}

outro(chalk.gray("Done."));
