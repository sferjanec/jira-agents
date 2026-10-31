import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, ToolSet, defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { AgentRunner } from "./contracts.js";
import { AuditFailure, stageFailure } from "./diagnostics.js";
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Agent invocation cancelled or timed out."));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
        }
    });
    try {
        return await Promise.race([operation, cancelled]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}
export async function withCopilotRunner<T>(
    action: (runner: AgentRunner) => Promise<T>,
    signal: AbortSignal
): Promise<T> {
    const workingDirectory = await mkdtemp(join(tmpdir(), "jira-mcp-audit-"));
    try {
        await using client = new CopilotClient({ workingDirectory });
        signal.throwIfAborted();
        await client.start();
        signal.throwIfAborted();
        const runner: AgentRunner = {
            async run(request, auditSignal) {
                const stageSignal = AbortSignal.any([auditSignal, AbortSignal.timeout(60000)]);
                try {
                    stageSignal.throwIfAborted();
                    const tools = request.tools.map((tool) => defineTool(tool.name, {
                        description: tool.description,
                        parameters: z.strictObject({}),
                        skipPermission: true,
                        defer: "never",
                        async handler() {
                            try {
                                stageSignal.throwIfAborted();
                                return await tool.execute(stageSignal);
                            } catch {
                                // SDK tool errors are model-visible; never forward Jira/HTTP exceptions.
                                throw new Error("Approved retrieval failed; the audit is incomplete.");
                            }
                        }
                    }));
                    const allowed = new ToolSet();
                    for (const tool of tools) {
                        allowed.addCustom(tool.name);
                    }
                    await using session = await client.createSession({
                        tools,
                        availableTools: allowed,
                        excludedTools: new ToolSet().addBuiltIn("*").addMcp("*"),
                        onPermissionRequest: () => ({ kind: "reject" }),
                        enableConfigDiscovery: false,
                        systemMessage: { mode: "replace", content: request.instructions }
                    });
                    stageSignal.throwIfAborted();
                    try {
                        // The abort signal owns the deadline; keep the SDK wait timeout outside it.
                        const response = await cancellable(session.sendAndWait({
                            prompt: JSON.stringify(request.input)
                        }, 65000), stageSignal);
                        if (!response?.data.content.trim() && request.role === "analyst") {
                            throw new AuditFailure("EMPTY_MODEL_RESPONSE");
                        }
                        return response?.data.content ?? "";
                    } catch (error) {
                        try {
                            await session.abort();
                        } catch {
                            throw stageFailure(error, auditSignal, stageSignal);
                        }
                        throw error;
                    }
                } catch (error) {
                    throw stageFailure(error, auditSignal, stageSignal);
                }
            }
        };
        return await action(runner);
    } finally {
        await rm(workingDirectory, { recursive: true });
    }
}
