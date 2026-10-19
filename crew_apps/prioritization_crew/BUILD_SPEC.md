# prioritization_crew — Build Spec

**Purpose:** Demo app for the PUG Tech Talk on Sat Oct 24, 2026: *"Agent, Pipeline, or Crew? How I Choose Multi-Agent Patterns with Microsoft Agent Framework."*

**One app, one task, three patterns.** The app ranks a fictional product backlog of 6 features using four lenses (RICE, strategic fit, effort and risk, customer pain). The same task runs as:

1. **Agent:** one model, all four lenses in one prompt
2. **Pipeline:** four lens scorers fan out, plain-code aggregator, critic loop
3. **Crew:** four lens agents contest the ranking in a round-robin group chat

The audience compares the three on output, model calls, wall time and trace shape, then sees what removing one agent does to the pipeline vs the crew.

**Location:** `crew_apps/prioritization_crew/` in the `ai-apps` repo.

---

## Taxonomy this app demonstrates (do not change)

- **`_agent`:** one model looping with itself.
- **`_pipeline`:** separately prompted agents; the artifact moves forward only. Generator/critic is always a pipeline. Parallel fan-out with no agent-to-agent interaction (decomposition) is a pipeline sub-pattern.
- **`_crew`:** peer agents contest the same artifact symmetrically, order-independent.
- **Removal test:** removing an agent from a pipeline removes a step; removing one from a crew changes the character of the result.

The README and console output should use these terms consistently.

---

## Hard constraints

- **Python** and **Microsoft Agent Framework** (`agent-framework` on PyPI). Same language as `pipeline_apps/document_triage_pipeline`.
- **Local models only at runtime.** Foundry Local is the primary provider. Ollama (`agent-framework-ollama`) is a fallback only for 12b-class roles if Foundry Local has no usable 12b-class model. No cloud model unless I explicitly approve it after the spike.
- **Runs fully offline** once models are downloaded.
- **Self-contained folder.** Do not import from other projects. You may *read* `pipeline_apps/document_triage_pipeline/` (especially `foundry_endpoint.py` and `stage3_agentframework.py`) and copy/adapt what works. Do not modify anything outside `crew_apps/prioritization_crew/`.
- **Verify Agent Framework APIs against the installed version** before using them (inspect the package, its samples, or docs). The orchestration APIs changed recently; do not rely on memory for class or method names. Prefer the framework's built-in concurrent and group chat orchestrations; if one doesn't fit the requirement below, compose a graph workflow with executors and edges and say why in the README.
- **No model-chosen tool calls anywhere.** In the earlier project, `tool_choice="auto"` produced 0/10 tool calls on local models. All structured output comes from JSON in the response text, validated with Pydantic, with one retry on invalid JSON.
- **Temperature 0** (or the lowest supported) everywhere, for repeatable demos.
- **Fictional data only.** No real company, product, team or metric references.
- **Pin every dependency version** in `requirements.txt`.
- **Hardware:** MacBook Pro, Apple M5 Pro, 24 GB unified memory. No CUDA.

---

## Folder structure

```
crew_apps/prioritization_crew/
  README.md
  BUILD_SPEC.md          # this file
  SPIKE_REPORT.md        # written in Phase 0
  requirements.txt       # pinned
  .env.example           # placeholders only
  .gitignore
  run.py                 # CLI entry point
  devui_app.py           # DevUI entry point
  warmup.py              # loads every configured model before the talk
  config.py              # env vars -> model per role, round caps, tracing flag
  foundry_endpoint.py    # adapted from document_triage_pipeline
  clients.py             # builds a chat client per role (foundry | ollama)
  telemetry.py           # OpenTelemetry setup
  lenses.py              # the four lens definitions and prompts
  schemas.py             # Pydantic models
  readout.py             # call counter, timer, ranking tables, run files
  fixtures/backlog.json
  patterns/
    agent.py
    pipeline.py
    crew.py
    relay.py             # stretch, Phase 4 only
  spike/                 # Phase 0 scripts
  runs/                  # run outputs (gitignored)
  tests/
```

---

## Configuration (`.env.example`)

