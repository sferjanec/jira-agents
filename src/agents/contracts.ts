import { z } from "zod";
import { backlogInputSchema, type fetchCandidateDescriptions, type fetchTriageBacklog } from "../jira/triage.js";
import type { AuditDiagnostic } from "./diagnostics.js";
export const auditInputSchema = backlogInputSchema.extend({
    maxCharacters: z.number().int().min(100).max(6000).default(3000),
    maxPairs: z.number().int().min(1).max(10).default(10)
        .describe("Review only the first N screening candidates, in returned order; caps description hydration and verification.")
});
export type AuditInput = z.input<typeof auditInputSchema>;
export type Backlog = Awaited<ReturnType<typeof fetchTriageBacklog>>;
export type Descriptions = Awaited<ReturnType<typeof fetchCandidateDescriptions>>;
export type AuditStage = "backlog" | "screening" | "hydration" | "verification";
export interface AuditProgress {
    stage: AuditStage | "audit" | "runtime";
    role?: "retriever" | "analyst";
    status: "started" | "running" | "completed" | "failed" | "skipped";
    elapsedMs: number;
    metrics?: Record<string, number | boolean>;
    error?: AuditDiagnostic;
}
export type AuditProgressListener = (event: AuditProgress) => void;
export interface AgentTool {
    name: string;
    description: string;
    execute(signal: AbortSignal): Promise<unknown>;
}
export interface AgentRequest {
    role: "retriever" | "analyst";
    stage: AuditStage;
    instructions: string;
    input: unknown;
    tools: AgentTool[];
}
export interface AgentRunner {
    run(request: AgentRequest, signal: AbortSignal): Promise<string>;
}
const key = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);
const explanation = z.string().trim().min(1).max(1000);
const confidence = z.enum(["low", "medium", "high"]);
export const candidateSchema = z.strictObject({
    keyA: key,
    keyB: key,
    reason: explanation,
    screeningConfidence: confidence
});
export const screeningSchema = z.strictObject({
    candidates: z.array(candidateSchema).max(10),
    screeningLimited: z.boolean(),
    limitations: explanation
});
export const verdictActions = {
    SUSPECTED_DUPLICATE: "REVIEW_AS_DUPLICATE",
    RELATED_BUT_DISTINCT: "CONSIDER_LINKING",
    FALSE_POSITIVE: "KEEP_SEPARATE",
    INSUFFICIENT_EVIDENCE: "GATHER_MORE_CONTEXT"
} as const;
export const evaluationSchema = z.strictObject({
    keyA: key,
    keyB: key,
    verdict: z.enum(["SUSPECTED_DUPLICATE", "RELATED_BUT_DISTINCT", "FALSE_POSITIVE", "INSUFFICIENT_EVIDENCE"]),
    confidence,
    evidence: explanation,
    differences: explanation,
    recommendedAction: z.enum(["REVIEW_AS_DUPLICATE", "CONSIDER_LINKING", "KEEP_SEPARATE", "GATHER_MORE_CONTEXT"])
        .describe(`Must match verdict using exactly this mapping: ${JSON.stringify(verdictActions)}`)
});
export const verificationSchema = z.strictObject({
    evaluations: z.array(evaluationSchema).max(10)
});
export type Candidate = z.infer<typeof candidateSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export interface AuditReport {
    projectKey: string;
    statuses: string[];
    status: "complete" | "limited" | "incomplete";
    summary: string;
    method: "llm-semantic-screening-and-description-review";
    coverage: {
        retrieved: number;
        limit: number;
        pagesFetched: number;
        truncated: boolean;
        possiblePairs: number;
        screeningLimited: boolean;
        candidatePairs: number;
        descriptionsFetched: number;
        missingDescriptions: number;
        truncatedDescriptions: number;
        pairsReviewed: number;
        agentInvocations: number;
    };
    candidates: Candidate[];
    evaluations: Evaluation[];
    descriptionCoverage: {
        key: string;
        missing: boolean;
        truncated: boolean;
        originalCharacters: number;
    }[];
    limitations: string[];
    trace: {
        role: AgentRequest["role"];
        stage: AuditStage;
        status: "completed" | "failed" | "skipped";
        elapsedMs: number;
    }[];
    error?: AuditDiagnostic & {
        stage: AuditStage;
    };
}
