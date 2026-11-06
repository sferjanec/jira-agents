import { newTelemetry } from "./metrics/runMetrics.js";
import { connectJiraMcp, formatTelemetry } from "./mcpScriptSupport.js";
import { formatBuildResult, runHybridBuild } from "./hybridBuild.js";

// Hybrid build: this script is an MCP client and runs the fixed steps in code. It reads the
// approved plan through the server, asks a tool-less model to return the files as JSON,
// validates that output, then calls the server to create the branch, write each file and
// update the ticket. Compare with `npm run build:agent`, where the model chooses the tool calls.
const [issueKey, workspaceRoot] = process.argv.slice(2);
if (!issueKey || !workspaceRoot) {
    console.error("Usage: npm run build:hybrid -- <ISSUE-KEY> <absolute-repo-path>");
    process.exit(2);
}

const telemetry = newTelemetry();
const mcp = await connectJiraMcp(false);
try {
    const result = await runHybridBuild(mcp, issueKey, workspaceRoot, telemetry, AbortSignal.timeout(360000));
    console.log(formatBuildResult(result));
    console.log(`[tokens] ${formatTelemetry(telemetry)}`);
} finally {
    await mcp.close();
}
