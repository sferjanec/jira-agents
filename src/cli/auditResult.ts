import { z } from "zod";
const failureSchema = z.object({
    error: z.object({
        stage: z.enum(["backlog", "screening", "hydration", "verification"]).optional(),
        code: z.enum([
            "SDK_FAILURE", "STAGE_TIMEOUT", "AUDIT_TIMEOUT", "AUDIT_CANCELLED",
            "EMPTY_MODEL_RESPONSE", "MODEL_OUTPUT_TOO_LARGE", "INVALID_JSON",
            "SCHEMA_VALIDATION_FAILED", "BUSINESS_RULE_FAILED", "RETRIEVAL_FAILED",
            "RETRIEVAL_PROTOCOL_FAILED", "RUNTIME_FAILURE", "AUDIT_BUSY", "INTERNAL_FAILURE"
        ])
    })
});
export function writeAuditResult(
    result: unknown,
    stdout: (text: string) => void = console.log,
    stderr: (text: string) => void = console.error
): number {
    const parsed = z.object({
        structuredContent: z.unknown().optional(),
        content: z.unknown().optional(),
        isError: z.boolean().optional()
    }).safeParse(result);
    if (!parsed.success) {
        stderr("Audit failed: MCP returned an invalid result envelope.");
        return 1;
    }
    const envelope = parsed.data;
    const payload = envelope.structuredContent ?? envelope.content;
    if (payload === undefined) {
        stderr("Audit failed: MCP returned no report or content.");
        return 1;
    }
    stdout(JSON.stringify(payload, null, 2));
    if (!envelope.isError) {
        return 0;
    }
    const failure = failureSchema.safeParse(envelope.structuredContent);
    if (failure.success) {
        const { stage, code } = failure.data.error;
        stderr(`Audit failed${stage ? ` at ${stage}` : ""} [${code}]. See error.details and trace in the JSON report; do not treat partial results as a clean backlog.`);
    } else {
        stderr("Audit failed. See the JSON error result on stdout; no complete result is available.");
    }
    return 1;
}
