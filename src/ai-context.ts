import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import simpleGit, { type SimpleGit, type StatusResult } from "simple-git";

export const literalPathspecs = (files: string[]) => files.map((file) => `:(literal)${file}`);

export const includeRenameSources = (files: string[], status: StatusResult | null) => {
    const paths = new Set(files);
    for (const rename of status?.renamed ?? []) {
        // A recreated source is a separate picker entry and needs its own selection.
        const sourceHasOwnEntry = status?.files.some((file) => file.path === rename.from);
        if (paths.has(rename.to) && !sourceHasOwnEntry) paths.add(rename.from);
    }
    return [...paths];
};

const repositoryPaths = async (git: SimpleGit, files: string[]) => {
    const root = (await git.revparse(["--show-toplevel"])).replace(/\r?\n$/, "");
    const prefix = (await git.revparse(["--show-prefix"])).replace(/\r?\n$/, "");
    return { root, paths: files.map((file) => relative(root, resolve(root, prefix, file))) };
};

/** Already-staged deletions have no index entry and must not be passed to git add. */
export const stageSelectedFiles = async (git: SimpleGit, files: string[]) => {
    if (files.length === 0) return;
    const { paths } = await repositoryPaths(git, files);
    const selected = new Set(paths);
    const candidates = await git.raw([
        "ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z", "--",
        ...literalPathspecs(files)
    ]);
    const stageable = [...new Set(candidates.split("\0").filter((file) => selected.has(file)))];
    if (stageable.length) {
        await git.add(["--all", "--", ...stageable.map((file) => `:(top,literal)${file}`)]);
    }
};

/** Build the prospective commit without touching the user's index or working tree. */
export const collectAiContext = async (
    git: SimpleGit,
    commitAll: boolean,
    files: string[],
    status: StatusResult | null
) => {
    if (!commitAll && files.length === 0) throw new Error("No files selected for AI context.");

    const { root, paths: selectedPaths } = await repositoryPaths(git, files);
    const paths = includeRenameSources(selectedPaths, status);

    const temporaryDir = await mkdtemp(join(tmpdir(), "gita-ai-index-"));
    try {
        const indexPath = join(temporaryDir, "index");
        const preview = simpleGit({ baseDir: root, trimmed: false }).env({
            ...process.env,
            GIT_INDEX_FILE: indexPath
        });
        // Preserve tracked additions even if they now match an ignore rule.
        const originalIndex = (await git.revparse(["--path-format=absolute", "--git-path", "index"]))
            .replace(/\r?\n$/, "");
        try {
            await copyFile(originalIndex, indexPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await preview.raw(["read-tree", "--empty"]);
        }
        const head = await preview.raw(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
        if (commitAll) await preview.add(["--all"]);
        else await stageSelectedFiles(preview, paths);

        // External diff tools, text conversions, and copy detection may read other files.
        const args = ["--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--submodule=short"];
        if (head.trim()) args.push(head.trim());
        // The copied index can contain unrelated staged changes. Scope every output.
        const scope = commitAll ? [] : ["--", ...literalPathspecs(paths)];
        const statusSummary = await preview.diff([...args, "--name-status", ...scope]);
        const diffStat = await preview.diff([...args, "--stat", ...scope]);
        const diff = await preview.diff([...args, ...scope]);
        return { statusSummary, diffStat, diff };
    } finally {
        await rm(temporaryDir, { recursive: true, force: true });
    }
};
