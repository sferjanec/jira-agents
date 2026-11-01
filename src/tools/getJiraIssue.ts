import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { detailIssue, summarizeIssue } from "../jira/formatters.js";
import { getIssue } from "../jira/jiraService.js";
export function registerGetJiraIssue(server: McpServer) {
    server.registerTool(
        "get_jira_issue",
        {
            title: "Get Jira Issue",
            description: "Retrieve a Jira issue by key and return a compact summary. Set includeDetails to also get the description and the most recent comments as plain text, or includeFull for raw output.",
            inputSchema: {
                issueKey: z.string(),
                includeFull: z.boolean().optional().default(false),
                includeDetails: z.boolean().optional().default(false)
            }
        },
        async ({ issueKey, includeFull = false, includeDetails = false }: { issueKey: string; includeFull?: boolean; includeDetails?: boolean }) => {
            const issue = await getIssue(issueKey);
            const payload = includeFull ? issue : includeDetails ? detailIssue(issue) : summarizeIssue(issue);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(payload, null, 2)
                    }
                ]
            };
        }
    );
}
