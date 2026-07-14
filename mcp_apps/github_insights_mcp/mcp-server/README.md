# github-insights-mcp-server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
**read-only** GitHub repo insight tools over stdio. Point any MCP client at it — Claude
Desktop, Claude Code, the [MCP inspector](https://github.com/modelcontextprotocol/inspector),
or the `demo-ui/` app in this project — and it can answer questions about a GitHub repo's
structure, activity, issues, and PRs.

Every tool takes `owner` and `repo` as required parameters. Nothing is hardcoded to one
repository. Tools return **structured JSON, not prose** — summarizing that data into natural
language is the calling LLM's job, not this server's.

This server is read-only by design: no tool creates, updates, or deletes anything on GitHub.

## Tools

**Content & structure**
| Tool | Description |
|---|---|
| `get_repo_structure` | File/directory tree at a given path (default: full recursive tree from the root) |
| `get_file_content` | Decoded content of a single file (rejects files over ~100KB with a clear message) |
| `search_code` | Code search scoped to the repo (GitHub's code search API requires `GITHUB_TOKEN` — it 401s unauthenticated even for public repos) |
| `get_readme` | Fetches and decodes the repo's README |

**Activity & insights**
| Tool | Description |
|---|---|
| `summarize_changelog` | Commits between two refs, grouped by conventional-commit type (feat/fix/chore/docs/etc.) |
| `get_commit_activity` | Commit counts bucketed by day, week, and author |
| `get_contributor_stats` | Contributor list with commit counts |
| `get_release_notes_draft` | Merged PRs since a tag (or the latest release), grouped by label |

**Issues & PRs**
| Tool | Description |
|---|---|
| `list_issues` | Filtered issue list (state/labels/assignee); excludes PRs |
| `get_issue_details` | Full issue plus its comment thread |
| `list_pull_requests` | Filtered PR list with basic diff stats (files changed, +/- lines) |
| `get_pr_details` | Full PR: files changed, review status, comments |
| `search_issues` | Cross issue/PR search scoped to the repo |

## Auth

`GITHUB_TOKEN` is **optional**. Without it, the server falls back to unauthenticated GitHub
API calls (60 requests/hour) — it still works, just with a lower ceiling. Set it to raise
the limit to 5,000 requests/hour. No write scopes are needed for anything this server does.

## Running standalone

```bash
npm install
npm run build
GITHUB_TOKEN=ghp_xxx npm start   # GITHUB_TOKEN is optional
```

This starts the server on stdio — it's meant to be spawned by an MCP client, not run
interactively. To sanity-check it manually, use the
[MCP inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Using it from Claude Desktop

Add this to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github-insights": {
      "command": "node",
      "args": ["/absolute/path/to/mcp_apps/github_insights_mcp/mcp-server/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

Drop the `env` block entirely if you don't want to set a token — the server still runs, just
at the lower unauthenticated rate limit.

## Development

```bash
npm run dev    # tsc --watch
npx tsc --noEmit  # type-check only
```

## Relationship to `demo-ui/`

`demo-ui/` (in the parent folder) is a reference chat client that spawns this server as a
subprocess and lets an LLM call these tools to answer natural-language questions. This
server has no dependency on it and works the same standalone in any MCP client.
