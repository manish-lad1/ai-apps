import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Spawns the compiled mcp-server as a subprocess and talks to it over
 * stdio. One MCP client (and one subprocess) per chat session, reused
 * across messages rather than respawned per request — sessions are kept
 * in memory here, keyed by a client-generated session id.
 */

type Session = {
  client: Client;
  tools: Tool[];
  lastUsed: number;
};

const sessions = new Map<string, Session>();

// Sweep sessions that have gone idle so a long-running server process
// doesn't accumulate abandoned mcp-server subprocesses.
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function serverEntrypoint(): string {
  // demo-ui and mcp-server are sibling, self-contained project folders.
  // process.cwd() is demo-ui's root when run via `npm run dev`/`npm start`
  // from within demo-ui/, matching how this project is meant to be run.
  return process.env.MCP_SERVER_PATH ?? path.resolve(process.cwd(), "../mcp-server/dist/index.js");
}

async function createSession(githubToken?: string): Promise<Session> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverEntrypoint()],
    env: githubToken ? { GITHUB_TOKEN: githubToken } : {},
  });

  const client = new Client({ name: "github-insights-demo-ui", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();

  return { client, tools, lastUsed: Date.now() };
}

/** Gets (or lazily creates) the MCP session for a chat session id. */
export async function getSession(sessionId: string, githubToken?: string): Promise<Session> {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const session = await createSession(githubToken);
  sessions.set(sessionId, session);
  return session;
}

export function listSessionTools(sessionId: string): Tool[] {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`No active MCP session for id "${sessionId}". Call getSession first.`);
  }
  return session.tools;
}

export async function callTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`No active MCP session for id "${sessionId}". Call getSession first.`);
  }
  session.lastUsed = Date.now();
  return session.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
}

export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await session.client.close();
}

let sweepStarted = false;
export function ensureIdleSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUsed > SESSION_IDLE_MS) {
        sessions.delete(id);
        session.client.close().catch(() => {});
      }
    }
  }, SWEEP_INTERVAL_MS).unref();
}
