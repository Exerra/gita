import { describe, expect, test } from "bun:test";
import { FileSelection } from "./file-selection";

const files = [
    { path: "README.md", status: " M" },
    { path: "src/index.ts", status: " M" },
    { path: "src/ui/picker.ts", status: "??" },
    { path: "src/ui/picker.test.ts", status: "??" },
    { path: "src-old/deleted.ts", status: " D" },
    { path: ".gita/config.json", status: "A " }
];

describe("folder and file selection", () => {
    test("groups paths into a sorted tree with top-level folders open", () => {
        const selection = new FileSelection([...files, files[0]]);
        expect(selection.roots.map((node) => node.path)).toEqual([".gita", "src", "src-old", "README.md"]);
        expect(selection.files).toHaveLength(6);
        expect(selection.rows.map(({ node, depth }) => [node.path, depth])).toEqual([
            [".gita", 0], [".gita/config.json", 1],
            ["src", 0], ["src/ui", 1], ["src/index.ts", 1],
            ["src-old", 0], ["src-old/deleted.ts", 1], ["README.md", 0]
        ]);
    });

    test("selecting a collapsed folder includes all descendants and no sibling prefixes", () => {
        const selection = new FileSelection(files);
        const src = selection.roots.find((node) => node.path === "src")!;
        selection.expanded.delete("src");
        selection.toggle(src);
        expect(selection.selectedFiles).toEqual(["src/index.ts", "src/ui/picker.ts", "src/ui/picker.test.ts"]);
        expect(selection.state(src)).toBe("all");
        expect(selection.state(src.children[0])).toBe("all");
        selection.toggle(src);
        expect(selection.selectedFiles).toEqual([]);
    });

    test("individual exclusions update all ancestors; toggling a mixed folder selects the rest", () => {
        const selection = new FileSelection(files);
        const src = selection.roots.find((node) => node.path === "src")!;
        const ui = src.children.find((node) => node.path === "src/ui")!;
        const picker = ui.children.find((node) => node.path === "src/ui/picker.ts")!;
        selection.toggle(src);
        selection.toggle(picker);
        expect(selection.state(src)).toBe("some");
        expect(selection.state(ui)).toBe("some");
        expect(selection.state(picker)).toBe("none");
        expect(selection.selectedCount(src)).toBe(2);
        selection.toggle(ui);
        expect(selection.state(src)).toBe("all");
        selection.toggle(ui);
        expect(selection.selectedFiles).toEqual(["src/index.ts"]);
    });

    test("select all includes hidden files; selections survive collapsing and reopening folders", () => {
        const selection = new FileSelection(files);
        selection.toggleAll();
        expect(selection.selectedFiles).toEqual(files.map((file) => file.path));
        selection.expanded.clear();
        selection.expanded.add("src");
        expect(selection.selected.size).toBe(files.length);
        selection.toggleAll();
        expect(selection.selectedFiles).toEqual([]);
        selection.toggle(selection.roots[0]);
        selection.toggleAll();
        expect(selection.selected.size).toBe(files.length);
    });

    test("arrow navigation opens folders, enters children, and returns to parents", () => {
        const selection = new FileSelection(files.filter((file) => file.path.startsWith("src/")));
        const focused = () => selection.rows[selection.cursor].node.path;
        expect(focused()).toBe("src");
        selection.navigate("right");
        expect(focused()).toBe("src/ui");
        selection.navigate("right");
        expect(focused()).toBe("src/ui");
        expect(selection.expanded.has("src/ui")).toBe(true);
        selection.navigate("right");
        expect(focused()).toBe("src/ui/picker.test.ts");
        selection.navigate("space");
        selection.navigate("left");
        expect(focused()).toBe("src/ui");
        selection.navigate("left");
        expect(selection.expanded.has("src/ui")).toBe(false);
        expect(selection.selectedFiles).toEqual(["src/ui/picker.test.ts"]);
        selection.navigate("left");
        expect(focused()).toBe("src");
        selection.navigate("left");
        expect(selection.rows).toHaveLength(1);
        selection.navigate("down");
        selection.navigate("up");
        expect(focused()).toBe("src");
    });

    test("Home and End navigate visible rows, including root files", () => {
        const selection = new FileSelection(files);
        selection.navigate("end");
        expect(selection.rows[selection.cursor].node.path).toBe("README.md");
        selection.navigate("space");
        selection.navigate("home");
        expect(selection.cursor).toBe(0);
        expect(selection.selectedFiles).toEqual(["README.md"]);
    });

    test("handles an empty list and treats paths with spaces as exact files", () => {
        const empty = new FileSelection([]);
        empty.navigate("space");
        empty.toggleAll();
        expect(empty.rows).toEqual([]);
        expect(empty.selectedFiles).toEqual([]);
        const selection = new FileSelection([{ path: "new folder/file name.txt", status: "??" }]);
        selection.toggle(selection.roots[0]);
        expect(selection.selectedFiles).toEqual(["new folder/file name.txt"]);
    });
});
