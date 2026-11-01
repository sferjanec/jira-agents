import { jira } from "./jiraClient.js";
import type { JiraReader } from "./triage.js";
import type { JiraCommenter, JiraLabeler } from "../tools/createFeatureSpec.js";
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

// The only Jira write in this project: adds one comment to one issue. It is wired in only when
// JIRA_POST_CLARIFICATIONS=true (see src/tools/index.ts).
export const jiraCommenter: JiraCommenter = {
    async addComment(key, body, signal) {
        await jira.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body }, { timeout: 30000, signal });
    }
};

// Adds a label so agent-assisted tickets can be filtered in Jira (for cycle-time comparison).
// Returns undefined for an invalid label, because Jira labels cannot contain spaces.
export function jiraLabeler(label: string | undefined): JiraLabeler | undefined {
    const value = label?.trim();
    if (!value) {
        return undefined;
    }
    if (!/^[A-Za-z0-9_.-]{1,255}$/.test(value)) {
        console.error("JIRA_AGENT_LABEL ignored: use letters, digits, '-', '_' or '.' only (no spaces).");
        return undefined;
    }
    return {
        label: value,
        async addLabel(key, signal) {
            await jira.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: [{ add: value }] } }, { timeout: 30000, signal });
        }
    };
}
