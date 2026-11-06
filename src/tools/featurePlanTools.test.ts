import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFeaturePlanTools } from "./featurePlanTools.js";

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
    openQuestions: [] as string[]
};

async function withClient(run: (client: Client, root: string) => Promise<void>) {
    const server = new McpServer({ name: "plan-tools-test", version: "1.0.0" });
    const client = new Client({ name: "plan-tools-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerFeaturePlanTools(server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const root = await mkdtemp(join(tmpdir(), "jira-plan-tools-"));
    try {
        await run(client, root);
    } finally {
        await client.close();
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
}

test("save_feature_plan validates, saves and refuses to overwrite", async () => {
    await withClient(async (client, root) => {
        const args = { issueKey: "PROJ-1", summary: "Add thing", workspaceRoot: root, plan };
        const saved = await client.callTool({ name: "save_feature_plan", arguments: args });
        assert.notEqual(saved.isError, true);
        const content = await readFile(join(root, ".specs", "PROJ-1-TASK.md"), "utf8");
        assert.match(content, /# Feature Plan: PROJ-1 - Add thing/);
        const again = await client.callTool({ name: "save_feature_plan", arguments: args });
        assert.equal(again.isError, true);
        assert.match(JSON.stringify(again.structuredContent), /SPEC_ALREADY_EXISTS/);
    });
});

test("save_feature_plan rejects unsafe file paths", async () => {
    await withClient(async (client, root) => {
        const bad = { ...plan, implementationSteps: [{ ...plan.implementationSteps[0], files: ["../secret.ts"] }] };
        const result = await client.callTool({
            name: "save_feature_plan",
            arguments: { issueKey: "PROJ-2", summary: "Bad", workspaceRoot: root, plan: bad }
        });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.structuredContent), /MODEL_OUTPUT_INVALID/);
    });
});

test("save_feature_plan writes clarifications instead of a plan", async () => {
    await withClient(async (client, root) => {
        const vague = { ...plan, openQuestions: ["NEEDS CLARIFICATION: which page?"] };
        const result = await client.callTool({
            name: "save_feature_plan",
            arguments: { issueKey: "PROJ-3", summary: "Vague", workspaceRoot: root, plan: vague }
        });
        assert.notEqual(result.isError, true);
        assert.equal((result.structuredContent as { needsClarification: boolean }).needsClarification, true);
        assert.match(await readFile(join(root, ".specs", "PROJ-3-CLARIFICATIONS.md"), "utf8"), /which page/);
    });
});

test("get_repo_context returns layout for a repository", async () => {
    await withClient(async (client, root) => {
        const result = await client.callTool({ name: "get_repo_context", arguments: { workspaceRoot: root } });
        assert.notEqual(result.isError, true);
        assert.equal((result.structuredContent as { workspaceRoot: string }).workspaceRoot.length > 0, true);
    });
});
