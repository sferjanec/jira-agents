import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JiraReader } from "../jira/triage.js";
import { createFeatureSpecService, registerCreateFeatureSpec } from "./createFeatureSpec.js";

const plan = {
    objective: "Plan a small feature.",
    acceptanceCriteria: ["The plan is saved."],
    inScope: ["A reviewable plan."],
    outOfScope: ["Source code generation."],
    implementationSteps: [{
        title: "Create the plan",
        files: ["src/feature.ts"],
        action: "Follow existing repository conventions.",
        tests: ["Check the generated output."]
    }],
    openQuestions: []
};

const reader: JiraReader = {
    async search() {
        throw new Error("Search should not be called.");
    },
    async issue(key) {
        return {
            key,
            fields: {
                summary: "Add a feature",
                description: {
                    type: "doc",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Bounded Jira description." }] }]
                }
            }
        };
    }
};

test("create_feature_spec retrieves Jira, generates a plan, and writes only the plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-feature-spec-"));
    try {
        let promptInput: unknown;
        const service = createFeatureSpecService(reader, async (_instructions, input) => {
            promptInput = input;
            return JSON.stringify(plan);
        });
        const result = await service({
            issueKey: "PROJ-452",
            workspaceRoot: root
        }, new AbortController().signal);
        assert.equal(result.issueKey, "PROJ-452");
        assert.equal(result.needsClarification, false);
        assert.ok(result.path);
        assert.match(result.path, /\.specs\/PROJ-452-TASK\.md$/);
        assert.equal(await readFile(result.path, "utf8"), result.plan);
        assert.equal(
            (promptInput as { issue: { description: string } }).issue.description,
            "Bounded Jira description."
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("create_feature_spec MCP tool describes its write behavior and returns errors explicitly", async () => {
    const server = new McpServer({ name: "feature-spec-test", version: "1.0.0" });
    const client = new Client({ name: "feature-spec-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerCreateFeatureSpec(server, async () => {
        throw new Error("private path details");
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const { tools } = await client.listTools();
        const tool = tools.find((item) => item.name === "create_feature_spec");
        assert.ok(tool);
        assert.equal(tool.annotations?.readOnlyHint, false);
        assert.match(tool.description ?? "", /will not overwrite an existing plan/);
        const result = await client.callTool({
            name: "create_feature_spec",
            arguments: { issueKey: "PROJ-452", workspaceRoot: "/workspace" }
        });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.structuredContent), /"INTERNAL_FAILURE"/);
        assert.doesNotMatch(JSON.stringify(result), /private path details/);
    } finally {
        await client.close();
        await server.close();
    }
});

test("create_feature_spec rejects malformed Jira issue keys before retrieval", async () => {
    let calls = 0;
    const invalidReader: JiraReader = {
        ...reader,
        async issue() {
            calls += 1;
            throw new Error("Unexpected retrieval");
        }
    };
    const root = await mkdtemp(join(tmpdir(), "jira-feature-spec-invalid-"));
    try {
        const service = createFeatureSpecService(invalidReader, async () => JSON.stringify(plan));
        await assert.rejects(service({
            issueKey: "../PROJ-452",
            workspaceRoot: root
        }, new AbortController().signal));
        assert.equal(calls, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

const vaguePlan = JSON.stringify({
    ...plan,
    openQuestions: ["NEEDS CLARIFICATION: Which drop-down on the admin page?"]
});
const clarificationsFile = (root: string) => join(root, ".specs", "PROJ-452-CLARIFICATIONS.md");

test("create_feature_spec flags clarification requests, saves a clarifications file and no plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-feature-spec-"));
    try {
        const service = createFeatureSpecService(reader, async () => vaguePlan);
        const result = await service({ issueKey: "PROJ-452", workspaceRoot: root }, new AbortController().signal);
        assert.equal(result.needsClarification, true);
        assert.deepEqual(result.clarifications, ["Which drop-down on the admin page?"]);
        assert.equal(result.path, undefined);
        assert.equal(result.jiraCommentPosted, undefined);
        assert.equal(result.clarificationsPath, clarificationsFile(root));
        assert.match(await readFile(clarificationsFile(root), "utf8"), /- Which drop-down on the admin page\?/);
        await assert.rejects(readFile(join(root, ".specs", "PROJ-452-TASK.md"), "utf8"));

        // A rerun replaces the file, and a later successful plan removes it.
        const rerun = createFeatureSpecService(reader, async () => JSON.stringify({
            ...plan,
            openQuestions: ["NEEDS CLARIFICATION: Which option is missing?"]
        }));
        await rerun({ issueKey: "PROJ-452", workspaceRoot: root }, new AbortController().signal);
        const replaced = await readFile(clarificationsFile(root), "utf8");
        assert.match(replaced, /Which option is missing/);
        assert.doesNotMatch(replaced, /drop-down/);

        const good = createFeatureSpecService(reader, async () => JSON.stringify(plan));
        const final = await good({ issueKey: "PROJ-452", workspaceRoot: root }, new AbortController().signal);
        assert.equal(final.needsClarification, false);
        await assert.rejects(readFile(clarificationsFile(root), "utf8"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("create_feature_spec posts the clarification comment only when a commenter is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-feature-spec-"));
    try {
        const comments: { key: string; body: unknown }[] = [];
        const service = createFeatureSpecService(reader, async () => vaguePlan, {
            async addComment(key, body) {
                comments.push({ key, body });
            }
        });
        const result = await service({ issueKey: "PROJ-452", workspaceRoot: root }, new AbortController().signal);
        assert.equal(result.jiraCommentPosted, true);
        assert.equal(comments.length, 1);
        assert.equal(comments[0].key, "PROJ-452");
        assert.match(JSON.stringify(comments[0].body), /Which drop-down on the admin page\?/);
        assert.match(JSON.stringify(comments[0].body), /\[Agent\]/);

        const failing = createFeatureSpecService(reader, async () => vaguePlan, {
            async addComment() {
                throw new Error("secret token details");
            }
        });
        const failed = await failing({ issueKey: "PROJ-452", workspaceRoot: root }, new AbortController().signal);
        assert.equal(failed.needsClarification, true);
        assert.equal(failed.jiraCommentPosted, false);
        assert.doesNotMatch(failed.jiraCommentError ?? "", /secret/);
        assert.ok(await readFile(clarificationsFile(root), "utf8"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("create_feature_spec adds the agent label when a labeler is provided and survives a label failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "jira-feature-spec-"));
    try {
        const labeled: string[] = [];
        const service = createFeatureSpecService(reader, async () => JSON.stringify(plan), undefined, {
            label: "agent-assisted",
            async addLabel(key) {
                labeled.push(key);
            }
        });
        const result = await service({ issueKey: "PROJ-452", workspaceRoot: root }, new AbortController().signal);
        assert.deepEqual(labeled, ["PROJ-452"]);
        assert.equal(result.jiraLabelAdded, true);
        assert.equal(result.needsClarification, false);

        const failing = createFeatureSpecService(reader, async () => vaguePlan, undefined, {
            label: "agent-assisted",
            async addLabel() {
                throw new Error("nope");
            }
        });
        const failed = await failing({ issueKey: "PROJ-452", workspaceRoot: root }, new AbortController().signal);
        assert.equal(failed.needsClarification, true);
        assert.equal(failed.jiraLabelAdded, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
