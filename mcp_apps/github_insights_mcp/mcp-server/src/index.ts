#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGitHubClient } from "./github-client.js";
import { registerContentTools } from "./tools/content.js";
import { registerActivityTools } from "./tools/activity.js";
import { registerIssueTools } from "./tools/issues.js";

const server = new McpServer({
  name: "github-insights-mcp",
  version: "0.1.0",
});

const octokit = createGitHubClient();

registerContentTools(server, octokit);
registerActivityTools(server, octokit);
registerIssueTools(server, octokit);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP wire protocol — all diagnostic output must go to
  // stderr or it corrupts the stdio transport.
  console.error("github-insights-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting github-insights-mcp server:", err);
  process.exit(1);
});
