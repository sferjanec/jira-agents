import { z } from "zod";
const issueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);
export const backlogInputSchema = z.object({
    projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100),
    statuses: z.array(z.string().trim().min(1).max(100)).min(1).max(10)
        .default(["To Do", "In Progress"]),
    maxIssues: z.number().int().min(1).max(100).default(30)
});
export const descriptionsInputSchema = z.object({
    issueKeys: z.array(issueKeySchema).min(1).max(20),
    maxCharacters: z.number().int().min(100).max(6000).default(3000)
});
const compactIssueSchema = z.object({
    key: issueKeySchema,
    fields: z.object({
        summary: z.string(),
        status: z.object({ name: z.string() }),
        created: z.string()
    })
});
const pageSchema = z.object({
    issues: z.array(compactIssueSchema),
    isLast: z.boolean().optional(),
    nextPageToken: z.string().min(1).optional()
});
export interface JiraReader {
    search(body: {
        jql: string;
        fields: string[];
        maxResults: number;
        nextPageToken?: string;
    }, signal?: AbortSignal): Promise<unknown>;
    issue(key: string, fields: string[], signal?: AbortSignal): Promise<unknown>;
}
export async function fetchTriageBacklog(reader: JiraReader, input: z.input<typeof backlogInputSchema>, signal?: AbortSignal) {
    const { projectKey, statuses, maxIssues } = backlogInputSchema.parse(input);
    const jql = `project = "${projectKey}" AND status in (${statuses.map((status) => JSON.stringify(status)).join(", ")}) ORDER BY created ASC, key ASC`;
    const issues: { key: string; summary: string; status: string; created: string }[] = [];
    const seenKeys = new Set<string>();
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;
    let pagesFetched = 0;
    let truncated = false;
    do {
        signal?.throwIfAborted();
        const page = pageSchema.parse(await reader.search({
            jql,
            fields: ["summary", "status", "created"],
            maxResults: maxIssues - issues.length,
            ...(nextPageToken ? { nextPageToken } : {})
        }, signal));
        pagesFetched += 1;
        for (const issue of page.issues) {
            if (seenKeys.has(issue.key)) {
                throw new Error("Jira returned repeated issues during pagination; retry the audit.");
            }
            seenKeys.add(issue.key);
            if (issues.length === maxIssues) {
                truncated = true;
                continue;
            }
            issues.push({
                key: issue.key,
                summary: issue.fields.summary,
                status: issue.fields.status.name,
                created: issue.fields.created
            });
        }
        if (page.isLast === true) {
            break;
        }
        if (!page.nextPageToken) {
            throw new Error("Jira did not provide a final-page marker or continuation token.");
        }
        if (seenTokens.has(page.nextPageToken) || page.issues.length === 0) {
            throw new Error("Jira pagination did not advance; retry the audit.");
        }
        seenTokens.add(page.nextPageToken);
        nextPageToken = page.nextPageToken;
        if (issues.length === maxIssues) {
            truncated = true;
            break;
        }
    } while (true);
    return {
        projectKey,
        statuses,
        issues,
        coverage: {
            retrieved: issues.length,
            limit: maxIssues,
            pagesFetched,
            truncated,
            possiblePairs: issues.length * (issues.length - 1) / 2
        }
    };
}
function descriptionText(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Jira returned an unsupported description format.");
    }
    const node = value as Record<string, unknown>;
    if (node.type === "text" && typeof node.text === "string") {
        return node.text;
    }
    if (node.type === "hardBreak") {
        return "\n";
    }
    if (Array.isArray(node.content)) {
        const separator = node.type === "paragraph" || node.type === "heading" ? "" : "\n";
        return node.content.map(descriptionText).join(separator);
    }
    if (typeof node.type !== "string") {
        throw new Error("Jira returned an unsupported description node.");
    }
    return "";
}
export async function fetchCandidateDescriptions(reader: JiraReader, input: z.input<typeof descriptionsInputSchema>, signal?: AbortSignal) {
    const { issueKeys, maxCharacters } = descriptionsInputSchema.parse(input);
    const issues = [];
    for (const key of new Set(issueKeys)) {
        signal?.throwIfAborted();
        const issue = z.object({
            key: issueKeySchema,
            fields: z.object({
                summary: z.string(),
                description: z.unknown().optional()
            })
        }).parse(await reader.issue(key, ["summary", "description"], signal));
        if (issue.key !== key) {
            throw new Error("Jira returned a different issue key than requested.");
        }
        const text = descriptionText(issue.fields.description).trim();
        issues.push({
            key,
            summary: issue.fields.summary,
            description: text.slice(0, maxCharacters),
            missing: text.length === 0,
            truncated: text.length > maxCharacters,
            originalCharacters: text.length
        });
    }
    return { issues, fetched: issues.length, maxCharacters };
}
