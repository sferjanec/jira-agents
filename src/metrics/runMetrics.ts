import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Per-run counters filled in by the model adapters. They hold numbers only, never prompts, ticket text or file contents.
export interface ModelTelemetry {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    // Sum of the SDK's billing multipliers; this is not a dollar amount.
    cost: number;
    apiMs: number;
    model?: string;
    readsApproved: number;
    readsDenied: number;
    bytesRead: number;
    budgetExhausted: boolean;
}

export function newTelemetry(): ModelTelemetry {
    return {
        modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0, apiMs: 0,
        readsApproved: 0, readsDenied: 0, bytesRead: 0, budgetExhausted: false
    };
}

// Accepts any session event and picks up the SDK's per-call "assistant.usage" payload.
export function applyUsageEvent(telemetry: ModelTelemetry, event: { type: string; data?: unknown }): void {
    if (event.type !== "assistant.usage") {
        return;
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
    telemetry.modelCalls += 1;
    telemetry.inputTokens += number(data.inputTokens);
    telemetry.outputTokens += number(data.outputTokens);
    telemetry.cacheReadTokens += number(data.cacheReadTokens);
    telemetry.cost += number(data.cost);
    telemetry.apiMs += number(data.duration);
    if (typeof data.model === "string") {
        telemetry.model = data.model;
    }
}

export interface RunRecord {
    ts: string;
    stage: "plan" | "build";
    issueKey: string;
    outcome: string;
    errorCode?: string;
    totalMs: number;
    spans: Record<string, number>;
    telemetry: ModelTelemetry;
    extra: Record<string, string | number | boolean>;
}

export function metricsFile(): string | undefined {
    return process.env.METRICS_FILE?.trim() || undefined;
}

// Collects timings and the outcome for one run and appends one JSON line when METRICS_FILE is set.
export class RunRecorder {
    readonly telemetry = newTelemetry();
    private readonly started = Date.now();
    private readonly spans: Record<string, number> = {};
    private readonly extra: Record<string, string | number | boolean> = {};
    private outcome = "unknown";
    private errorCode: string | undefined;

    constructor(private readonly stage: "plan" | "build", private readonly issueKey: string) {}

    async span<T>(name: string, operation: () => Promise<T>): Promise<T> {
        const start = Date.now();
        try {
            return await operation();
        } finally {
            this.spans[name] = (this.spans[name] ?? 0) + Date.now() - start;
        }
    }

    set(name: string, value: string | number | boolean): void {
        this.extra[name] = value;
    }

    succeed(outcome: string): void {
        this.outcome = outcome;
    }

    fail(error: unknown): void {
        const code = (error as { code?: unknown } | null)?.code;
        this.outcome = "failed";
        this.errorCode = typeof code === "string" ? code : "UNKNOWN";
    }

    // Telemetry must never break a run, so every write error is swallowed.
    async finish(): Promise<void> {
        const file = metricsFile();
        if (!file) {
            return;
        }
        const record: RunRecord = {
            ts: new Date().toISOString(),
            stage: this.stage,
            issueKey: this.issueKey,
            outcome: this.outcome,
            ...(this.errorCode ? { errorCode: this.errorCode } : {}),
            totalMs: Date.now() - this.started,
            spans: this.spans,
            telemetry: this.telemetry,
            extra: this.extra
        };
        try {
            await mkdir(dirname(file), { recursive: true });
            await appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
        } catch {
            // Ignored on purpose.
        }
    }
}
