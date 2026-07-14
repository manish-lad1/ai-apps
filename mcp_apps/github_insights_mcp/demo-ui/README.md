# github-insights-demo-ui

A reference chat client for [`mcp-server/`](../mcp-server) — this is a **demo/reference
client, not the primary artifact**. The MCP server is the real portfolio piece and works
standalone in any MCP client; this app exists to show it working end-to-end with an LLM
deciding which tools to call.

Ask a natural-language question about a GitHub repo. The app spawns `mcp-server` as a
subprocess, sends the conversation plus the server's tool list to an LLM, and loops:
whenever the model asks to call a tool, it's called against the real MCP server, the
result is fed back, and the loop continues until the model has a final answer. Every tool
call — name, arguments, and raw result — is shown in a collapsible **tool trace** panel
under the answer, so the mechanics are visible instead of hidden behind a chat bubble.

## How it relates to `mcp-server/`

This app **spawns and talks to** `mcp-server/` over stdio (via `lib/mcp-client.ts`); it
does not reimplement any of its logic. One MCP client / subprocess is created per browser
session and reused across messages, not respawned per request.

## Stack

- Next.js 16, TypeScript, Tailwind CSS
- `@modelcontextprotocol/sdk` client (`StdioClientTransport`) to spawn and call the server
- LLM calls via `lib/llm-provider.ts`: `LLM_PROVIDER` env var switches between Ollama
  (local dev, no API key needed) and the Claude API (production verification)

## Setup

```bash
# 1. Build the sibling mcp-server first — this app spawns its compiled output.
cd ../mcp-server && npm install && npm run build && cd ../demo-ui

# 2. Install and configure this app
npm install
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY if using LLM_PROVIDER=anthropic

# 3. Run
npm run dev
```

Open http://localhost:3000, enter a repo (e.g. `manish-lad1/ai-apps`), and ask a question.

## Env vars

| Var | Required | Purpose |
|---|---|---|
| `LLM_PROVIDER` | no (defaults to `anthropic` in code; `.env.example` ships `ollama`) | `"ollama"` or `"anthropic"` |
| `ANTHROPIC_API_KEY` | if `LLM_PROVIDER=anthropic` | Claude API key |
| `ANTHROPIC_MODEL` | no | defaults to `claude-sonnet-5` |
| `OLLAMA_BASE_URL` | no | defaults to `http://localhost:11434` |
| `OLLAMA_MODEL` | no | defaults to `gemma3:12b` — must be a tool-calling-capable model |
| `GITHUB_TOKEN` | no | fallback token for the spawned MCP server if the UI's per-session token field is left blank |

The GitHub token field in the UI is optional, kept in React state only (never written to
localStorage, never logged), and passed per-request to set `GITHUB_TOKEN` in the spawned
MCP server subprocess's env for that session only.

## Notes

- `mcp-server`'s `search_code` tool requires a GitHub token even for public repos — that's
  a GitHub API constraint (code search 401s unauthenticated), not a bug here.
- Tool-calling with Ollama requires a model that actually supports function calling (e.g.
  `gemma4:12b`, `llama3.1`) — check `ollama show <model>` for a `tools` capability before
  assuming a "no tools called" answer means something's broken.
- The chat loop caps at 6 rounds of tool calls per turn (`MAX_TOOL_ROUNDTRIPS` in
  `app/api/chat/route.ts`) to avoid a runaway loop if a model keeps requesting tools.
