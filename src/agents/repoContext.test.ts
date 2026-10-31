import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gatherRepoContext, saveFeatureSpec } from "./repoContext.js";
import { FeatureSpecFailure } from "./featureSpecFailure.js";

test("repository context is bounded to visible layout and recognized instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-repo-context-"));
    const external = await mkdtemp(join(tmpdir(), "jira-repo-external-"));
    try {
        await mkdir(join(root, "src", "api"), { recursive: true });
        await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
        await mkdir(join(root, ".github"));
        await writeFile(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
        await writeFile(join(root, ".github", "copilot-instructions.md"), "Use the current patterns.");
        await writeFile(join(external, "AGENTS.md"), "Do not include external files.");
        await symlink(join(external, "AGENTS.md"), join(root, "AGENTS.md"));
        const context = await gatherRepoContext(root);

        assert.deepEqual(context.stack, ["Node.js / JavaScript or TypeScript (package.json present)"]);
        assert.match(context.layout, /src\/\n  api\//);
        assert.doesNotMatch(context.layout, /node_modules/);
        assert.match(context.instructions, /Use the current patterns/);
        assert.doesNotMatch(context.instructions, /Do not include external files/);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(external, { recursive: true, force: true });
    }
});

test("feature plans are saved without overwriting existing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-spec-save-"));
    try {
        const path = await saveFeatureSpec(root, "PROJ-452", "# Plan\n");
        assert.equal(await readFile(path, "utf8"), "# Plan\n");
        await assert.rejects(
            saveFeatureSpec(root, "PROJ-452", "# Replacement\n"),
            (error: unknown) => error instanceof FeatureSpecFailure && error.code === "SPEC_ALREADY_EXISTS"
        );
        assert.equal(await readFile(path, "utf8"), "# Plan\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("feature plan saver rejects malformed issue keys and relative workspace paths", async () => {
    await assert.rejects(
        saveFeatureSpec("/workspace", "../PROJ-452", "content"),
        (error: unknown) => error instanceof FeatureSpecFailure && error.code === "INVALID_WORKSPACE"
    );
    await assert.rejects(
        saveFeatureSpec("workspace", "PROJ-452", "content"),
        (error: unknown) => error instanceof FeatureSpecFailure && error.code === "INVALID_WORKSPACE"
    );
});
