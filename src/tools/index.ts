import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetJiraIssue } from "./getJiraIssue.js";
import { registerSearchJira } from "./searchJira.js";
import { registerTriageTools } from "./triage.js";
import { jiraCommenter, jiraLabeler, triageReader } from "../jira/jiraService.js";
import { copilotAuditService, registerAuditJiraDuplicates } from "./auditJiraDuplicates.js";
import { registerFeatureBuildTools } from "./featureBuildTools.js";
import { registerFeaturePlanTools } from "./featurePlanTools.js";
import { createFeatureSpecService, registerCreateFeatureSpec } from "./createFeatureSpec.js";
import { createFeatureBuildService, registerBuildFeatureFromSpec } from "./buildFeatureFromSpec.js";
export function registerJiraTools(server: McpServer) {
    registerGetJiraIssue(server);
    registerSearchJira(server);
    registerTriageTools(server, triageReader);
    registerAuditJiraDuplicates(server, copilotAuditService(triageReader));
    // Off by default: the only Jira writes are the clarification comment and the optional agent label, each enabled explicitly.
    const commenter = process.env.JIRA_POST_CLARIFICATIONS === "true" ? jiraCommenter : undefined;
    registerCreateFeatureSpec(server, createFeatureSpecService(triageReader, undefined, commenter, jiraLabeler(process.env.JIRA_AGENT_LABEL)));
    registerBuildFeatureFromSpec(server, createFeatureBuildService());
    registerFeaturePlanTools(server);
    registerFeatureBuildTools(server);
}
