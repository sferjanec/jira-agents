import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
const workingDirectory = await mkdtemp(join(tmpdir(), "jira-mcp-sdk-check-"));
try {
    await using client = new CopilotClient({ workingDirectory });
    await client.start();
    await using session = await client.createSession({
        availableTools: [],
        onPermissionRequest: () => ({ kind: "reject" }),
        systemMessage: {
            mode: "replace",
            content: "You are running a connectivity check. Respond only with the exact text requested."
        }
    });
    const response = await session.sendAndWait(
        "Respond with exactly: SDK access confirmed",
        60000
    );
    const text = response?.data.content.trim();
    if (text !== "SDK access confirmed") {
        throw new Error("SDK check failed: no response or the response did not match the expected text.");
    }
    console.log(text);
} finally {
    await rm(workingDirectory, { recursive: true });
}
