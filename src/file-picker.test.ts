import { describe, expect, test } from "bun:test";
import { isCancel } from "@clack/prompts";
import type { Key } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import simpleGit from "simple-git";
import { selectChangedFiles } from "./file-picker";
import { FileSelection } from "./file-selection";
import type { ChangedFile } from "./file-selection";

const files = [
    { path: "src/nested/first.ts", status: " M" },
    { path: "src/nested/second.ts", status: " D" },
    { path: "README.md", status: "??" }
];

const picker = (entries: ChangedFile[] = files, rows = 24) => {
    const input = new PassThrough();
    let outputText = "";
    const output = Object.assign(new Writable({
        write(chunk, _encoding, callback) { outputText += chunk.toString(); callback(); }
    }), { columns: 80, rows });
    const result = selectChangedFiles({ files: entries, input, output });
    return {
        result,
        press: (name: string, char?: string, extra?: Partial<Key>) => input.emit("keypress", char, { name, ...extra }),
        text: () => Bun.stripANSI(outputText),
        input
    };
};

describe("terminal file picker", () => {
    test("Space selects folders, individual exclusions show mixed state, Enter returns exact leaves", async () => {
        const ui = picker();
        ui.press("space", " ");
        expect(ui.text()).toContain("2 of 3 files selected");
        ui.press("right"); // nested folder
        ui.press("right"); // open nested folder
        ui.press("right"); // first file
        ui.press("space", " ");
        expect(ui.text()).toContain("[-]");
        expect(ui.text()).toContain("1 of 3 files selected");
        ui.press("return", "\r");
        expect(await ui.result).toEqual(["src/nested/second.ts"]);
        expect(ui.input.listenerCount("keypress")).toBe(0);
    });

    test("Enter with no selection shows an error and keeps the picker open", async () => {
        const ui = picker();
        ui.press("return", "\r");
        expect(ui.text()).toContain("Select at least one file or folder with Space.");
        ui.press("a", "a");
        ui.press("return", "\r");
        expect(await ui.result).toEqual(files.map((file) => file.path));
    });

    test("all/none shortcut clears selection, and Escape or Ctrl+C cancels", async () => {
        for (const name of ["escape", "c"]) {
            const ui = picker();
            ui.press("a", "a");
            ui.press("a", "a");
            expect(ui.text()).toContain("0 of 3 files selected");
            ui.press(name, name === "c" ? "\x03" : "\x1b", { ctrl: name === "c" });
            expect(isCancel(await ui.result)).toBe(true);
            expect(ui.input.listenerCount("keypress")).toBe(0);
        }
    });

    test("long lists keep the focused file visible when scrolling in a short terminal", async () => {
        const entries = Array.from({ length: 40 }, (_, i) => ({ path: `src/file-${i}.ts`, status: "??" }));
        const ui = picker(entries, 16);
        ui.press("end");
        expect(ui.text()).toContain("src/file-39.ts");
        ui.press("space", " ");
        ui.press("home");
        ui.press("left"); // collapse src without losing its selected descendant
        ui.press("return", "\r");
        expect(await ui.result).toEqual(["src/file-39.ts"]);
    });

    test("escapes control characters in filenames and handles an empty list", async () => {
        const ui = picker([{ path: "bad\nfile\x1b.txt", status: "??" }]);
        expect(ui.text()).toContain('"bad\\nfile\\u001b.txt"');
        ui.press("space", " ");
        ui.press("return", "\r");
        expect(await ui.result).toEqual(["bad\nfile\x1b.txt"]);
        expect(await selectChangedFiles({ files: [] })).toEqual([]);
    });
});

test("new folder contents are individually selectable and stage correctly from a subdirectory", async () => {
    const root = await mkdtemp(join(tmpdir(), "gita-picker-"));
    try {
        await mkdir(join(root, "new folder/nested"), { recursive: true });
        await mkdir(join(root, "work"));
        await Bun.write(join(root, ".gitignore"), "ignored.txt\n");
        await Bun.write(join(root, "new folder/nested/first file.txt"), "first");
        await Bun.write(join(root, "new folder/second.txt"), "second");
        await Bun.write(join(root, "new folder/ignored.txt"), "ignored");
        const git = simpleGit(root);
        await git.init();
        const cwd = join(root, "work");
        const subdirGit = simpleGit(cwd);
        const status = await subdirGit.status(["--untracked-files=all"]);
        expect(status.not_added).toContain("new folder/nested/first file.txt");
        expect(status.not_added).not.toContain("new folder/ignored.txt");
        const selection = new FileSelection(status.files.map((file) => ({ path: file.path, status: "??" })));
        const folder = selection.roots.find((node) => node.path === "new folder")!;
        selection.toggle(folder);
        expect(selection.selectedFiles).toEqual(["new folder/nested/first file.txt", "new folder/second.txt"]);
        // Exclude a file after selecting its parent, then stage the exact remaining leaf.
        selection.toggle(folder.children.find((node) => node.path === "new folder/second.txt")!);
        const paths = selection.selectedFiles.map((file) => relative(cwd, resolve(root, file)));
        await subdirGit.add(paths);
        expect((await git.diff(["--cached", "--name-only"])).trim()).toBe("new folder/nested/first file.txt");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
