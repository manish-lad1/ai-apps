# GitHub Insights MCP

An MCP server that exposes **read-only GitHub repo insight tools**, plus a reference chat
UI that shows it working end-to-end with an LLM deciding which tools to call.

> Part of [ai-apps](../../) — a collection of open, forkable AI apps by [Manish Lad](https://manishlad.substack.com).

The project has two self-contained parts:

| Folder | What it is |
|---|---|
| [`mcp-server/`](./mcp-server) | **The primary artifact.** A standalone MCP server (stdio transport) exposing 13 read-only tools for a GitHub repo's structure, activity, issues, and PRs. Works in any MCP client — Claude Desktop, Claude Code, the MCP inspector — not just the demo UI. |
| [`demo-ui/`](./demo-ui) | A demo/reference Next.js chat app that spawns `mcp-server` as a subprocess, lets an LLM (Ollama or Claude) decide which tools to call to answer natural-language questions about a repo, and shows every tool call in a live **tool trace** panel. |

## Why two parts

The server is the real portfolio piece: a tool *provider*, not an agent, meant to be
useful standalone in any MCP client. The demo UI exists only to prove it works end-to-end
and to make the MCP mechanics (tool calls, arguments, raw results) visible instead of
hiding them behind a chat bubble — it has no logic of its own beyond spawning the server
and running a tool-calling loop.

## Demo

<img src="./demo.gif" width="900" alt="Demo of github_insights_mcp" />

## Requirements

- Node.js 20+
- (Optional) A GitHub personal access token with `public_repo` read scope — [create one
  here](https://github.com/settings/tokens). Without it, the server runs fine but is
  capped at GitHub's unauthenticated rate limit (60 req/hr vs. 5,000 with a token).

## Quick start

```bash
# 1. Build the server
cd mcp-server
npm install
npm run build

# 2. Run the demo UI against it
cd ../demo-ui
npm install
cp .env.example .env.local   # fill in ANTHROPIC_API_KEY, or leave LLM_PROVIDER=ollama
                              # optionally set GITHUB_TOKEN to raise the rate limit
npm run dev
```

Open http://localhost:3000, enter a repo (e.g. `manish-lad1/ai-apps`), and ask a question
— or click "Tools" to browse the live tool list first.

To use the server standalone (e.g. from Claude Desktop) without the demo UI at all, see
[`mcp-server/README.md`](./mcp-server/README.md) for the config snippet.

## What the server can answer

**Content & structure** — `get_repo_structure`, `get_file_content`, `search_code`, `get_readme`
**Activity & insights** — `summarize_changelog`, `get_commit_activity`, `get_contributor_stats`, `get_release_notes_draft`
**Issues & PRs** — `list_issues`, `get_issue_details`, `list_pull_requests`, `get_pr_details`, `search_issues`

Every tool takes `owner` and `repo` — nothing is hardcoded to one repository — and returns
structured JSON, not prose. Full descriptions are in
[`mcp-server/README.md`](./mcp-server/README.md), or browse them live via the demo UI's
"Tools" drawer.

## Example questions to try in the demo

> *"What changed in this repo in the last month?"*

> *"Show me open issues that haven't been touched in 30 days."*

> *"Who are the top contributors, and what's the file structure look like?"*

> *"Draft release notes since the last tag."*

Good things to check on questions like these: does the tool trace panel show a sensible
sequence of tool calls (not one giant call trying to do everything), and does the final
answer actually reflect what those tools returned rather than the model guessing?

## Design principles

- **Read-only.** No tool creates, updates, or deletes anything on GitHub.
- **No token required to start.** `GITHUB_TOKEN` is optional; without it the server just
  runs at GitHub's lower unauthenticated rate limit (60 req/hr vs. 5,000).
- **Structured over prose.** Tools return data; summarizing it into natural language is
  the calling LLM's job — the same "don't ask an LLM to do what code can do exactly"
  reasoning behind field-ID generation in [`form_builder_agent`](../../ai_agents/form_builder_agent)
  and RICE-score computation in [`prd_critique_agent`](../../ai_agents/prd_critique_agent).
- **Self-contained.** Each folder has its own `package.json` and is independently
  installable/runnable — no shared packages or cross-folder imports.

## Key concepts learned building this

- **Building your own tool provider beats wrapping an existing one, when the point is the
  tools themselves.** GitHub ships an official, comprehensive MCP server — but reusing it
  here would mean no real design artifact to show, and it doesn't have the composed,
  PM-flavored tools (like grouped changelog summaries) that make this project worth having.
- **"Arms, not brain" is a real design constraint, not just a slogan.** Tools like
  `summarize_changelog` return grouped, structured data rather than pre-written prose —
  the calling LLM decides how to phrase the answer. This keeps the server reusable across
  very different clients (a chat UI, a CLI, another agent) that might want the same data
  presented differently.
- **A tool provider should degrade gracefully, not require setup.** Making `GITHUB_TOKEN`
  optional (at the cost of a lower rate limit) meant the server works the first time
  someone tries it, with no account creation or config required — friction at first-run
  is friction most people won't push through.
- **Making mechanics visible is itself a feature.** The tool trace panel in the demo UI
  adds real engineering work for no change in what the assistant can do — its entire
  value is making MCP's tool-calling loop legible instead of hidden behind a chat bubble.

## What else you can do with this

- **Write scopes** — add gated, explicitly-confirmed tools for things like commenting on
  an issue or opening a PR, behind a clear opt-in flag.
- **Caching** — cache `get_repo_structure` / `get_readme` responses for a short TTL to
  cut down on redundant API calls during a single chat session.
- **More platforms** — a parallel `gitlab-client.ts` or `bitbucket-client.ts` behind the
  same tool interface, so the same 13 tools work across providers.
- **Streaming tool results** — for large repos, stream `get_commit_activity` results
  incrementally instead of waiting for the full range to resolve.

## More detail

- [`mcp-server/README.md`](./mcp-server/README.md) — full tool list, auth, standalone
  usage, Claude Desktop config.
- [`demo-ui/README.md`](./demo-ui/README.md) — stack, env vars, chat-loop internals,
  known gotchas (e.g. `search_code` needing a token, Ollama tool-calling support).

## License

MIT — see the [root LICENSE](../../LICENSE).
