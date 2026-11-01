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

const blockTypes = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote", "rule", "tableRow"]);

// Converts Jira's rich-text format to plain text. Unknown nodes are skipped instead of failing.
export function richTextToPlainText(node: any): string {
    if (node === null || node === undefined) {
        return "";
    }
    if (typeof node === "string") {
        return node;
    }
    if (node.type === "text") {
        return typeof node.text === "string" ? node.text : "";
    }
    if (node.type === "hardBreak") {
        return "\n";
    }
    if (node.type === "mention" || node.type === "emoji") {
        return node.attrs?.text ?? node.attrs?.shortName ?? "";
    }
    const children: any[] = Array.isArray(node.content) ? node.content : [];
    if (node.type === "bulletList" || node.type === "orderedList") {
        return children.map((child, index) =>
            `${node.type === "orderedList" ? `${index + 1}.` : "-"} ${richTextToPlainText(child).trim()}`
        ).join("\n") + "\n";
    }
    const text = children.map(richTextToPlainText).join(node.type === "tableRow" ? " | " : "");
    return blockTypes.has(node.type) ? `${text}\n` : text;
}

const maxComments = 20;

export function detailIssue(issue: JiraIssue) {
    const fields = issue?.fields ?? {};
    const allComments: any[] = Array.isArray(fields.comment?.comments) ? fields.comment.comments : [];
    return {
        ...summarizeIssue(issue),
        description: richTextToPlainText(fields.description).trim() || "(no description)",
        comments: allComments.slice(-maxComments).map((comment) => ({
            author: safeValue(comment?.author?.displayName, "Unknown"),
            created: safeValue(comment?.created, "Unknown"),
            body: richTextToPlainText(comment?.body).trim()
        })),
        commentsTruncated: allComments.length > maxComments
    };
}
