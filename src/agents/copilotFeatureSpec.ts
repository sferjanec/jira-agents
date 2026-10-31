import { CopilotClient, ToolSet } from "@github/copilot-sdk";
import { FeatureSpecFailure } from "./featureSpecFailure.js";
import type { FeatureSpecModel } from "./featureSpec.js";
import { isReadAllowed } from "./readPolicy.js";

const stageTimeoutMs = 170000;

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

// The Copilot session is rooted at the repository and explores it itself. Only reads that
// pass the read policy are approved; shell, write, network and every other request is rejected.
export const copilotFeatureSpecModel: FeatureSpecModel = async (instructions, input, signal, workspaceRoot) => {
    const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(stageTimeoutMs)]);
    const debug = process.env.EXPLORE_DEBUG === "1";
    const stats = { approved: 0, denied: 0 };
    try {
        await using client = new CopilotClient({ workingDirectory: workspaceRoot });
        stageSignal.throwIfAborted();
        await client.start();
        stageSignal.throwIfAborted();
        await using session = await client.createSession({
            workingDirectory: workspaceRoot,
            availableTools: new ToolSet().addBuiltIn(["view", "grep", "glob"]),
            onPermissionRequest: (request) => {
                const allowed = request.kind === "read" && isReadAllowed(workspaceRoot, request.path);
                stats[allowed ? "approved" : "denied"] += 1;
                if (debug) {
                    console.error(`[explore] ${allowed ? "ALLOW" : "DENY "} ${request.kind} ${"path" in request ? request.path : ""}`);
                }
                return allowed
                    ? { kind: "approve-once" }
                    : { kind: "reject", feedback: "Only reading source files inside the repository is permitted." };
            },
            enableConfigDiscovery: false,
            systemMessage: { mode: "replace", content: instructions }
        });
        try {
            const response = await cancellable(session.sendAndWait({
                prompt: JSON.stringify(input)
            }, stageTimeoutMs + 5000), stageSignal);
            if (debug) {
                console.error(`[explore] reads approved=${stats.approved} denied=${stats.denied}`);
            }
            if (!response?.data.content.trim()) {
                throw new FeatureSpecFailure("MODEL_OUTPUT_INVALID");
            }
            return response.data.content;
        } catch (error) {
            try {
                await session.abort();
            } catch {
                // Preserve the original model or cancellation failure.
            }
            throw error;
        }
    } catch (error) {
        if (debug) {
            console.error("[explore] failure:", error);
        }
        if (signal.aborted || stageSignal.aborted) {
            throw new FeatureSpecFailure("REQUEST_CANCELLED");
        }
        if (error instanceof FeatureSpecFailure) {
            throw error;
        }
        throw new FeatureSpecFailure("MODEL_REQUEST_FAILED");
    }
};
