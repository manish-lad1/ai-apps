# Phase 0 spike report

Date: 2026-10-19 · Machine: MacBook Pro, Apple M5 Pro, 24 GB unified memory
Foundry Local CLI 0.10.3 · agent-framework-core 1.22.0 · agent-framework-orchestrations 1.3.2 · agent-framework-openai 1.17.0

Scripts are in [`spike/`](spike/). Raw results, including full crew transcripts, are in [`spike/results/`](spike/results/).

## Recommendation

| Role | Model | Why |
|---|---|---|
| `SCORER_MODEL` | `foundry:phi-4-mini` | 10/10 clean `LensScores` parses on the first try, 3.6 s per call. |
| `AGENT_MODEL` | `foundry:phi-4-mini` | Same as the scorer, for a fair comparison (spec). |
| `CRITIC_MODEL` | `foundry:mistral-nemo-12b-instruct` | A true 12b. Clean JSON, no reasoning tokens, about 9 s per turn, 7.3 GB. |
| `CREW_MODEL` | `foundry:mistral-nemo-12b-instruct` | Same reasons. See the crew verdict below: usable, but the debate is thin. |

The alternative is `qwen3-14b`. It reasons better about the numbers, but it is slower (about 13 s per turn) and heavier (9.9 GB, swap grew to 35 GB). It needs `/no_think` and a lenient JSON parser, and in its last run three lens agents echoed the previous speaker's sentence. If you would rather have smarter-but-messier for the crew, swap `CREW_MODEL` to it; the code paths are the same.

No cloud model is needed, and the Ollama fallback was not needed either. Foundry has usable 12b-class models. `gemma4:12b` is installed in Ollama if we ever want a third opinion.

## Results

| # | Step | Result | Wall time |
|---|---|---|---|
| 1 | List Foundry models | 37 chat/multimodal models. 12b-class with tool-calling flag: mistral-nemo-12b (7.3 GB), qwen3-14b (9.9 GB), qwen2.5-14b (9.3 GB). phi-4 (14b, 8.4 GB) has no tool flag. Tool support is irrelevant here because we never use tools. | <1 s |
| 2 | Pick models | Small: phi-4-mini (cached). 12b-class: mistral-nemo-12b and qwen3-14b, both downloaded. | Downloads: about 20 min |
| 3 | Load both at once | phi-4-mini + nemo: **both load**, 10.5 s + 27.1 s. Swap grew 11.2 → 21.4 GB. phi-4-mini + qwen3-14b: 8.8 s + 34.5 s, swap 20.4 → 35.3 GB. | 38 s / 43 s |
| 4 | 10× `LensScores` on small model | **phi-4-mini: 10/10 first try** (3.6 s avg). qwen3-4b: 2/10 even after a retry (its `<think>` block ran past 1,500 tokens without closing; 44 s avg). | 36 s / 437 s |
| 5 | 2-round crew, 4 lens agents | Works after one adapter fix (below). nemo: 8/8 turns, 4/4 round-2 JSON parses, 4/4 name another lens. qwen3-14b: 4/4 after parser fix. **Substance is weak**; see the verdict. | nemo 69–73 s · qwen3-14b 87–107 s (8 calls each) |
| 6 | Ollama fallback | Not run; not needed. | n/a |
| 7 | One trace to OTLP | **Spans arrive**: `pattern.spike` → `invoke_agent lens.rice` → `chat Phi-4-mini…`, one trace ID, token counts present, no prompt/response content (sensitive data off). | 17 s |

Memory note. With **nothing loaded**, this machine was already using about 19.8 of 24 GB (Teams, Claude, WhatsApp, etc.). The models still load, but they push the system into heavy swap. Memory-mapped weights show up as swap growth, not as "used" memory or daemon RSS, so swap is the honest number. **Before the talk: quit everything you don't need, then run `warmup.py`.** The earlier triage project's note that "this machine cannot hold both chat models at once" is out of date for this hardware.

## Crew verdict: do agents rebut each other by name?

**By name, yes. Contesting, barely.** Across all runs, every round-2 reply names another real lens. But:

- **Nobody changes their mind.** Across all six saved runs, 21 agent turns had parseable rankings in both rounds, and only 1 changed between rounds (nemo `effort_risk`, in one run). A "concede" never changed a ranking.
- **mistral-nemo** rebuttals are one-line restatements of the agent's own mandate ("Customer pain is immediate, enterprise readiness can wait"). In one run, `rice` "conceded" by copying `strategic_fit`'s objection word for word. Its RICE lens also ranks F3 first, which is wrong: the arithmetic puts F1 first.
- **qwen3-14b** engages with specific claims ("While F1 has a high RICE score, F3 …") and gets the RICE order right. But in the final run, three agents copied the previous speaker's exact sentence, including an argument that had nothing to do with their own lens.

