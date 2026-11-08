import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnowledgeBase, mergeKnowledgeConfig } from "./knowledge";

test("knowledge base requires explicit opt-in and resolves paths from the repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "gita-knowledge-test-"));
    try {
        await Bun.write(join(root, ".gita/knowledge/context.md"), "ADDITIONAL_CONTEXT");
        expect(mergeKnowledgeConfig().enabled).toBe(false);
        expect(mergeKnowledgeConfig({ paths: [".gita/knowledge"] }).enabled).toBe(false);
        expect(await loadKnowledgeBase(undefined, undefined, root)).toBeNull();
        expect(await loadKnowledgeBase({ enabled: false }, undefined, root)).toBeNull();
        const knowledge = await loadKnowledgeBase({ enabled: true }, undefined, root);
        expect(knowledge?.text).toContain("ADDITIONAL_CONTEXT");
        expect(knowledge?.entries[0]?.source).toBe(join(root, ".gita/knowledge/context.md"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
