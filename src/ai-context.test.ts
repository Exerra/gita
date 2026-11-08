import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { includeRenameSources, literalPathspecs, stageSelectedFiles } from "./ai-context";
import { generateAiCommitMessage } from "./ai";
import { defaultAiConfig } from "./config";

describe("AI file selection boundaries", () => {
    let root: string;
    let git: SimpleGit;
    let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
    let requestBody: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "gita-ai-test-"));
        git = simpleGit({ baseDir: root, trimmed: false });
        await git.init();
        await git.addConfig("user.name", "Gita Test");
        await git.addConfig("user.email", "test@example.invalid");
        await git.addConfig("core.hooksPath", "/dev/null");
        requestBody = "";
        fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url, options) => {
            requestBody = String(options?.body);
            return Response.json({ choices: [{ message: { content: '{"title":"test selected changes"}' } }] });
        }) as typeof fetch);
    });

    afterEach(async () => {
        fetchMock.mockRestore();
        await rm(root, { recursive: true, force: true });
    });

    const write = async (path: string, content: string) => Bun.write(join(root, path), content);
    const baseline = async (files: string[]) => {
        for (const file of files) await write(file, `original ${file}\n`);
        await git.add(["--all"]);
        await git.commit("baseline");
    };
    const generate = async (files: string[], commitAll = false, instance = git) => {
        const status = await instance.status(["--untracked-files=all"]);
        const result = await generateAiCommitMessage(instance, {
            ...defaultAiConfig, model: "test", maxRetries: 0
        }, commitAll, files, status, () => {}, () => {});
        expect(result?.title).toBe("test selected changes");
        return JSON.parse(requestBody).messages[1].content as string;
    };

    test("unchecked tracked, staged, and untracked paths never enter the outgoing request", async () => {
        await baseline(["selected.txt", "unchecked.txt", "private-staged.txt"]);
        await write("selected.txt", "SELECTED_CONTENT\n");
        await write("unchecked.txt", "UNCHECKED_CONTENT\n");
        await write("private-staged.txt", "PRIVATE_STAGED_CONTENT\n");
        await git.add(["private-staged.txt"]);
        await write("private-untracked.txt", "PRIVATE_UNTRACKED_CONTENT\n");
        const prompt = await generate(["selected.txt"]);
        expect(prompt).toContain("SELECTED_CONTENT");
        for (const text of ["unchecked.txt", "UNCHECKED_CONTENT", "private-staged.txt", "PRIVATE_STAGED_CONTENT",
            "private-untracked.txt", "PRIVATE_UNTRACKED_CONTENT"]) expect(prompt).not.toContain(text);
    });

    test("includes final staged and unstaged contents, additions, and deletions without changing the real index", async () => {
        await baseline(["staged.txt", "mixed.txt", "deleted.txt", "unchecked.txt"]);
        await write("staged.txt", "STAGED_CONTENT\n");
        await write("mixed.txt", "INTERMEDIATE_CONTENT\n");
        await git.add(["staged.txt", "mixed.txt"]);
        await write("mixed.txt", "FINAL_CONTENT\n");
        await rm(join(root, "deleted.txt"));
        await write("new.txt", "NEW_CONTENT\n");
        const indexPath = join(root, ".git/index");
        const before = await Bun.file(indexPath).bytes();
        const prompt = await generate(["staged.txt", "mixed.txt", "deleted.txt", "new.txt"]);
        for (const text of ["STAGED_CONTENT", "FINAL_CONTENT", "NEW_CONTENT", "-original deleted.txt"]) {
            expect(prompt).toContain(text);
        }
        expect(prompt).not.toContain("INTERMEDIATE_CONTENT");
        expect(await Bun.file(indexPath).bytes()).toEqual(before);
    });

    test("literal brackets, asterisks, question marks, and pathspec-looking names cannot select neighbors", async () => {
        const selected = ["[ab].ts", "*.txt", "?.md", ":(glob)*.json"];
        const unchecked = ["a.ts", "private.txt", "x.md", "private.json"];
        await baseline([...selected, ...unchecked]);
        for (const file of selected) await write(file, `SELECTED ${file}\n`);
        for (const file of unchecked) await write(file, `PRIVATE ${file}\n`);
        const prompt = await generate(selected);
        for (const file of selected) expect(prompt).toContain(`SELECTED ${file}`);
        for (const file of unchecked) expect(prompt).not.toContain(file);
        // The same literal paths are used for the eventual stage and commit.
        await stageSelectedFiles(git, selected);
        await git.commit("selected only", literalPathspecs(selected));
        const committed = await git.raw(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
        for (const file of unchecked) expect(committed).not.toContain(file);
        expect((await git.status()).modified.sort()).toEqual(unchecked.sort());
    });

    test("resolves selected paths from subdirectories and includes outside paths only when selected", async () => {
        await baseline(["work/[ab].ts", "work/a.ts", "outside.txt", "private.txt"]);
        for (const file of ["work/[ab].ts", "work/a.ts", "outside.txt", "private.txt"]) {
            await write(file, `CHANGED ${file}\n`);
        }
        const prompt = await generate(["[ab].ts", "../outside.txt"], false, simpleGit(join(root, "work")));
        expect(prompt).toContain("CHANGED work/[ab].ts");
        expect(prompt).toContain("CHANGED outside.txt");
        expect(prompt).not.toContain("work/a.ts");
        expect(prompt).not.toContain("private.txt");
    });

    test("initial commits include selected untracked files and do not create a real index", async () => {
        await write("selected.txt", "FIRST_COMMIT_CONTENT\n");
        await write("unchecked.txt", "PRIVATE_CONTENT\n");
        const prompt = await generate(["selected.txt"]);
        expect(prompt).toContain("FIRST_COMMIT_CONTENT");
        expect(prompt).not.toContain("unchecked.txt");
        expect(await Bun.file(join(root, ".git/index")).exists()).toBe(false);
    });

    test("staged new files are still included after becoming ignored", async () => {
        await baseline(["baseline.txt"]);
        await write("selected.txt", "STAGED_NEW_CONTENT\n");
        await write("private.txt", "UNCHECKED_STAGED_CONTENT\n");
        await git.add(["selected.txt", "private.txt"]);
        await write(".gitignore", "selected.txt\nprivate.txt\n");
        const prompt = await generate(["selected.txt"]);
        expect(prompt).toContain("STAGED_NEW_CONTENT");
        expect(prompt).not.toContain("UNCHECKED_STAGED_CONTENT");
        expect(prompt).not.toContain("private.txt");
    });

    test("already-staged deletions can be previewed and committed independently", async () => {
        await baseline(["selected.txt", "private.txt"]);
        await git.rm(["selected.txt"]);
        await write("private.txt", "UNCHECKED_STAGED_CONTENT\n");
        await git.add(["private.txt"]);
        const prompt = await generate(["selected.txt"]);
        expect(prompt).toContain("-original selected.txt");
        expect(prompt).not.toContain("private.txt");
        await stageSelectedFiles(git, ["selected.txt"]);
        await git.commit("selected deletion", literalPathspecs(["selected.txt"]));
        expect((await git.status()).staged).toEqual(["private.txt"]);
    });

    test("stage-all includes changes across the repository and excludes ignored files", async () => {
        await baseline(["work/selected.txt", "outside.txt", "deleted.txt"]);
        await write("work/selected.txt", "SELECTED_CONTENT\n");
        await write("outside.txt", "OUTSIDE_CONTENT\n");
        await git.add(["outside.txt"]);
        await rm(join(root, "deleted.txt"));
        await write("new.txt", "NEW_CONTENT\n");
        await write(".gitignore", "ignored.txt\n");
        await write("ignored.txt", "IGNORED_SECRET\n");
        const prompt = await generate(["."], true, simpleGit(join(root, "work")));
        for (const text of ["SELECTED_CONTENT", "OUTSIDE_CONTENT", "NEW_CONTENT", "-original deleted.txt"]) {
            expect(prompt).toContain(text);
        }
        expect(prompt).not.toContain("IGNORED_SECRET");
    });

    test("selected renames include their source and exclude unrelated renames", async () => {
        await baseline(["before.txt", "private-before.txt"]);
        await git.mv("before.txt", "after.txt");
        await git.mv("private-before.txt", "private-after.txt");
        const status = await git.status(["--untracked-files=all"]);
        expect(includeRenameSources(["after.txt"], status)).toEqual(["after.txt", "before.txt"]);
        const prompt = await generate(["after.txt"]);
        expect(prompt).toContain("before.txt");
        expect(prompt).toContain("after.txt");
        expect(prompt).not.toContain("private-before.txt");
        expect(prompt).not.toContain("private-after.txt");
        const paths = includeRenameSources(["after.txt"], status);
        await stageSelectedFiles(git, paths);
        await git.commit("selected rename", literalPathspecs(paths));
        const tree = await git.raw(["ls-tree", "--name-only", "HEAD"]);
        expect(tree).toContain("after.txt");
        expect(tree).not.toMatch(/^before.txt$/m);
        expect(tree).toContain("private-before.txt");
    });

    test("empty selections fall back without sending a request", async () => {
        const result = await generateAiCommitMessage(git, { ...defaultAiConfig, model: "test", maxRetries: 0 },
            false, [], await git.status(), () => {}, () => {});
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("recreating a renamed source does not include its unchecked contents", async () => {
        await baseline(["before.txt"]);
        await git.mv("before.txt", "after.txt");
        await write("before.txt", "UNCHECKED_RECREATED_CONTENT\n");
        const status = await git.status(["--untracked-files=all"]);
        expect(includeRenameSources(["after.txt"], status)).toEqual(["after.txt"]);
        const prompt = await generate(["after.txt"]);
        expect(prompt).not.toContain("UNCHECKED_RECREATED_CONTENT");
        const paths = includeRenameSources(["after.txt"], status);
        await stageSelectedFiles(git, paths);
        await git.commit("selected destination", literalPathspecs(paths));
        expect(await git.show(["HEAD:before.txt"])).not.toContain("UNCHECKED_RECREATED_CONTENT");
    });

    test("symlinks include the link itself without reading the unselected target", async () => {
        await write("private.txt", "PRIVATE_TARGET_CONTENT\n");
        await symlink("private.txt", join(root, "selected-link"));
        const prompt = await generate(["selected-link"]);
        expect(prompt).toContain("120000");
        expect(prompt).not.toContain("PRIVATE_TARGET_CONTENT");
    });

    test("disables external diffs and text conversions", async () => {
        await baseline(["selected.txt"]);
        await write(".gitattributes", "selected.txt diff=private\n");
        await git.add([".gitattributes"]);
        await git.commit("attributes");
        await git.addConfig("diff.external", "false");
        await git.addConfig("diff.private.textconv", "echo PRIVATE_CONVERSION_CONTENT");
        await write("selected.txt", "SELECTED_CONTENT\n");
        const prompt = await generate(["selected.txt"]);
        expect(prompt).toContain("SELECTED_CONTENT");
        expect(prompt).not.toContain("PRIVATE_CONVERSION_CONTENT");
    });
});
