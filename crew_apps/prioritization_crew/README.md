# Prioritization Crew

Rank one product backlog three ways: as an agent, as a pipeline, and as a crew. Same task, same lens prompts, same local models. Compare what each pattern produces, what it costs, and what its trace looks like.

Part of [ai-apps](../../), a collection of small, self-contained AI applications, each demonstrating one architecture end to end. This one is the demo for the PUG Tech Talk on 24 October 2026: *"Agent, Pipeline, or Crew? How I Choose Multi-Agent Patterns with Microsoft Agent Framework."*

## Demo

> _GIF to be added._

| Trace | Screenshot |
|---|---|
| Agent (3 spans) | _to be added_ |
| Pipeline (about 56 spans) | _to be added_ |
| Crew (about 243 spans) | _to be added_ |
| Pipeline in DevUI | _to be added_ |

## What it shows

A fictional team note-taking app, **Tandem**, has six candidate features. Four lenses judge them: **RICE**, **strategic fit**, **effort and risk**, and **customer pain**. The app ranks the backlog with the same four lenses arranged three ways:

| Pattern | Shape | Model calls | What decides the ranking |
|---|---|---|---|
| **Agent** | one model, all four lenses in one prompt | 1 | the model |
| **Pipeline** | four lens scorers fan out → plain-code sum → critic loop | 9–12 | arithmetic, then a critic's objections |
| **Crew** | four lens agents argue in a round-robin group chat → Borda count | 8 | each lens's final ranking, combined by plain code |

The taxonomy, used the same way in the code, the console output and this README:

- **`_agent`**: one model looping with itself.
- **`_pipeline`**: separately prompted agents; the artifact only moves forward. Generator/critic is always a pipeline. A parallel fan-out with no agent-to-agent interaction is a pipeline sub-pattern.
- **`_crew`**: peer agents contest the same artifact symmetrically, independent of order.
- **Removal test**: removing an agent from a pipeline removes a step; removing one from a crew changes the character of the result.

