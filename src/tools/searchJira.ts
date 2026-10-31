import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { summarizeSearchResults } from "../jira/formatters.js";
import { searchIssues } from "../jira/jiraService.js";
export function registerSearchJira(server: McpServer) {
    server.registerTool(
        "search_jira",
        {
            title: "Search Jira",
            description: "Search Jira with JQL or by project key and return a compact summary by default.",
            inputSchema: {
                jql: z.string().optional(),
                projectKey: z.string().optional(),
                maxResults: z.number().int().positive().optional().default(10),
                includeFull: z.boolean().optional().default(false)
            }
        },
        async ({ jql, projectKey, maxResults = 10, includeFull = false }: { jql?: string; projectKey?: string; maxResults?: number; includeFull?: boolean }) => {
            const defaultStatuses = ["Open", "To Do", "Ready to Work", "In Progress"];
            const resolvedJql = jql ?? (projectKey
                ? `project = ${projectKey} AND status in (${defaultStatuses.map((status) => `"${status}"`).join(", ")}) ORDER BY priority DESC, created ASC`
                : undefined);
            if (!resolvedJql) {
                throw new Error("Either jql or projectKey must be supplied.");
            }
            const results = await searchIssues(resolvedJql, maxResults);
            const payload = includeFull ? results : summarizeSearchResults(results, maxResults);
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
