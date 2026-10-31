import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditDuplicates } from "../agents/audit.js";
import type { AgentRunner } from "../agents/contracts.js";
import type { JiraReader } from "../jira/triage.js";
import { registerAuditJiraDuplicates, type AuditService } from "./auditJiraDuplicates.js";
async function connection(service: AuditService) {
    const server = new McpServer({ name: "audit-test", version: "1.0.0" });
    registerAuditJiraDuplicates(server, service);
    const client = new Client({ name: "audit-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
        client,
        async [Symbol.asyncDispose]() {
            await client.close();
            await server.close();
        }
    };
}
const reader: JiraReader = {
    async search() { return { issues: [], isLast: true }; },
    async issue() { throw new Error("Unexpected issue call"); }
};
const runner: AgentRunner = {
    async run(request, signal) {
        await request.tools[0].execute(signal);
        return "Done";
    }
};
test("audit MCP tool exposes defaults, validates input and returns a structured report", async () => {
    let calls = 0;
    await using link = await connection(async (input, signal) => {
        calls += 1;
        assert.equal(input.maxPairs, calls === 1 ? 10 : 2);
        return auditDuplicates(reader, runner, input, signal);
    });
    const { tools } = await link.client.listTools();
    assert.equal(tools[0].name, "audit_jira_duplicates");
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    assert.equal(tools[0].annotations?.openWorldHint, true);
    const invalid = await link.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO", maxIssues: 101 }
    });
    assert.equal(invalid.isError, true);
    assert.equal(calls, 0);
    const result = await link.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO" }
    });
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result.structuredContent), /"status":"complete"/);
    assert.match(JSON.stringify(result.structuredContent), /"limit":30/);
    assert.equal(calls, 1);
    const capped = await link.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO", maxPairs: 2 }
    });
    assert.equal(capped.isError, false);
    assert.equal(calls, 2);
    const invalidCap = await link.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO", maxPairs: 11 }
    });
    assert.equal(invalidCap.isError, true);
    assert.equal(calls, 2);
});
test("audit tool marks incomplete reports as errors and sanitizes startup failures", async () => {
    await using link = await connection(async (input, signal) => auditDuplicates(reader, {
        async run() { throw new Error("secret-response"); }
    }, input, signal));
    const result = await link.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO" }
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.structuredContent), /"status":"incomplete"/);
    assert.doesNotMatch(JSON.stringify(result), /secret-response/);
    await using failed = await connection(async () => { throw new Error("secret-runtime-config"); });
    const failure = await failed.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO" }
    });
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure.content), /runtime initialization or cleanup failed/);
    assert.match(JSON.stringify(failure.structuredContent), /"code":"RUNTIME_FAILURE"/);
    assert.doesNotMatch(JSON.stringify(failure), /secret-runtime-config/);
});
test("concurrent audits fail fast and the server can accept another after completion", async () => {
    let release = () => {};
    let started = () => {};
    const start = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    await using link = await connection(async (input, signal) => {
        started();
        await wait;
        return auditDuplicates(reader, runner, input, signal);
    });
    const first = link.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO" }
    });
    await start;
    try {
        const busy = await link.client.callTool({
            name: "audit_jira_duplicates", arguments: { projectKey: "DEMO" }
        });
        assert.equal(busy.isError, true);
        assert.match(JSON.stringify(busy.content), /already running/);
    } finally {
        release();
    }
    assert.equal((await first).isError, false);
    const next = await link.client.callTool({
        name: "audit_jira_duplicates", arguments: { projectKey: "DEMO" }
    });
    assert.equal(next.isError, false);
});
