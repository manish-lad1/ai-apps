# Naming convention

How projects in this repo are named, so it stays consistent as new ones are added.

## Pattern

`<artifact-or-domain>-<pattern-suffix>`

The first part names *what it does* (the domain or artifact — `prd`, `meeting`, `invoice`, `newsletter`). The suffix names *how it's built*, so the AI architecture is visible from the folder name alone, before opening the README.

| Pattern | Suffix | Signals | Lives in | Example |
|---|---|---|---|---|
| Single agent | `-agent` | One LLM-driven agent, possibly multi-step internally | `ai_agents/` | `prd_critique_agent` |
| Multi-agent orchestration | `-crew` | Multiple distinct agents contesting or debating the *same* question at the same level — symmetric, order-independent | `crew_apps/` | `prioritization_crew` |
| Multi-stage handoff | `-pipeline` | Multiple distinct agents passing an artifact forward through fixed, ordered stages — possibly with gates (human approval) or asymmetric generator/critic loops within a stage | `pipeline_apps/` | `idea_research_pipeline` |
| RAG app | `-rag` | Retrieval-augmented generation | `rag_apps/` | `knowledge_base_rag` |
| MCP server | `-mcp` | Exposes tools via MCP (a tool *provider*, not itself an agent) | `mcp_apps/` | `github_insights_mcp` |
| Utility app | *(plain name, no suffix)* | General tool; may or may not be AI-driven | `utility_apps/` | `finance_tracker` |

## Rules of thumb

- **No `ai-` prefix.** Every project in this repo is already an AI project — the repo name and category folder already say that. A prefix repeated on every folder adds no information and pushes the actually-distinguishing part of the name further right.
- **Don't call something an "agent" unless it's genuinely agentic** — autonomous, multi-step, making its own decisions about what to do next. A RAG app that just retrieves-then-generates isn't an agent. An MCP server is a tool *provider*, not an agent — it's the thing an agent calls. Precision here signals real understanding to technical readers; misusing "agent" as a generic AI-project suffix reads as marketing rather than engineering.
- **The suffix should earn its place.** If a project doesn't cleanly fit one category (e.g. an agent that's also RAG-backed), pick the suffix for its *primary* architecture and explain the rest in the README — don't stack suffixes.
- **Keep it short.** Two to four words, kebab-case, no abbreviations that need explaining.

## Deciding "agent" vs "crew" vs "pipeline"

Three questions settle it:

**1. How many agents, and do they loop with themselves?**
One system prompt, one model, driving a multi-step internal loop (draft → critique → refine) — that's still `-agent`. The loop happens *inside* a single agent's process, even if it alternates roles.

**2. Does the artifact move forward only, or get contested at the same level?**
- `-pipeline`: forward-only. Each stage takes the previous stage's *output*, produces its own output, hands off. Agents don't see each other's reasoning, only results. Order is fixed and meaningful — reordering breaks it. A pipeline stage can contain an asymmetric generator/critic loop (one agent drafts, another critiques and sends it back) or a human approval gate — that's still forward motion, just paused or cycled *within* one stage before advancing.
- `-crew`: the same artifact or question, engaged by multiple *peer* agents at the same level, where the result is a genuine function of their disagreement. Order is arbitrary or parallel. Removing an agent doesn't remove a step — it changes the character of the output.

**3. Can you remove one agent without changing what the answer means?**
- Pipeline: no — removing a stage removes a step (no report without research).
- Crew: also no, but differently — the process doesn't get shorter, the *character* of the result changes (drop the strategic-fit voice from a prioritization crew, and "top of the list" now means something else).

**A note on parallel-but-independent work:** agents that fan out to work independent sub-questions in parallel and then get aggregated (e.g. one research agent per question, no interaction between them) are neither crew nor a standalone pattern of their own — this is *decomposition*, a sub-pattern that lives *inside* a `-pipeline` stage. It's not a crew because the agents never contest each other; it doesn't get its own suffix because it's not a top-level architecture, just how one stage does its work.

**A note on generator/critic loops specifically:** a critic reviewing a generator's draft and sending it back is asymmetric — one agent holds a gate the other doesn't — not a peer contest. That makes it part of a `-pipeline` stage, never a reason to use `-crew`, even though two distinctly-prompted agents are involved.
