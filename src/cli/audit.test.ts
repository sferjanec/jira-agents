import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseAuditArgs } from "./audit.js";
import { fetchTriageBacklog, type JiraReader } from "../jira/triage.js";
import { writeAuditResult } from "./auditResult.js";
test("Backlog replaces the default statuses and requested limits are forwarded", async () => {
    const options = parseAuditArgs(["PROJ", "--status", "Backlog", "--max-issues", "100", "--max-characters", "1500", "--max-pairs", "2"]);
    assert.equal(options.help, false);
    if (options.help) {
        assert.fail("Expected audit input");
    }
    assert.deepEqual(options.input, {
        projectKey: "PROJ", statuses: ["Backlog"], maxIssues: 100, maxCharacters: 1500, maxPairs: 2
    });
    let searches = 0;
    const reader: JiraReader = {
        async search(body) {
            searches += 1;
            assert.equal(body.jql, 'project = "PROJ" AND status in ("Backlog") ORDER BY created ASC, key ASC');
            assert.equal(body.maxResults, 100);
            return { issues: [], isLast: true };
        },
        async issue() { throw new Error("Unexpected hydration"); }
    };
    await fetchTriageBacklog(reader, options.input);
    assert.equal(searches, 1);
});
test("omitting statuses preserves tool defaults and repeated status flags select exactly those statuses", () => {
    const defaults = parseAuditArgs(["PROJ"]);
    assert.equal(defaults.help, false);
    if (!defaults.help) {
        assert.deepEqual(defaults.input.statuses, ["To Do", "In Progress"]);
        assert.equal(defaults.input.maxIssues, 30);
        assert.equal(defaults.input.maxPairs, 10);
    }
    const multiple = parseAuditArgs(["PROJ", "--status", "Backlog", "--status", "Ready to Work"]);
    if (multiple.help) {
        assert.fail("Expected audit input");
    }
    assert.deepEqual(multiple.input.statuses, ["Backlog", "Ready to Work"]);
});
test("help is available without a project; missing/invalid scope, flags and limits fail", () => {
    assert.deepEqual(parseAuditArgs(["--help"]), { help: true });
    for (const args of [
        [], ["PROJ", "OTHER"], ["invalid key"], ["PROJ", "--unknown"],
        ["PROJ", "--status"], ["PROJ", "--status", ""],
        ["PROJ", "--max-issues", "101"], ["PROJ", "--max-issues", "0"],
        ["PROJ", "--max-issues", "1.5"], ["PROJ", "--max-issues", "invalid"],
        ["PROJ", "--max-characters", "99"], ["PROJ", "--max-characters", "6001"],
        ["PROJ", "--max-pairs", "0"], ["PROJ", "--max-pairs", "11"],
        ["PROJ", "--max-pairs", "1.5"], ["PROJ", "--max-pairs", "invalid"],
        ["PROJ", "--max-pairs"]
    ]) {
        assert.throws(() => parseAuditArgs(args), `Expected invalid arguments: ${args.join(" ")}`);
    }
});
test("CLI help and invalid input do not require Jira credentials or start a server", () => {
    const env = { ...process.env, JIRA_URL: "", JIRA_USER: "", JIRA_API_TOKEN: "" };
    const help = spawnSync(process.execPath, ["--import", "tsx", "src/example-audit.ts", "--help"], {
        encoding: "utf8", env, timeout: 10000
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--status Backlog/);
    const invalid = spawnSync(process.execPath, ["--import", "tsx", "src/example-audit.ts", "PROJ", "--max-issues", "101"], {
        encoding: "utf8", env, timeout: 10000
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /maxIssues/);
    assert.doesNotMatch(invalid.stderr, /Missing required environment/);
});
test("failed audit prints JSON to stdout and a separate safe stage/code summary to stderr", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const report = {
        status: "incomplete",
        trace: [{ stage: "verification", status: "failed", elapsedMs: 60001 }],
        error: {
            stage: "verification", code: "STAGE_TIMEOUT",
            message: "Agent stage exceeded its 60-second deadline."
        }
    };
    const exitCode = writeAuditResult(
        { structuredContent: report, content: [], isError: true },
        (text) => stdout.push(text), (text) => stderr.push(text)
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(stdout.join("")), report);
    assert.match(stderr.join(""), /verification \[STAGE_TIMEOUT\]/);
    assert.match(stderr.join(""), /partial results/);
});
test("successful reports keep stderr empty and unstructured tool failures still get a safe console message", () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    assert.equal(writeAuditResult(
        { structuredContent: { status: "complete" }, content: [] },
        (text) => stdout.push(text), (text) => stderr.push(text)
    ), 0);
    assert.equal(stderr.length, 0);
    assert.equal(writeAuditResult({
        content: [{ text: "private-transport-response" }], isError: true
    }, (text) => stdout.push(text), (text) => stderr.push(text)), 1);
    assert.match(stderr[0], /Audit failed/);
    assert.doesNotMatch(stderr[0], /private-transport-response/);
});
test("absent or malformed MCP results fail explicitly instead of producing success-shaped JSON", () => {
    for (const result of [{ toolResult: "unexpected" }, null, { isError: "private-value" }]) {
        const stderr: string[] = [];
        const stdout: string[] = [];
        assert.equal(writeAuditResult(result, (text) => stdout.push(text), (text) => stderr.push(text)), 1);
        assert.equal(stdout.length, 0);
        assert.match(stderr[0], /Audit failed/);
        assert.doesNotMatch(stderr[0], /private-value/);
    }
});
