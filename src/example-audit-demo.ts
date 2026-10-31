import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JiraReader } from "./jira/triage.js";
import { copilotAuditService, registerAuditJiraDuplicates } from "./tools/auditJiraDuplicates.js";

const defaultStatuses = ["To Do", "In Progress", "Backlog", "Refinement"];
const tickets = [
    {
        key: "DEMO-1", summary: "Login redirects forever after session expires",
        status: "To Do", created: "2026-09-01",
        description: "After an SSO session expires, opening the dashboard redirects between the login page and callback forever. Clear the expired session cookie before restarting login. Acceptance: one login returns the user to the dashboard."
    },
    {
        key: "DEMO-2", summary: "Expired SSO cookie causes endless sign-in loop",
        status: "In Progress", created: "2026-09-02",
        description: "An expired SSO session cookie remains on the callback route, causing repeated login redirects when visiting the dashboard. Remove the expired cookie. Acceptance: signing in once opens the dashboard."
    },
    {
        key: "DEMO-3", summary: "Export dashboard chart as CSV",
        status: "To Do", created: "2026-09-03",
        description: "Add a CSV export button to the sales chart. Include visible rows and column headers. This does not change authentication."
    },
    {
        key: "DEMO-4", summary: "Invoice PDF download fails for large invoices",
        status: "Backlog", created: "2026-09-04",
        description: "Downloading an invoice PDF over 100 pages returns a server error. Stream large invoices in chunks and preserve the existing PDF layout."
    },
    {
        key: "DEMO-5", summary: "Large invoices return an error when exporting PDF",
        status: "Refinement", created: "2026-09-05",
        description: "PDF export fails for invoices with many pages. Generate the document incrementally so large invoices can be downloaded successfully."
    },
    {
        key: "DEMO-6", summary: "Add keyboard shortcuts to the chart editor",
        status: "Refinement", created: "2026-09-06",
        description: "Support keyboard shortcuts for undo and redo in the chart editor. Keep the current toolbar actions available."
    },
    {
        key: "DEMO-7", summary: "Show a warning before deleting a saved dashboard",
        status: "In Progress", created: "2026-09-07",
        description: "Display a confirmation dialog before permanently deleting a saved dashboard. The dialog should identify the dashboard by name."
    },
    {
        key: "DEMO-8", summary: "Allow filtering the issue table by owner",
        status: "Backlog", created: "2026-09-08",
        description: "Add an owner filter to the issue table so users can narrow results to a selected assignee."
    }
] as const;

const help = `Usage: npm run example:audit:demo [options]
Options:
  --status <NAME>   Include an exact synthetic status; repeat to select multiple
  --max-pairs <N>   Review first N screened pairs, 1-10 (default 10)
  --help            Show this help without Copilot or Jira calls
Default statuses: ${defaultStatuses.join(", ")}
This uses synthetic tickets and the Copilot SDK; Jira credentials and a .env file are not required.`;

function parseArgs(args: string[]) {
    const statuses: string[] = [];
    let maxPairs = 10;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help" || arg === "-h") {
            return { help: true as const };
        }
        if (arg === "--status") {
            const status = args[index + 1]?.trim();
            if (!status || status.startsWith("--")) {
                throw new Error("--status requires a nonempty status name.");
            }
            statuses.push(status);
            index += 1;
            continue;
        }
        if (arg === "--max-pairs") {
            const value = args[index + 1];
            if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10) {
                throw new Error("--max-pairs must be an integer from 1 to 10.");
            }
            maxPairs = Number(value);
            index += 1;
            continue;
        }
        throw new Error(`Unknown option: ${arg}`);
    }
    return {
        help: false as const,
        statuses: statuses.length > 0 ? [...new Set(statuses)] : defaultStatuses,
        maxPairs
    };
}

function statusesFromJql(jql: string): string[] {
    const match = jql.match(/\bstatus\s+in\s*\(([^)]*)\)/i);
    if (!match) {
        throw new Error("Synthetic Jira reader received an unsupported status query.");
    }
    return [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
        .map(([, value]) => JSON.parse(`"${value}"`) as string);
}

async function main() {
    let options: ReturnType<typeof parseArgs>;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Invalid command-line arguments.");
        console.error(help);
        process.exitCode = 1;
        return;
    }
    if (options.help) {
        console.log(help);
        return;
    }

    const reader: JiraReader = {
        async search({ jql }) {
            const selectedStatuses = new Set(statusesFromJql(jql));
            return {
                issues: tickets
                    .filter((ticket) => selectedStatuses.has(ticket.status))
                    .map((ticket) => ({
                        key: ticket.key,
                        fields: {
                            summary: ticket.summary,
                            status: { name: ticket.status },
                            created: ticket.created
                        }
                    })),
                isLast: true
            };
        },
        async issue(key) {
            const ticket = tickets.find((item) => item.key === key);
            if (!ticket) {
                throw new Error("Unapproved synthetic ticket requested.");
            }
            return { key, fields: { summary: ticket.summary, description: ticket.description } };
        }
    };

    const server = new McpServer({ name: "synthetic-audit-demo", version: "1.0.0" });
    registerAuditJiraDuplicates(server, copilotAuditService(reader));
    const client = new Client({ name: "synthetic-audit-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
            name: "audit_jira_duplicates",
            arguments: { projectKey: "DEMO", statuses: options.statuses, maxPairs: options.maxPairs }
        }, undefined, { timeout: 330000 });
        console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
        if (result.isError) {
            process.exitCode = 1;
        }
    } finally {
        await client.close();
        await server.close();
    }
}

await main();
