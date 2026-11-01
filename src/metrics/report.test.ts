import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRecords, summarize } from "./report.js";
import { applyUsageEvent, newTelemetry, RunRecorder } from "./runMetrics.js";

test("usage events accumulate tokens, calls and duration, and other events are ignored", () => {
    const telemetry = newTelemetry();
    applyUsageEvent(telemetry, { type: "assistant.usage", data: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cost: 1, duration: 800, model: "m1" } });
    applyUsageEvent(telemetry, { type: "assistant.usage", data: { inputTokens: 50, outputTokens: 10 } });
    applyUsageEvent(telemetry, { type: "assistant.message", data: { inputTokens: 999 } });
    assert.equal(telemetry.modelCalls, 2);
    assert.equal(telemetry.inputTokens, 150);
    assert.equal(telemetry.outputTokens, 30);
    assert.equal(telemetry.cacheReadTokens, 5);
    assert.equal(telemetry.apiMs, 800);
    assert.equal(telemetry.model, "m1");
});

test("run recorder writes one metadata-only JSON line only when METRICS_FILE is set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "metrics-"));
    const file = join(directory, "nested", "runs.jsonl");
    const previous = process.env.METRICS_FILE;
    try {
        delete process.env.METRICS_FILE;
        const off = new RunRecorder("plan", "KAN-1");
        off.succeed("plan_saved");
        await off.finish();
        await assert.rejects(readFile(file, "utf8"));

        process.env.METRICS_FILE = file;
        const run = new RunRecorder("plan", "KAN-1");
        await run.span("model", async () => undefined);
        run.telemetry.inputTokens = 1234;
        run.set("labelAdded", true);
        run.fail({ code: "MODEL_REQUEST_FAILED" });
        await run.finish();
        const lines = (await readFile(file, "utf8")).trim().split("\n");
        assert.equal(lines.length, 1);
        const record = JSON.parse(lines[0]);
        assert.equal(record.issueKey, "KAN-1");
        assert.equal(record.outcome, "failed");
        assert.equal(record.errorCode, "MODEL_REQUEST_FAILED");
        assert.equal(record.telemetry.inputTokens, 1234);
        assert.equal(record.extra.labelAdded, true);
        assert.ok("model" in record.spans);
    } finally {
        if (previous === undefined) {
            delete process.env.METRICS_FILE;
        } else {
            process.env.METRICS_FILE = previous;
        }
        await rm(directory, { recursive: true });
    }
});

test("report summarizes runs and skips damaged lines", () => {
    const record = (key: string, outcome: string, input: number, exhausted: boolean, labelAdded = false) => JSON.stringify({
        ts: "2026-10-31T00:00:00.000Z", stage: "plan", issueKey: key, outcome, totalMs: 15000,
        spans: { jiraFetch: 500, model: 14000 },
        telemetry: { ...newTelemetry(), inputTokens: input, outputTokens: 800, modelCalls: 3, readsApproved: 5, budgetExhausted: exhausted },
        extra: { labelAdded }
    });
    const text = [
        record("KAN-1", "plan_saved", 20000, false, true),
        record("KAN-2", "needs_clarification", 45000, true, true),
        "{not json"
    ].join("\n");
    const records = parseRecords(text);
    assert.equal(records.length, 2);
    const report = summarize(records);
    assert.match(report, /plan \(2 runs\)/);
    assert.match(report, /Clarification rate: 50%/);
    assert.match(report, /Read budget exhausted: 50%/);
    assert.match(report, /Slowest step: model/);
    assert.match(report, /KAN-2.*45,000 in/);
    assert.match(report, /tagged with the agent label: 2/);
    assert.equal(summarize([]), "No runs recorded yet.");
});
