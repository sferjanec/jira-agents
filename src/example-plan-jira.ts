import { createFeatureSpecService } from "./tools/createFeatureSpec.js";
import { jiraCommenter, jiraLabeler, triageReader } from "./jira/jiraService.js";

// Runs the real planner against a real Jira issue (credentials from .env). The clarification
// comment is posted only when JIRA_POST_CLARIFICATIONS=true, exactly as in the MCP server.
const [issueKey, workspaceRoot] = process.argv.slice(2);
if (!issueKey || !workspaceRoot) {
    console.error("Usage: npm run plan:jira -- <ISSUE-KEY> <absolute-repo-path>");
    process.exit(2);
}

const commenter = process.env.JIRA_POST_CLARIFICATIONS === "true" ? jiraCommenter : undefined;
console.log(`Jira comment posting: ${commenter ? "ON" : "off"}`);
const result = await createFeatureSpecService(triageReader, undefined, commenter, jiraLabeler(process.env.JIRA_AGENT_LABEL))(
    { issueKey, workspaceRoot },
    AbortSignal.timeout(300000)
);
if (result.needsClarification) {
    console.log(`NEEDS CLARIFICATION\nQuestions file: ${result.clarificationsPath}\nJira comment posted: ${result.jiraCommentPosted ?? "n/a"}\nJira label added: ${result.jiraLabelAdded ?? "n/a"}\n${result.clarifications.map((item) => `- ${item}`).join("\n")}`);
} else {
    console.log(`Plan saved: ${result.path}\nJira label added: ${result.jiraLabelAdded ?? "n/a"}`);
}
