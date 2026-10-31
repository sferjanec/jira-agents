import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { copilotFeatureBuilderModel } from "../agents/copilotFeatureBuilder.js";
import {
    gatherFeatureBuildContext,
    generateFeatureFiles,
    writeFeatureFiles,
    type FeatureBuilderModel
} from "../agents/featureBuilder.js";
import { FeatureBuilderFailure } from "../agents/featureBuilderFailure.js";

const execFileAsync = promisify(execFile);
const issueKeySchema = z.string().max(100).regex(/^[A-Z][A-Z0-9_]*-\d+$/);
const buildInputSchema = z.object({
    issueKey: issueKeySchema.describe("Issue key for the human-approved plan in .specs."),
    workspaceRoot: z.string().trim().min(1).max(4096)
        .describe("Absolute path to the root of a clean Git repository.")
});
export type BuildFeatureInput = z.input<typeof buildInputSchema>;
export type BuildFeatureResult = {
    issueKey: string;
    branch: string;
    planPath: string;
    created: string[];
    modified: string[];
    skipped: { path: string; reason: string }[];
    pushed: false;
};
export type FeatureBuildService = (input: BuildFeatureInput, signal: AbortSignal) => Promise<BuildFeatureResult>;

async function git(root: string, args: string[]): Promise<string> {
    try {
        const result = await execFileAsync("git", args, {
            cwd: root,
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 1024 * 1024
        });
        return result.stdout.trim();
    } catch {
        throw new FeatureBuilderFailure("REPOSITORY_INVALID");
    }
}

function dirtyExceptPlan(status: string, issueKey: string): boolean {
    const approvedPlanPath = `.specs/${issueKey}-TASK.md`;
    return status.split(/\r?\n/).some((line) => {
        if (!line) {
            return false;
        }
        const state = line.slice(0, 2);
        const path = line.slice(3);
        return state !== "??" || path !== approvedPlanPath;
    });
}

async function readApprovedPlan(root: string, issueKey: string): Promise<{ path: string; content: string }> {
    const relativePath = `.specs/${issueKey}-TASK.md`;
    const path = join(root, relativePath);
    try {
        const info = await lstat(path);
        const resolved = await realpath(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 30000 || resolved !== path) {
            throw new FeatureBuilderFailure("PLAN_INVALID");
        }
        const file = await open(path, "r");
        let content: string;
        try {
            const buffer = Buffer.alloc(30001);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 30000) {
                throw new FeatureBuilderFailure("PLAN_INVALID");
            }
            content = buffer.toString("utf8", 0, bytesRead);
        } finally {
            await file.close();
        }
        return { path: relativePath, content };
    } catch (error) {
        if (error instanceof FeatureBuilderFailure) {
            throw error;
        }
        if (typeof error === "object" && error !== null && "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new FeatureBuilderFailure("PLAN_NOT_FOUND");
        }
        throw new FeatureBuilderFailure("PLAN_INVALID");
    }
}

async function preflightGit(root: string, issueKey: string): Promise<void> {
    const gitRoot = await git(root, ["rev-parse", "--show-toplevel"]);
    if (await realpath(gitRoot) !== root) {
        throw new FeatureBuilderFailure("REPOSITORY_INVALID");
    }
    const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirtyExceptPlan(status, issueKey)) {
        throw new FeatureBuilderFailure("REPOSITORY_DIRTY");
    }
    const branch = `agent/${issueKey.toLowerCase()}-builder`;
    try {
        await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
            cwd: root,
            encoding: "utf8",
            timeout: 15000
        });
        throw new FeatureBuilderFailure("BRANCH_EXISTS");
    } catch (error) {
        if (error instanceof FeatureBuilderFailure) {
            throw error;
        }
        const processError = error as { code?: string | number; status?: number };
        if (typeof error === "object" && error !== null &&
            (processError.code === 1 || processError.status === 1)) {
            return;
        }
        throw new FeatureBuilderFailure("BRANCH_FAILED");
    }
}

async function createBranch(root: string, issueKey: string): Promise<string> {
    const branch = `agent/${issueKey.toLowerCase()}-builder`;
    try {
        await execFileAsync("git", ["switch", "-c", branch], {
            cwd: root,
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 1024 * 1024
        });
        return branch;
    } catch {
        throw new FeatureBuilderFailure("BRANCH_FAILED");
    }
}

