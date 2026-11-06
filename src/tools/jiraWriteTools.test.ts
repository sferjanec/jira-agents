import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerJiraWriteTools } from "./jiraWriteTools.js";

async function withTools(
    env: NodeJS.ProcessEnv,
    run: (client: Client, calls: { comments: unknown[]; labels: string[] }) => Promise<void>,
    failWrites = false
) {
    const calls = { comments: [] as unknown[], labels: [] as string[] };
    const server = new McpServer({ name: "jira-write-test", version: "1.0.0" });
    const client = new Client({ name: "jira-write-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerJiraWriteTools(server, {
        env: () => env,
        commenter: {
            async addComment(_key, body) {
                if (failWrites) {
                    throw new Error("secret detail");
                }
                calls.comments.push(body);
            }
        },
        labeler: (label) => label ? {
            label,
            async addLabel(key) {
                if (failWrites) {
                    throw new Error("secret detail");
                }
                calls.labels.push(`${key}:${label}`);
            }
        } : undefined
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        await run(client, calls);
    } finally {
        await client.close();
        await server.close();
    }
}

const clarification = { name: "post_clarification_comment", arguments: { issueKey: "PROJ-1", questions: ["Which page?"] } };

test("Jira write tools do nothing unless explicitly enabled", async () => {
    await withTools({}, async (client, calls) => {
        const comment = await client.callTool(clarification);
        assert.equal((comment.structuredContent as { posted: boolean }).posted, false);
        const completion = await client.callTool({ name: "post_completion_comment", arguments: { issueKey: "PROJ-1", stage: "plan" } });
        assert.equal((completion.structuredContent as { posted: boolean }).posted, false);
        const label = await client.callTool({ name: "add_agent_label", arguments: { issueKey: "PROJ-1" } });
        assert.equal((label.structuredContent as { posted: boolean }).posted, false);
        assert.deepEqual(calls, { comments: [], labels: [] });
    });
});

test("Jira write tools post when enabled and never in fixture mode", async () => {
    const enabled = { JIRA_POST_CLARIFICATIONS: "true", JIRA_POST_COMPLETION: "true", JIRA_AGENT_LABEL: "agent-assisted" };
    await withTools(enabled, async (client, calls) => {
        assert.equal(((await client.callTool(clarification)).structuredContent as { posted: boolean }).posted, true);
        const build = await client.callTool({
            name: "post_completion_comment",
            arguments: { issueKey: "PROJ-1", stage: "build", branch: "agent/proj-1-builder", files: ["src/a.ts"], skipped: ["src/b.ts: not grounded"] }
        });
        assert.equal((build.structuredContent as { posted: boolean }).posted, true);
        assert.equal(((await client.callTool({ name: "add_agent_label", arguments: { issueKey: "PROJ-1" } })).structuredContent as { posted: boolean }).posted, true);
        assert.equal(calls.comments.length, 2);
        assert.deepEqual(calls.labels, ["PROJ-1:agent-assisted"]);
        assert.match(JSON.stringify(calls.comments[1]), /agent\/proj-1-builder/);
    });
    await withTools({ ...enabled, JIRA_FIXTURES_DIR: "/fixtures" }, async (client, calls) => {
        assert.equal(((await client.callTool(clarification)).structuredContent as { reason: string }).reason.startsWith("simulated"), true);
        await client.callTool({ name: "add_agent_label", arguments: { issueKey: "PROJ-1" } });
        assert.deepEqual(calls, { comments: [], labels: [] });
    });
});

test("Jira write tools hide failure details and reject a malformed branch", async () => {
    await withTools({ JIRA_POST_CLARIFICATIONS: "true" }, async (client) => {
        const failed = await client.callTool(clarification);
        assert.equal(failed.isError, true);
        assert.doesNotMatch(JSON.stringify(failed), /secret detail/);
    }, true);
    await withTools({ JIRA_POST_COMPLETION: "true" }, async (client) => {
        const bad = await client.callTool({
            name: "post_completion_comment",
            arguments: { issueKey: "PROJ-1", stage: "build", branch: "main" }
        });
        assert.equal(bad.isError, true);
    });
});
