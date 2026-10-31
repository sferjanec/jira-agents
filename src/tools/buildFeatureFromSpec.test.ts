import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFeatureBuildService } from "./buildFeatureFromSpec.js";
import { FeatureBuilderFailure } from "../agents/featureBuilderFailure.js";

const plan = [
    "# Feature Plan: PROJ-452 - Add widget",
    "",
    "> Source ticket: PROJ-452",
    "",
    "## Repository-grounded implementation steps",
    "",
    "### 1. Widget implementation",
    "",
    "**Files:** `src/Widget.ts`, `src/Widget.test.ts`",
    "",
    "Implement the widget using current conventions.",
    ""
].join("\n");

function git(root: string, ...args: string[]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function createRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "jira-builder-repo-"));
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Builder Test");
    git(root, "config", "user.email", "builder-test@example.invalid");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
    await writeFile(join(root, "README.md"), "test repo");
    await writeFile(join(root, "src", "Widget.ts"), "export class Widget { old = true; }\n");
    git(root, "add", "package.json", "README.md", "src/Widget.ts");
    git(root, "commit", "-m", "initial");
    await mkdir(join(root, ".specs"));
    await writeFile(join(root, ".specs", "PROJ-452-TASK.md"), plan);
    return root;
}

test("builder creates a local branch and modifies only approved plan files", async () => {
    const root = await createRepo();
    try {
        const model = async (_instructions: string, context: { plannedFiles: { path: string; existingContent?: string }[] }) => {
            assert.equal(context.plannedFiles.length, 2);
            assert.equal(context.plannedFiles[0]?.existingContent, "export class Widget { old = true; }\n");
            return JSON.stringify({
                files: [
                    { path: "src/Widget.ts", content: "export class Widget { old = false; }\n" },
                    { path: "src/Widget.test.ts", content: "import { test } from 'node:test';\ntest('widget', () => {});\n" }
                ],
                skipped: []
            });
        };
        const service = createFeatureBuildService(model);
        const result = await service({
            issueKey: "PROJ-452",
            workspaceRoot: root
        }, new AbortController().signal);

        assert.equal(result.branch, "agent/proj-452-builder");
        assert.equal(result.pushed, false);
        assert.deepEqual(result.created, ["src/Widget.test.ts"]);
        assert.deepEqual(result.modified, ["src/Widget.ts"]);
        assert.deepEqual(result.skipped, []);
        assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), result.branch);
        assert.equal(await readFile(join(root, "src", "Widget.ts"), "utf8"), "export class Widget { old = false; }\n");
        assert.match(await readFile(join(root, "src", "Widget.test.ts"), "utf8"), /test\('widget'/);
        assert.equal(await readFile(join(root, ".specs", "PROJ-452-TASK.md"), "utf8"), plan);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("builder refuses unrelated dirty files before calling the model", async () => {
    const root = await createRepo();
    try {
        await writeFile(join(root, "unplanned.txt"), "local change");
        let called = false;
        const service = createFeatureBuildService(async () => {
            called = true;
            return JSON.stringify({ files: [], skipped: [] });
        });
        await assert.rejects(service({
            issueKey: "PROJ-452",
            workspaceRoot: root
        }, new AbortController().signal), (error: unknown) =>
            error instanceof FeatureBuilderFailure && error.code === "REPOSITORY_DIRTY"
        );
        assert.equal(called, false);
        assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "main");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("builder rejects a missing or mismatched plan without creating a branch", async () => {
    const root = await createRepo();
    try {
        await writeFile(join(root, ".specs", "PROJ-452-TASK.md"), plan.replace("PROJ-452", "PROJ-999"));
        const service = createFeatureBuildService(async () => JSON.stringify({ files: [], skipped: [] }));
        await assert.rejects(service({
            issueKey: "PROJ-452",
            workspaceRoot: root
        }, new AbortController().signal), (error: unknown) =>
            error instanceof FeatureBuilderFailure && error.code === "PLAN_INVALID"
        );
        assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "main");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("builder does not reuse an existing generated branch", async () => {
    const root = await createRepo();
    try {
        git(root, "branch", "agent/proj-452-builder");
        let called = false;
        const service = createFeatureBuildService(async () => {
            called = true;
            return JSON.stringify({ files: [], skipped: [] });
        });
        await assert.rejects(service({
            issueKey: "PROJ-452",
            workspaceRoot: root
        }, new AbortController().signal), (error: unknown) =>
            error instanceof FeatureBuilderFailure && error.code === "BRANCH_EXISTS"
        );
        assert.equal(called, false);
        assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "main");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
