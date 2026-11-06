import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jiraEnvironment } from "./config/jiraEnvironment.js";
import type { ModelTelemetry } from "./metrics/runMetrics.js";

export const projectRoot = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]src$/, "");

export interface McpCaller {
    // Calls one tool, logs it, and returns its structured result. Tool errors become exceptions.
    call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T>;
    close(): Promise<void>;
}

// Starts the jira-mcp server as a subprocess and returns a caller for its tools. The calling
// script, not a model, decides when each tool runs. Jira write flags pass through from this
// process; with simulate, tickets come from simulation/fixtures and Jira is never contacted.
export async function connectJiraMcp(simulate: boolean): Promise<McpCaller> {
    const passthrough: Record<string, string> = {};
    for (const key of ["JIRA_POST_CLARIFICATIONS", "JIRA_POST_COMPLETION", "JIRA_AGENT_LABEL"]) {
        const value = process.env[key];
        if (value !== undefined) {
            passthrough[key] = value;
        }
    }
    const client = new Client({ name: "jira-mcp-script", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", join(projectRoot, "src", "server.ts")],
        cwd: projectRoot,
        env: {
            ...getDefaultEnvironment(),
            ...jiraEnvironment(),
            ...passthrough,
            ...(simulate ? { JIRA_FIXTURES_DIR: join(projectRoot, "simulation", "fixtures") } : {})
        },
        stderr: "inherit"
    }));
    return {
        async call(name, args) {
            console.log(`[mcp] ${name}`);
            const result = await client.callTool({ name, arguments: args });
            const content = result.content as { type: string; text?: string }[] | undefined;
            const text = content?.find((item) => item.type === "text")?.text ?? "";
            if (result.isError) {
                throw new Error(`${name} failed: ${text}`);
            }
            if (result.structuredContent) {
                return result.structuredContent as never;
            }
            return JSON.parse(text) as never;
        },
        close: () => client.close()
    };
}

export function formatTelemetry(telemetry: ModelTelemetry): string {
    return [
        `model calls: ${telemetry.modelCalls}`,
        `input tokens: ${telemetry.inputTokens}`,
        `output tokens: ${telemetry.outputTokens}`,
        `cache-read tokens: ${telemetry.cacheReadTokens}`,
        `cost multiplier: ${telemetry.cost}`,
        ...(telemetry.model ? [`model: ${telemetry.model}`] : [])
    ].join(" | ");
}
