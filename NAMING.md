# Naming convention

How projects in this repo are named, so it stays consistent as new ones are added.

## Pattern

`<artifact-or-domain>-<pattern-suffix>`

The first part names *what it does* (the domain or artifact — `prd`, `meeting`, `invoice`, `newsletter`). The suffix names *how it's built*, so the AI architecture is visible from the folder name alone, before opening the README.

| Pattern | Suffix | Signals | Lives in | Example |
|---|---|---|---|---|
| Single agent | `-agent` | One LLM-driven agent, possibly multi-step internally | `ai_agents/` | `prd-critique-agent` |
| Multi-agent orchestration | `-crew` | Multiple distinct, cooperating or debating agents | `ai_agents/` | `prioritization-crew` |
| RAG app | `-rag` | Retrieval-augmented generation | `rag_apps/` | `newsletter-rag` |
| MCP server | `-mcp` | Exposes tools via MCP (a tool *provider*, not itself an agent) | `mcp_apps/` | `pm-toolkit-mcp` |
| Utility app | *(plain name, no suffix)* | General tool; may or may not be AI-driven | `utility_apps/` | `finance-tracker` |

## Rules of thumb

- **No `ai-` prefix.** Every project in this repo is already an AI project — the repo name and category folder already say that. A prefix repeated on every folder adds no information and pushes the actually-distinguishing part of the name further right.
- **Don't call something an "agent" unless it's genuinely agentic** — autonomous, multi-step, making its own decisions about what to do next. A RAG app that just retrieves-then-generates isn't an agent. An MCP server is a tool *provider*, not an agent — it's the thing an agent calls. Precision here signals real understanding to technical readers; misusing "agent" as a generic AI-project suffix reads as marketing rather than engineering.
- **The suffix should earn its place.** If a project doesn't cleanly fit one category (e.g. an agent that's also RAG-backed), pick the suffix for its *primary* architecture and explain the rest in the README — don't stack suffixes.
- **Keep it short.** Two to four words, kebab-case, no abbreviations that need explaining.

## Deciding "agent" vs "crew"

If there's one system prompt and one model driving a multi-step internal loop (draft → critique → refine, for example) — that's still `-agent`. The loop happens *inside* a single agent's process.

If there are genuinely distinct personas/roles calling the model separately with different jobs, possibly disagreeing with each other (a researcher agent, a writer agent, and a critic agent handing off work, or two agents arguing opposite sides of a decision) — that's `-crew`.
