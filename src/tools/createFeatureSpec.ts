import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { copilotFeatureSpecModel } from "../agents/copilotFeatureSpec.js";
import { createFeaturePlan } from "../agents/featureSpec.js";
import { FeatureSpecFailure } from "../agents/featureSpecFailure.js";
import { RunRecorder } from "../metrics/runMetrics.js";
import { gatherRepoContext, removeClarifications, saveClarifications, saveFeatureSpec } from "../agents/repoContext.js";
import { fetchCandidateDescriptions, type JiraReader } from "../jira/triage.js";

const issueKeySchema = z.string().max(100).regex(/^[A-Z][A-Z0-9_]*-\d+$/);
export const createFeatureSpecInputSchema = z.object({
    issueKey: issueKeySchema.describe("Jira issue key, such as PROJ-452."),
    workspaceRoot: z.string().trim().min(1).max(4096)
        .describe("Absolute path to the repository root to inspect.")
});
export type CreateFeatureSpecInput = z.input<typeof createFeatureSpecInputSchema>;

export interface JiraCommenter {
    addComment(issueKey: string, body: unknown, signal?: AbortSignal): Promise<void>;
}

export interface JiraLabeler {
    label: string;
    addLabel(issueKey: string, signal?: AbortSignal): Promise<void>;
}

export type FeatureSpecService = (
    input: CreateFeatureSpecInput,
    signal: AbortSignal
) => Promise<{
    issueKey: string;
    path?: string;
    clarificationsPath?: string;
    jiraCommentPosted?: boolean;
    jiraCommentError?: string;
    jiraLabelAdded?: boolean;
    plan: string;
    needsClarification: boolean;
    clarifications: string[];
}>;

export const clarificationPattern = /^- NEEDS CLARIFICATION:\s*(.+)$/gim;

export function renderClarifications(issueKey: string, summary: string, questions: string[]): string {
    return [
        `# Clarifications needed: ${issueKey} - ${summary.replace(/[\r\n]+/g, " ")}`,
        "",
        "The planner could not build a reliable plan from this ticket. Please answer the questions below in the ticket, then run plan generation again.",
        "",
        ...questions.map((question) => `- ${question}`),
        ""
    ].join("\n");
}

export function clarificationComment(questions: string[]) {
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    return {
        type: "doc",
        version: 1,
        content: [
            {
                type: "paragraph",
                content: [
                    { type: "text", text: "[Agent] ", marks: [{ type: "strong" }] },
                    { type: "text", text: "This comment was added automatically by the Jira planning agent, not by a person. Planning could not proceed because this ticket needs more detail. Please answer the following and rerun plan generation:" }
                ]
            },
            {
                type: "bulletList",
                content: questions.map((question) => ({ type: "listItem", content: [paragraph(question)] }))
            }
        ]
    };
}

function logJiraFailure(what: string, error: unknown): void {
    if (process.env.EXPLORE_DEBUG === "1") {
        // Log only the HTTP status and Jira's response body; the raw error carries credentials.
        const failure = error as { response?: { status?: number; data?: unknown }; message?: string };
        console.error(`[${what}] failed:`, failure.response?.status ?? "no response", JSON.stringify(failure.response?.data) ?? failure.message);
    }
}

