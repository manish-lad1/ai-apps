# Agent guide — Form Builder Agent

Project-specific context for AI coding agents (Claude Code, Cursor, etc.) working on this repo. If you're a human, the [README](./README.md) is the better starting point — this file is about *how to work on the code*, not what it does for end users.

## What this project is

An agent that turns a plain-language description into a live, working form. The loop is: **generate** (description → structured spec) → **render** (spec → real inputs) → **refine** (conversational edits to the spec) → **export** (spec → standalone code). Preserve that shape when making changes — don't collapse generate/refine into one call, and don't let export depend on a fresh model call (see the security/architecture rule below, which matters more than usual here).

## The one rule that matters most — read this before touching anything

**The model never produces UI code. It only ever produces a structured JSON spec (`FormSpec`).** A fixed, pre-written React component (`FormRenderer.tsx`) maps that spec to real inputs. This is a **security decision, not a style preference**: letting a model emit raw HTML/JS and rendering it directly would be a genuine XSS risk — arbitrary AI-generated code executing in the browser. If a change proposal involves the model returning code, HTML, or anything beyond the fixed `FormSpec` shape, that's the wrong direction — push back and keep it data-only.

## Architecture — read this before editing

```
lib/llm-provider.ts → generateStructured({ systemPrompt, userPrompt, schema })
```
Same abstraction as the sibling project `prd_critique_agent` — copied in, not shared via a package, per this repo's "each project is self-contained" philosophy. Nothing outside this file should know whether it's talking to Ollama or Claude.

```
app/api/generate/route.ts   description + framework → first-pass FormSpec
app/api/refine/route.ts     current spec + instruction → updated FormSpec (full spec
                             regenerated each turn, not a surgical patch — same
                             "avoid union-type schema complexity" reasoning as the
                             PRD project's priority schema)

lib/schemas.ts   FormSpec / FormField types and JSON Schema. Two things the model
                 NEVER produces:
                   - `id` — generated in withGeneratedIds() by slugifying the label,
                     deduplicating on collision. stripIds() removes ids before a
                     spec is sent back to the model for refinement. Never let a raw
                     model response with a stray `id` flow through, and never send
                     a spec WITH ids back to the model.
                   - nothing else — `inferred: boolean` IS produced by the model on
                     every field (true = "I added this because forms like this
                     usually need it", false = "the user asked for this directly").

lib/prompts.ts   Generate and refine prompts. The refine prompt has one rule that's
                 easy to accidentally break while editing: if a user's instruction
                 removes or changes a field that was `inferred: true`, that's now an
                 explicit decision and must NOT be reverted on a later turn just
                 because forms of that type "usually" have it. If you're debugging
                 "why did a deleted field come back," check this prompt first.

lib/repetition-guard.ts   Detects degenerate/repetitive model output. Copied as-is
                 from prd_critique_agent — if you fix or tune something here, check
                 whether the same fix should be ported back to that project too.

lib/export.ts    exportAsJSX() and exportAsHTML() — PURE, SYNCHRONOUS template
                 functions over a FormSpec. Must NEVER call generateStructured() or
                 make any network call. The entire point is that exported code is
                 instant and byte-for-byte consistent with what's rendered on
                 screen — if export ever needs a second model call, something has
                 gone wrong in the design.

components/FormRenderer.tsx     FormSpec → live, validated inputs. The only place
                 that should ever map a `type` string to an actual HTML element.
components/RefinementChat.tsx   Chat-style input + instruction history, calls
                 /api/refine, replaces the current spec.
```

## Commands

```bash
npm run dev
npm run build        # minimum bar before considering any change done
npx tsc --noEmit
npx eslint app lib components
```

## Known failure modes — check for these first if output looks wrong

1. **Thinking-mode token leakage.** Same root cause documented in `prd_critique_agent`'s guide — a reasoning-mode model (or Claude Sonnet 5's default adaptive thinking) can leak tokens into schema-constrained JSON, or silently consume the token budget meant for the response. If a generated spec is truncated or contains stray tokens, check whether `thinking` is disabled for the active provider before touching prompts.
2. **Truncation vs. malformed JSON.** A `JSON.parse` failure almost always means the response ran out of token budget mid-generation. Raise `max_tokens` / `num_predict` before suspecting the schema.
3. **Degenerate repetition.** Caught by `repetition-guard.ts` after parsing — but in this project it can show up in a form-specific way too: duplicate or near-duplicate fields in the `fields` array after a refine call. If the guard isn't catching a case, check whether its duplicate-entry threshold needs adjusting for this shape of data.
4. **A deleted field reappears after further refinement.** This is a prompt-logic bug, not a model-reliability bug — check `lib/prompts.ts`'s `inferred` handling first (see above), not the model or the schema.
5. **Exported code doesn't match the live preview.** Check that `lib/export.ts` wasn't accidentally given a stale spec, and that it's still purely synchronous — no LLM call snuck back in.

## Conventions

- Schema changes go in `lib/schemas.ts` only.
- Prompt changes go in `lib/prompts.ts` only.
- **Adding a new field type touches three places, not one** — easy to forget one:
  1. `FIELD_TYPES` in `lib/schemas.ts`
  2. A render case in `components/FormRenderer.tsx`
  3. Handling in **both** `exportAsJSX()` and `exportAsHTML()` in `lib/export.ts`
- Don't add new npm dependencies for something achievable with native `fetch`, template strings, or a `RegExp` — same minimal-dependency stance as the rest of this repo.

## Testing changes

No automated test suite (by design, for a portfolio-scoped project). A reasonable manual pass when changing prompts or schemas:
1. Generate from 2-3 varied descriptions (a short one, a named-form-type one like "signup form" that relies on inference, a longer explicit one).
2. Delete an inferred field, then send another unrelated refinement instruction — confirm the deleted field doesn't come back.
3. Compare exported JSX/HTML against the live rendered form field-by-field.
