export type ChangedFile = {
    path: string;
    status: string;
};

export type FileNode = {
    name: string;
    path: string;
    kind: "file" | "folder";
    parent?: FileNode;
    children: FileNode[];
    files: ChangedFile[];
};

export type FileRow = { node: FileNode; depth: number };
export type SelectionState = "none" | "some" | "all";

/** Selection is always stored as exact file paths, even when a folder is toggled. */
export class FileSelection {
    readonly roots: FileNode[] = [];
    readonly selected = new Set<string>();
    readonly expanded = new Set<string>();
    readonly files: ChangedFile[];
    cursor = 0;

    constructor(files: ChangedFile[]) {
        this.files = [...new Map(files.map((file) => [file.path, file])).values()];
        const folders = new Map<string, FileNode>();

        for (const file of this.files) {
            const parts = file.path.split("/");
            let parent: FileNode | undefined;
            for (let index = 0; index < parts.length; index += 1) {
                const path = parts.slice(0, index + 1).join("/");
                const isFolder = index < parts.length - 1;
                let node = isFolder ? folders.get(path) : undefined;
                if (!node) {
                    node = {
                        name: parts[index], path, kind: isFolder ? "folder" : "file",
                        parent, children: [], files: []
                    };
                    (parent?.children ?? this.roots).push(node);
                    if (isFolder) folders.set(path, node);
                }
                node.files.push(file);
                parent = node;
            }
        }

        const sort = (nodes: FileNode[]) => {
            nodes.sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { numeric: true });
            });
            for (const node of nodes) sort(node.children);
        };
        sort(this.roots);
        // Show files in top-level folders immediately; keep deeper folders compact.
        for (const node of this.roots) {
            if (node.kind === "folder") this.expanded.add(node.path);
        }
    }

    get rows(): FileRow[] {
        const rows: FileRow[] = [];
        const visit = (nodes: FileNode[], depth: number) => {
            for (const node of nodes) {
                rows.push({ node, depth });
                if (this.expanded.has(node.path)) visit(node.children, depth + 1);
            }
        };
        visit(this.roots, 0);
        return rows;
    }

    get selectedFiles(): string[] {
        return this.files.filter((file) => this.selected.has(file.path)).map((file) => file.path);
    }

    selectedCount(node: FileNode): number {
        return node.files.filter((file) => this.selected.has(file.path)).length;
    }

    state(node: FileNode): SelectionState {
        const count = this.selectedCount(node);
        return count === 0 ? "none" : count === node.files.length ? "all" : "some";
    }

    toggle(node: FileNode): void {
        const deselect = this.state(node) === "all";
        for (const file of node.files) {
            if (deselect) this.selected.delete(file.path);
            else this.selected.add(file.path);
        }
    }

    toggleAll(): void {
        if (this.selected.size === this.files.length) this.selected.clear();
        else for (const file of this.files) this.selected.add(file.path);
    }

    navigate(action: "up" | "down" | "left" | "right" | "space" | "home" | "end"): void {
        const rows = this.rows;
        const current = rows[this.cursor]?.node;
        if (!current) return;

        switch (action) {
            case "up": this.cursor = Math.max(0, this.cursor - 1); break;
            case "down": this.cursor = Math.min(rows.length - 1, this.cursor + 1); break;
            case "home": this.cursor = 0; break;
            case "end": this.cursor = rows.length - 1; break;
            case "space": this.toggle(current); break;
            case "right":
                if (current.kind === "folder") {
                    if (this.expanded.has(current.path)) this.cursor += 1;
                    else this.expanded.add(current.path);
                }
                break;
            case "left":
                if (current.kind === "folder" && this.expanded.has(current.path)) {
                    this.expanded.delete(current.path);
                } else if (current.parent) {
                    this.cursor = rows.findIndex(({ node }) => node === current.parent);
                }
                break;
        }
    }
}
