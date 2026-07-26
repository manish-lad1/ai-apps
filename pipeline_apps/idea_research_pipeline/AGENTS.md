# Agent guide — Idea Research Pipeline

Project-specific context for AI coding agents (Claude Code, Cursor, etc.) working on this repo. If you're a human, the [README](./README.md) is the better starting point — this file is about *how to work on the code*, not what it does for end users.

## What this project is

A four-gate pipeline: question generation → **human approval** → parallel decomposed research → report with a generator/critic loop. Stages hand artifacts forward; they don't converse.

Two properties are the whole point of the project. Preserve them:

1. **Stage 03 research agents are isolated from each other.** No shared context, no message passing, no "here's what the other agents found". If two agents reach contradictory conclusions, that contradiction must survive to stage 04 — detecting it there is the most valuable thing this app does. Making the agents aware of each other would turn a pipeline into a crew and quietly destroy that signal.
2. **The stage 04 loop is asymmetric.** The critic reviews and objects; it never rewrites. Don't "improve" it by letting the critic propose its own version, and don't collapse the two agents into one model critiquing itself — that's [`prd_critique_agent`](../../ai_agents/prd_critique_agent), a different project.

## Architecture — read this before editing

Two abstraction seams. Nothing outside these files may branch on a provider:

```
lib/llm-provider.ts     → generateStructured({ systemPrompt, userPrompt, schema, maxTokens })
lib/search-provider.ts  → search(query) → { results, digest }
```

If you're adding a feature and find yourself checking `LLM_PROVIDER` or `SEARCH_PROVIDER` anywhere else, the abstraction is leaking — push the logic back in.

```
lib/
  confidence.ts        deriveConfidence(sources, {reachedSufficiency}). THE rule. Pure
                        function, no model call, safe to import client-side. If you
                        change the rule, update the README's Design principles section —
                        the rule being explainable is a feature.
  schemas.ts           JSON Schema per model call. Claude's Structured Outputs needs
                        `additionalProperties:false` + explicit `required` on EVERY
                        object. Keep nesting to 2 levels — deeper measurably degrades
                        local-model reliability. IDs are never in a schema; they're
                        assigned in code.
  prompts.ts           All system/user prompts. Tune output quality HERE first — almost
                        always cheaper than changing a schema or the loop.
  config.ts            Every env-tunable limit, validated and range-clamped in one place.
  route-helpers.ts     Input validation + the server-side approval gate + ndjsonStream().
  repetition-guard.ts  Degenerate-output detection; runs after every generateStructured().

agents/
  research-agent.ts    Two things live here: the per-question round loop, and
                        researchAll()'s concurrency scheduler (fixed worker pool over a
                        shared cursor). Both are load-bearing.
  report-generator.ts  reconcileReport() overwrites confidence/question/category from the
                        real Stage 2 results and re-adds any question the model skipped.
                        Facts we already computed are not the model's to restate.
  report-critic.ts     Enforces "any high or medium finding blocks approval" in code.

app/api/*/route.ts     Thin: validate input, run the stage, stream NDJSON.
                        The stage 04 generator/critic LOOP lives in generate-report's
                        route — it's orchestration, not agent logic.
```

## Commands

```bash
npm run dev          # start local dev server
npm run build        # production build — the bar before calling a change done
npx tsc --noEmit     # type-check only, faster than a full build
npx eslint app lib components agents
```

## Known failure modes — check these first if output looks wrong

1. **Thinking-mode token leakage / budget theft.** Any model with a reasoning mode can leak internal reasoning into schema-constrained JSON, or spend the `max_tokens` budget meant for the response on hidden thinking. `think: false` is set on every Ollama call and `thinking: {type:"disabled"}` on the schema-constrained Claude calls. **Don't remove either.** If output is truncated or contains stray tokens, check this before suspecting the prompt.
2. **…but don't disable thinking on the search call.** `searchWithAnthropic` deliberately leaves thinking on, because Claude Opus 5 with thinking disabled can write a tool call out as visible text instead of invoking it — the search silently never runs and you get an empty result with no error. Thinking off is correct only where no tool is attached.
3. **Truncation vs malformed JSON.** "Unterminated string" from `JSON.parse` almost always means the response ran out of budget mid-generation. Raise that call's `maxTokens` before suspecting the schema.
4. **Confidence looks too high.** Check `reachedSufficiency`, not just the source count. An agent can retrieve three agreeing sources that never address the question; the sufficiency input exists to catch exactly that. See `lib/confidence.ts`.
5. **A cited URL isn't in the sources list.** That's `keepOnlyRetrievedSources()` doing its job — it drops any URL that never appeared in a real search result for that question. Check the search actually returned results before assuming a bug.
6. **Stage 04 approves with objections listed.** Smaller local models return `approved: true` alongside findings. `report-critic.ts` overrides this. If you see it in logs, that's the guard, not a failure.

## Conventions

- Self-contained by design: `llm-provider.ts` is a local copy of the pattern from `prd_critique_agent`, deliberately **not** imported across project folders. Same for anything else shared-looking.
- Schema changes go in `lib/schemas.ts` only; prompt changes in `lib/prompts.ts` only. Don't inline either in a route or an agent.
- Limits go in `lib/config.ts` with a sane default and a clamped range — never read `process.env` for a pipeline limit elsewhere.
- Compute deterministic things in code, not in the model: confidence, IDs, question/category reconciliation, the approval threshold. If you catch yourself asking the model to restate something the code already knows, overwrite it instead.
- Don't add dependencies for what `fetch` / `JSON.parse` / native APIs already do. Current deps: Next, React, Tailwind, the Anthropic SDK. That's intentional, not an oversight.
- Streaming is NDJSON over a `ReadableStream` (`ndjsonStream()` in route-helpers) — not SSE. One-way progress only; no EventSource, no reconnect semantics.

## Testing changes

There's no automated test suite (by design, for a portfolio-scoped project). Verify against the free path — Ollama + Tavily — which covers everything except the Claude-specific code:

1. **Stage 01/02:** generate questions, edit one, delete one, add a custom one, uncheck to 2 and confirm the gate blocks. Also `curl` `/api/run-research` with 2 questions — the server gate must reject independently of the UI.
2. **Stage 03:** approve more questions than `MAX_CONCURRENT_RESEARCH_AGENTS` and confirm the grid shows exactly the cap running with the rest queued, then backfilling. Expand a row and check the trace shows real queries and round transitions.
3. **`deriveConfidence` is a pure function** — the cheapest thing in the project to test directly. Cover: same-domain pages don't count as corroboration, disagreement caps at `low`, and `reachedSufficiency:false` caps at `low`.
4. **Stage 04:** `curl` `/api/generate-report` with hand-written research results. Two cases worth keeping: results that deliberately contradict each other (does `open_contradictions` name it?), and results with no sources at all (does the loop escalate rather than approve?).

**The Claude path (`LLM_PROVIDER=claude` / `SEARCH_PROVIDER=anthropic`) needs a real API key and has not been exercised end-to-end.** Its shapes type-check against the installed SDK, but verify it against a live key before considering a provider-affecting change done — especially `searchWithAnthropic`'s `pause_turn` resume loop and the `web_search_tool_result` block parsing, which have no local equivalent.
