import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetJiraIssue } from "./getJiraIssue.js";
import { registerSearchJira } from "./searchJira.js";
import { registerTriageTools } from "./triage.js";
import { triageReader } from "../jira/jiraService.js";
import { copilotAuditService, registerAuditJiraDuplicates } from "./auditJiraDuplicates.js";
import { createFeatureSpecService, registerCreateFeatureSpec } from "./createFeatureSpec.js";
import { createFeatureBuildService, registerBuildFeatureFromSpec } from "./buildFeatureFromSpec.js";
export function registerJiraTools(server: McpServer) {
    registerGetJiraIssue(server);
    registerSearchJira(server);
    registerTriageTools(server, triageReader);
    registerAuditJiraDuplicates(server, copilotAuditService(triageReader));
    registerCreateFeatureSpec(server, createFeatureSpecService(triageReader));
    registerBuildFeatureFromSpec(server, createFeatureBuildService());
}
