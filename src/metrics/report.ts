import type { RunRecord } from "./runMetrics.js";

export function parseRecords(text: string): RunRecord[] {
    const records: RunRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        try {
            const value = JSON.parse(line) as RunRecord;
            if (value && typeof value.stage === "string" && value.telemetry && typeof value.totalMs === "number") {
                records.push(value);
            }
        } catch {
            // Skip a damaged line (for example a partial write) and keep the rest.
        }
    }
    return records;
}

function percentile(values: number[], fraction: number): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : "n/a";
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const whole = (value: number) => Math.round(value).toLocaleString("en-US");

function stageReport(stage: string, runs: RunRecord[]): string[] {
    const count = (outcome: string) => runs.filter((run) => run.outcome === outcome).length;
    const outcomes = [...new Set(runs.map((run) => run.outcome))].map((outcome) => `${outcome} ${count(outcome)}`).join(", ");
    const lines = [`## ${stage} (${runs.length} runs)`, `Outcomes: ${outcomes}`];
    if (stage === "plan") {
        lines.push(`Clarification rate: ${percent(count("needs_clarification"), runs.length)}`);
        lines.push(`Read budget exhausted: ${percent(runs.filter((run) => run.telemetry.budgetExhausted).length, runs.length)}`);
        lines.push(`Reads per run (avg): ${(average(runs.map((run) => run.telemetry.readsApproved)) ).toFixed(1)} approved, ${(average(runs.map((run) => run.telemetry.readsDenied))).toFixed(1)} denied`);
        lines.push(`Bytes read per run: avg ${whole(average(runs.map((run) => run.telemetry.bytesRead)))}, max ${whole(Math.max(...runs.map((run) => run.telemetry.bytesRead)))}`);
    }
    const input = runs.map((run) => run.telemetry.inputTokens);
    const output = runs.map((run) => run.telemetry.outputTokens);
    lines.push(`Input tokens: avg ${whole(average(input))}, p95 ${whole(percentile(input, 0.95))}, max ${whole(Math.max(...input))}`);
    lines.push(`Output tokens: avg ${whole(average(output))}, p95 ${whole(percentile(output, 0.95))}, max ${whole(Math.max(...output))}`);
    lines.push(`Model calls per run (avg): ${average(runs.map((run) => run.telemetry.modelCalls)).toFixed(1)}; billing multiplier per run (avg): ${average(runs.map((run) => run.telemetry.cost)).toFixed(2)}`);

    const spanNames = [...new Set(runs.flatMap((run) => Object.keys(run.spans)))];
    const spanAverages = spanNames.map((name) => ({ name, avg: average(runs.map((run) => run.spans[name] ?? 0)) }))
        .sort((a, b) => b.avg - a.avg);
    lines.push(`Total time: avg ${seconds(average(runs.map((run) => run.totalMs)))}, p95 ${seconds(percentile(runs.map((run) => run.totalMs), 0.95))}`);
    if (spanAverages.length > 0) {
        lines.push(`Time by step (avg): ${spanAverages.map((span) => `${span.name} ${seconds(span.avg)}`).join(", ")}`);
        lines.push(`Slowest step: ${spanAverages[0].name}`);
    }
    const heaviest = [...runs].sort((a, b) => b.telemetry.inputTokens - a.telemetry.inputTokens).slice(0, 3);
    lines.push("Heaviest runs by input tokens:");
    for (const run of heaviest) {
        lines.push(`  ${run.issueKey} ${run.ts.slice(0, 19)}Z  ${whole(run.telemetry.inputTokens)} in / ${whole(run.telemetry.outputTokens)} out, ${seconds(run.totalMs)}, ${run.outcome}`);
    }
    return lines;
}

export function summarize(records: RunRecord[]): string {
    if (records.length === 0) {
        return "No runs recorded yet.";
    }
    const lines = ["# Agent run metrics", ""];
    for (const stage of ["plan", "build"]) {
        const runs = records.filter((record) => record.stage === stage);
        if (runs.length > 0) {
            lines.push(...stageReport(stage, runs), "");
        }
    }
    const tagged = new Set(records.filter((record) => record.extra.labelAdded === true).map((record) => record.issueKey));
    lines.push(`Tickets touched: ${new Set(records.map((record) => record.issueKey)).size}; tagged with the agent label: ${tagged.size}`);
    if (records.length < 20) {
        lines.push("Note: fewer than 20 runs, so treat these numbers as indications only.");
    }
    return lines.join("\n");
}
