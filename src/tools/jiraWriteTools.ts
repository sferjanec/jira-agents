import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jiraCommenter, jiraLabeler } from "../jira/jiraService.js";
import { clarificationComment, type JiraCommenter, type JiraLabeler } from "./createFeatureSpec.js";

const issueKeySchema = z.string().max(100).regex(/^[A-Z][A-Z0-9_]*-\d+$/);

interface JiraWriteOptions {
    commenter: JiraCommenter;
    labeler: (label: string | undefined) => JiraLabeler | undefined;
    // Read at call time so tests and the fixture mode can change them.
    env: () => NodeJS.ProcessEnv;
}

function agentComment(text: string, bullets: string[]) {
    const paragraph = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
    return {
        type: "doc",
        version: 1,
        content: [
            {
                type: "paragraph",
                content: [
                    { type: "text", text: "[Agent] ", marks: [{ type: "strong" }] },
                    { type: "text", text }
                ]
            },
            ...(bullets.length
                ? [{ type: "bulletList", content: bullets.map((item) => ({ type: "listItem", content: [paragraph(item)] })) }]
                : [])
        ]
    };
}

function result(payload: { posted: boolean; reason?: string }, text: string, isError = false) {
    return {
        ...(isError ? { isError: true } : {}),
        structuredContent: payload,
        content: [{ type: "text" as const, text }]
    };
}

// Jira writes for a calling script or agent. Each tool is off unless explicitly enabled, writes one
// fixed kind of comment or label (never free-form text), and never contacts Jira in fixture mode.
export function registerJiraWriteTools(server: McpServer, options: JiraWriteOptions = {
    commenter: jiraCommenter,
    labeler: jiraLabeler,
    env: () => process.env
}) {
    const gate = (flag: string): { enabled: boolean; reason?: string } => {
        const env = options.env();
        if (env.JIRA_FIXTURES_DIR) {
            return { enabled: false, reason: "simulated: JIRA_FIXTURES_DIR is set, so Jira is not contacted" };
        }
        return env[flag] === "true"
            ? { enabled: true }
            : { enabled: false, reason: `disabled: set ${flag}=true on the server to enable` };
    };

    server.registerTool("post_clarification_comment", {
        title: "Post Clarification Comment",
        description: "Adds one comment to a Jira issue listing the questions the reporter must answer before a plan can be made. The comment is marked as agent-written. Off unless the server is started with JIRA_POST_CLARIFICATIONS=true; never writes in fixture mode.",
        inputSchema: {
            issueKey: issueKeySchema,
            questions: z.array(z.string().trim().min(1).max(500)).min(1).max(12)
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    }, async ({ issueKey, questions }) => {
        const state = gate("JIRA_POST_CLARIFICATIONS");
        if (!state.enabled) {
            return result({ posted: false, reason: state.reason }, `Comment not posted (${state.reason}).`);
        }
        try {
            await options.commenter.addComment(issueKey, clarificationComment(questions), AbortSignal.timeout(30000));
            return result({ posted: true }, `Clarification comment posted on ${issueKey}.`);
        } catch {
            return result({ posted: false, reason: "The Jira comment could not be posted." }, "The Jira comment could not be posted.", true);
        }
    });

    server.registerTool("post_completion_comment", {
        title: "Post Completion Comment",
        description: "Adds one agent-marked comment to a Jira issue saying a stage finished: stage \"plan\" (plan saved for review) or \"build\" (branch created, files written, nothing pushed). Off unless the server is started with JIRA_POST_COMPLETION=true; never writes in fixture mode.",
        inputSchema: {
            issueKey: issueKeySchema,
            stage: z.enum(["plan", "build"]),
            branch: z.string().max(200).regex(/^agent\/[a-z0-9_-]+-builder$/).optional(),
            files: z.array(z.string().max(300)).max(30).optional().describe("Repository-relative paths written."),
            skipped: z.array(z.string().max(500)).max(30).optional().describe("Skipped paths with reasons.")
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    }, async ({ issueKey, stage, branch, files = [], skipped = [] }) => {
        const state = gate("JIRA_POST_COMPLETION");
        if (!state.enabled) {
            return result({ posted: false, reason: state.reason }, `Comment not posted (${state.reason}).`);
        }
        const body = stage === "plan"
            ? agentComment("A feature plan was generated and saved for human review. No source code was changed.", [])
            : agentComment(
                `Code was generated on local branch ${branch ?? "(unknown)"} for human review. Nothing was pushed.`,
                [...files.map((file) => `Written: ${file}`), ...skipped.map((item) => `Skipped: ${item}`)]
            );
        try {
            await options.commenter.addComment(issueKey, body, AbortSignal.timeout(30000));
            return result({ posted: true }, `Completion comment posted on ${issueKey}.`);
        } catch {
            return result({ posted: false, reason: "The Jira comment could not be posted." }, "The Jira comment could not be posted.", true);
        }
    });

    server.registerTool("add_agent_label", {
        title: "Add Agent Label",
        description: "Adds the configured agent label (JIRA_AGENT_LABEL) to a Jira issue so agent-assisted tickets can be filtered. Off unless JIRA_AGENT_LABEL is set on the server; never writes in fixture mode.",
        inputSchema: { issueKey: issueKeySchema },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async ({ issueKey }) => {
        const env = options.env();
        if (env.JIRA_FIXTURES_DIR) {
            const reason = "simulated: JIRA_FIXTURES_DIR is set, so Jira is not contacted";
            return result({ posted: false, reason }, `Label not added (${reason}).`);
        }
        const labeler = options.labeler(env.JIRA_AGENT_LABEL);
        if (!labeler) {
            const reason = "disabled: set a valid JIRA_AGENT_LABEL on the server to enable";
            return result({ posted: false, reason }, `Label not added (${reason}).`);
        }
        try {
            await labeler.addLabel(issueKey, AbortSignal.timeout(30000));
            return result({ posted: true }, `Label ${labeler.label} added to ${issueKey}.`);
        } catch {
            return result({ posted: false, reason: "The Jira label could not be added." }, "The Jira label could not be added.", true);
        }
    });
}
