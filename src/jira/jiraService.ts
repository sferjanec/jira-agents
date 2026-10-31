import { jira } from "./jiraClient.js";
import type { JiraReader } from "./triage.js";
export const triageReader: JiraReader = {
    async search(body, signal) {
        const response = await jira.post("/rest/api/3/search/jql", body, { timeout: 30000, signal });
        return response.data;
    },
    async issue(key, fields, signal) {
        const response = await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
            params: { fields: fields.join(",") },
            signal,
            timeout: 30000
        });
        return response.data;
    }
};
export async function getIssue(issueKey: string) {
    const response = await jira.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`);
    return response.data;
}
export async function searchIssues(jql: string, maxResults = 20) {
    const response = await jira.post("/rest/api/3/search/jql", {
        jql,
        maxResults,
        fields: ["key", "summary", "status", "priority", "assignee", "updated", "created"]
    });
    return response.data;
}
