#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, spinner, path, tasks, Task, log } from "@clack/prompts";
import chalk from "chalk";
import simpleGit, { GitResponseError, PushResult } from "simple-git";

const version = "0.0.3"

const baseDir = process.cwd()

const git = simpleGit({
    baseDir: baseDir,
    binary: "git",
    maxConcurrentProcesses: 6,
    trimmed: false
})

intro(`${chalk.bold.green("Gita")} ${chalk.gray("(v" + version + ")")} by ${chalk.bold("Exerra")}`)

let file = ""

const commitAll = await confirm({ message: "Commit all?" })

if (commitAll) file = "."
else {
    const selectedPath = await path({
        message: 'Select a file:',
        root: baseDir, // Starting directory
        directory: false, // Set to true to only show directories
    });

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

try {
    let taskList: Task[] = [
        {
            title: 'Initialising Git',
            task: async () => {
                await git.init()
                return 'Git initialised';
            },
        },
        {
            title: "Committing",
            task: async () => {
                await git.commit(description ? [title, description] : title, file)
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
    }
    // usually happens when a new git repo is made
    else if (err.message.includes("Committingfatal: The current branch main has no upstream branch.") || err.message.includes("fatal: The current branch main has no upstream branch.")) {
        try {
            log.warn("There is no upstream branch. Making main the upstream branch.")
            const remotes = await git.getRemotes()

            const remote = await select({
                message: "What remote to push to?",
                options: remotes.map(remote => ({ label: remote.name, value: remote.name }))
            })

            await git.push(remote as string, "main", ["--set-upstream"])
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