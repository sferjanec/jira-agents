type JiraIssue = any;
function safeValue<T>(value: T | undefined | null, fallback: T): T {
    return value ?? fallback;
}
export function summarizeIssue(issue: JiraIssue) {
    const fields = issue?.fields ?? {};
    return {
        key: issue?.key ?? "UNKNOWN",
        summary: safeValue(fields.summary, "No summary available"),
        status: safeValue(fields.status?.name, "Unknown"),
        priority: safeValue(fields.priority?.name, "Unknown"),
        assignee: safeValue(fields.assignee?.displayName, "Unassigned"),
        reporter: safeValue(fields.reporter?.displayName, "Unknown"),
        updated: safeValue(fields.updated, "Unknown"),
        created: safeValue(fields.created, "Unknown"),
        url: safeValue(issue?.self, "Unknown")
    };
}
export function summarizeSearchResults(searchResult: any, maxItems = 10) {
    const issues = Array.isArray(searchResult?.issues) ? searchResult.issues.slice(0, maxItems) : [];
    return {
        total: searchResult?.total ?? issues.length,
        maxResults: maxItems,
        issues: issues.map((issue: JiraIssue) => summarizeIssue(issue))
    };
}