// commenter and labeler are optional: when omitted, Jira is never written to.
export function createFeatureSpecService(
    reader: JiraReader,
    model = copilotFeatureSpecModel,
    commenter?: JiraCommenter,
    labeler?: JiraLabeler
): FeatureSpecService {
    return async (rawInput, signal) => {
        const input = createFeatureSpecInputSchema.parse(rawInput);
        const run = new RunRecorder("plan", input.issueKey);
        try {
            const result = await runPlan(input, signal, run);
            run.succeed(result.needsClarification ? "needs_clarification" : "plan_saved");
            return result;
        } catch (error) {
            run.fail(error);
            throw error;
        } finally {
            await run.finish();
        }
    };

    async function runPlan(
        input: z.output<typeof createFeatureSpecInputSchema>,
        signal: AbortSignal,
        run: RunRecorder
    ): ReturnType<FeatureSpecService> {
        signal.throwIfAborted();

        let issue: { key: string; summary: string; description: string };
        try {
            const result = await run.span("jiraFetch", () => fetchCandidateDescriptions(reader, {
                issueKeys: [input.issueKey],
                maxCharacters: 6000
            }, signal));
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

        const repoContext = await run.span("repoContext", () => gatherRepoContext(input.workspaceRoot));
        signal.throwIfAborted();
        const plan = await run.span("model", () => createFeaturePlan(issue, repoContext, model, signal, run.telemetry));
        run.set("planChars", plan.length);
        signal.throwIfAborted();

        let jiraLabelAdded: boolean | undefined;
        const tagTicket = async () => {
            if (!labeler) {
                return;
            }
            try {
                await run.span("jiraWrite", () => labeler.addLabel(issue.key, signal));
                jiraLabelAdded = true;
            } catch (error) {
                logJiraFailure("jira-label", error);
                jiraLabelAdded = false;
            }
            run.set("labelAdded", jiraLabelAdded);
        };

        const clarifications = [...plan.matchAll(clarificationPattern)].map((match) => match[1].trim());
        if (clarifications.length > 0) {
            // The plan is not saved: an existing plan is never overwritten, so saving would block the rerun after the ticket is updated.
            const clarificationsPath = await saveClarifications(
                repoContext.workspaceRoot, issue.key, renderClarifications(issue.key, issue.summary, clarifications)
            );
            const result: Awaited<ReturnType<FeatureSpecService>> = {
                issueKey: issue.key, plan, needsClarification: true, clarifications, clarificationsPath
            };
            if (commenter) {
                try {
                    await run.span("jiraWrite", () => commenter.addComment(issue.key, clarificationComment(clarifications), signal));
                    result.jiraCommentPosted = true;
                } catch (error) {
                    logJiraFailure("jira-comment", error);
                    // The local file already holds the questions, so a Jira failure must not fail the run.
                    result.jiraCommentPosted = false;
                    result.jiraCommentError = "The Jira comment could not be posted.";
                }
                run.set("commentPosted", result.jiraCommentPosted);
            }
            await tagTicket();
            if (jiraLabelAdded !== undefined) {
                result.jiraLabelAdded = jiraLabelAdded;
            }
            return result;
        }
        const path = await saveFeatureSpec(repoContext.workspaceRoot, issue.key, plan);
        await removeClarifications(repoContext.workspaceRoot, issue.key);
        await tagTicket();
        return {
            issueKey: issue.key, path, plan, needsClarification: false, clarifications,
            ...(jiraLabelAdded === undefined ? {} : { jiraLabelAdded })
        };
    }
}

export function registerCreateFeatureSpec(server: McpServer, service: FeatureSpecService) {
    let active = false;
    server.registerTool("create_feature_spec", {
        title: "Create Jira Feature Plan",
        description: "Fetches one Jira issue and bounded repository context, asks Copilot to create a reviewable implementation plan, and saves it as .specs/{ISSUE-KEY}-TASK.md. Writes no source code, will not overwrite an existing plan, and normally does not modify Jira. If the ticket is too vague it saves .specs/{ISSUE-KEY}-CLARIFICATIONS.md instead of a plan and, only when the server is started with JIRA_POST_CLARIFICATIONS=true, also adds one comment with the questions to the ticket. If JIRA_AGENT_LABEL is set it also adds that label to the ticket. Sends issue text and selected repository context to Copilot; use only where permitted by your data policy.",
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
                        text: `${result.issueKey} needs clarification before a plan can be saved. No plan was saved; the questions are in ${result.clarificationsPath}${result.jiraCommentPosted ? " and were posted to the Jira ticket" : result.jiraCommentError ? ` (${result.jiraCommentError})` : ""}. Update the ticket with:\n${result.clarifications.map((item) => `- ${item}`).join("\n")}\nThen run this tool again.`
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
