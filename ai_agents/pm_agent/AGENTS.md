# Agent guide — PM Agent

Project-specific context for AI coding agents (Claude Code, Cursor, etc.) working on this repo. If you're a human, the [README](./README.md) is the better starting point — this file is about *how to work on the code*, not what it does for end users.

## What this project is

An agent that turns a rough feature idea into a PRD through a three-stage loop: **draft → critique → refine**. The critique stage is a second model call reviewing the first, against a fixed rubric — that's the entire point of the project, so preserve it when making changes. Don't collapse the loop back into a single call, even if it seems simpler.

## Architecture — read this before editing

Everything in the app funnels through one function:

```
lib/llm-provider.ts → generateStructured({ systemPrompt, userPrompt, schema })
```

Nothing else in the codebase should know whether it's talking to Ollama or Claude. If you're adding a feature and find yourself branching on `LLM_PROVIDER` anywhere outside this file, that's a sign the abstraction is leaking — push the logic back into `llm-provider.ts` instead.

```
app/api/{draft,critique,refine}/route.ts   thin handlers: validate input, build the
                                             prompt + schema, call generateStructured()
lib/schemas.ts        JSON Schema + TypeScript types. PRD schema is built per-request
                       via buildPrdSchema(framework) — each request contains exactly
                       ONE priority shape (MoSCoW or RICE), never a union. Keep nesting
                       to 2 levels max; deeper nesting measurably degrades reliability
                       on local models.
lib/prompts.ts         All system/user prompts for the three stages. Tune here first
                       if output quality needs adjusting — usually cheaper than
                       touching the schema or the loop logic.
lib/repetition-guard.ts  Detects degenerate output (token-repetition loops, duplicate
                       array entries) that's still valid JSON. Runs after every
                       generateStructured() call; one automatic retry before throwing.
lib/route-helpers.ts   Shared input validation + RICE score computation. RICE's score
                       is computed here in code, NEVER by the model — LLM arithmetic
                       isn't reliable enough to trust for a prioritization number.
```

## Commands

```bash
npm run dev          # start local dev server
npm run build        # production build — run this before considering any change done
npx tsc --noEmit     # type-check only, faster than a full build
npx eslint app lib components
```

Treat a clean `npm run build` as the minimum bar before calling a change finished — it catches route-wiring and type issues that `tsc` alone can miss.

## Known failure modes — check for these first if output looks wrong

1. **Thinking-mode token leakage.** Any model with a reasoning/"thinking" mode can leak internal reasoning into schema-constrained JSON output (seen on Gemma 4 locally), or have that reasoning silently consume the `max_tokens` budget meant for the response (seen on Claude Sonnet 5, where adaptive thinking is on by default). If output is truncated or contains stray tokens like `thought_process_` or leaked internal field names, check whether thinking is disabled for the active provider before assuming it's a prompt problem.
2. **Truncation vs. malformed JSON.** "Unterminated string" or similar `JSON.parse` errors almost always mean the response ran out of token budget mid-generation, not that the model produced genuinely broken JSON. Raise `max_tokens` / `num_predict` before suspecting the schema or prompt.
3. **Degenerate repetition.** A model can produce perfectly valid JSON that's just the same story/point repeated many times. `lib/repetition-guard.ts` catches this after parsing — if you're debugging a "why does this look wrong but no error was thrown" case, check whether the guard's thresholds need adjusting rather than assuming it's a content-quality issue.

## Conventions

- Schema changes go in `lib/schemas.ts` only — both providers read from the same schema, so there's one place to update, not two.
- Prompt changes go in `lib/prompts.ts` only — don't inline prompt strings in the route handlers.
- Add a new priority framework by: extending the `Framework` type, adding a JSON Schema branch in `buildPrdSchema()`, adding framework-specific guidance text in `prompts.ts`'s `FRAMEWORK_GUIDANCE`, and a UI toggle option in `page.tsx`. All four steps, or the framework won't actually reach the model.
- Don't add new npm dependencies for something `fetch`, `JSON.parse`, or a native `RegExp` can already do — the project deliberately has few dependencies (Next.js, Tailwind, the Anthropic SDK) and that's intentional, not an oversight.

## Testing changes

There's no automated test suite (by design, for a portfolio-scoped project) — instead there's a flaw-based eval set (`pm-agent-eval.xlsx`, kept alongside this project during development, not committed) with 10 inputs, each with deliberately planted issues the critique step should catch. If you're changing prompts or schemas, a quick way to sanity-check impact is running a couple of those inputs through both providers before and after your change, rather than relying on a single manual test.
