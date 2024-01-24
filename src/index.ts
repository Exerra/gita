#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, spinner} from "@clack/prompts";
import chalk from "chalk";
import simpleGit from "simple-git";

const git = simpleGit({
    baseDir: process.cwd(),
    binary: "git",
    maxConcurrentProcesses: 6,
    trimmed: false
})

intro(`${chalk.bold.green("Gita")} by ${chalk.bold("Exerra")}`)

const questions = await group(
    {
        file: () => text({
            message: chalk.bold("What file do you wish to commit?"),
            placeholder: ".",
            initialValue: ".",
            validate(value) {
                if (value.length === 0) return "You must select a file/files!"
            }
        }),
        title: () => text({
            message: chalk.bold("What will be the title?"),
            validate(value) {
                if (value.length === 0) return "You must write a title!"
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
            cancel("Gita stopped by user action.")
            process.exit(0)
        }
    }
)

let { file, title, description, push } = questions

const s = spinner()

s.start("Committing...")

try {
    await git.init()

    await git.add(file)

    await git.commit(title, file)

    if (push) {
        s.message("Pushing...")
        
        await git.push()
    }
} catch (e) {
    console.log(e)
    throw new Error("Problem with Git", e || "")

    cancel("Gita stopped .")
}

s.stop()

outro("Thanks for using Gita!")