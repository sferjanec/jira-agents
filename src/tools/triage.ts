import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import axios from "axios";
import {
    backlogInputSchema,
    descriptionsInputSchema,
    fetchCandidateDescriptions,
    fetchTriageBacklog,
    type JiraReader
} from "../jira/triage.js";
async function toolResult(action: () => Promise<Record<string, unknown>>) {
    try {
        const payload = await action();
        return {
            structuredContent: payload,
            content: [{ type: "text" as const, text: JSON.stringify(payload) }]
        };
    } catch (error) {
        const message = axios.isAxiosError(error)
            ? `Jira request failed (${error.response?.status ?? error.code ?? "network error"}). Check access and retry; this audit is incomplete.`
            : "Jira retrieval or validation failed. Check the request and Jira response format; this audit is incomplete.";
        return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
}
export function registerTriageTools(server: McpServer, reader: JiraReader) {
    server.registerTool("fetch_triage_backlog", {
        title: "Fetch Compact Triage Backlog",
        description: "Read a bounded, paginated backlog for duplicate screening. Returns key, summary, status, created and explicit coverage. No descriptions. Defaults to all issue types in To Do/In Progress.",
        inputSchema: backlogInputSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false }
    }, async (input) => toolResult(() => fetchTriageBacklog(reader, input)));
    server.registerTool("fetch_candidate_descriptions", {
        title: "Fetch Candidate Descriptions",
        description: "Read descriptions only for suspected duplicate keys (maximum 20). Converts Jira rich text to bounded text and marks missing/truncated evidence. Does not modify Jira.",
        inputSchema: descriptionsInputSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false }
    }, async (input) => toolResult(() => fetchCandidateDescriptions(reader, input)));
}
