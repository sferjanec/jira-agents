import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    gatherFeatureBuildContext,
    generateFeatureFiles,
    writeFeatureFiles
} from "./featureBuilder.js";
import { FeatureBuilderFailure } from "./featureBuilderFailure.js";

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

test("builder context contains only plan-listed targets and bounded nearby examples", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-builder-context-"));
    try {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
        await writeFile(join(root, "src", "Widget.ts"), "export class Widget {}");
        await writeFile(join(root, "src", "Nearby.ts"), "export const example = true;");
        const context = await gatherFeatureBuildContext("PROJ-452", root, plan);

        assert.deepEqual(context.plannedFiles.map((file) => file.path), ["src/Widget.ts", "src/Widget.test.ts"]);
        assert.equal(context.plannedFiles[0]?.existingContent, "export class Widget {}");
        assert.equal(context.plannedFiles[1]?.existingContent, undefined);
        assert.match(context.repository.instructions, /package\.json/);
        assert.deepEqual(context.examples.map((file) => file.path), ["src/Nearby.ts"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("builder skips directories and 'None specified' steps instead of rejecting the plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-builder-dir-"));
    try {
        await mkdir(join(root, "src", "resources"), { recursive: true });
        await writeFile(join(root, "src", "Widget.ts"), "export class Widget {}");
        const mixedPlan = `${plan}\n**Files:** \`src/resources\`\n\n**Files:** None specified\n`;
        const context = await gatherFeatureBuildContext("PROJ-452", root, mixedPlan);

        assert.deepEqual(context.plannedFiles.map((file) => file.path), ["src/Widget.ts", "src/Widget.test.ts"]);
        assert.deepEqual(context.preSkipped.map((item) => item.path), ["src/resources"]);
        const output = await generateFeatureFiles(context, async () => JSON.stringify({
            files: [{ path: "src/Widget.ts", content: "source" }],
            skipped: [
                { path: "src/Widget.test.ts", reason: "unclear" },
                { path: "src/resources", reason: "directory echoed by the model" }
            ]
        }), new AbortController().signal);
        assert.deepEqual(output.skipped.map((item) => item.path), ["src/resources", "src/Widget.test.ts"]);

        const onlyDirectory = plan.replace("`src/Widget.ts`, `src/Widget.test.ts`", "`src/resources`");
        await assert.rejects(
            gatherFeatureBuildContext("PROJ-452", root, onlyDirectory),
            (error: unknown) => error instanceof FeatureBuilderFailure && error.code === "PLAN_INVALID"
        );
        await assert.rejects(
            gatherFeatureBuildContext("PROJ-452", root, plan.replace("src/Widget.ts", ".env")),
            (error: unknown) => error instanceof FeatureBuilderFailure && /\.env/.test(error.message)
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("builder rejects unsafe, unplanned, and unaccounted model paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-builder-output-"));
    try {
        const context = await gatherFeatureBuildContext("PROJ-452", root, plan);
        await assert.rejects(
            generateFeatureFiles(context, async () => JSON.stringify({
                files: [
                    { path: "src/Widget.ts", content: "source" },
                    { path: "../../outside", content: "unsafe" }
                ],
                skipped: [{ path: "src/Widget.test.ts", reason: "unclear" }]
            }), new AbortController().signal),
            (error: unknown) => error instanceof FeatureBuilderFailure && error.code === "MODEL_OUTPUT_INVALID"
        );
        await assert.rejects(
            gatherFeatureBuildContext("PROJ-452", root, plan.replace("src/Widget.ts", ".github/copilot-instructions.md")),
            (error: unknown) => error instanceof FeatureBuilderFailure && error.code === "PLAN_INVALID"
        );
        await assert.rejects(
            generateFeatureFiles(context, async () => JSON.stringify({
                files: [{ path: "src/Widget.ts", content: "source" }],
                skipped: []
            }), new AbortController().signal),
            (error: unknown) => error instanceof FeatureBuilderFailure && error.code === "MODEL_OUTPUT_INVALID"
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("builder writes validated files and refuses symlinked output paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-builder-write-"));
    const outside = await mkdtemp(join(tmpdir(), "jira-builder-outside-"));
    try {
        await mkdir(join(root, "src"));
        await writeFile(join(outside, "external.ts"), "keep me");
        await writeFile(join(root, "src", "Existing.ts"), "before");
        await symlink(join(outside, "external.ts"), join(root, "src", "External.ts"));
        await writeFeatureFiles(root, [
            { path: "src/Widget.ts", content: "export class Widget {}" },
            { path: "src/Existing.ts", content: "after" }
        ]);
        assert.equal(await readFile(join(root, "src", "Widget.ts"), "utf8"), "export class Widget {}");
        assert.equal((await stat(join(root, "src", "Existing.ts"))).mode & 0o777, 0o644);
        assert.equal(await readFile(join(root, "src", "Existing.ts"), "utf8"), "after");
        await assert.rejects(
            writeFeatureFiles(root, [{ path: "src/External.ts", content: "overwrite" }]),
            (error: unknown) => error instanceof FeatureBuilderFailure && error.code === "FILE_WRITE_FAILED"
        );
        assert.equal(await readFile(join(outside, "external.ts"), "utf8"), "keep me");
        await assert.rejects(
            writeFeatureFiles(root, [{ path: "../outside.ts", content: "unsafe" }]),
            (error: unknown) => error instanceof FeatureBuilderFailure && error.code === "MODEL_OUTPUT_INVALID"
        );
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});
