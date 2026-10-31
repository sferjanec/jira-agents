import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { copilotFeatureSpecModel } from "../agents/copilotFeatureSpec.js";
import { createFeaturePlan } from "../agents/featureSpec.js";
import { FeatureSpecFailure } from "../agents/featureSpecFailure.js";
import { gatherRepoContext, saveFeatureSpec } from "../agents/repoContext.js";
import { fetchCandidateDescriptions, type JiraReader } from "../jira/triage.js";

const issueKeySchema = z.string().max(100).regex(/^[A-Z][A-Z0-9_]*-\d+$/);
export const createFeatureSpecInputSchema = z.object({
    issueKey: issueKeySchema.describe("Jira issue key, such as PROJ-452."),
    workspaceRoot: z.string().trim().min(1).max(4096)
        .describe("Absolute path to the repository root to inspect.")
});
export type CreateFeatureSpecInput = z.input<typeof createFeatureSpecInputSchema>;

export type FeatureSpecService = (
    input: CreateFeatureSpecInput,
    signal: AbortSignal
) => Promise<{
    issueKey: string;
    path?: string;
    plan: string;
    needsClarification: boolean;
    clarifications: string[];
}>;

const clarificationPattern = /^- NEEDS CLARIFICATION:\s*(.+)$/gim;

export function createFeatureSpecService(
    reader: JiraReader,
    model = copilotFeatureSpecModel
): FeatureSpecService {
    return async (rawInput, signal) => {
        const input = createFeatureSpecInputSchema.parse(rawInput);
        signal.throwIfAborted();

        let issue: { key: string; summary: string; description: string };
        try {
            const result = await fetchCandidateDescriptions(reader, {
                issueKeys: [input.issueKey],
                maxCharacters: 6000
            }, signal);
            const retrieved = result.issues[0];
            if (!retrieved || retrieved.key !== input.issueKey) {
                throw new Error("Jira returned an unexpected issue.");
            }
            issue = {
                key: retrieved.key,
                summary: retrieved.summary.slice(0, 500),
                description: retrieved.description
            };
        } catch {
            if (signal.aborted) {
                throw new FeatureSpecFailure("REQUEST_CANCELLED");
            }
            throw new FeatureSpecFailure("JIRA_RETRIEVAL_FAILED");
        }

        const repoContext = await gatherRepoContext(input.workspaceRoot);
        signal.throwIfAborted();
        const plan = await createFeaturePlan(issue, repoContext, model, signal);
        signal.throwIfAborted();
        const clarifications = [...plan.matchAll(clarificationPattern)].map((match) => match[1].trim());
        if (clarifications.length > 0) {
            // Not saved: an existing plan is never overwritten, so saving would block the rerun after the ticket is updated.
            return { issueKey: issue.key, plan, needsClarification: true, clarifications };
        }
        const path = await saveFeatureSpec(repoContext.workspaceRoot, issue.key, plan);
        return { issueKey: issue.key, path, plan, needsClarification: false, clarifications };
    };
}

export function registerCreateFeatureSpec(server: McpServer, service: FeatureSpecService) {
    let active = false;
    server.registerTool("create_feature_spec", {
        title: "Create Jira Feature Plan",
        description: "Fetches one Jira issue and bounded repository context, asks Copilot to create a reviewable implementation plan, and saves it as .specs/{ISSUE-KEY}-TASK.md. Writes no source code, does not modify Jira, and will not overwrite an existing plan. Sends issue text and selected repository context to Copilot; use only where permitted by your data policy.",
        inputSchema: createFeatureSpecInputSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    }, async (input, extra) => {
        if (active) {
            return {
                isError: true,
                content: [{ type: "text" as const, text: "Feature plan generation is already running. Wait for it to finish before retrying." }]
            };
        }
        active = true;
        const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(180000)]);
        try {
            const result = await service(input, signal);
            if (result.needsClarification) {
                return {
                    structuredContent: result,
                    content: [{
                        type: "text" as const,
                        text: `${result.issueKey} needs clarification before a plan can be saved. No file was written. Update the ticket with:\n${result.clarifications.map((item) => `- ${item}`).join("\n")}\nThen run this tool again.`
                    }]
                };
            }
            return {
                structuredContent: result,
                content: [{
                    type: "text" as const,
                    text: `Feature plan generated at ${result.path}. Review it before asking Copilot to implement the plan.`
                }]
            };
        } catch (error) {
            const failure = error instanceof FeatureSpecFailure
                ? error
                : signal.aborted
                    ? new FeatureSpecFailure("REQUEST_CANCELLED")
                    : new FeatureSpecFailure("INTERNAL_FAILURE");
            return {
                isError: true,
                structuredContent: { error: { code: failure.code, message: failure.message } },
                content: [{ type: "text" as const, text: failure.message }]
            };
        } finally {
            active = false;
        }
    });
}
