import { z } from "zod";
const messages = {
    SDK_FAILURE: "Copilot SDK request or session failed. Check model availability, authentication, quota, and service access.",
    STAGE_TIMEOUT: "Agent stage exceeded its 60-second deadline.",
    AUDIT_TIMEOUT: "Audit exceeded its overall deadline.",
    AUDIT_CANCELLED: "Audit cancelled by the caller.",
    EMPTY_MODEL_RESPONSE: "Analysis agent returned no response.",
    MODEL_OUTPUT_TOO_LARGE: "Agent output exceeded the 50000-character response limit.",
    INVALID_JSON: "Agent returned invalid JSON.",
    SCHEMA_VALIDATION_FAILED: "Agent output did not match the required schema.",
    BUSINESS_RULE_FAILED: "Agent output violated a workflow validation rule.",
    RETRIEVAL_FAILED: "Approved Jira retrieval failed. Check Jira access and response format.",
    RETRIEVAL_PROTOCOL_FAILED: "Retrieval agent did not execute its approved tool successfully exactly once.",
    RUNTIME_FAILURE: "Audit runtime initialization or cleanup failed. No complete result is available.",
    AUDIT_BUSY: "An audit is already running in this server. Wait for it to finish before retrying.",
    INTERNAL_FAILURE: "Audit stage failed unexpectedly. No complete result is available."
} as const;
export type AuditErrorCode = keyof typeof messages;
export interface ValidationDetail {
    path: string;
    rule: string;
}
export interface AuditDiagnostic {
    code: AuditErrorCode;
    message: string;
    details?: ValidationDetail[];
}
export class AuditFailure extends Error {
    constructor(readonly code: AuditErrorCode, readonly details?: ValidationDetail[]) {
        super(messages[code]);
        this.name = "AuditFailure";
    }
}
export function cancellationFailure(signal: AbortSignal): AuditFailure {
    return new AuditFailure(
        signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
            ? "AUDIT_TIMEOUT" : "AUDIT_CANCELLED"
    );
}
export function stageFailure(error: unknown, auditSignal: AbortSignal, stageSignal: AbortSignal): AuditFailure {
    if (auditSignal.aborted) {
        return cancellationFailure(auditSignal);
    }
    if (stageSignal.aborted) {
        return new AuditFailure("STAGE_TIMEOUT");
    }
    return error instanceof AuditFailure ? error : new AuditFailure("SDK_FAILURE");
}
export function diagnostic(error: unknown, signal: AbortSignal): AuditDiagnostic {
    const failure = signal.aborted ? cancellationFailure(signal)
        : error instanceof AuditFailure ? error : new AuditFailure("INTERNAL_FAILURE");
    return {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {})
    };
}
const safeFields = new Set([
    "candidates", "evaluations", "keyA", "keyB", "reason", "screeningConfidence",
    "screeningLimited", "limitations", "verdict", "confidence", "evidence",
    "differences", "recommendedAction"
]);
export function parseAgentOutput<T>(text: string, schema: z.ZodType<T>): T {
    if (text.length > 50000) {
        throw new AuditFailure("MODEL_OUTPUT_TOO_LARGE");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        // JSON parse exceptions can contain fragments of model/ticket text.
        throw new AuditFailure("INVALID_JSON");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
        throw new AuditFailure("SCHEMA_VALIDATION_FAILED", result.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.map((part) => typeof part === "number" ? String(part)
                : typeof part === "string" && safeFields.has(part) ? part : "[field]").join(".") || "$",
            rule: issue.code
        })));
    }
    return result.data;
}
export function ruleFailure(rule: string, index?: number): AuditFailure {
    return new AuditFailure("BUSINESS_RULE_FAILED", [{
        path: index === undefined ? "$" : `evaluations.${index}`,
        rule
    }]);
}
