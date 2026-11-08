import { Prompt } from "@clack/core";
import { limitOptions, S_BAR_END, symbol, symbolBar, unicodeOr } from "@clack/prompts";
import type { CommonOptions } from "@clack/prompts";
import chalk from "chalk";
import { FileSelection } from "./file-selection";
import type { ChangedFile, FileRow } from "./file-selection";

type FilePickerOptions = CommonOptions & { files: ChangedFile[] };

// Keep unusual filenames from breaking the tree layout or emitting terminal controls.
const displayPath = (path: string) => /[\x00-\x1f\x7f-\x9f]/.test(path) ? JSON.stringify(path) : path;

const formatStatus = (status: string): string => {
    const code = status.trim();
    if (code.includes("U") || code === "AA" || code === "DD") return chalk.red(status);
    if (code.includes("D")) return chalk.red(status);
    if (code.includes("R")) return chalk.cyan(status);
    if (code.includes("A")) return chalk.green(status);
    if (code.includes("M") || code.includes("T")) return chalk.yellow(status);
    return chalk.dim(status);
};

/** A folder checkbox selects only its changed descendants, including collapsed ones. */
export const selectChangedFiles = async (options: FilePickerOptions): Promise<string[] | symbol> => {
    const selection = new FileSelection(options.files);
    if (selection.files.length === 0) return [];

    const formatRow = ({ node, depth }: FileRow, active: boolean): string => {
        const state = selection.state(node);
        const checkbox = state === "all" ? chalk.green("[x]")
            : state === "some" ? chalk.yellow("[-]") : chalk.dim("[ ]");
        const disclosure = node.kind === "file" ? " "
            : selection.expanded.has(node.path) ? unicodeOr("▾", "v") : unicodeOr("▸", ">");
        const label = displayPath(node.name) + (node.kind === "folder" ? "/" : "");
        const detail = node.kind === "folder"
            ? chalk.dim(`${selection.selectedCount(node)}/${node.files.length}`)
            : formatStatus(node.files[0].status);
        return `${active ? chalk.cyan(">") : " "} ${"  ".repeat(depth)}${checkbox} ${disclosure} ${active ? chalk.cyan(label) : label}  ${detail}`;
    };

    const prompt = new Prompt<string[]>({
        input: options.input,
        output: options.output,
        signal: options.signal,
        validate: (value) => value?.length ? undefined : "Select at least one file or folder with Space.",
        render() {
            const heading = `${symbol(this.state)}  Select changed files or folders`;
            const bar = symbolBar(this.state);
            if (this.state === "cancel") return `${heading}\n${bar}  ${chalk.dim("Selection canceled.")}`;
            if (this.state === "submit") {
                const count = selection.selected.size;
                return `${heading}\n${bar}  ${chalk.dim(`${count} ${count === 1 ? "file" : "files"} selected`)}`;
            }

            const rows = selection.rows;
            const focusedPath = rows[selection.cursor]?.node.path ?? "";
            const body = limitOptions({
                options: rows,
                cursor: selection.cursor,
                maxItems: 12,
                output: options.output,
                columnPadding: 3,
                rowPadding: 10,
                style: formatRow
            }).map((line) => `${bar}  ${line}`);

            return [
                heading,
                `${bar}  ${chalk.dim("Folders select all changed files inside. [-] = partly selected.")}`,
                `${bar}`,
                ...body,
                `${bar}`,
                `${bar}  ${chalk.bold(`${selection.selected.size} of ${selection.files.length} files selected`)}`,
                `${bar}  ${chalk.dim(displayPath(focusedPath))}`,
                `${bar}  ${chalk.dim("↑/↓ Move · ←/→ Open/close · Space Select")}`,
                `${bar}  ${chalk.dim("a All/none · Enter Continue · Esc Cancel")}`,
                this.state === "error" ? `${bar}  ${chalk.yellow(this.error)}` : undefined,
                chalk.gray(S_BAR_END)
            ].filter((line) => line !== undefined).join("\n");
        }
    }, false);

    prompt.value = [];
    prompt.on("cursor", (action) => {
        if (action === "up" || action === "down" || action === "left" || action === "right" || action === "space") {
            selection.navigate(action);
            prompt.value = selection.selectedFiles;
        }
    });
    prompt.on("key", (char, key) => {
        if (key.ctrl || key.meta) return;
        if (char === "a") selection.toggleAll();
        if (key.name === "home" || key.name === "end") selection.navigate(key.name);
        if (char === "　" && !key.name) selection.navigate("space");
        prompt.value = selection.selectedFiles;
    });

    return await prompt.prompt() ?? [];
};
