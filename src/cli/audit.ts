import { parseArgs } from "node:util";
import { auditInputSchema } from "../agents/contracts.js";
export const auditUsage = `Usage: npm run example:audit -- <PROJECT_KEY> [options]
Options:
  --status <NAME>          Exact Jira status; repeat to select multiple statuses
  --max-issues <N>         Ticket limit, 1-100 (default 30)
  --max-characters <N>     Description character limit, 100-6000 (default 3000)
  --max-pairs <N>          Review first N candidate pairs, 1-10 (default 10)
  --help                  Show help without contacting Jira or Copilot
Example: npm run example:audit -- PROJ --status Backlog --max-issues 100
Without --status, the existing To Do / In Progress defaults apply.
The report is written as JSON to stdout; incomplete audits exit nonzero.
This calls audit_jira_duplicates and sends bounded ticket data to Copilot models.`;
export function parseAuditArgs(args: string[]) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            status: { type: "string", multiple: true },
            "max-issues": { type: "string" },
            "max-characters": { type: "string" },
            "max-pairs": { type: "string" },
            help: { type: "boolean", short: "h" }
        }
    });
    if (values.help) {
        return { help: true as const };
    }
    if (positionals.length !== 1) {
        throw new Error("Supply exactly one Jira project key, for example PROJ.");
    }
    function integer(value: string | undefined, flag: string) {
        if (value === undefined) {
            return undefined;
        }
        if (!/^\d+$/.test(value)) {
            throw new Error(`${flag} must be a positive integer.`);
        }
        return Number(value);
    }
    const result = auditInputSchema.safeParse({
        projectKey: positionals[0],
        statuses: values.status,
        maxIssues: integer(values["max-issues"], "--max-issues"),
        maxCharacters: integer(values["max-characters"], "--max-characters"),
        maxPairs: integer(values["max-pairs"], "--max-pairs")
    });
    if (!result.success) {
        throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    return { help: false as const, input: result.data };
}
