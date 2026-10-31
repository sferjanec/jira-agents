import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchCandidateDescriptions, fetchTriageBacklog, type JiraReader } from "./triage.js";
function issue(number: number) {
    return {
        key: `DEMO-${number}`,
        fields: { summary: `Ticket ${number}`, status: { name: "To Do" }, created: "2026-10-01T00:00:00Z" }
    };
}
function reader(overrides: Partial<JiraReader> = {}): JiraReader {
    return {
        async search() { throw new Error("Unexpected search"); },
        async issue() { throw new Error("Unexpected description hydration"); },
        ...overrides
    };
}
test("retrieves 100 compact records across pages and reports 4,950 possible pairs", async () => {
    const calls: Parameters<JiraReader["search"]>[0][] = [];
    const result = await fetchTriageBacklog(reader({
        async search(body) {
            calls.push(body);
            const offset = calls.length === 1 ? 0 : 50;
            return {
                issues: Array.from({ length: 50 }, (_, index) => issue(offset + index + 1)),
                isLast: offset === 50,
                ...(offset === 0 ? { nextPageToken: "page-two" } : {})
            };
        }
    }), { projectKey: "DEMO", maxIssues: 100 });
    assert.equal(result.issues.length, 100);
    assert.deepEqual(result.coverage, {
        retrieved: 100, limit: 100, pagesFetched: 2, truncated: false, possiblePairs: 4950
    });
    assert.deepEqual(calls.map((call) => call.maxResults), [100, 50]);
    assert.equal(calls[1].nextPageToken, "page-two");
    assert.deepEqual(calls[0].fields, ["summary", "status", "created"]);
    assert.deepEqual(Object.keys(result.issues[0]), ["key", "summary", "status", "created"]);
    assert.match(calls[0].jql, /status in \("To Do", "In Progress"\)/);
});
test("marks a capped backlog incomplete rather than claiming full coverage", async () => {
    const result = await fetchTriageBacklog(reader({
        async search() { return { issues: [issue(1), issue(2)], nextPageToken: "more", isLast: false }; }
    }), { projectKey: "DEMO", maxIssues: 2 });
    assert.equal(result.coverage.truncated, true);
    assert.equal(result.coverage.possiblePairs, 1);
});
test("an empty final backlog does not hydrate descriptions", async () => {
    const result = await fetchTriageBacklog(reader({
        async search() { return { issues: [], isLast: true }; }
    }), { projectKey: "DEMO" });
    assert.equal(result.coverage.retrieved, 0);
    assert.equal(result.coverage.truncated, false);
});
test("rejects repeated pagination tokens, missing continuation and repeated issues", async () => {
    let page = 0;
    await assert.rejects(fetchTriageBacklog(reader({
        async search() { return { issues: [issue(++page)], nextPageToken: "same" }; }
    }), { projectKey: "DEMO" }), /pagination did not advance/);
    await assert.rejects(fetchTriageBacklog(reader({
        async search() { return { issues: [issue(1)] }; }
    }), { projectKey: "DEMO" }), /continuation token/);
    await assert.rejects(fetchTriageBacklog(reader({
        async search() { return { issues: [issue(1)], nextPageToken: String(++page) }; }
    }), { projectKey: "DEMO" }), /repeated issues/);
});
test("validates scope and limits before making requests and escapes statuses", async () => {
    await assert.rejects(fetchTriageBacklog(reader(), { projectKey: 'DEMO" OR project = OTHER' }));
    await assert.rejects(fetchTriageBacklog(reader(), { projectKey: "DEMO", maxIssues: 101 }));
    await assert.rejects(fetchTriageBacklog(reader(), { projectKey: "DEMO", statuses: [] }));
    await fetchTriageBacklog(reader({
        async search(body) {
            assert.ok(body.jql.includes('status in ("Ready \\"Now\\"")'));
            return { issues: [], isLast: true };
        }
    }), { projectKey: "DEMO", statuses: ['Ready "Now"'] });
});
test("hydrates unique approved keys once, requests only required fields and flattens rich text", async () => {
    const calls: string[] = [];
    const result = await fetchCandidateDescriptions(reader({
        async issue(key, fields) {
            calls.push(key);
            assert.deepEqual(fields, ["summary", "description"]);
            return {
                key,
                fields: {
                    summary: "SSO redirect",
                    description: {
                        type: "doc",
                        content: [
                            { type: "paragraph", content: [
                                { type: "text", text: "Fix ", marks: [{ type: "strong" }] },
                                { type: "text", text: "SSO" },
                                { type: "hardBreak" },
                                { type: "text", text: "redirect" }
                            ] },
                            { type: "paragraph", content: [{ type: "text", text: "Acceptance criteria" }] },
                            { type: "mediaSingle", content: [{ type: "media", attrs: { id: "not-text" } }] }
                        ]
                    }
                }
            };
        }
    }), { issueKeys: ["DEMO-1", "DEMO-2", "DEMO-1"] });
    assert.deepEqual(calls, ["DEMO-1", "DEMO-2"]);
    assert.equal(result.fetched, 2);
    assert.equal(result.issues[0].description, "Fix SSO\nredirect\nAcceptance criteria");
    assert.equal(result.issues[0].missing, false);
    assert.equal(result.issues[0].truncated, false);
});
test("marks missing and truncated descriptions without inventing evidence", async () => {
    const result = await fetchCandidateDescriptions(reader({
        async issue(key) {
            return { key, fields: { summary: "Title", description: key === "DEMO-1" ? null : "x".repeat(150) } };
        }
    }), { issueKeys: ["DEMO-1", "DEMO-2"], maxCharacters: 100 });
    assert.equal(result.issues[0].missing, true);
    assert.equal(result.issues[1].description.length, 100);
    assert.equal(result.issues[1].originalCharacters, 150);
    assert.equal(result.issues[1].truncated, true);
});
test("rejects excessive keys, unexpected response keys and malformed descriptions", async () => {
    await assert.rejects(fetchCandidateDescriptions(reader(), {
        issueKeys: Array.from({ length: 21 }, (_, index) => `DEMO-${index + 1}`)
    }));
    await assert.rejects(fetchCandidateDescriptions(reader({
        async issue() { return { key: "OTHER-1", fields: { summary: "Title" } }; }
    }), { issueKeys: ["DEMO-1"] }), /different issue key/);
    await assert.rejects(fetchCandidateDescriptions(reader({
        async issue(key) { return { key, fields: { summary: "Title", description: 123 } }; }
    }), { issueKeys: ["DEMO-1"] }), /unsupported description/);
});
test("does not turn request failures into empty successful results", async () => {
    await assert.rejects(fetchTriageBacklog(reader({
        async search() { throw new Error("Denied"); }
    }), { projectKey: "DEMO" }), /Denied/);
    await assert.rejects(fetchCandidateDescriptions(reader({
        async issue() { throw new Error("Denied"); }
    }), { issueKeys: ["DEMO-1"] }), /Denied/);
});
