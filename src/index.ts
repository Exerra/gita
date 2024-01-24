#! /usr/bin/env bun

import { cancel, group, intro, outro, select, text, confirm, spinner} from "@clack/prompts";
import simpleGit from "simple-git";

const git = simpleGit({
    baseDir: process.cwd(),
    binary: "git",
    maxConcurrentProcesses: 6,
    trimmed: false
})

intro("Gita by Exerra")

const questions = await group(
    {
        file: () => text({
            message: "What file(s) do you wish to commit?",
            placeholder: ".",
            initialValue: ".",
            validate(value) {
                if (value.length === 0) return "You must select a file/files!"
            }
        }),
        title: () => text({
            message: "What will be the title?",
            validate(value) {
                if (value.length === 0) return "You must write a title!"
            }
        }),
        description: () => text({
            message: "What will be the description? (leave blank for no desc.)"
        }),
        push: () => confirm({
            message: "Do you want to push?"
        })
    },
    {
        onCancel: ({ results }) => {
            cancel("Gita stopped.")
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
} catch (e) {
    console.log(e)
    throw new Error("Problem whilst committing", e || "")

    cancel("Gita stopped.")
}

if (push) {
    s.message("Pushing...")
    
    await git.push()
}

s.stop()

outro("Thanks for using Gita!")