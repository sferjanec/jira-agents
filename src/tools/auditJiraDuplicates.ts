import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditDuplicates } from "../agents/audit.js";
import { auditInputSchema, type AuditInput, type AuditReport } from "../agents/contracts.js";
import type { JiraReader } from "../jira/triage.js";
import { AuditFailure, diagnostic } from "../agents/diagnostics.js";
import { logAuditProgress } from "../agents/progress.js";
export type AuditService = (input: AuditInput, signal: AbortSignal) => Promise<AuditReport>;
export function copilotAuditService(reader: JiraReader): AuditService {
    return async (input, signal) => {
        const started = performance.now();
        logAuditProgress({ stage: "runtime", status: "started", elapsedMs: 0 });
        try {
            const { withCopilotRunner } = await import("../agents/copilot.js");
            const report = await withCopilotRunner((runner) => auditDuplicates(
                reader, runner, input, signal, logAuditProgress
            ), signal);
            logAuditProgress({
                stage: "runtime", status: "completed",
                elapsedMs: Math.round(performance.now() - started)
            });
            return report;
        } catch {
            const error = diagnostic(new AuditFailure("RUNTIME_FAILURE"), signal);
            logAuditProgress({
                stage: "runtime", status: "failed",
                elapsedMs: Math.round(performance.now() - started), error
            });
            throw new AuditFailure("RUNTIME_FAILURE");
        }
    };
}
export function registerAuditJiraDuplicates(server: McpServer, service: AuditService) {
    let active = false;
    server.registerTool("audit_jira_duplicates", {
        title: "Audit Jira Duplicates with Two Agents",
        description: "Runs a TypeScript coordinator with Copilot SDK retrieval and analysis agents. Retrieves a compact project backlog, screens meaning for up to 10 candidate pairs, then hydrates and verifies only the first maxPairs candidates (default 10). Returns validated verdicts and an execution trace. Sends bounded ticket data to Copilot models and consumes Copilot usage. Read-only; heuristic, not exhaustive. May take several minutes.",
        inputSchema: auditInputSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    }, async (input, extra) => {
        if (active) {
            return {
                isError: true,
                structuredContent: { status: "incomplete", error: diagnostic(new AuditFailure("AUDIT_BUSY"), extra.signal) },
                content: [{ type: "text" as const, text: "An audit is already running in this server. Wait for it to finish before retrying." }]
            };
        }
        active = true;
        const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(300000)]);
        try {
            const report = await service(input, signal);
            return {
                isError: report.status === "incomplete",
                structuredContent: { ...report },
                content: [{ type: "text" as const, text: JSON.stringify(report) }]
            };
        } catch {
            const error = diagnostic(new AuditFailure("RUNTIME_FAILURE"), signal);
            return {
                isError: true,
                structuredContent: { status: "incomplete", error },
                content: [{
                    type: "text" as const,
                    text: error.message
                }]
            };
        } finally {
            active = false;
        }
    });
}
