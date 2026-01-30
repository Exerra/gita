#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, spinner, path, tasks, Task} from "@clack/prompts";
import chalk from "chalk";
import simpleGit from "simple-git";

const baseDir = process.cwd()

const git = simpleGit({
    baseDir: baseDir,
    binary: "git",
    maxConcurrentProcesses: 6,
    trimmed: false
})

intro(`${chalk.bold.green("Gita")} by ${chalk.bold("Exerra")}`)

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
    console.log(e)
    throw new Error("Problem with Git", e || "")

    cancel("Gita stopped .")
}

outro("Thanks for using Gita!")