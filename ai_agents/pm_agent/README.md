# PM Agent

**From a rough idea to a review-ready PRD** — an agent that drafts a PRD from a messy feature idea, critiques its own draft against a product-review rubric, then rewrites it to fix what it found.

> Part of [ai-apps](../../) — a collection of open, forkable AI apps by [Manish Lad](https://manishlad.substack.com).

<!-- Add a demo GIF or screenshot here once deployed -->

## What it does

You give it a rough, informal feature idea — the kind of thing a stakeholder drops in Slack in two sentences — and it produces a structured, review-ready PRD. Instead of one prompt and one answer, it runs a three-stage loop and shows you every stage as it happens:

```
01  Draft      →  first-pass PRD from your rough notes
02  Critique   →  a second pass reviews the draft against a PM rubric —
                   testability, missing edge cases, vague metrics, severity-rated
03  Refine     →  the draft is rewritten to address what the critique found
```

The point isn't just "AI writes a PRD" — plenty of tools do that. The point is making the *review* step real and visible, the same way a second pair of eyes catches things a first draft misses in an actual spec review.

## Features

- **Two prioritization frameworks** — MoSCoW or RICE, chosen per request. RICE scores are computed in code, not by the model — LLM arithmetic isn't reliable enough to trust for a number your roadmap depends on.
- **Provider-agnostic** — runs on a local Ollama model for free during development, or the Claude API for production, switched with a single environment variable. No code differs between the two paths.
- **True structured output** — uses Claude's native Structured Outputs and Ollama's schema-constrained generation, so every response is guaranteed to match a strict JSON Schema — no regex-scraping an LLM's free text.
- **A degeneration guard** — some models can produce repetitive or corrupted output that's still technically valid JSON. This is detected automatically and retried before it ever reaches the UI.
- **Severity-rated critique** — every critique point is tagged high/medium/low, so you can see at a glance what actually needs fixing versus a minor nit.

## How it works

Everything routes through one function: `generateStructured({ systemPrompt, userPrompt, schema })` in `lib/llm-provider.ts`. Nothing else in the app knows or cares whether it's talking to a local model or Claude — that's the single design decision the whole project is built around.

```
app/
  api/draft/     — raw idea + framework → first-pass PRD
  api/critique/  — draft PRD → structured review feedback
  api/refine/    — draft + critique → improved PRD
  page.tsx       — orchestrates the loop, progressive-reveal UI

lib/
  llm-provider.ts      — the ONE function that talks to Ollama or Claude
  schemas.ts           — JSON Schemas + types, built per-request based on
                          the chosen priority framework
  prompts.ts           — system/user prompts for all three loop stages
  repetition-guard.ts  — detects degenerate/repetitive model output
  route-helpers.ts     — shared validation + RICE score computation

components/
  Stage.tsx        — the numbered pipeline node + reveal animation
  PrdView.tsx       — renders a PRD (draft and refined both use this)
  CritiqueView.tsx  — renders critique points, sorted by severity
```

## Installation

```bash
git clone https://github.com/manish-lad1/ai-apps.git
cd ai-apps/ai_agents/pm-agent
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

Get a key at [console.anthropic.com](https://console.anthropic.com). A full draft → critique → refine run costs a fraction of a cent.

### Option B — Local model via Ollama (free)

```bash
ollama pull gemma3:12b   # or another model of your choice
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

1. Paste a rough feature idea into the text box (or click **"Try an example"**).
2. Choose **MoSCoW** or **RICE** for prioritization.
3. Click **Generate PRD** and watch the three stages resolve in order.
4. Read the critique panel — the severity tags tell you what's worth acting on.

## Example inputs

These are deliberately a bit messy — that's the point, they're closer to what a real stakeholder actually sends you than a clean spec would be.

> *"Our users keep complaining they can't find things in the app. Let's add a search bar at the top so they can search across everything — documents, people, settings, all of it. It needs to be fast and smart. This is high priority since it comes up a lot in feedback."*

> *"Admins want to clean up old records faster. Add a way to select multiple items in the admin table and delete them all at once."*

> *"Our docs are long and people don't read them. Add an AI feature that summarizes any document into a short summary so users can grasp it quickly."*

Good critiques to watch for on inputs like these: does it flag *untestable* language ("fast," "smart")? Does it catch implied risks the input doesn't mention outright — who's allowed to see search results, what happens to records referencing a deleted item, whether an AI summary could be confidently wrong?

## Key concepts learned building this

A few things worth calling out, either because they're genuinely useful or because they cost real debugging time:

- **Structured output ≠ correct output.** A JSON Schema guarantees *shape*, not *quality* or even *completion*. Both providers can still run out of token budget mid-generation and truncate a perfectly-shaped response into invalid JSON. Budgeting output length generously matters as much as the schema itself.
- **"Thinking" tokens compete with your output budget.** This bit twice, on two different vendors: a local reasoning-mode model (Gemma 4) leaked its internal reasoning into constrained JSON output, and Claude Sonnet 5's *adaptive thinking* (on by default) silently consumed part of a fixed `max_tokens` budget meant for the actual response. Same underlying failure mode, two different systems — worth checking for on any model with a reasoning mode.
- **Compute deterministic things in code, not in the model.** RICE scores are a simple formula. Rather than trust an LLM's arithmetic, the model estimates the inputs and the code computes the score. Small decision, but it removed an entire category of possible errors.
- **A flaw-based eval beats a golden-output eval for generative tasks.** There's no single "correct" PRD for a rough idea, so grading against one exact expected output mostly measures wording differences. Testing whether the critique step catches *specific, deliberately planted* problems — and rating severity calibration and false positives — gave a far more honest signal of model quality.
- **Self-critique can be a genuine safety net, not just a nice idea.** In testing, the critique step reliably caught its own draft step's corruption and even independently re-checked the draft's arithmetic — useful, unprompted behavior that came for free from the loop structure.

## What else you can do with this

Some natural directions if you want to extend it:

- **A real tool call mid-loop** — e.g. an `estimate_effort()` function the agent can invoke, pushing it from a "chain" toward a genuine agent in the strict sense.
- **A template switcher** — standard PRD vs. an Amazon-style 6-pager vs. JTBD framing.
- **A clarifying-questions step** before drafting, for inputs too vague to draft from confidently.
- **Swap the domain entirely** — the draft → critique → refine pattern isn't PRD-specific. The same loop works for a marketing brief, an incident postmortem, or a design doc, by changing `lib/prompts.ts` and `lib/schemas.ts`.

## License

MIT — see the [root LICENSE](../../LICENSE).
