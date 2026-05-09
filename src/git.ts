import type { StatusResult } from "simple-git";

export const formatStatusSummary = (status: StatusResult): string => {
    const lines: string[] = [];

    if (status.modified.length) lines.push(`modified: ${status.modified.join(", ")}`);
    if (status.created.length) lines.push(`created: ${status.created.join(", ")}`);
    if (status.deleted.length) lines.push(`deleted: ${status.deleted.join(", ")}`);
    if (status.not_added.length) lines.push(`untracked: ${status.not_added.join(", ")}`);
    if (status.renamed.length) {
        const renamed = status.renamed.map(({ from, to }) => `${from} -> ${to}`);
        lines.push(`renamed: ${renamed.join(", ")}`);
    }

    return lines.join("\n");
};
