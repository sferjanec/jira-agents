import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jiraEnvironment } from "./config/jiraEnvironment.js";
const client = new Client({
    name: "jira-mcp-example-client",
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
async function main() {
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log("Available tools:");
    for (const tool of tools) {
        console.log(`- ${tool.name}: ${tool.description ?? ""}`);
    }
    const [issueKey] = process.argv.slice(2);
    if (!issueKey) {
        console.log("\nPass an issue key to retrieve it, for example:");
        console.log("npm run example:client -- PROJ-123");
        return;
    }
    const result = await client.callTool({
        name: "get_jira_issue",
        arguments: { issueKey }
    });
    console.log(`\nResult for ${issueKey}:`);
    console.log(JSON.stringify(result, null, 2));
}
try {
    await main();
} finally {
    await client.close();
}