`--without <lens>` runs the removal test live. [Results](#results) below shows what it does to each pattern.

## The backlog

[`fixtures/backlog.json`](fixtures/backlog.json). Everything in it is made up: the product, the features, the numbers and the quotes. No real company, product, team or metric appears anywhere.

| | Feature | Theme (priority) | Reach | Impact | Conf. | Effort | RICE |
|---|---|---|---|---|---|---|---|
| F1 | Home-screen widget | mobile (3) | 12,000 | 1 | 90% | 2 | **5,400** |
| F2 | SSO and audit log | enterprise readiness (1) | 1,500 | 3 | 70% | **14** | 225 |
| F3 | Offline conflict fix | mobile (3) | **350** | 3 | 95% | 3 | 333 |
| F4 | Smart paste cleanup | AI-assisted writing (2) | 3,000 | 0.5 | 90% | **1** | 1,350 |
| F5 | AI thread summary | AI-assisted writing (2) | 6,000 | 2 | 50% | 9 | 667 |
| F6 | Admin usage dashboard | enterprise readiness (1) | 800 | 1 | 80% | 5 | 128 |

The fixture is designed so the lenses disagree:

- **F1** has the top RICE score but sits in the lowest-priority theme.
- **F2** is the most strategic feature and the most expensive.
- **F3** has the most intense pain in its quotes ("I lost an entire board meeting's notes. Twice.") and the smallest reach.
- **F4** is cheap, low-risk and middling on everything else.

`rice_score` and `rice_rank` are computed in code and shown to every model. The Phase 0 spike showed that neither phi-4-mini nor the 12b models do the arithmetic reliably.

## How each pattern works

All three patterns use the same lens mandates ([`lenses.py`](lenses.py)), so a difference in output comes from the pattern, not the wording. No agent is given tools. Every structured reply is JSON in the response text, validated with Pydantic ([`schemas.py`](schemas.py)), with one retry on an invalid reply. Temperature is 0 everywhere.

### Agent ([`patterns/agent.py`](patterns/agent.py))

One agent named `ranker` on phi-4-mini. The prompt holds the backlog and all four mandates; the reply is a `Ranking`. One call, plus at most one retry.

### Pipeline ([`patterns/pipeline.py`](patterns/pipeline.py))

```
start ──fan-out──> lens.rice ─────────┐
                   lens.strategic_fit ├──fan-in──> aggregate ──> critic ──> done
                   lens.effort_risk   │                ^            │
                   lens.customer_pain ┘                └── rescore <┘  (objections, under the cap)
```

1. **Fan-out.** Four scorer agents on phi-4-mini, one per lens. Each returns `LensScores` for all six features without seeing the others.
2. **Aggregate.** Plain Python: equal weights, sum of lens scores, ties to lower effort, then to feature id.
3. **Critic.** One agent on mistral-nemo-12b reviews the ranking against the lens scores. It returns a `CriticVerdict`. It judges but never scores.
4. **Loop.** If the critic objects, only the lenses it names re-score only the features it names, with the objection and their current score in the prompt. Then aggregate and critique again. The critic reviews at most `MAX_CRITIC_ROUNDS` times. If it still objects after its last review, the ranking is printed with the outstanding objections. It is never silently approved.

**Why this is a pipeline, even with a loop.** The loop is asymmetric: the critic judges and the scorers revise. The artifact only moves forward, and no scorer sees another scorer's reasoning.

**Why a graph workflow and not `ConcurrentBuilder`.** `ConcurrentBuilder` ends at its aggregator and runs every participant every time. The critic loop needs to send work back to a subset of scorers and round again. So the pipeline uses the same primitives `ConcurrentBuilder` is built from (`add_fan_out_edges`, `add_fan_in_edges`) plus two edges for the loop. Executors keep no state between messages, so one built workflow can run any number of times. DevUI relies on that.

### Crew ([`patterns/crew.py`](patterns/crew.py))

```
round 1:  rice → strategic_fit → effort_risk → customer_pain   (each: a full ranking + its strongest objection)
round 2:  rice → strategic_fit → effort_risk → customer_pain   (each: answers another lens by id, final ranking)
then:     Borda count over the four final rankings, in plain code
```

- Built on Agent Framework's `GroupChatBuilder`, with a **plain-code round-robin `selection_func`**. No model picks the speaker.
- **No manager or moderator model.** Adding one would make it a different pattern. Synthesis is a Borda count: with six features, first place earns 5 points and last earns 0. Ties go to lower effort.
- **Disagreements** are features whose ranks differ by 2 or more across lenses.
- Every member has the same powers and contests the same artifact. The order is fixed only so runs repeat.

Two adapters make the group chat work on a local 12b model. Both are plain code and the same for every member, so the crew stays symmetric:

1. **Peer view** (`clients.peer_view`). The group chat hands each member its peers' turns as `assistant` messages. mistral-nemo answers a conversation that ends on an assistant turn with an empty string (7 of 8 turns in the spike). The middleware rewrites peers' turns as attributed `user` turns (`[lens.rice] said: …`), merges consecutive same-role turns as the Mistral chat template expects, and ends on a user turn naming the speaker and round.
2. **Turn prompt** (`crew.crew_turn_prompt`). From round 2 on, the closing user turn names the required JSON shape and lists the speaker's sharpest rank gaps, computed in code from the peers' rankings. For example: "strategic_fit ranks SSO and audit log (F2) #1; you rank it #5." Without this, the last speaker repeated its round-1 reply word for word, in 3 of 3 runs.

## Requirements

- macOS on Apple silicon (developed on an M5 Pro, 24 GB unified memory). No CUDA needed.
- [Foundry Local](https://learn.microsoft.com/azure/ai-foundry/foundry-local/) **0.10.3**, service running
- Python **3.13** (developed against 3.13.15 from Homebrew)
- Two cached models, about 11 GB on disk:

  | Role | Alias | Size | Served variant |
  |---|---|---|---|
  | Scorers, agent | `phi-4-mini` | 3.7 GB | `Phi-4-mini-instruct-generic-gpu` |
  | Critic, crew | `mistral-nemo-12b-instruct` | 7.3 GB | `mistral-nemo-12b-instruct-generic-gpu` |

- Optional: the Foundry Toolkit for VS Code, whose local OTLP collector listens on `localhost:4317`. Without it, tracing turns itself off with one line.

Everything runs offline once the models are downloaded. No cloud model is used anywhere.

## Quick start

Install Foundry Local and download the two models:

```bash
brew tap microsoft/foundrylocal
```

```bash
brew install foundrylocal
```

```bash
foundry model download phi-4-mini
```

```bash
foundry model download mistral-nemo-12b-instruct
```

Create the environment (from `crew_apps/prioritization_crew/`):

```bash
/opt/homebrew/bin/python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

`.env` is optional; every setting has a default in [`config.py`](config.py). To change one, copy [`.env.example`](.env.example) to `.env` and replace the placeholders.

An hour before presenting, quit what you can and warm the models:

```bash
.venv/bin/python warmup.py
```

### The demo, in DevUI

Start DevUI (it loads both models, then opens http://127.0.0.1:8080):

```bash
.venv/bin/python devui_app.py
```

Everything from here happens in the browser. Pick an entry from the dropdown at the top left, click **Configure & Run**, type anything (for example `Rank the backlog.`) and click **Run Workflow**. Each entry ends on a **Workflow Complete** box with a readable report. What you type doesn't change the result: the backlog and the task are already in every prompt, so a demo can't drift because of wording.

| # | Entry | Time | The report shows |
|---|---|---|---|
| 0 | `backlog` | instant | the six features being ranked: themes, reach, impact, confidence, effort and RICE, why the lenses disagree, every customer quote, and the four lens mandates (display only; nothing here goes to a model) |
| 1 | `agent` | ~5 s | model calls and wall time, the ranking, and a note when it is just the backlog's own order |
| 2 | `pipeline` | ~1–1.5 min | each lens's scores and their sum, the RICE check before and after the critic, the re-scores, the outstanding objections |
| 3 | `crew` | ~1.5–2 min | each lens's final rank and the Borda points, the RICE check, how many lenses changed their mind, disagreements, every exchange |
| 4 | `pipeline without customer_pain` | ~1 min | the same pipeline report with one lens gone, then the **removal test** table against the latest full pipeline run |
| 5 | `crew without customer_pain` | ~1 min | the same crew report with one voice gone, then the removal test table against the latest full crew run |
| 6 | `compare` | instant | the latest full agent, pipeline and crew runs side by side: ranks, model calls, wall time, trace shape |

Start with 0 to show the audience what is being ranked. Run 1–3 before 4–6: the removal tables and the comparison read the runs those entries save to `runs/`. While the pipeline or crew is running, the Execution Timeline shows each step, and for the crew each member's turn. The **Traces** tab shows spans if a collector is running.

The removed lens is `DEVUI_WITHOUT` (default `customer_pain`); set it in `.env` to remove a different one.

### Or from the command line

The same patterns, with the same results, for scripting or checking without a browser:

```bash
.venv/bin/python run.py --pattern agent
```

```bash
.venv/bin/python run.py --pattern pipeline
```

```bash
.venv/bin/python run.py --pattern crew
```

All three back to back, with a side-by-side table:

```bash
.venv/bin/python run.py --compare
```

The removal test. After a full run of the same pattern exists in `runs/`, this also prints a rank-delta table:

```bash
.venv/bin/python run.py --pattern crew --without customer_pain
```

Tests (125, all on a fake chat client, no models needed):

```bash
.venv/bin/python -m pytest tests -q
```

Add `--no-trace` to `run.py` or `devui_app.py` to skip span export.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCORER_MODEL` | `foundry:phi-4-mini` | pipeline lens scorers |
| `AGENT_MODEL` | `foundry:phi-4-mini` | the single agent; same as the scorers for a fair comparison |
| `CRITIC_MODEL` | `foundry:mistral-nemo-12b-instruct` | pipeline critic |
| `CREW_MODEL` | `foundry:mistral-nemo-12b-instruct` | crew members |
| `MAX_CRITIC_ROUNDS` | `2` | critic reviews per pipeline run; `0` skips the critic |
| `MAX_CREW_ROUNDS` | `2` | crew rounds including round 1; minimum 2 |
| `TEMPERATURE` | `0` | every agent |
| `FOUNDRY_MAX_CONCURRENCY` | `1` | Foundry requests in flight; see [Known constraints](#concurrent-requests-crash-foundry-local-0103) |
| `DEVUI_WITHOUT` | `customer_pain` | the lens DevUI's two "without" entries remove |
| `ENABLE_TRACING` | `true` | export spans |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | the collector |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` | only gRPC is supported |

Models are written `<provider>:<model id>`, where the provider is `foundry` or `ollama`. Ollama is wired in only as a fallback for the 12b roles; Foundry had a usable 12b model, so it is not used.

## Results

Measured on 19 October 2026 on the M5 Pro (24 GB) with the defaults above, from the run files in `runs/`. Each figure is from runs of the final code for that pattern. Runs at temperature 0 were identical from one run to the next. Only wall time varied, because the machine was swapping heavily (see [Memory](#memory)). On 20 October, every DevUI entry was rerun and gave the same rankings, call counts and removal tables as below.

### The three patterns

| | Agent | Pipeline | Crew |
|---|---|---|---|
| Runs | 6 | 3 | 4 |
| Model calls | 1 | 12 | 8 |
| Wall time | 4.2–5.4 s | 66–82 s | 88–122 s |
| Ranking | F1 F2 F3 F4 F5 F6 | F1 F3 F2 F4 F6 F5 | F1 F3 F4 F2 F5 F6 |

Side by side, from `run.py --compare`:

| Feature | Agent | Pipeline | Crew |
|---|---|---|---|
| Home-screen widget (F1) | #1 | #1 | #1 |
| SSO and audit log (F2) | #2 | #3 | #4 |
| Offline conflict fix (F3) | #3 | #2 | #2 |
| Smart paste cleanup (F4) | #4 | #4 | #3 |
| AI thread summary (F5) | #5 | #6 | #5 |
| Admin usage dashboard (F6) | #6 | #5 | #6 |

The pipeline's 12 calls are 4 first-pass scores, 2 critic reviews, 3 re-scores and 3 JSON retries. One re-score was still invalid after its retry and kept its old score.

### RICE lens check

How many of the 15 feature pairs the RICE voice puts out of computed-RICE order (ties count half):

| | Before critic | Final |
|---|---|---|
| Pipeline, phi-4-mini | 4 / 15 | 2.5 / 15 |
| Crew, mistral-nemo-12b | n/a | 2 / 15 |

### The removal test

Rank of each feature with all four lenses, and without one:

| Feature | Pipeline | Pipeline −pain | Pipeline −RICE | Crew | Crew −pain |
|---|---|---|---|---|---|
| F1 Home-screen widget | 1 | 1 | 2 | 1 | 2 |
| F2 SSO and audit log | 3 | 5 | 3 | 4 | 4 |
| F3 Offline conflict fix | 2 | 2 | 1 | 2 | 3 |
| F4 Smart paste cleanup | 4 | 4 | 5 | 3 | 1 |
| F5 AI thread summary | 6 | 6 | 6 | 5 | 6 |
| F6 Admin usage dashboard | 5 | 3 | 4 | 6 | 5 |

What changed underneath:

- **Pipeline.** Removing a lens left every other lens's first-pass scores **identical**: one column disappeared, as the taxonomy predicts. The final scores still shifted, because the critic reads every column and objected to different features once one was gone. In a pipeline, removal stays clean only up to the first step that sees everything.
- **Crew.** Removing customer pain changed **two of the three remaining voices' own rankings** (strategic fit and effort/risk each swapped their bottom two). The other lenses never heard pain's arguments. This is the effect the taxonomy predicts, but here it is small. Most of the crew's rank change comes from losing a Borda voter.

### Trace shape

From a `--compare` run sent to a local OTLP receiver (crew turn structure as above):

| Pattern | Spans | Shape |
|---|---|---|
| Agent | 3 | `run agent` → `invoke_agent ranker` → `chat` |
| Pipeline | 56 | `run pipeline` → `workflow.run` → fan-out/fan-in edge groups → `executor.process` for start, four lenses, aggregate, critic ×2, rescore |
| Crew | 243 | `run crew` → `workflow.run` → 9 orchestrator steps, each turn broadcast to every member over 140 single edges |

Spans carry agent names, token counts and workflow message types. No prompt or reply text is exported.

## Findings

What worked and what didn't, on these models and this machine.

1. **The agent pattern on phi-4-mini does not rank.** In all six runs it returned F1, F2, F3, F4, F5, F6: the order the backlog lists them. Its totals and notes look plausible ("Home-screen widget, decided by Strategic fit", for a feature in the lowest-priority theme). One small model weighing four lenses at once is the weakest result in the app. That is a fair argument for decomposition, but this is one model on one task.
2. **phi-4-mini is an unreliable RICE scorer, even with the answer in the prompt.** Given `rice_score` and `rice_rank`, it still put 4 of 15 pairs out of order (for example, F3, RICE rank 4, scored 7; F5, rank 3, scored 2). Kept on purpose (the RICE lens stays on phi-4-mini like the other scorers) and reported by the RICE check on every pipeline run.
3. **The critic helped once it was told what a useful objection looks like.** In the first version, two of its three objections judged Fit and Pain by reach and impact (off-mandate), and phi-4-mini complied. Every re-score moved the wrong way, and the RICE check got worse (4 → 5). Requiring each objection to say HIGHER or LOWER, and to judge each lens only by its own mandate, turned that around (4 → 2.5). The critic still contradicts itself in round 2 ("should be LOWER… scored 2, should be closer to 5"), so every run ends at the cap with objections listed.
4. **Re-scorers need their current score in the prompt.** Told only "should be LOWER", phi-4-mini re-scored F2 as **800**. With "Your current scores: F2 = 5" it answers in range. An invalid re-score now keeps the old score and says so, rather than failing the run.
5. **The crew talks to each other, but nobody changes their mind.** Every round-2 turn answers another lens by id, and the rebuttals cite specific features ("RICE favors reach, but F3 & F2 address intense pain"). But no lens changed its ranking between rounds in any final-code run (0 of 4, four runs). Some rebuttals argue another lens's mandate (RICE: "F4's AI theme is strategic"). The crew's ranking is the four opening positions, Borda-counted. On these models, the "contest" changes the transcript, not the result.
6. **The crew finds no agreement.** All six features have rank spreads of 2 or more. F1 and F3 tie on Borda points (13 each), and plain code breaks the tie by effort.
7. **Prompt wording matters more than temperature.** Temperature 0 made every run identical. But small wording changes, and once a daemon restart, flipped outputs: integer scores became fractional (9.5, 0.5), and a concrete example ranking was copied word for word by both 12b models in the spike. Every format example uses placeholder ids (`"F?"`) for that reason. Two more examples came up while building the DevUI view. Adding a display-only `short_name` field to the backlog JSON made phi-4-mini's customer-pain scorer write broken JSON twice in a row, so display fields are now kept out of every prompt. And opening the crew with "Rank the backlog." instead of the usual task gave a different crew ranking, so the crew now always opens with the same task, whatever is typed.

## Known constraints

### Concurrent requests crash Foundry Local 0.10.3

Four concurrent phi-4-mini requests killed the daemon in 2 of 5 runs. The macOS crash report shows SIGSEGV in ONNX Runtime's WebGPU backend (`dawn::native::DeviceBase::CreateBindGroup`). Concurrency also bought nothing: 25.0 s concurrent vs 25.3 s sequential. Every Foundry client therefore shares one chat middleware that caps requests in flight at `FOUNDRY_MAX_CONCURRENCY` (default 1). The pipeline still fans out with real fan-out edges and concurrent tasks; only the HTTP calls queue. With the cap, 5 of 5 concurrent runs completed.

### The group chat needs an adapter on local models

See [Crew](#crew-patternscrewpy). Out of the box, `GroupChatBuilder` produced 7 empty turns out of 8 on mistral-nemo. Also, in `agent-framework-orchestrations` 1.3.2 the group chat's output is an `AgentResponse`, not the `list[Message]` its docstring describes, and the docstring's round-robin example indexes an `OrderedDict` by integer.

To make the crew's Borda result the workflow's final output, `CrewOrchestrator` subclasses the framework's `GroupChatOrchestrator`. It picks speakers the same way, and when the last round ends it runs the plain-code synthesis instead of yielding the stock "reached the maximum number of rounds" message. The builder only accepts a ready-made orchestrator, which needs a participant registry the builder creates, so `CrewBuilder` overrides `GroupChatBuilder._resolve_orchestrator`, and `ParticipantRegistry` is imported from a private module. Both are small, but both would break if the framework renames them.

### Memory

With no models loaded, the development machine was already using about 19.8 of 24 GB (Teams, Claude, WhatsApp). Both models load (about 38 s cold), but swap grew by roughly their combined size, and wall times drifted run to run (pipeline 66 → 82 s, crew 88 → 122 s) on identical calls. Quit other apps and run `warmup.py` before presenting.

### DevUI

- **The final output box stacks every output of a run** in one narrow, monospace box with no markdown, and breaks long lines mid-word. So in DevUI builds each pattern yields only a plain-text report, with tables kept within 52 characters and other lines wrapped at word boundaries. The crew's member turns are intermediate events: they show in the Execution Timeline, not in the final box.
- **DevUI builds its input form from the start executor's input types and prefers `Message`.** The group chat's orchestrator accepts `Message`, which gave the crew a six-field form. `CrewOrchestrator` advertises only plain text, so every entry takes one text box.
- **The agent is a one-step workflow in DevUI**, not a chat agent, so it runs the same way as the others and ends on a report. Its single executor is the ranker: no extra model and no extra step.
- **Streamed replies needed a fix.** Foundry Local 0.10.3 puts a cumulative usage item in front of the text in every streamed chunk. DevUI starts a new content part after each non-text item and adds up every chunk's usage, so chat replies rendered one token per line, with token counts around 243,000. A chat middleware keeps usage only on the closing chunk. `run.py` doesn't stream and was never affected.
- DevUI's own `instrumentation_enabled` turns on sensitive-data capture, so `devui_app.py` leaves it off and uses `telemetry.py` instead. Auth is off because DevUI binds to 127.0.0.1 only.
- The DevUI terminal prints "Processor is already shutdown, ignoring call" lines during runs. They come from OpenTelemetry; every run still completes and its output is unaffected. The cause isn't investigated yet.

### Tracing was checked against a stand-in collector

Spans were confirmed with a minimal OTLP/gRPC receiver on `:4317` ([`spike/otlp_sink.py`](spike/otlp_sink.py)), not the Foundry Toolkit collector, because VS Code wasn't running. The export path is the same, but the Toolkit view is unverified. Only spans are exported; metric and log exporters are deliberately not configured.

### `pip install agent-framework` stalls

The meta-package's connector tree kept pip resolving for more than 10 minutes. [`requirements.txt`](requirements.txt) pins only the packages this app uses (`agent-framework-core`, `-openai`, `-orchestrations`, `-ollama`, `-devui`) plus their exact transitive versions.

## Design principles

**Plain code decides wherever a model doesn't have to.** Speaker order, aggregation, Borda, tie-breaks, disagreement detection and the crew's gap digest are all code. Models produce opinions; code turns them into a ranking. That is also what keeps each pattern honest: the crew has no moderator model and the pipeline has no model in its aggregator.

**Validate, retry once, then say what happened.** Every reply goes through a Pydantic model. One retry with the validation error, then a visible outcome: a kept score, a round-1 fallback, or a clear error. Never a silent guess.

**Show the weakness on screen.** The RICE check, the critic's outstanding objections, failed re-scores and "rankings changed after round 1: 0 of 4" are printed on every run, because they are the most useful things for an audience comparing patterns.

## Extension ideas

- **Relay** (`patterns/relay.py`, not built): the same group chat API, but each agent refines the previous agent's ranking in turn. Order matters and nobody contests, so it is a pipeline. It would show that the topology doesn't decide the pattern.
- **A stronger crew model.** In the spike, `qwen3-14b` engaged with specific claims better than mistral-nemo, but it needed `/no_think`, lenient JSON parsing, and more memory. Swapping `CREW_MODEL` is the cheapest test of whether "nobody changes their mind" is the model or the pattern.
- Compute the RICE lens in code and keep models for the judgement lenses, then compare the pipeline's critic behaviour.

## More detail

- [`SPIKE_REPORT.md`](SPIKE_REPORT.md): Phase 0 model selection, memory, parse rates, and the first crew transcripts
- [`clients.py`](clients.py): clients per role, the one-retry JSON call, the Foundry concurrency gate, and the peer-view adapter
- [`patterns/pipeline.py`](patterns/pipeline.py): the graph workflow and the critic loop
- [`patterns/crew.py`](patterns/crew.py): the group chat, the turn prompt, Borda and disagreements
- [`lenses.py`](lenses.py): the four mandates and every prompt
- [`schemas.py`](schemas.py): the validation contract and JSON extraction
- [`readout.py`](readout.py): what the audience sees, and the run files
- [`telemetry.py`](telemetry.py): spans-only OpenTelemetry export
- [`BUILD_SPEC.md`](BUILD_SPEC.md): the brief this was built from
- [Foundry Local documentation](https://learn.microsoft.com/azure/ai-foundry/foundry-local/)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)

## License

MIT, see [LICENSE](../../LICENSE).
