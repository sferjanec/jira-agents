import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { summarizeIssue } from "../jira/formatters.js";
import { getIssue } from "../jira/jiraService.js";
export function registerGetJiraIssue(server: McpServer) {
    server.registerTool(
        "get_jira_issue",
        {
            title: "Get Jira Issue",
            description: "Retrieve a Jira issue by key and return a compact summary unless raw output is requested.",
            inputSchema: {
                issueKey: z.string(),
                includeFull: z.boolean().optional().default(false)
            }
        },
        async ({ issueKey, includeFull = false }: { issueKey: string; includeFull?: boolean }) => {
            const issue = await getIssue(issueKey);
            const payload = includeFull ? issue : summarizeIssue(issue);
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
