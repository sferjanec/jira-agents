import { copilotFeatureBuilderModel } from "./agents/copilotFeatureBuilder.js";
import { generateFeatureFiles, type FeatureBuildContext } from "./agents/featureBuilder.js";
import type { ModelTelemetry } from "./metrics/runMetrics.js";
import type { McpCaller } from "./mcpScriptSupport.js";

export interface HybridBuildResult {
    branch: string;
    written: string[];
    skipped: string[];
    commentPosted: boolean;
    commentReason?: string;
}

// Build steps shared by `build:hybrid` and `plan:hybrid --auto-build`. The script calls the
// server's tools in a fixed order and uses the model only to produce the file contents.
export async function runHybridBuild(
    mcp: McpCaller,
    issueKey: string,
    workspaceRoot: string,
    telemetry: ModelTelemetry,
    signal: AbortSignal
): Promise<HybridBuildResult> {
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
    return { branch, written, skipped, commentPosted: comment.posted, commentReason: comment.reason };
}

export function formatBuildResult(result: HybridBuildResult): string {
    return `Branch: ${result.branch}\nWritten: ${result.written.join(", ") || "none"}\nSkipped: ${result.skipped.join("; ") || "none"}\nJira comment posted: ${result.commentPosted}${result.commentReason ? ` (${result.commentReason})` : ""}\nNothing was pushed.`;
}