That is enough for the demo's point (removing a voice changes the result), but on its own it would not convince a room that the agents debate. Proposed Phase 3 mitigations:

1. Make round 2 ask each agent to quote the specific claim it is answering and to say whether its ranking moved, and why.
2. Give each agent a compact digest of the other lenses' round-1 rankings, instead of only raw transcript text, so the disagreement is explicit.
3. Precompute each feature's RICE value in the fixture or prompt. Neither small nor 12b models do the arithmetic reliably, and a wrong RICE lens weakens every comparison.

## Things that broke, and the fixes the app must carry

1. **The group chat sends peers as `assistant` turns, and local models answer them with nothing.** With `GroupChatBuilder` out of the box, 7 of 8 nemo turns came back as empty strings. Each agent's context ended on another agent's `assistant` message, and the Mistral chat template has nothing to reply to. Fix (in `spike/s4_group_chat.py`): a per-agent chat middleware that rewrites other lenses' turns as `user` messages tagged `[lens.x] said:`, merges consecutive same-role messages (Mistral expects user and assistant turns to alternate), and ends on a user prompt like "Your turn, lens.y. ROUND n." This keeps the built-in round-robin group chat; it only changes how peers are presented. Phase 3 will carry it and the README will explain it.
2. **Models copy the format example.** When the prompt showed a concrete ranking as an example, the RICE agent in both models (and qwen's effort_risk) returned that exact ranking. Prompts must use placeholder IDs (`"F?"`) in examples.
3. **A placeholder that isn't valid JSON produces broken JSON.** `[six feature ids]` in the template led qwen3-14b to emit five-item lists with a stray `]]`.
4. **qwen3-14b adds a trailing `}`.** Fix: decode the first complete JSON object (`json.JSONDecoder.raw_decode`) and ignore any trailing text. This goes into the Phase 1 parser, alongside stripping `<think>` blocks.
5. **Group chat output is an `AgentResponse`, not `list[Message]`.** It contains only the orchestrator's "reached maximum rounds" message, so the class docstring is out of date. Per-turn output has to come from participant output events or a middleware. The docstring's round-robin example (`state.participants[i]`) also fails, because `participants` is an OrderedDict keyed by name.
6. **The framework warns "Running agent with empty message cache"** on each agent's first turn. This is harmless: history arrives through the session.
7. **phi-4-mini doesn't compute RICE.** Its JSON is perfect, but it gave F1, F3 and F5 all a 9 under the RICE lens, though their real RICE values are 4050, 285 and 3000. See mitigation 3.
8. **Metrics export needs a collector that accepts metrics.** My stand-in OTLP sink only implemented traces. The Foundry Toolkit collector should accept both; otherwise, disable metrics in `telemetry.py`.
9. **The `agent-framework` meta-package stalled pip for 10+ minutes** while resolving its connector tree. Phase 1 pins only what we use: `agent-framework-core`, `-openai`, `-orchestrations`, `-devui`, `-ollama`.

## Not verified

- The trace was confirmed against a local OTLP/gRPC sink on `:4317`, not the Foundry Toolkit collector, because VS Code wasn't running. The export path and endpoint are identical; the Toolkit's view still needs checking.
- Each crew configuration was run 2–3 times. Temperature 0 is close to deterministic on Foundry, but not exactly: the same nemo run produced slightly different text between runs.

## Addendum from Phase 1 (live smoke test of the shared core)

- **Concurrent requests crash Foundry Local 0.10.3.** Four concurrent phi-4-mini requests killed the daemon in 2 of 5 runs. The macOS crash report shows SIGSEGV in ONNX Runtime's WebGPU backend (`dawn::native::DeviceBase::CreateBindGroup` from `onnxruntime::webgpu::WebGpuContext::LaunchComputePipeline`). Concurrency also bought nothing: 25.0 s concurrent vs 25.3 s sequential. Fix: every Foundry client shares a chat middleware that caps requests in flight at `FOUNDRY_MAX_CONCURRENCY` (default 1). With it, 5 of 5 concurrent runs completed. The pipeline can still use the framework's concurrent fan-out; the HTTP calls just queue.
- **phi-4-mini's RICE lens is still unreliable with `rice_score` and `rice_rank` provided.** For example, F5 (RICE rank 3) scored 2 and F3 (rank 4) scored 7. This is a Phase 2 decision.
- **phi-4-mini as the single-agent ranker is weak.** It gave totals of 27–28 for all six features and attributed every note to "Strategic fit".
