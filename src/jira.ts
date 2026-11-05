import type { JiraRuntimeConfig } from "./types";

export const extractJiraIssueIds = (branch: string): string[] => {
    const matches = branch.matchAll(/(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]*-\d+(?![A-Za-z0-9_])/g);
    return [...new Set(Array.from(matches, ([match]) => match))];
};

export const formatCommitTitle = (title: string, branch: string, config: JiraRuntimeConfig): string => {
    if (!config.enabled) return title;

    const tickets = extractJiraIssueIds(branch);
    if (tickets.length === 0) return title;

    // A single replacement pass keeps placeholder-like text in the title literal.
    return config.template.replace(/%ticket%|%title%/g, (placeholder) =>
        placeholder === "%ticket%" ? tickets.join(", ") : title
    );
};
