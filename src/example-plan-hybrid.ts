import { FeatureSpecFailure } from "./agents/featureSpecFailure.js";
import { generateFeaturePlan, type FeaturePlan } from "./agents/featureSpec.js";
import { copilotFeatureSpecModel } from "./agents/copilotFeatureSpec.js";
import type { RepoContext } from "./agents/repoContext.js";
import { newTelemetry } from "./metrics/runMetrics.js";
import { connectJiraMcp, formatTelemetry } from "./mcpScriptSupport.js";

// Hybrid planning: this script is an MCP client and runs the fixed steps in code. It calls the
// server's tools for Jira and the repository, uses the model only to reason about the plan
// (read-only view/grep/glob, no MCP tools), then calls the server again to save the plan and
// update the ticket. Compare with `npm run plan:agent`, where the model chooses the tool calls.
// With --simulate, tickets come from simulation/fixtures and Jira is never contacted.
const simulate = process.argv.includes("--simulate");
const [issueKey, workspaceRoot] = process.argv.slice(2).filter((arg) => arg !== "--simulate");
if (!issueKey || !workspaceRoot) {
    console.error("Usage: npm run plan:hybrid -- <ISSUE-KEY> <absolute-repo-path> [--simulate]");
    process.exit(2);
}

const signal = AbortSignal.timeout(300000);
const telemetry = newTelemetry();
const mcp = await connectJiraMcp(simulate);
try {
    const issue = await mcp.call<{ key: string; summary: string; description: string }>(
        "get_jira_issue", { issueKey, includeDetails: true }
    );
    const repoContext = await mcp.call<RepoContext & Record<string, unknown>>("get_repo_context", { workspaceRoot });

    const ticket = { key: issue.key, summary: issue.summary.slice(0, 500), description: issue.description.slice(0, 6000) };
    let plan: FeaturePlan | undefined;
    for (let attempt = 1; plan === undefined; attempt += 1) {
        try {
            plan = await generateFeaturePlan(ticket, repoContext, copilotFeatureSpecModel, signal, telemetry);
        } catch (error) {
            // The model returned something that is not a valid plan; one retry is allowed.
            if (!(error instanceof FeatureSpecFailure) || error.code !== "MODEL_OUTPUT_INVALID" || attempt >= 2) {
                throw error;
            }
            console.log("[plan] model output was invalid, retrying once");
        }
    }

    const saved = await mcp.call<{ needsClarification: boolean; path?: string; clarificationsPath?: string; clarifications: string[] }>(
        "save_feature_plan", { issueKey, summary: ticket.summary, workspaceRoot, plan }
    );
    if (saved.needsClarification) {
        const comment = await mcp.call<{ posted: boolean; reason?: string }>(
            "post_clarification_comment", { issueKey, questions: saved.clarifications }
        );
        console.log(`NEEDS CLARIFICATION\nQuestions file: ${saved.clarificationsPath}\nJira comment posted: ${comment.posted}${comment.reason ? ` (${comment.reason})` : ""}\n${saved.clarifications.map((item) => `- ${item}`).join("\n")}`);
    } else {
        const comment = await mcp.call<{ posted: boolean; reason?: string }>(
            "post_completion_comment", { issueKey, stage: "plan" }
        );
        console.log(`Plan saved: ${saved.path}\nJira comment posted: ${comment.posted}${comment.reason ? ` (${comment.reason})` : ""}`);
    }
    const label = await mcp.call<{ posted: boolean; reason?: string }>("add_agent_label", { issueKey });
    console.log(`Jira label added: ${label.posted}${label.reason ? ` (${label.reason})` : ""}`);
    console.log(`[tokens] ${formatTelemetry(telemetry)}`);
} finally {
    await mcp.close();
}
