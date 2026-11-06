import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AxiosError } from "axios";
import type { JiraReader } from "../jira/triage.js";
import { registerTriageTools } from "./triage.js";
test("MCP exposes bounded read-only tools, structured results and sanitized failures", async () => {
    let fail = false;
    let descriptionCalls = 0;
    const reader: JiraReader = {
        async search() {
            if (fail) {
                throw new AxiosError("secret response body", "ECONNABORTED");
            }
            return {
                issues: [{
                    key: "DEMO-1",
                    fields: { summary: "Login issue", status: { name: "To Do" }, created: "2026-10-01" }
                }],
                isLast: true
            };
        },
        async issue(key) {
            descriptionCalls += 1;
            return { key, fields: { summary: "Login issue", description: "A description." } };
        }
    };
    const server = new McpServer({ name: "triage-test", version: "1.0.0" });
    registerTriageTools(server, reader);
    const client = new Client({ name: "triage-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
            "fetch_candidate_descriptions", "fetch_triage_backlog"
        ]);
        assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
        const backlog = await client.callTool({
            name: "fetch_triage_backlog", arguments: { projectKey: "DEMO" }
        });
        assert.notEqual(backlog.isError, true);
        assert.deepEqual(backlog.structuredContent, {
            projectKey: "DEMO",
            statuses: ["To Do", "In Progress"],
            issues: [{ key: "DEMO-1", summary: "Login issue", status: "To Do", created: "2026-10-01" }],
            coverage: { retrieved: 1, limit: 30, pagesFetched: 1, truncated: false, possiblePairs: 0 }
        });
        assert.equal(descriptionCalls, 0);
        const hydrated = await client.callTool({
            name: "fetch_candidate_descriptions", arguments: { issueKeys: ["DEMO-1", "DEMO-1"] }
        });
        assert.deepEqual(hydrated.structuredContent, {
            issues: [{
                key: "DEMO-1",
                summary: "Login issue",
                description: "A description.",
                missing: false,
                truncated: false,
                originalCharacters: 14
            }],
            fetched: 1,
            maxCharacters: 3000
        });
        assert.equal(descriptionCalls, 1);
        const invalid = await client.callTool({
            name: "fetch_triage_backlog", arguments: { projectKey: "DEMO", maxIssues: 101 }
        });
        assert.equal(invalid.isError, true);
        fail = true;
        const failure = await client.callTool({
            name: "fetch_triage_backlog", arguments: { projectKey: "DEMO" }
        });
        assert.equal(failure.isError, true);
        assert.match(JSON.stringify(failure.content), /ECONNABORTED/);
        assert.doesNotMatch(JSON.stringify(failure), /secret response body/);
        assert.equal(failure.structuredContent, undefined);
    } finally {
        await client.close();
        await server.close();
    }
});
test("actual stdio server starts and preserves the original tools alongside the demo tools", async () => {
    const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/server.ts"],
        cwd: process.cwd(),
        env: {
            PATH: process.env.PATH ?? "",
            JIRA_URL: "https://jira.example.invalid",
            JIRA_USER: "demo@example.invalid",
            JIRA_API_TOKEN: "synthetic-test-value"
        },
        stderr: "pipe"
    });
    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
            "add_agent_label", "audit_jira_duplicates", "build_feature_from_spec", "create_build_branch", "create_feature_spec",
            "fetch_candidate_descriptions", "fetch_triage_backlog", "get_jira_issue", "get_repo_context",
            "post_clarification_comment", "post_completion_comment",
            "read_approved_plan", "save_feature_plan", "search_jira", "write_planned_file"
        ]);
        const invalid = await client.callTool({
            name: "fetch_candidate_descriptions", arguments: { issueKeys: [] }
        });
        assert.equal(invalid.isError, true);
    } finally {
        await client.close();
    }
});
