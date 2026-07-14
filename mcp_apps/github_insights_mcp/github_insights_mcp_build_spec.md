# Build Spec: `github_insights_mcp`

**Target location:** `mcp_apps/github_insights_mcp/` in the `ai-apps` repo
**Paste this whole document as the initial prompt to Claude Code Desktop.**

---

## Before you start (do this in the terminal, not in Claude Code)

Claude Code Desktop worktrees only inherit *committed* history. If you start a session
against an empty or half-scaffolded folder, the worktree won't see anything you haven't
committed yet.

1. `cd` into the `ai-apps` repo.
2. Create the folder skeleton and commit it *empty* (or with just this spec file inside it)
   before opening Claude Code:
   ```
   mkdir -p mcp_apps/github_insights_mcp
   cp github_insights_mcp_build_spec.md mcp_apps/github_insights_mcp/BUILD_SPEC.md
   git add mcp_apps/github_insights_mcp
   git commit -m "scaffold: github_insights_mcp"
   ```
3. Make sure `.claude/worktrees/` is in `.gitignore` at the repo root (add it if it isn't).
4. Open Claude Code Desktop, point it at `mcp_apps/github_insights_mcp/`, and paste in
   the "Prompt for Claude Code" section below.

---

## Prompt for Claude Code

You are building a two-part project inside `mcp_apps/github_insights_mcp/` in an existing
monorepo called `ai-apps`. Follow the conventions below exactly — this repo has an
established structure and this project must match it.

### Repo conventions to follow

- Each project folder is **fully self-contained**. Do not create shared packages or
  reference code outside this folder. Duplicate any provider-routing or client logic
  locally rather than importing from sibling projects.
- Naming: this project uses the `_mcp` suffix because the primary artifact is a tool
  provider, not an agent.
- No shared `node_modules` hoisting assumptions — each sub-app (`mcp-server/`,
  `demo-ui/`) gets its own `package.json` and is independently runnable.

### Project overview

Two components in one folder:

1. **`mcp-server/`** — a standalone MCP server (stdio transport) exposing read-only
   GitHub repo insight tools. This is the real portfolio artifact and must work
   standalone in any MCP client (Claude Desktop config, Claude Code, etc.), not just
   the demo UI.
2. **`demo-ui/`** — a Next.js chat app that spawns the MCP server as a subprocess,
   acts as its own MCP client, and lets an LLM decide which tools to call to answer
   natural-language questions about a repo. Includes a visible "tool trace" panel.

Every tool takes `owner` and `repo` as required parameters — nothing is hardcoded to
one repository.

---

## Part 1: `mcp-server/`

### Stack
- TypeScript, Node.js
- `@modelcontextprotocol/sdk` for the server
- `octokit` (or `@octokit/rest`) for GitHub API calls
- `zod` for tool input schema validation

### File structure
```
mcp-server/
  src/
    index.ts              # server entrypoint, registers all tools, stdio transport
    github-client.ts       # Octokit wrapper: auth, rate-limit handling, error shaping
    types.ts               # shared zod schemas / TS types
    tools/
      content.ts            # get_repo_structure, get_file_content, search_code, get_readme
      activity.ts           # summarize_changelog, get_commit_activity, get_contributor_stats, get_release_notes_draft
      issues.ts             # list_issues, get_issue_details, list_pull_requests, get_pr_details, search_issues
  package.json
  tsconfig.json
  .env.example
  README.md
```

### Auth
- `GITHUB_TOKEN` env var, **optional**. If absent, fall back to unauthenticated GitHub
  API calls (60 req/hr limit) — the server must still function, just with a lower
  ceiling. Never require a token to start.
- No write scopes needed anywhere. This server is **read-only by design** — do not
  implement any tool that creates, updates, or deletes anything on GitHub.

### Tools to implement

Design principle: tools return **structured, pre-processed data**, not prose. Any
summarization into natural language is the calling LLM's job, not the server's. This
keeps the server a pure "arms" layer.

**Content & structure**
- `get_repo_structure(owner, repo, path?, ref?)` — returns file/directory tree at the
  given path (default root), using the Git Trees API for full-repo listings.
- `get_file_content(owner, repo, path, ref?)` — returns decoded file content. Cap size
  (e.g. reject/truncate files over ~100KB with a clear message).
- `search_code(owner, repo, query)` — wraps the GitHub code search API scoped to the
  repo.
- `get_readme(owner, repo, ref?)` — fetches and decodes the README.

**Activity & insights**
- `summarize_changelog(owner, repo, from, to)` — fetches commits between two refs
  (tags, SHAs, or dates), and returns them **grouped by conventional-commit type**
  (feat/fix/chore/docs/etc., parsed from commit message prefixes, with an "other"
  bucket for anything that doesn't match) plus author. Do not write prose here —
  return the grouped structured list.
- `get_commit_activity(owner, repo, since, until)` — returns commit counts bucketed by
  day/week and by author, for charting or summarizing.
- `get_contributor_stats(owner, repo)` — contributor list with commit counts, using
  the contributors API.
- `get_release_notes_draft(owner, repo, since_tag?)` — merged PRs since the given tag
  (or since the latest release if omitted), grouped by label.

**Issues & PRs**
- `list_issues(owner, repo, state?, labels?, assignee?)` — filtered issue list
  (exclude PRs, which the GitHub API returns mixed in by default).
- `get_issue_details(owner, repo, issue_number)` — full issue plus comment thread.
- `list_pull_requests(owner, repo, state?, base?)` — filtered PR list with basic diff
  stats (files changed, +/- lines).
- `get_pr_details(owner, repo, pr_number)` — full PR: files changed, review status,
  comments.
- `search_issues(owner, repo, query)` — cross issue/PR search scoped to the repo.

### Error handling
- Wrap every Octokit call. On a 403 rate-limit response, return a clear structured
  error (not a stack trace) telling the caller to supply `GITHUB_TOKEN` for a higher
  limit.
- On a 404 (repo/file/issue not found), return a clear "not found" error rather than
  letting the raw exception surface.
- Never throw unhandled — every tool handler returns a valid MCP tool result, error or
  not.

### README for `mcp-server/`
Document: what this is, the full tool list with one-line descriptions, how to run it
standalone, and a Claude Desktop config snippet (`mcpServers` JSON block) so it's
usable outside the demo UI too.

---

## Part 2: `demo-ui/`

### Stack
- Next.js 16, TypeScript, Tailwind CSS (match `prd_critique_agent`'s stack)
- `@modelcontextprotocol/sdk` client (`StdioClientTransport`) to spawn and talk to the
  `mcp-server`
- LLM calls via the same provider-routing pattern used in `prd_critique_agent`:
  `LLM_PROVIDER` env var switches between Ollama (`gemma3:12b`, local dev) and the
  Claude API (production verification)

### File structure
```
demo-ui/
  app/
    page.tsx                    # landing: repo selector + chat
    api/chat/route.ts           # POST endpoint running the tool-calling loop
    components/
      RepoSelector.tsx           # owner/repo input, optional GitHub token field
      ChatPanel.tsx               # chat messages
      ToolTrace.tsx                # collapsible list of tool calls + params + raw results
  lib/
    llm-provider.ts             # duplicated provider-routing logic (own copy, not shared)
    mcp-client.ts                # spawns mcp-server subprocess, lists tools, calls tools
  package.json
  tsconfig.json
  .env.example
  README.md
```

### Repo selector + token handling
- Input for `owner/repo` (placeholder example: `manish-lad1/ai-apps`).
- Optional GitHub token field, explicitly labeled as optional and only needed to raise
  the rate limit. Store it in React state only — never write it to localStorage,
  never log it, never persist it anywhere. It's passed per-request to the API route
  and used only to set `GITHUB_TOKEN` in the spawned MCP server subprocess's env for
  that session.

### MCP client integration (`lib/mcp-client.ts`)
- On first request in a session, spawn the compiled `mcp-server` (`node
  ../mcp-server/dist/index.js`) as a child process with `StdioClientTransport`, with
  `GITHUB_TOKEN` set in its env if the user supplied one.
- Call `listTools()` once and cache the tool schemas for that session.
- Expose a `callTool(name, args)` function used by the chat loop.
- Reuse one subprocess per chat session; don't spawn a new one per message.

### Chat / tool-calling loop (`app/api/chat/route.ts`)
1. Convert the MCP tool schemas to the Claude API's tool-use format (or Ollama's
   equivalent tool-calling format, depending on `LLM_PROVIDER`).
2. Send the conversation + available tools to the LLM.
3. If the response contains `tool_use` blocks, call the corresponding MCP tools via
   `mcp-client.ts`, collect results, append them as tool results, and send back to the
   LLM. Loop until the LLM returns a final text response (cap at a reasonable max
   number of tool round-trips, e.g. 6, to avoid runaway loops).
4. Return both the final text response **and** the full list of tool calls made
   (name, args, result) so the UI can render the tool trace.
5. **Important:** when `LLM_PROVIDER=anthropic` and the model is a Claude Sonnet
   model, thinking mode must be explicitly disabled (`thinking: { type: "disabled" }`)
   with `max_tokens: 8192` — adaptive thinking has previously caused token-leakage
   issues with schema-constrained / tool-calling output in this repo's other
   projects. Apply the same fix here.

### `ToolTrace.tsx`
Render each tool call as a collapsed card: tool name, input params, and a
pretty-printed (collapsed by default) JSON result. This is a deliberate design choice
— it makes the MCP mechanics visible instead of hiding them behind a black-box chat
bubble.

### README for `demo-ui/`
Document: setup, env vars, how it relates to `mcp-server/` (spawns it, doesn't
reimplement its logic), and a note that this is a demo/reference client, not the
primary artifact.

---

## Build order

1. `mcp-server/` — get the server running standalone first, verify each tool against a
   real public repo (e.g. `manish-lad1/ai-apps` itself) via a manual MCP client or the
   MCP inspector before touching the UI.
2. `demo-ui/lib/mcp-client.ts` — verify subprocess spawning and `listTools()` /
   `callTool()` work against the compiled server.
3. `demo-ui/lib/llm-provider.ts` + the chat loop — wire up tool-calling end to end
   with Ollama first (`LLM_PROVIDER=ollama`), then verify against the Claude API.
4. UI components last: `RepoSelector`, `ChatPanel`, `ToolTrace`.

## Root-level README addition
Add an entry for `github_insights_mcp` in the root `ai-apps` README's "Repository
structure" section, consistent with the existing entries for `prd_critique_agent` and
`form_builder_agent`.

## Validation checklist before calling it done
- [ ] `mcp-server` runs standalone via a Claude Desktop `mcpServers` config with zero
      changes needed
- [ ] Every tool tested against at least one real public repo
- [ ] Rate-limit and 404 errors return clean structured messages, not stack traces
- [ ] No tool can create, update, or delete anything on GitHub
- [ ] Demo UI works with `LLM_PROVIDER=ollama` (no API key required) for local dev
- [ ] Demo UI works with `LLM_PROVIDER=anthropic` with thinking disabled
- [ ] GitHub token field in the UI is never persisted or logged
- [ ] Tool trace panel shows real tool names/params/results, not a fabricated summary
