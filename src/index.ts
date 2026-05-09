#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, spinner, path, tasks, Task, log, isCancel } from "@clack/prompts";
import chalk from "chalk";
import simpleGit, { GitResponseError, PushResult } from "simple-git";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const packageJsonPath = resolve(currentDir, "../package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
const version = packageJson.version ?? "0.0.0";

const baseDir = process.cwd()

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
        cancel("Gita stopped by user action.")
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

let file = ""

const commitAll = await confirm({ message: "Commit all?" })

if (isCancel(commitAll)) {
    cancel("Gita stopped by user action. No commit has been made.")
    process.exit(0)
}

if (commitAll) file = "."
else {
    const selectedPath = await path({
        message: 'Select a file:',
        root: baseDir, // Starting directory
        directory: false, // Set to true to only show directories
    });

    if (isCancel(selectedPath)) {
        cancel("Gita stopped by user action. No commit has been made.")
        process.exit(0)
    }

    file = selectedPath as string
}


const questions = await group(
    {
        title: () => text({
            message: chalk.bold("What will be the title?"),
            validate(value) {
                if (!value || value.length === 0) return "You must write a title!"
            }
        }),
        description: () => text({
            message: chalk.bold("What will be the description? (leave blank for no desc.)")
        }),
        push: () => confirm({
            message: chalk.bold("Do you want to push?")
        })
    },
    {
        onCancel: ({ results }) => {
            cancel("Gita stopped by user action. No commit has been made.")
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
