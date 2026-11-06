import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFeatureBuildTools } from "./featureBuildTools.js";

const plan = [
    "# Feature Plan: PROJ-1 - Add thing",
    "",
    "> Source ticket: PROJ-1",
    "",
    "### 1. Edit",
    "",
    "**Files:** `src/a.txt`, `src/new.txt`",
    "",
    "Do it.",
    ""
].join("\n");

async function withRepo(run: (client: Client, root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "jira-build-tools-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "Test");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "old\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    await mkdir(join(root, ".specs"));
    await writeFile(join(root, ".specs", "PROJ-1-TASK.md"), plan);
    const server = new McpServer({ name: "build-tools-test", version: "1.0.0" });
    const client = new Client({ name: "build-tools-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerFeatureBuildTools(server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        await run(client, root);
    } finally {
        await client.close();
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
}

test("write_planned_file refuses to write before the build branch exists", async () => {
    await withRepo(async (client, root) => {
        const result = await client.callTool({
            name: "write_planned_file",
            arguments: { issueKey: "PROJ-1", workspaceRoot: root, path: "src/a.txt", content: "new\n" }
        });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.structuredContent), /BRANCH_FAILED/);
        assert.equal(await readFile(join(root, "src", "a.txt"), "utf8"), "old\n");
    });
});

test("read, branch and write flow only writes planned paths", async () => {
    await withRepo(async (client, root) => {
        const read = await client.callTool({ name: "read_approved_plan", arguments: { issueKey: "PROJ-1", workspaceRoot: root } });
        assert.notEqual(read.isError, true);
        assert.match(JSON.stringify(read.structuredContent), /old\\n/);

        const branch = await client.callTool({ name: "create_build_branch", arguments: { issueKey: "PROJ-1", workspaceRoot: root } });
        assert.equal((branch.structuredContent as { branch: string }).branch, "agent/proj-1-builder");
        const again = await client.callTool({ name: "create_build_branch", arguments: { issueKey: "PROJ-1", workspaceRoot: root } });
        assert.equal(again.isError, true);

        const modified = await client.callTool({
            name: "write_planned_file",
            arguments: { issueKey: "PROJ-1", workspaceRoot: root, path: "src/a.txt", content: "new\n" }
        });
        assert.equal((modified.structuredContent as { action: string }).action, "modified");
        const created = await client.callTool({
            name: "write_planned_file",
            arguments: { issueKey: "PROJ-1", workspaceRoot: root, path: "src/new.txt", content: "hi\n" }
        });
        assert.equal((created.structuredContent as { action: string }).action, "created");
        assert.equal(await readFile(join(root, "src", "a.txt"), "utf8"), "new\n");

        for (const path of ["src/other.txt", "../escape.txt", ".git/config", ".specs/PROJ-1-TASK.md"]) {
            const rejected = await client.callTool({
                name: "write_planned_file",
                arguments: { issueKey: "PROJ-1", workspaceRoot: root, path, content: "x" }
            });
            assert.equal(rejected.isError, true, path);
        }
    });
});
