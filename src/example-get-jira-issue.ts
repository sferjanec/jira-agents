import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jiraEnvironment } from "./config/jiraEnvironment.js";
const issueKey = process.argv[2] ?? "PROJ-123";
const compactOnly = process.argv.includes("--compact") || process.argv.includes("-c");
const client = new Client({
    name: "jira-mcp-example-get-jira-issue",
    version: "1.0.0"
});
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const transport = new StdioClientTransport({
    command: npmCommand,
    args: ["start"],
    cwd: process.cwd(),
    env: jiraEnvironment(),
    stderr: "inherit"
});
function parseToolText(result: any): any {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
        return result;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
async function main() {
    await client.connect(transport);
    const result = await client.callTool({
        name: "get_jira_issue",
        arguments: { issueKey, includeFull: false }
    });
    const payload = parseToolText(result);
    if (compactOnly) {
        console.log(JSON.stringify({
            key: payload?.key,
            summary: payload?.summary,
            status: payload?.status,
            priority: payload?.priority,
            assignee: payload?.assignee,
            updated: payload?.updated,
            reporter: payload?.reporter
        }, null, 2));
        return;
    }
    console.log(JSON.stringify(payload, null, 2));
}
try {
    await main();
} finally {
    await client.close();
}
