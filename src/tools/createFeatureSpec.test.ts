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
