import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerJiraTools } from "./tools/index.js";
const server = new McpServer({
    name: "jira-mcp",
    version: "1.0.0"
});
registerJiraTools(server);
const transport = new StdioServerTransport();
await server.connect(transport);
