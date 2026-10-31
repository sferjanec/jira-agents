import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFeatureSpecService } from "./tools/createFeatureSpec.js";
import { createFeatureBuildService } from "./tools/buildFeatureFromSpec.js";
import type { JiraReader } from "./jira/triage.js";

// Simulation harness: serves ticket text from simulation/fixtures instead of Jira,
// then runs the real Copilot planner and builder against a local repository.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "simulation", "fixtures");
const [command, issueKey, workspaceRoot] = process.argv.slice(2);

if ((command !== "plan" && command !== "build") || !issueKey || !workspaceRoot) {
    console.error("Usage: npm run simulate -- <plan|build> <ISSUE-KEY> <absolute-repo-path>");
    process.exit(2);
}

const reader: JiraReader = {
    async search() {
        throw new Error("Search is not available in the simulation.");
    },
    async issue(key) {
        const [summary, ...body] = (await readFile(join(fixtures, `${key}.txt`), "utf8")).split("\n");
        return { key, fields: { summary, description: body.join("\n") } };
    }
};

const signal = AbortSignal.timeout(command === "plan" ? 300000 : 360000);
if (command === "plan") {
    const result = await createFeatureSpecService(reader)({ issueKey, workspaceRoot }, signal);
    if (result.needsClarification) {
        console.log(`NEEDS CLARIFICATION (nothing saved):\n${result.clarifications.map((item) => `- ${item}`).join("\n")}\n\n${result.plan}`);
    } else {
        console.log(`Plan saved: ${result.path}\n\n${result.plan}`);
    }
} else {
    console.log(JSON.stringify(await createFeatureBuildService()({ issueKey, workspaceRoot }, signal), null, 2));
}
