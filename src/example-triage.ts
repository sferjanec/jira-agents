import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jiraEnvironment } from "./config/jiraEnvironment.js";
const defaultStatuses = ["Open", "To Do", "Ready to Work", "In Progress"];
const readyBucketDefaults = ["Ready to Work", "To Do", "Open"];
const args = process.argv.slice(2);
const seenFlags = new Set<string>();
function splitStatusValues(rawValue: string): string[] {
    return rawValue
        .split(/[|,]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !part.startsWith("-"));
}
let projectKey = "IPCM";
let maxResults = 10;
let compactOnly = false;
let outputPath: string | undefined;
let jsonOutput = false;
const triageStatuses: string[] = [...defaultStatuses];
const readyBucketStatuses: string[] = [...readyBucketDefaults];
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
        case "--project":
        case "--projectKey":
        case "-p": {
            const value = args[i + 1]?.trim();
            if (value && !value.startsWith("-")) {
                projectKey = value;
                i += 1;
            }
            break;
        }
        case "--status": {
            const value = args[i + 1]?.trim();
            if (value && !value.startsWith("-")) {
                triageStatuses.push(...splitStatusValues(value));
                readyBucketStatuses.push(...splitStatusValues(value));
                i += 1;
            }
            break;
        }
        case "--ready-status": {
            const value = args[i + 1]?.trim();
            if (value && !value.startsWith("-")) {
                readyBucketStatuses.push(...splitStatusValues(value));
                i += 1;
            }
            break;
        }
        case "--max-results":
        case "--maxResults": {
            const value = args[i + 1]?.trim();
            if (value && /^\d+$/.test(value)) {
                maxResults = Number(value);
                i += 1;
            }
            break;
        }
        case "--compact":
        case "-c":
            compactOnly = true;
            break;
        case "--output":
        case "-o": {
            const value = args[i + 1]?.trim();
            if (value && !value.startsWith("-")) {
                outputPath = value;
                i += 1;
            }
            break;
        }
        case "--json":
            jsonOutput = true;
            break;
        case "--help":
        case "-h":
            console.log("Usage: npm run example:triage -- [--project <KEY>] [--status <STATUS>] [--ready-status <STATUS>] [--max-results <N>] [--compact] [--output <path>] [--json]");
            console.log("Example: npm run example:triage -- --project BOS --status 'Ready to Work' --status 'In Progress' --ready-status 'To Do' --ready-status 'Open' --compact --output ./triage-report.json --json");
            console.log("Tip: quote statuses that contain spaces, such as 'Ready to Work'. You can also pass a comma-separated list like --ready-status 'To Do,Open'.");
            process.exit(0);
            break;
        default:
            if (!arg.startsWith("-") && !seenFlags.has(arg)) {
                projectKey = arg;
                seenFlags.add(arg);
                continue;
            }
            if (/^\d+$/.test(arg)) {
                maxResults = Number(arg);
            }
            break;
    }
}
const uniqueStatuses = [...new Set(triageStatuses.filter((status) => status.trim().length > 0))];
const uniqueReadyStatuses = [...new Set(readyBucketStatuses.filter((status) => status.trim().length > 0))];
const client = new Client({
    name: "jira-mcp-example-triage",
    version: "1.0.0"
});
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const transport = new StdioClientTransport({
    command: npmCommand,
    args: ["start"],
    cwd: process.cwd(),
    env: jiraEnvironment(),
    stderr: "inherit"
});
function parseToolText(result: any): any {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
        return result;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
function formatIssueLine(issue: any): string {
    const key = issue?.key ?? "UNKNOWN";
    const summary = issue?.summary ?? "No summary available";
    const status = issue?.status ?? "Unknown";
    const priority = issue?.priority ?? "Unknown";
    const assignee = issue?.assignee ?? "Unassigned";
    return `- ${key}: ${summary} | Status: ${status} | Priority: ${priority} | Assignee: ${assignee}`;
}
function formatIssueDetail(issue: any): string {
    const key = issue?.key ?? "UNKNOWN";
    const summary = issue?.summary ?? "No summary available";
    const status = issue?.status ?? "Unknown";
    const priority = issue?.priority ?? "Unknown";
    const assignee = issue?.assignee ?? "Unassigned";
    const reporter = issue?.reporter ?? "Unknown";
    const updated = issue?.updated ? new Date(issue.updated).toLocaleString() : "Unknown";
    return [
        `${key} — ${summary}`,
        `Status: ${status} | Priority: ${priority} | Assignee: ${assignee}`,
        `Reporter: ${reporter} | Updated: ${updated}`
    ].join("\n");
}
async function main() {
    await client.connect(transport);
    const statusClause = uniqueStatuses.map((status) => `"${status}"`).join(", ");
    const searchResponse = await client.callTool({
        name: "search_jira",
        arguments: {
            jql: `project = ${projectKey} AND status in (${statusClause}) ORDER BY priority DESC, created ASC`,
            maxResults,
            includeFull: false
        }
    });
    const searchData = parseToolText(searchResponse);
    const issues = searchData?.issues ?? [];
    if (!issues.length) {
        console.log(`No issues found for project ${projectKey} using status filter: ${uniqueStatuses.join(", ")}.`);
        return;
    }
    if (compactOnly) {
        const readyBucket = issues.filter((issue: any) => uniqueReadyStatuses.includes(issue.status));
        const inProgress = issues.filter((issue: any) => issue.status === "In Progress");
        const lines = [
            `Project ${projectKey} triage summary`,
            `Total matching issues: ${issues.length}`,
            `${uniqueReadyStatuses.join(" / ")}: ${readyBucket.length}`,
            `In Progress: ${inProgress.length}`,
            "",
            ...issues.slice(0, Math.min(10, issues.length)).map(formatIssueLine)
        ];
        const reportText = lines.join("\n");
        if (outputPath) {
            const fs = await import("node:fs/promises");
            await fs.writeFile(outputPath, reportText + "\n", "utf8");
            console.log(`Saved compact triage report to ${outputPath}`);
        }
        console.log(reportText);
        return;
    }
    const detailLines: string[] = [];
    for (const issue of issues) {
        const issueKey = issue?.key;
        if (!issueKey) {
            continue;
        }
        const issueResponse = await client.callTool({
            name: "get_jira_issue",
            arguments: { issueKey, includeFull: false }
        });
        const issueData = parseToolText(issueResponse);
        detailLines.push(`Fetching ${issueKey}...`);
        detailLines.push(formatIssueDetail(issueData));
        detailLines.push("");
    }
    const reportLines = [
        `Project ${projectKey} triage summary`,
        `Total matching issues: ${issues.length}`,
        "",
        ...issues.map((issue: any) => formatIssueLine(issue)),
        "",
        ...detailLines
    ];
    if (outputPath) {
        const fs = await import("node:fs/promises");
        if (jsonOutput) {
            const jsonPayload = issues.map((issue: any) => ({
                key: issue.key,
                summary: issue.summary,
                status: issue.status,
                priority: issue.priority,
                assignee: issue.assignee
            }));
            await fs.writeFile(outputPath, JSON.stringify(jsonPayload, null, 2) + "\n", "utf8");
            console.log(`Saved JSON triage report to ${outputPath}`);
        } else {
            await fs.writeFile(outputPath, reportLines.join("\n") + "\n", "utf8");
            console.log(`Saved triage report to ${outputPath}`);
        }
    }
    if (jsonOutput) {
        console.log(JSON.stringify(issues.map((issue: any) => ({
            key: issue.key,
            summary: issue.summary,
            status: issue.status,
            priority: issue.priority,
            assignee: issue.assignee
        })), null, 2));
        return;
    }
    console.log(reportLines.join("\n"));
}
try {
    await main();
} finally {
    await client.close();
}
