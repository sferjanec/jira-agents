import assert from "node:assert/strict";
import { test } from "node:test";
import { auditDuplicates } from "./audit.js";
import type { AgentRequest, AgentRunner, AgentTool, AuditProgress } from "./contracts.js";
import { logAuditProgress } from "./progress.js";
import type { JiraReader } from "../jira/triage.js";
import { AuditFailure, diagnostic, parseAgentOutput, stageFailure } from "./diagnostics.js";
import { verificationSchema, verdictActions } from "./contracts.js";
const candidate = {
    keyA: "DEMO-1", keyB: "DEMO-2",
    reason: "Both describe a login redirect loop.", screeningConfidence: "high"
};
const screening = {
    candidates: [candidate], screeningLimited: false, limitations: "Titles may omit important differences."
};
const evaluation = {
    keyA: "DEMO-1", keyB: "DEMO-2", verdict: "SUSPECTED_DUPLICATE", confidence: "high",
    evidence: "Both describe repeated login redirects after session expiry.",
    differences: "No meaningful scope differences in the supplied descriptions.",
    recommendedAction: "REVIEW_AS_DUPLICATE"
};
function fixture(count = 3, descriptions: Record<string, string | null> = {}) {
    const hydrated: string[] = [];
    const searches: unknown[] = [];
    const reader: JiraReader = {
        async search(body, signal) {
            signal?.throwIfAborted();
            searches.push(body);
            return {
                issues: Array.from({ length: count }, (_, index) => ({
                    key: `DEMO-${index + 1}`,
                    fields: {
                        summary: index < 2 ? "Login redirect loop" : "Export chart data",
                        status: { name: "To Do" }, created: "2026-10-01"
                    }
                })),
                isLast: true
            };
        },
        async issue(key, _fields, signal) {
            signal?.throwIfAborted();
            hydrated.push(key);
            return {
                key, fields: {
                    summary: "Login redirect loop",
                    description: key in descriptions ? descriptions[key] : "Repeated login redirects after session expiry."
                }
            };
        }
    };
    return { reader, hydrated, searches };
}
class ScriptedRunner implements AgentRunner {
    readonly requests: AgentRequest[] = [];
    constructor(
        private readonly screen: unknown = screening,
        private readonly verify: unknown = { evaluations: [evaluation] }
    ) {}
    async run(request: AgentRequest, signal: AbortSignal): Promise<string> {
        this.requests.push(request);
        if (request.role === "retriever") {
            assert.equal(request.tools.length, 1);
            await request.tools[0].execute(signal);
            return "Retrieved.";
        }
        assert.deepEqual(request.tools, []);
        const value = request.stage === "screening" ? this.screen : this.verify;
        return typeof value === "string" ? value : JSON.stringify(value);
    }
}
test("pair limit hydrates and verifies only the first candidates while preserving discovered pairs", async () => {
    const candidates = [
        { ...candidate, keyA: "DEMO-5", keyB: "DEMO-6" },
        { ...candidate, keyA: "DEMO-1", keyB: "DEMO-2" },
        { ...candidate, keyA: "DEMO-3", keyB: "DEMO-4" }
    ];
    for (const maxPairs of [1, 2, 3, 10]) {
        const { reader, hydrated } = fixture(6);
        const selected = candidates.slice(0, maxPairs);
        const runner = new ScriptedRunner({ ...screening, candidates }, {
            evaluations: selected.map(({ keyA, keyB }) => ({ ...evaluation, keyA, keyB }))
        });
        const events: AuditProgress[] = [];
        const result = await auditDuplicates(reader, runner, { projectKey: "DEMO", maxPairs },
            new AbortController().signal, (event) => events.push(event));
        assert.deepEqual(hydrated, selected.flatMap(({ keyA, keyB }) => [keyA, keyB]));
        const request = runner.requests.find((item) => item.stage === "verification");
        assert.ok(request && typeof request.input === "object" && request.input !== null && "data" in request.input);
        const data = request.input.data;
        assert.ok(typeof data === "object" && data !== null && "candidates" in data && "descriptions" in data);
        assert.deepEqual(data.candidates, selected);
        assert.ok(Array.isArray(data.descriptions));
        assert.equal(data.descriptions.length, selected.length * 2);
        assert.deepEqual(result.candidates, candidates);
        assert.equal(result.coverage.candidatePairs, 3);
        assert.equal(result.coverage.pairsReviewed, selected.length);
        assert.equal(result.status, maxPairs < 3 ? "limited" : "complete");
        assert.equal(result.limitations.some((text) => text.includes("Pair review capped")), maxPairs < 3);
        assert.equal(events.find((event) => event.stage === "screening" && event.status === "completed")
            ?.metrics?.pairsSelectedForReview, selected.length);
    }
});
test("pair cap does not permit evaluations of unselected pairs", async () => {
    const { reader } = fixture(4);
    const candidates = [candidate, { ...candidate, keyA: "DEMO-3", keyB: "DEMO-4" }];
    const result = await auditDuplicates(reader, new ScriptedRunner({ ...screening, candidates }, {
        evaluations: [{ ...evaluation, keyA: "DEMO-3", keyB: "DEMO-4" }]
    }), { projectKey: "DEMO", maxPairs: 1 });
    assert.equal(result.status, "incomplete");
    assert.equal(result.error?.details?.[0].rule, "UNKNOWN_OR_REPEATED_PAIR");
});
test("verification instructions and schema expose the exact mapping enforced by the coordinator", async () => {
    const { reader } = fixture();
    const runner = new ScriptedRunner();
    await auditDuplicates(reader, runner, { projectKey: "DEMO" });
    const request = runner.requests.find((item) => item.stage === "verification");
    assert.ok(request);
    assert.ok(request.instructions.includes(JSON.stringify(verdictActions)));
    assert.ok(JSON.stringify(request.input).includes("allowedVerdictActions"));
    assert.ok(JSON.stringify(verificationSchema.toJSONSchema()).includes("Must match verdict"));
});
test("all verdict/action combinations are accepted only when they match the documented mapping", async () => {
    for (const [verdict, expectedAction] of Object.entries(verdictActions)) {
        for (const recommendedAction of Object.values(verdictActions)) {
            const { reader } = fixture();
            const result = await auditDuplicates(reader, new ScriptedRunner(screening, {
                evaluations: [{ ...evaluation, verdict, recommendedAction }]
            }), { projectKey: "DEMO" });
            if (recommendedAction === expectedAction) {
                assert.notEqual(result.status, "incomplete", `${verdict}/${recommendedAction}`);
                assert.equal(result.evaluations[0].recommendedAction, expectedAction);
            } else {
                assert.equal(result.error?.code, "BUSINESS_RULE_FAILED");
                assert.equal(result.error?.details?.[0].rule, "VERDICT_ACTION_MISMATCH");
            }
        }
    }
});
test("progress emits ordered stage start/completion events, observed metrics and total timing", async () => {
    const { reader } = fixture();
    const events: AuditProgress[] = [];
    const result = await auditDuplicates(reader, new ScriptedRunner(), { projectKey: "DEMO" },
        new AbortController().signal, (event) => events.push(event));
    assert.equal(result.status, "complete");
    assert.deepEqual(events.map((event) => `${event.stage}:${event.status}`), [
        "audit:started", "backlog:started", "backlog:completed",
        "screening:started", "screening:completed", "hydration:started",
        "hydration:completed", "verification:started", "verification:completed", "audit:completed"
    ]);
    assert.deepEqual(events[2].metrics, { retrieved: 3, pagesFetched: 1, truncated: false });
    assert.deepEqual(events[4].metrics, { candidatePairs: 1, pairsSelectedForReview: 1, screeningLimited: false });
    assert.deepEqual(events[6].metrics, {
        descriptionsFetched: 2, missingDescriptions: 0, truncatedDescriptions: 0
    });
    assert.deepEqual(events[8].metrics, { pairsReviewed: 1 });
    assert.ok(events.every((event) => Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0));
    for (const entry of result.trace) {
        assert.equal(events.find((event) => event.stage === entry.stage && event.status === "completed")?.elapsedMs, entry.elapsedMs);
    }
    assert.doesNotMatch(JSON.stringify(events), /Login redirect|session expiry|DEMO-/);
});
test("running heartbeats stop when a stage completes or fails", async (context) => {
    context.mock.timers.enable({ apis: ["setInterval"] });
    for (const fail of [false, true]) {
        const { reader } = fixture();
        const events: AuditProgress[] = [];
        const delegate = new ScriptedRunner({ ...screening, candidates: [] });
        await auditDuplicates(reader, {
            async run(request, signal) {
                if (request.stage === "screening") {
                    context.mock.timers.tick(10000);
                    if (fail) {
                        throw new AuditFailure("SDK_FAILURE");
                    }
                }
                return delegate.run(request, signal);
            }
        }, { projectKey: "DEMO" }, new AbortController().signal, (event) => events.push(event));
        assert.equal(events.filter((event) => event.stage === "screening" && event.status === "running").length, 1);
        const count = events.length;
        context.mock.timers.tick(30000);
        assert.equal(events.length, count);
        assert.equal(events.find((event) => event.stage === "hydration")?.status, "skipped");
    }
});
test("failed progress includes safe validation details and stderr logger adds timestamps", async (context) => {
    const { reader } = fixture();
    const events: AuditProgress[] = [];
    await auditDuplicates(reader, new ScriptedRunner(screening, {
        evaluations: [{ ...evaluation, recommendedAction: "KEEP_SEPARATE" }]
    }), { projectKey: "DEMO" }, new AbortController().signal, (event) => events.push(event));
    const failure = events.find((event) => event.stage === "verification" && event.status === "failed");
    assert.ok(failure);
    assert.equal(failure.error?.code, "BUSINESS_RULE_FAILED");
    assert.deepEqual(failure.error?.details, [{ path: "evaluations.0", rule: "VERDICT_ACTION_MISMATCH" }]);
    const lines: string[] = [];
    context.mock.method(console, "error", (text: string) => lines.push(text));
    logAuditProgress(failure);
    assert.match(lines[0], /^\[jira-audit\] /);
    const parsed = JSON.parse(lines[0].slice("[jira-audit] ".length));
    assert.ok(Number.isFinite(Date.parse(parsed.timestamp)));
    assert.equal(parsed.stage, "verification");
    assert.doesNotMatch(lines[0], /Login redirect|session expiry|DEMO-/);
});
test("runs separate retrieval/analysis stages, captures real tool data and returns a validated report", async () => {
    const { reader, hydrated } = fixture();
    const runner = new ScriptedRunner();
    const result = await auditDuplicates(reader, runner, { projectKey: "DEMO" });
    assert.equal(result.status, "complete");
    assert.deepEqual(runner.requests.map((request) => [request.role, request.stage]), [
        ["retriever", "backlog"], ["analyst", "screening"],
        ["retriever", "hydration"], ["analyst", "verification"]
    ]);
    assert.deepEqual(hydrated, ["DEMO-1", "DEMO-2"]);
    assert.deepEqual(result.evaluations, [evaluation]);
    assert.deepEqual(result.coverage, {
        retrieved: 3, limit: 30, pagesFetched: 1, truncated: false,
        possiblePairs: 3, screeningLimited: false, candidatePairs: 1,
        descriptionsFetched: 2, missingDescriptions: 0, truncatedDescriptions: 0,
        pairsReviewed: 1, agentInvocations: 4
    });
    assert.ok(result.trace.every((entry) => entry.status === "completed"));
    assert.ok(result.trace.every((entry) => Number.isInteger(entry.elapsedMs) && entry.elapsedMs >= 0));
    assert.doesNotMatch(JSON.stringify(runner.requests[1].input), /description/);
});
test("invalid JSON is diagnosed without leaking model text", async () => {
    const { reader } = fixture();
    const result = await auditDuplicates(reader, new ScriptedRunner(
        screening, 'secret-model-text {"evaluations":'
    ), { projectKey: "DEMO" });
    assert.equal(result.error?.code, "INVALID_JSON");
    assert.equal(result.error?.stage, "verification");
    assert.ok((result.trace.find((entry) => entry.stage === "verification")?.elapsedMs ?? -1) >= 0);
    assert.doesNotMatch(JSON.stringify(result), /secret-model-text/);
});
test("schema diagnostics identify field path and rule without echoing values or unknown property names", async () => {
    const { reader } = fixture();
    const result = await auditDuplicates(reader, new ScriptedRunner(screening, {
        evaluations: [{ ...evaluation, evidence: "SECRET".repeat(200) }]
    }), { projectKey: "DEMO" });
    assert.equal(result.error?.code, "SCHEMA_VALIDATION_FAILED");
    assert.deepEqual(result.error?.details, [{ path: "evaluations.0.evidence", rule: "too_big" }]);
    assert.doesNotMatch(JSON.stringify(result.error), /SECRET/);
    try {
        parseAgentOutput(JSON.stringify({ evaluations: [], "private-ticket-content": true }), verificationSchema);
        assert.fail("Expected schema failure");
    } catch (error) {
        assert.ok(error instanceof AuditFailure);
        assert.equal(error.code, "SCHEMA_VALIDATION_FAILED");
        assert.doesNotMatch(JSON.stringify(error.details), /private-ticket-content/);
    }
});
test("missing-description business-rule failure identifies the evaluation index", async () => {
    const { reader } = fixture(2, { "DEMO-1": null });
    const result = await auditDuplicates(reader, new ScriptedRunner(), { projectKey: "DEMO" });
    assert.equal(result.error?.code, "BUSINESS_RULE_FAILED");
    assert.deepEqual(result.error?.details, [{
        path: "evaluations.0", rule: "MISSING_DESCRIPTION_REQUIRES_INSUFFICIENT_EVIDENCE"
    }]);
});
test("SDK failures and stage timeouts stay distinct in reports", async () => {
    for (const code of ["SDK_FAILURE", "STAGE_TIMEOUT"] as const) {
        const { reader } = fixture();
        const delegate = new ScriptedRunner();
        const result = await auditDuplicates(reader, {
            async run(request, signal) {
                if (request.stage === "verification") {
                    throw new AuditFailure(code);
                }
                return delegate.run(request, signal);
            }
        }, { projectKey: "DEMO" });
        assert.equal(result.error?.code, code);
        assert.equal(result.error?.stage, "verification");
        assert.equal(result.trace[3].status, "failed");
        assert.equal(result.coverage.pairsReviewed, 0);
    }
});
test("SDK boundary classifies stage deadlines, audit deadlines and cancellation without raw exception text", () => {
    const active = new AbortController().signal;
    const timedOut = AbortSignal.abort(new DOMException("private-timeout-details", "TimeoutError"));
    const cancelled = AbortSignal.abort("private-cancellation-reason");
    assert.equal(stageFailure(new Error("private-sdk-response"), active, active).code, "SDK_FAILURE");
    assert.equal(stageFailure(new Error("private-sdk-response"), active, timedOut).code, "STAGE_TIMEOUT");
    assert.equal(stageFailure(new Error("private-sdk-response"), timedOut, timedOut).code, "AUDIT_TIMEOUT");
    assert.equal(stageFailure(new Error("private-sdk-response"), cancelled, cancelled).code, "AUDIT_CANCELLED");
    assert.doesNotMatch(JSON.stringify(diagnostic(new Error("private-sdk-response"), active)), /private/);
});
test("skipped stages have zero duration and Jira failures have a dedicated code", async () => {
    const { reader } = fixture();
    reader.search = async () => { throw new Error("private-http-response"); };
    const result = await auditDuplicates(reader, new ScriptedRunner(), { projectKey: "DEMO" });
    assert.equal(result.error?.code, "RETRIEVAL_FAILED");
    assert.ok(result.trace.filter((entry) => entry.status === "skipped").every((entry) => entry.elapsedMs === 0));
    assert.doesNotMatch(JSON.stringify(result), /private-http-response/);
});
test("hydrates each approved key once even when it occurs in multiple pairs", async () => {
    const { reader, hydrated } = fixture();
    const result = await auditDuplicates(reader, new ScriptedRunner({
        ...screening, candidates: [candidate, { ...candidate, keyB: "DEMO-3" }]
    }, { evaluations: [evaluation, { ...evaluation, keyB: "DEMO-3" }] }), { projectKey: "DEMO" });
    assert.equal(result.status, "complete");
    assert.deepEqual(hydrated, ["DEMO-1", "DEMO-2", "DEMO-3"]);
    assert.equal(result.coverage.pairsReviewed, 2);
});
for (const count of [0, 1]) {
    test(`${count} tickets skips screening, hydration and verification`, async () => {
        const { reader, hydrated } = fixture(count);
        const runner = new ScriptedRunner();
        const result = await auditDuplicates(reader, runner, { projectKey: "DEMO" });
        assert.equal(result.status, "complete");
        assert.equal(runner.requests.length, 1);
        assert.deepEqual(hydrated, []);
        assert.equal(result.coverage.pairsReviewed, 0);
        assert.deepEqual(result.trace.map((entry) => entry.status), ["completed", "skipped", "skipped", "skipped"]);
    });
}
test("zero candidates does not fetch descriptions or invoke verification", async () => {
    const { reader, hydrated } = fixture();
    const runner = new ScriptedRunner({ ...screening, candidates: [] });
    const result = await auditDuplicates(reader, runner, { projectKey: "DEMO" });
    assert.equal(result.status, "complete");
    assert.equal(runner.requests.length, 2);
    assert.deepEqual(hydrated, []);
    assert.match(result.summary, /does not prove/);
});
for (const [label, candidates] of [
    ["self pair", [{ ...candidate, keyB: candidate.keyA }]],
    ["unknown key", [{ ...candidate, keyB: "OTHER-1" }]],
    ["duplicate unordered pair", [candidate, { ...candidate, keyA: candidate.keyB, keyB: candidate.keyA }]],
    ["more than 10 pairs", Array.from({ length: 11 }, () => candidate)]
] as const) {
    test(`rejects screening ${label} before hydration`, async () => {
        const { reader, hydrated } = fixture();
        const result = await auditDuplicates(reader, new ScriptedRunner({ ...screening, candidates }), { projectKey: "DEMO" });
        assert.equal(result.status, "incomplete");
        assert.equal(result.error?.stage, "screening");
        assert.deepEqual(hydrated, []);
    });
}
for (const output of ["not json", "``json\n{}\n``", JSON.stringify({ ...screening, extra: true }), "x".repeat(50001)]) {
    test(`rejects malformed or oversized model output (${output.length} characters)`, async () => {
        const { reader, hydrated } = fixture();
        const result = await auditDuplicates(reader, new ScriptedRunner(output), { projectKey: "DEMO" });
        assert.equal(result.status, "incomplete");
        assert.deepEqual(hydrated, []);
    });
}
test("description review can reject a title collision as a false positive", async () => {
    const { reader } = fixture(2, { "DEMO-1": "Backend session expiry.", "DEMO-2": "UI chart layout." });
    const result = await auditDuplicates(reader, new ScriptedRunner(screening, {
        evaluations: [{
            ...evaluation, verdict: "FALSE_POSITIVE", recommendedAction: "KEEP_SEPARATE",
            evidence: "The descriptions address unrelated behavior.",
            differences: "One is backend session behavior; the other is UI layout."
        }]
    }), { projectKey: "DEMO" });
    assert.equal(result.status, "complete");
    assert.equal(result.evaluations[0].verdict, "FALSE_POSITIVE");
});
for (const [label, evaluations] of [
    ["missing pair", []],
    ["unknown pair", [{ ...evaluation, keyB: "OTHER-1" }]],
    ["repeated pair", [evaluation, evaluation]],
    ["invalid verdict", [{ ...evaluation, verdict: "DUPLICATE_CONFIRMED" }]],
    ["inconsistent action", [{ ...evaluation, recommendedAction: "KEEP_SEPARATE" }]]
]) {
    test(`rejects verification with ${label}`, async () => {
        const { reader } = fixture();
        const result = await auditDuplicates(reader, new ScriptedRunner(screening, { evaluations }), { projectKey: "DEMO" });
        assert.equal(result.status, "incomplete");
        assert.equal(result.error?.stage, "verification");
        assert.deepEqual(result.evaluations, []);
    });
}
test("missing descriptions require insufficient evidence and mark a successful audit limited", async () => {
    const { reader } = fixture(2, { "DEMO-1": null });
    const invalid = await auditDuplicates(reader, new ScriptedRunner(), { projectKey: "DEMO" });
    assert.equal(invalid.status, "incomplete");
    const valid = await auditDuplicates(reader, new ScriptedRunner(screening, {
        evaluations: [{
            ...evaluation, verdict: "INSUFFICIENT_EVIDENCE", confidence: "low",
            evidence: "One description is missing.", recommendedAction: "GATHER_MORE_CONTEXT"
        }]
    }), { projectKey: "DEMO" });
    assert.equal(valid.status, "limited");
    assert.equal(valid.coverage.missingDescriptions, 1);
    assert.deepEqual(valid.descriptionCoverage.find((issue) => issue.key === "DEMO-1"), {
        key: "DEMO-1", missing: true, truncated: false, originalCharacters: 0
    });
});
test("truncated descriptions cannot support high confidence", async () => {
    const { reader } = fixture(2, { "DEMO-1": "x".repeat(200) });
    const invalid = await auditDuplicates(reader, new ScriptedRunner(), { projectKey: "DEMO", maxCharacters: 100 });
    assert.equal(invalid.status, "incomplete");
    const valid = await auditDuplicates(reader, new ScriptedRunner(screening, {
        evaluations: [{ ...evaluation, confidence: "medium", evidence: "The supplied truncated excerpt overlaps." }]
    }), { projectKey: "DEMO", maxCharacters: 100 });
    assert.equal(valid.status, "limited");
    assert.equal(valid.coverage.truncatedDescriptions, 1);
});
test("requires a real approved tool invocation, not a fabricated retriever response", async () => {
    const { reader, searches } = fixture();
    const result = await auditDuplicates(reader, {
        async run() { return JSON.stringify({ issues: [] }); }
    }, { projectKey: "DEMO" });
    assert.equal(result.status, "incomplete");
    assert.equal(result.error?.stage, "backlog");
    assert.equal(searches.length, 0);
});
test("a second retrieval call is rejected even if the agent catches its error", async () => {
    const { reader, searches } = fixture();
    const result = await auditDuplicates(reader, {
        async run(request, signal) {
            await request.tools[0].execute(signal);
            await assert.rejects(request.tools[0].execute(signal), /only be called once/);
            return "Done";
        }
    }, { projectKey: "DEMO" });
    assert.equal(result.status, "incomplete");
    assert.equal(searches.length, 1);
});
test("retrieval failures are sanitized, terminal, and do not masquerade as no duplicates", async () => {
    const { reader, hydrated } = fixture();
    reader.search = async () => { throw new Error("secret-http-response"); };
    const result = await auditDuplicates(reader, new ScriptedRunner(), { projectKey: "DEMO" });
    assert.equal(result.status, "incomplete");
    assert.equal(result.error?.stage, "backlog");
    assert.deepEqual(hydrated, []);
    assert.doesNotMatch(JSON.stringify(result), /secret-http-response/);
});
test("hydration failure skips verification and does not substitute empty descriptions", async () => {
    const { reader } = fixture();
    reader.issue = async () => { throw new Error("Denied"); };
    const runner = new ScriptedRunner();
    const result = await auditDuplicates(reader, runner, { projectKey: "DEMO" });
    assert.equal(result.status, "incomplete");
    assert.equal(result.error?.stage, "hydration");
    assert.equal(runner.requests.length, 3);
    assert.deepEqual(result.evaluations, []);
});
test("cancelled audits stop before any model or Jira calls", async () => {
    const { reader, searches } = fixture();
    const runner = new ScriptedRunner();
    const result = await auditDuplicates(reader, runner, { projectKey: "DEMO" }, AbortSignal.abort());
    assert.equal(result.status, "incomplete");
    assert.match(result.error?.message ?? "", /cancelled/);
    assert.equal(runner.requests.length, 0);
    assert.equal(searches.length, 0);
});
test("invalid project input fails before any agent invocation", async () => {
    const { reader } = fixture();
    const runner = new ScriptedRunner();
    await assert.rejects(auditDuplicates(reader, runner, { projectKey: 'DEMO" OR project = OTHER' }));
    assert.equal(runner.requests.length, 0);
});
test("an explicit screening limitation propagates even with zero candidates", async () => {
    const { reader, hydrated } = fixture();
    const result = await auditDuplicates(reader, new ScriptedRunner({
        ...screening, candidates: [], screeningLimited: true
    }), { projectKey: "DEMO" });
    assert.equal(result.status, "limited");
    assert.equal(result.coverage.screeningLimited, true);
    assert.deepEqual(hydrated, []);
});
test("a truncated backlog stays limited and preserves the observed retrieval counts", async () => {
    const { reader } = fixture();
    reader.search = async () => ({
        issues: [{
            key: "DEMO-1",
            fields: { summary: "Login problem", status: { name: "To Do" }, created: "2026-10-01" }
        }],
        isLast: false, nextPageToken: "more"
    });
    const result = await auditDuplicates(reader, new ScriptedRunner(), { projectKey: "DEMO", maxIssues: 1 });
    assert.equal(result.status, "limited");
    assert.equal(result.coverage.truncated, true);
    assert.equal(result.coverage.retrieved, 1);
    assert.equal(result.coverage.agentInvocations, 1);
});
test("late retrieval tool callbacks cannot query Jira after their stage has closed", async () => {
    const { reader, searches } = fixture();
    let savedTool: AgentTool | undefined;
    const result = await auditDuplicates(reader, {
        async run(request) {
            savedTool = request.tools[0];
            return "I did not invoke the tool";
        }
    }, { projectKey: "DEMO" });
    assert.equal(result.status, "incomplete");
    assert.ok(savedTool);
    await assert.rejects(savedTool.execute(new AbortController().signal), /only be called once/);
    assert.equal(searches.length, 0);
});
test("cancellation reaches in-flight Jira requests and skips remaining stages", async () => {
    const controller = new AbortController();
    const { reader } = fixture();
    reader.issue = async (_key, _fields, signal) => {
        assert.ok(signal);
        const cancelled = new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Request cancelled")), { once: true });
        });
        controller.abort();
        return cancelled;
    };
    const runner = new ScriptedRunner();
    const result = await auditDuplicates(reader, runner, { projectKey: "DEMO" }, controller.signal);
    assert.equal(result.status, "incomplete");
    assert.equal(result.error?.stage, "hydration");
    assert.match(result.error?.message ?? "", /cancelled/);
    assert.equal(runner.requests.length, 3);
});
test("screening limits are explicit and the candidate cap bounds hydration to 20 keys", async () => {
    const { reader, hydrated } = fixture(20);
    const candidates = Array.from({ length: 10 }, (_, index) => ({
        ...candidate, keyA: `DEMO-${index * 2 + 1}`, keyB: `DEMO-${index * 2 + 2}`
    }));
    const evaluations = candidates.map((pair) => ({ ...evaluation, keyA: pair.keyA, keyB: pair.keyB }));
    const result = await auditDuplicates(reader, new ScriptedRunner(
        { ...screening, candidates }, { evaluations }
    ), { projectKey: "DEMO" });
    assert.equal(result.status, "limited");
    assert.equal(result.coverage.screeningLimited, true);
    assert.equal(hydrated.length, 20);
    assert.equal(result.coverage.possiblePairs, 190);
});
