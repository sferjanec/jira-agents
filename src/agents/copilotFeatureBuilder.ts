import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, ToolSet } from "@github/copilot-sdk";
import { applyUsageEvent } from "../metrics/runMetrics.js";
import { FeatureBuilderFailure } from "./featureBuilderFailure.js";
import type { FeatureBuildContext, FeatureBuilderModel } from "./featureBuilder.js";

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Builder invocation cancelled or timed out."));
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

export const copilotFeatureBuilderModel: FeatureBuilderModel = async (instructions, input, signal, telemetry) => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "jira-mcp-feature-builder-"));
    const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    try {
        await using client = new CopilotClient({ workingDirectory });
        stageSignal.throwIfAborted();
        await client.start();
        stageSignal.throwIfAborted();
        await using session = await client.createSession({
            excludedTools: new ToolSet().addBuiltIn("*").addMcp("*"),
            onPermissionRequest: () => ({ kind: "reject" }),
            enableConfigDiscovery: false,
            systemMessage: { mode: "replace", content: instructions }
        });
        if (telemetry) {
            session.on((event) => applyUsageEvent(telemetry, event));
        }
        try {
            const response = await cancellable(session.sendAndWait({
                prompt: JSON.stringify(input)
            }, 125000), stageSignal);
            if (!response?.data.content.trim()) {
                throw new FeatureBuilderFailure("MODEL_OUTPUT_INVALID");
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
        if (signal.aborted || stageSignal.aborted) {
            throw new FeatureBuilderFailure("REQUEST_CANCELLED");
        }
        if (error instanceof FeatureBuilderFailure) {
            throw error;
        }
        throw new FeatureBuilderFailure("MODEL_REQUEST_FAILED");
    } finally {
        try {
            await rm(workingDirectory, { recursive: true });
        } catch {
            throw new FeatureBuilderFailure("MODEL_REQUEST_FAILED");
        }
    }
};