async function checkBeforeBranch(root: string, issueKey: string, originalPlan: string): Promise<void> {
    const approved = await readApprovedPlan(root, issueKey);
    if (approved.content !== originalPlan) {
        throw new FeatureBuilderFailure("PLAN_INVALID");
    }
    const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirtyExceptPlan(status, issueKey)) {
        throw new FeatureBuilderFailure("REPOSITORY_DIRTY");
    }
}

export function createFeatureBuildService(model: FeatureBuilderModel = copilotFeatureBuilderModel): FeatureBuildService {
    return async (rawInput, signal) => {
        const parsedInput = buildInputSchema.safeParse(rawInput);
        if (!parsedInput.success) {
            throw new FeatureBuilderFailure("INVALID_INPUT");
        }
        const input = parsedInput.data;
        if (!isAbsolute(input.workspaceRoot)) {
            throw new FeatureBuilderFailure("INVALID_INPUT");
        }
        signal.throwIfAborted();
        let root: string;
        try {
            root = await realpath(input.workspaceRoot);
            const info = await lstat(root);
            if (!info.isDirectory()) {
                throw new FeatureBuilderFailure("REPOSITORY_INVALID");
            }
        } catch (error) {
            if (error instanceof FeatureBuilderFailure) {
                throw error;
            }
            throw new FeatureBuilderFailure("REPOSITORY_INVALID");
        }

        const approvedPlan = await readApprovedPlan(root, input.issueKey);
        await preflightGit(root, input.issueKey);
        const context = await gatherFeatureBuildContext(input.issueKey, root, approvedPlan.content);
        signal.throwIfAborted();
        const output = await generateFeatureFiles(context, model, signal);
        signal.throwIfAborted();
        await checkBeforeBranch(root, input.issueKey, approvedPlan.content);
        const branch = await createBranch(root, input.issueKey);
        try {
            const currentBranch = await git(root, ["branch", "--show-current"]);
            if (currentBranch !== branch) {
                throw new FeatureBuilderFailure("BRANCH_FAILED");
            }
            await writeFeatureFiles(root, output.files);
        } catch (error) {
            if (error instanceof FeatureBuilderFailure) {
                throw error;
            }
            throw new FeatureBuilderFailure("FILE_WRITE_FAILED");
        }

        return {
            issueKey: input.issueKey,
            branch,
            planPath: approvedPlan.path,
            created: output.files.filter((file) => !context.plannedFiles.find((planned) =>
                planned.path === file.path && planned.existingContent !== undefined
            )).map((file) => file.path),
            modified: output.files.filter((file) => context.plannedFiles.some((planned) =>
                planned.path === file.path && planned.existingContent !== undefined
            )).map((file) => file.path),
            skipped: output.skipped,
            pushed: false
        };
    };
}

export function registerBuildFeatureFromSpec(server: McpServer, service: FeatureBuildService) {
    let active = false;
    server.registerTool("build_feature_from_spec", {
        title: "Build Feature from Approved Plan",
        description: "Explicitly builds from .specs/{ISSUE-KEY}-TASK.md. Before asking Copilot for code, requires the workspace root to be a clean Git repository except for that one untracked approved plan, then creates local branch agent/{issue-key}-builder. The model has no filesystem, shell, Jira, or MCP access. The coordinator validates generated paths against the approved plan, writes only those files on the local branch, and never pushes. Requires human review of the plan before invoking. Sends the plan and bounded repository context to Copilot; use only where permitted by your data policy.",
        inputSchema: buildInputSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    }, async (input, extra) => {
        if (active) {
            return {
                isError: true,
                content: [{ type: "text" as const, text: "Feature building is already running. Wait for it to finish before retrying." }]
            };
        }
        active = true;
        const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(360000)]);
        try {
            const result = await service(input, signal);
            return {
                structuredContent: result,
                content: [{
                    type: "text" as const,
                    text: `Feature files generated on local branch ${result.branch}. Created ${result.created.length}; modified ${result.modified.length}; skipped ${result.skipped.length}. Nothing was pushed. Review the branch and run the relevant tests.`
                }]
            };
        } catch (error) {
            const failure = error instanceof FeatureBuilderFailure
                ? error
                : signal.aborted
                    ? new FeatureBuilderFailure("REQUEST_CANCELLED")
                    : new FeatureBuilderFailure("INTERNAL_FAILURE");
            return {
                isError: true,
                structuredContent: { error: { code: failure.code, message: failure.message } },
                content: [{ type: "text" as const, text: failure.message }]
            };
        } finally {
            active = false;
        }
    });
}
