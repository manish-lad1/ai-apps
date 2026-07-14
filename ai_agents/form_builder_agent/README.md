# Form Builder Agent

**From a plain-language description to a live, working form** — describe a form in plain English, watch it render as a real HTML form with working validation, refine it conversationally, then export clean React or HTML code.

> Part of [ai-apps](../../) — a collection of open, forkable AI apps by [Manish Lad](https://manishlad.substack.com).

<!-- Add a demo GIF or screenshot here once deployed -->

## What it does

Describe a form the way you'd describe it to a coworker — *"a job application form with resume upload, years of experience, and availability"* — and it produces a real, fillable, validating form immediately, not a mockup:

```
01  Generate  →  plain-language description → structured form spec
02  Render    →  spec renders as a live form — real inputs, real HTML5
                  validation, nothing that's just for show
03  Refine    →  describe a change in plain English; the model updates
                  the spec and tells you exactly what it did
04  Export    →  copy the same form as a working JSX component or
                  standalone HTML — instant, no LLM call involved
```

The interesting part isn't "AI generates a form" — plenty of tools do that. The interesting part is that one structured spec drives three completely different outputs (the live preview, the JSX export, the HTML export) with zero drift between them, because export is a pure function over the same data the preview renders from.

## Features

- **Field IDs are never trusted to the model.** The model produces labels, types, and validation rules — never an `id`. IDs are slugified from the label and deduplicated deterministically in code (`withGeneratedIds()`), the same reasoning [`prd_critique_agent`](../prd_critique_agent) applies to RICE scores: don't ask an LLM to do something code can do exactly.
- **Inferred vs. explicit field tracking.** Every field carries an `inferred: boolean` — `true` if the model added it because forms like this usually need it (e.g. a "confirm password" field on a signup form), `false` if you asked for it directly. Refinement respects this: remove an inferred field and it's gone for good, not silently re-added on a later turn.
- **Native, working HTML5 validation.** `required`, `minLength`/`maxLength`, `min`/`max`, and `pattern` are real DOM constraint-validation attributes, checked with `checkValidity()`/`reportValidity()` on submit. Checkbox groups — which have no native "at least one checked" constraint — get a hidden proxy input so they still validate through the same mechanism instead of a hand-rolled parallel check.
- **Conversational refinement with real feedback.** Each instruction appears in the log immediately with an "Updating…" state, then resolves in place to a one-sentence, model-written confirmation of what actually changed (e.g. *"Added a required phone field."*) — not just a generic success flag.
- **Provider-agnostic** — Claude API or a local Ollama model, switched with one environment variable. No code branches on which provider is active outside `lib/llm-provider.ts`.
- **True structured output** — Claude's native Structured Outputs and Ollama's schema-constrained generation, so every response is guaranteed to match a strict JSON Schema.
- **A degeneration guard** — catches repetitive or corrupted model output (still technically valid JSON, but broken) and retries once before surfacing an error.
- **Export is instant and drift-free.** `exportAsJSX()` / `exportAsHTML()` are pure template functions over the same `FormSpec` the preview renders from — no LLM call, so what you copy always exactly matches what you saw.
- **Manual light/dark theme toggle**, persisted across reloads with no flash of the wrong theme.

## How it works

Everything routes through one function: `generateStructured({ systemPrompt, userPrompt, schema })` in `lib/llm-provider.ts`. Nothing else in the app knows or cares whether it's talking to a local model or Claude.

```
app/
  api/generate/route.ts  — description → FormSpec
  api/refine/route.ts    — spec + instruction → updated FormSpec + a one-line summary
  page.tsx                — orchestrates the flow: description input → two-panel
                             (preview + refine) → export
  layout.tsx              — fonts, metadata, blocking theme-init script
  globals.css             — the "Signal" visual identity (steel/ink surfaces,
                             monospace labels, zero border-radius) with light/dark palettes

lib/
  llm-provider.ts      — the ONE function that talks to Ollama or Claude
  schemas.ts           — FormSpec/FormField types + JSON Schema; withGeneratedIds()
                          / stripIds() implement the id-handling rule above
  prompts.ts           — system/user prompts for generate and refine
  repetition-guard.ts  — detects degenerate/repetitive model output
  export.ts            — exportAsJSX() / exportAsHTML(), pure templates, no LLM calls

components/
  FormRenderer.tsx      — live-rendering form: every FormField.type mapped to a
                          real input, native validation, an inferred-field marker
  RefinementChat.tsx    — command-log style refine panel: pending → done/error
  ThemeToggle.tsx       — manual light/dark override, persisted to localStorage
```

## Installation

```bash
git clone https://github.com/manish-lad1/ai-apps.git
cd ai-apps/ai_agents/form_builder_agent
npm install
cp .env.example .env.local
```

Then pick one of the two options below.

### Option A — Claude API (recommended, works immediately)

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key-here
ANTHROPIC_MODEL=claude-sonnet-5
```

Get a key at [console.anthropic.com](https://console.anthropic.com).

### Option B — Local model via Ollama (free)

```bash
ollama pull gemma4:12b   # or another model of your choice
```

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:12b
```

> **Model note:** prefer models *without* a "thinking"/reasoning mode for local use (e.g. `gemma3`, not `gemma4`). Reasoning-mode models can leak internal thinking tokens into schema-constrained JSON, corrupting the output — see [Key concepts](#key-concepts-learned-building-this) below. The degeneration guard catches this, but a non-reasoning model avoids it entirely.

## Usage

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), then:

1. Describe the form you want (or click **"Use example"**).
2. Click **Build form** — a live, fillable form appears next to a refine panel.
3. Type follow-up instructions in plain English (*"add a phone field"*, *"make email required"*) — each one shows up immediately, then resolves to a confirmation of what changed.
4. Click **Copy as JSX** or **Copy as HTML** to grab the exact same form as working code.
5. **Start over** to describe a new form from scratch.

## Example prompts

> *"A signup form for a newsletter about vintage synthesizers — name, email, and how often they'd like to hear from us."*

> *"A job application form with resume upload, years of experience, and availability."*

> *"An event RSVP form — name, number of guests, dietary restrictions, and whether they need parking."*

Good things to check on inputs like these: does it infer the fields a form like this obviously needs (e.g. password confirmation on a signup form) without inventing anything you didn't ask for? Does removing an inferred field in a follow-up actually stick, instead of reappearing on a later refinement?

## Key concepts learned building this

- **Never let the model own an identifier it doesn't need to reason about.** Field `id`s are generated deterministically in code from the label, not produced by the model — removing an entire class of "did the model keep IDs consistent across turns" bugs, the same principle [`prd_critique_agent`](../prd_critique_agent) applies to RICE scores.
- **A boolean flag can encode intent, not just state.** `inferred: true/false` isn't just metadata — it changes how refinement behaves. Once a person has explicitly acted on a field, even to remove it, that decision has to survive every future turn, or the UI starts arguing with the user about their own instructions.
- **Structured output ≠ visually correct output.** A JSON Schema guarantees shape, but two real bugs slipped past that guarantee during testing: a single checkbox/switch fell back to a generic "Yes"/"Enabled" label instead of the field's actual label, and the plain-HTML export had dark text with no explicit background — invisible under a browser/OS dark-mode default. Neither was caught by `tsc` or `eslint`; both only surfaced by rendering the actual output in a browser.
- **"Thinking" tokens compete with your output budget.** Testing this app against a local Gemma 4 model (which has a reasoning mode) worked correctly across several generate/refine calls, but the risk is real and documented independently in [`prd_critique_agent`](../prd_critique_agent): reasoning-mode models can leak internal thinking tokens into schema-constrained JSON. Prefer a non-reasoning model (`gemma3`, not `gemma4`) for local use.
- **A theme toggle needs to fight the framework, a little.** Applying a stored theme before hydration — to avoid a flash of the wrong theme — means the server-rendered HTML and the first client paint *intentionally* disagree on one attribute. `suppressHydrationWarning` on `<html>` is the correct fix for that specific, deliberate mismatch, not a workaround to reach for reluctantly elsewhere.
- **Export correctness lives at the file-extension boundary, not just the code.** The generated JSX is valid TypeScript+JSX — verified by compiling it standalone against this project's own strict `tsconfig.json` — but pasting it into a file saved as `.ts` instead of `.tsx` produces a parser error that looks like a bug in the export. It isn't; JSX syntax is simply invalid in a non-`.tsx`/`.jsx` file. Worth checking before assuming exported code itself is broken.

## What else you can do with this

- **More field types** — file upload, rating/slider, address autocomplete.
- **Conditional logic** — show or hide a field based on another field's value.
- **Multi-step / paginated forms** for longer flows.
- **A real submission target** — wire the generated `handleSubmit` to an actual endpoint or a service like Zapier/Make instead of `console.log`.
- **Shareable specs** — encode a `FormSpec` into a URL so a form can be shared and reopened without regenerating it.

## License

MIT — see the [root LICENSE](../../LICENSE).