```
# Model per role. Format: <provider>:<model id>   provider = foundry | ollama
SCORER_MODEL=foundry:<small model, e.g. phi-4-mini>
AGENT_MODEL=foundry:<same as SCORER_MODEL, for a fair comparison>
CRITIC_MODEL=foundry:<12b-class model>
CREW_MODEL=foundry:<12b-class model>

MAX_CRITIC_ROUNDS=2
MAX_CREW_ROUNDS=2
TEMPERATURE=0

ENABLE_TRACING=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

---

## Data

### `fixtures/backlog.json`

A fictional product: **"Tandem," a team note-taking app.** Six features, each with:

- `id`, `name`, `description` (1–2 sentences)
- `reach` (users affected per quarter), `impact` (0.25 / 0.5 / 1 / 2 / 3), `confidence` (%), `effort` (person-weeks)
- `strategic_theme` (one of three company themes you define in the fixture, e.g. "enterprise readiness", "AI-assisted writing", "mobile")
- `customer_quotes`: exactly 2 short quotes

**Design the fixture so the lenses genuinely disagree.** The crew demo only works if they do. Include at least:

- one feature with the top RICE score but weak strategic fit
- one feature that is highly strategic but expensive
- one feature with intense customer pain but small reach
- one feature that is cheap, low-risk and middling on everything else

### `lenses.py`

Four lenses, each with a name, a one-line mandate and a prompt: **RICE**, **strategic fit**, **effort and risk**, **customer pain**. The same lens prompts are reused by every pattern so the comparison is fair.

### `schemas.py`

- `LensScores`: `lens`, `scores: [{feature_id, score (1–10 int), rationale (≤ 25 words)}]`, all six features required
- `Ranking`: `ranked: [{feature_id, rank, total, note}]`
- `CriticVerdict`: `approve: bool`, `objections: [{lens, feature_id, reason}]`
- `CrewPosition`: `lens`, `ranking: [feature_id x6]`, `responses: [{to_lens, stance: concede|rebut, reason}]`
- `CrewOutcome`: `ranking: Ranking`, `agreements: [str]`, `disagreements: [{feature_id, positions: {lens: rank}}]`

---

## The three patterns

### 1. Agent (`patterns/agent.py`)

One agent on `AGENT_MODEL`. The prompt contains the backlog and all four lens mandates; it returns a `Ranking` with a short note per feature. One model call (plus at most one retry).

### 2. Pipeline (`patterns/pipeline.py`)

1. **Fan-out:** four scorer agents (`SCORER_MODEL`), one per lens, run concurrently. Each returns `LensScores`.
2. **Aggregator:** plain Python, no model. Equal weights, sum of lens scores; ties broken by lower effort. Produces a `Ranking`.
3. **Critic:** one agent (`CRITIC_MODEL`) reviews the ranking against the lens scores and returns a `CriticVerdict`.
4. **Loop:** if the critic objects, only the lens scorer(s) named in the objections re-score the named feature(s) with the objection in context; then re-aggregate and re-critique. Cap at `MAX_CRITIC_ROUNDS`. At the cap, output the ranking **with the outstanding objections listed**. Never silently auto-approve.

This loop is asymmetric (critic judges, scorers revise), so it is a pipeline. Say so in the README.

### 3. Crew (`patterns/crew.py`)

Four lens agents on `CREW_MODEL` in a group chat with **round-robin speaker selection (no model picks the speaker)**.

- **Round 1:** each agent states its full ranking and its strongest objection to the likely consensus.
- **Round 2 (up to `MAX_CREW_ROUNDS`):** each agent must respond to at least one other agent **by lens name**, conceding or rebutting with a reason, then state its final ranking. Output is a `CrewPosition`.
- **Synthesis is plain code, not a manager agent:** Borda count across the four final rankings gives the crew ranking. Disagreements are features whose ranks differ by 2 or more across lenses. Output is a `CrewOutcome`.

No manager or moderator model. Adding one would turn it into a different pattern.

---

## CLI (`run.py`)

```
python run.py --pattern agent|pipeline|crew [--without <lens>] [--no-trace]
python run.py --compare            # runs all three back to back, prints a side-by-side table
```

- `--without <lens>` removes that lens from the pipeline (one score column disappears) and from the crew (one voice disappears). Works for `pipeline` and `crew`; for `agent` it removes that lens from the prompt.
- If a full run of the same pattern exists in `runs/`, print a **rank-delta table** (feature, rank with, rank without, change) after a `--without` run.

## Readout (`readout.py`)

After every run, print with `rich`:

- pattern name and its taxonomy label
- **model calls** (count every chat completion, including retries; wrap the chat client or use a counting middleware)
- **wall time**
- the final ranking table
- pipeline: the critic's outstanding objections, if any; crew: agreements and disagreements

Save each run as JSON to `runs/<timestamp>_<pattern>[_without-<lens>].json`. Output must be readable from the back of a room: short lines, no walls of text.

---

## Tracing and DevUI

- `telemetry.py`: when `ENABLE_TRACING=true`, configure Agent Framework's OpenTelemetry export to the OTLP endpoint above (the local collector in the Foundry Toolkit for VS Code). Disable sensitive-data capture by default.
- Give every agent a clear, distinct name (`lens.rice`, `lens.strategic_fit`, `lens.effort_risk`, `lens.customer_pain`, `critic`, `ranker`) so spans are readable on a projector.
- Wrap each run in a parent span carrying the pattern name.
- `devui_app.py`: expose the agent, the pipeline workflow and the crew workflow in DevUI. Check how the installed DevUI version discovers entities. The pipeline in DevUI is a must-have; the crew is nice-to-have.

## `warmup.py`

Loads every model named in `.env` and sends each a one-line prompt, printing load time per model. I run this an hour before the talk.

---

## Tests (`tests/`, pytest)

Use a fake chat client that returns canned JSON. Cover:

- schema validation and the one-retry path
- aggregator math and tie-breaking
- `--without` handling in pipeline and crew
- Borda count and disagreement detection
- critic loop stops at the cap and reports outstanding objections

---

## Phases

Work through these in order. **After each phase, stop, summarise what you did and what you found, commit to the current branch with a clear message, and wait for my go-ahead.** Do not push.

### Phase 0: Spike (stop and report)

Goal: retire the model risks before building. Put scripts in `spike/`.

1. List Foundry Local models available on this machine; note which support tool calling and their sizes.
2. Pick a small model (phi-4-mini or qwen3-4b) and the largest 12b-class model available.
3. Load both at the same time; report memory use.
4. Send the small model a `LensScores` request 10 times; report how many parse cleanly.
5. Run a minimal 2-round group chat with four lens agents on the 12b-class model. Judge honestly: do agents **rebut each other by name**, or just restate their own view?
6. Only if Foundry Local has no usable 12b-class model: repeat steps 3–5 with Ollama `gemma3:12b` (and `gemma4` if installed; check whether thinking tokens leak into the JSON).
7. Send one trace to the OTLP endpoint and confirm the spans arrive.
8. Measure wall time for each step.

Write `SPIKE_REPORT.md` with a results table and a recommendation for `SCORER_MODEL`, `CRITIC_MODEL` and `CREW_MODEL`. **Stop.**

### Phase 1: Scaffold and shared core

Folder, `requirements.txt` (pinned), `.env.example`, `config.py`, `clients.py`, `foundry_endpoint.py`, `schemas.py`, `lenses.py`, `fixtures/backlog.json`, `readout.py`, tests for schemas. **Stop.**

### Phase 2: Agent and pipeline

`patterns/agent.py`, `patterns/pipeline.py`, `run.py` for both patterns, `--without` for the pipeline, tracing, tests. Run each pattern 3 times and report wall times and call counts. **Stop.**

### Phase 3: Crew, removal and compare

`patterns/crew.py`, `--without` for the crew, rank-delta table, `--compare`, `devui_app.py`, `warmup.py`, tests. Run the crew 3 times and report wall time, call counts and the quality of rebuttals. **Stop.**

### Phase 4 (stretch, only if I say so): relay

`patterns/relay.py`: the same group chat API, but each agent refines the previous agent's ranking in turn. This is a pipeline built on the group chat API, because order matters and nobody contests. It proves that topology doesn't decide the pattern.

### Phase 5: README

Following my other ai-apps READMEs: what the app shows, the taxonomy, setup (Foundry Local install via Homebrew: `brew tap microsoft/foundrylocal` then `brew install foundrylocal`), how to run each demo, a results table filled from real `runs/`, placeholders for trace screenshots, and an honest findings section that includes anything that failed or was weak on local models.

---

## Before every commit

- `.env.example` contains placeholders only.
- `.gitignore` covers `.env*` (but not `.env.example`), `.venv/`, `__pycache__/`, `runs/`, `.claude/worktrees/`.
- No secrets, no real company data.
