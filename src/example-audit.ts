import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { auditUsage, parseAuditArgs } from "./cli/audit.js";
import { writeAuditResult } from "./cli/auditResult.js";
import { jiraEnvironment } from "./config/jiraEnvironment.js";
async function main() {
    let options;
    try {
        options = parseAuditArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Invalid command-line arguments.");
        console.error(auditUsage);
        process.exitCode = 1;
        return;
    }
    if (options.help) {
        console.log(auditUsage);
        return;
    }
    const client = new Client({ name: "jira-duplicate-audit-cli", version: "1.0.0" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", fileURLToPath(new URL("./server.ts", import.meta.url))],
        cwd: process.cwd(),
        env: jiraEnvironment(),
        stderr: "inherit"
    });
    try {
        await client.connect(transport);
        const result = await client.callTool({
            name: "audit_jira_duplicates",
            arguments: options.input
        }, undefined, { timeout: 330000 });
        process.exitCode = writeAuditResult(result);
    } finally {
        await client.close();
    }
}
try {
    await main();
} catch {
    console.error("Audit CLI failed. Check Jira configuration, Copilot login, server startup, and tool timeout. No complete result is available.");
    process.exitCode = 1;
}
