#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, tasks, Task, log, isCancel, spinner } from "@clack/prompts";
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
    return mergeAiConfig(globalConfig, projectConfig, cliAiMode);
};

const selectCommitTarget = async (repoRoot: string) => {
    const commitAll = await confirm({ message: "Commit all?" });

    if (isCancel(commitAll)) {
        cancel(cancelMessage);
        process.exit(0);
    }

    if (commitAll) return { commitAll, file: ".", status: null as StatusResult | null };

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

    const selectedFile = await select({
        message: "Select a file:",
        options: fileOptions
    });

    if (isCancel(selectedFile)) {
        cancel(cancelMessage);
        process.exit(0);
    }

    return { commitAll, file: selectedFile as string, status };
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
    file: string,
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
    const aiCommitMessage = await generateAiCommitMessage(
        git,
        aiConfig,
        commitAll,
        file,
        resolvedStatus,
        logVerbose,
        knowledgeBase ?? undefined
    );
    if (aiCommitMessage) aiSpinner.stop("AI commit message ready");
    else aiSpinner.stop("AI commit message unavailable");
    if (!aiCommitMessage) {
        logVerbose("AI output unavailable. Falling back to manual input.");
        log.warn("AI commit message unavailable. Falling back to manual input.");
    }
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
const knowledgeBase = await loadKnowledgeBase(knowledgeBaseConfig);
const { commitAll, file, status } = await selectCommitTarget(repoRoot);
const aiCommitMessage = await resolveAiCommitMessage(aiConfig, commitAll, file, status, knowledgeBase);

const questions = await group(
    {
        title: () => text({
            message: chalk.bold("What will be the title?"),
            initialValue: aiCommitMessage?.title,
            validate(value) {
                if (!value || value.length === 0) return "You must write a title!"
            }
        }),
        description: () => text({
            message: chalk.bold("What will be the description? (leave blank for no desc.)"),
            initialValue: aiCommitMessage?.description
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

let { title, description, push } = questions;

if (push) {
    const remotes = await git.getRemotes();
    if (remotes.length === 0) {
        log.warn("No remotes configured. Skipping push.");
        push = false;
    }
}

try {
    let taskList: Task[] = [
        {
            title: "Staging",
            task: async () => {
                if (commitAll) await git.add(["--all"]);
                else await git.add(file);

                return "Staging complete";
            },
        },
        {
            title: "Committing",
            task: async () => {
                if (commitAll) await git.commit(description ? [title, description] : title);
                else await git.commit(description ? [title, description] : title, file);

                return "Commit complete";
            },
        }
    ];

    if (push) taskList.push({
        title: "Pushing",
        task: async () => {
            await git.push();
            return "Push complete";
        },
    });

    await tasks(taskList);
} catch (e) {
    const err = e as GitResponseError<PushResult>;

    if (err.message.includes("No configured push destination")) {
        cancel("No remotes available. Cancelling push. Commit is saved. Add a remote, then run git push.");
        process.exit(1);
    }
    else if (err.message.toLowerCase().includes("no upstream branch")) {
        try {
            const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]);
            log.warn(`There is no upstream branch. Making ${currentBranch} the upstream branch.`);
            const remotes = await git.getRemotes();

            const remote = await select({
                message: "What remote to push to?",
                options: remotes.map(remote => ({ label: remote.name, value: remote.name }))
            });

            await git.push(remote as string, currentBranch, ["--set-upstream"]);
        } catch (e) {
            const err2 = e as GitResponseError<PushResult>;

            log.error(err2.message);
            cancel("Gita stopped due to an error.");
        }
    } else {
        log.error(err.message);
        cancel("Gita stopped due to an error.");
    }
}

outro(chalk.gray("Thanks for using Gita!"));
