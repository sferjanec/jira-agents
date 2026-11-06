import { copilotFeatureBuilderModel } from "./agents/copilotFeatureBuilder.js";
import { generateFeatureFiles, type FeatureBuildContext } from "./agents/featureBuilder.js";
import { newTelemetry } from "./metrics/runMetrics.js";
import { connectJiraMcp, formatTelemetry } from "./mcpScriptSupport.js";

// Hybrid build: this script is an MCP client and runs the fixed steps in code. It reads the
// approved plan through the server, asks a tool-less model to return the files as JSON,
// validates that output, then calls the server to create the branch, write each file and
// update the ticket. Compare with `npm run build:agent`, where the model chooses the tool calls.
const [issueKey, workspaceRoot] = process.argv.slice(2);
if (!issueKey || !workspaceRoot) {
    console.error("Usage: npm run build:hybrid -- <ISSUE-KEY> <absolute-repo-path>");
    process.exit(2);
}

const signal = AbortSignal.timeout(360000);
const telemetry = newTelemetry();
const mcp = await connectJiraMcp(false);
try {
    const context = await mcp.call<FeatureBuildContext & Record<string, unknown>>(
        "read_approved_plan", { issueKey, workspaceRoot }
    );
    // Validates every path against the plan and requires each planned file to be written or skipped.
    const output = await generateFeatureFiles(context, copilotFeatureBuilderModel, signal, telemetry);

    const { branch } = await mcp.call<{ branch: string }>("create_build_branch", { issueKey, workspaceRoot });
    const written: string[] = [];
    for (const file of output.files) {
        await mcp.call("write_planned_file", { issueKey, workspaceRoot, path: file.path, content: file.content });
        written.push(file.path);
    }
    const skipped = output.skipped.map((item) => `${item.path}: ${item.reason}`);
    const comment = await mcp.call<{ posted: boolean; reason?: string }>(
        "post_completion_comment", { issueKey, stage: "build", branch, files: written, skipped }
    );
    console.log(`Branch: ${branch}\nWritten: ${written.join(", ") || "none"}\nSkipped: ${skipped.join("; ") || "none"}\nJira comment posted: ${comment.posted}${comment.reason ? ` (${comment.reason})` : ""}\nNothing was pushed.`);
    console.log(`[tokens] ${formatTelemetry(telemetry)}`);
} finally {
    await mcp.close();
}
