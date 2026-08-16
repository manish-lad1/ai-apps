# Document Triage Pipeline

Classify, index, and interrogate a folder of documents on a laptop with the wifi switched off.

Part of [ai-apps](../../) — a collection of small, self-contained AI applications, each demonstrating one architecture end to end.

## Demo

> _GIF to be added._

## What it does

Three stages over a folder of documents, each consuming the previous stage's output:

1. **Ingest** — an agent reads each document, classifies it, extracts key fields, and flags personal data. Every record is validated against a Pydantic schema before it is written to `output/manifest.json`.
2. **Index** — every document is chunked on paragraph boundaries, embedded locally, and stored with its Stage 1 metadata in `output/index.json`.
3. **Ask** — questions are answered from retrieved context only. When the answer is not in the corpus the reply is exactly `NOT FOUND`, and every answer prints the filename it came from.

Nothing leaves the machine. No cloud API, no CDN, no telemetry — the models run on the local GPU through [Microsoft Foundry Local](https://learn.microsoft.com/azure/ai-foundry/foundry-local/).

### The corpus

`documents/` holds 10 synthetic documents — offer letters, invoices, contracts, medical notes, and identity records. It deliberately includes one document whose type is genuinely ambiguous, two that share a reference so at least one question needs both, and one dense with personal data.

**All of it is fabricated for this demo.** Names, addresses, account numbers, passport numbers, NHS numbers, and NI numbers are invented. No real personal data appears anywhere in this repository.

### Why this is a `_pipeline`

Forward-only, staged handoff. Stage 2 consumes Stage 1's manifest, Stage 3 consumes Stage 2's index, and reordering them breaks the chain. No two agents contest the same question, so it is not a `_crew`.

## Requirements

- macOS on Apple silicon (developed on an M5 Pro, 24 GB unified memory)
- [Foundry Local](https://learn.microsoft.com/azure/ai-foundry/foundry-local/) **0.10.3** or later, service running
- Python **3.13** (developed against 3.13.15 from Homebrew)
- Roughly 6 GB of free memory — enough for one chat model plus the embedding model
- Three cached models:

  | Purpose | Alias | Served variant |
  |---|---|---|
  | Chat + tool calling | `phi-4-mini` | `Phi-4-mini-instruct-generic-gpu` |
  | Chat (comparison) | `qwen3-4b` | `qwen3-4b-generic-gpu` |
  | Embeddings | `qwen3-embedding-0.6b` | `qwen3-embedding-0.6b-generic-gpu` |

**Note on the stack:** every other project in this repo is TypeScript / Next.js. This one is Python, deliberately — the Microsoft Agent Framework and the Foundry Local SDK both document Python as their primary path, and matching the vendor's documented path is worth more here than repo-wide uniformity.

## Quick start

```bash
foundry model download phi-4-mini
```

```bash
foundry model download qwen3-embedding-0.6b
```

```bash
/opt/homebrew/bin/python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Confirm the local endpoint answers before anything else:

```bash
.venv/bin/python smoke_raw.py
```

Then run all three stages:

```bash
.venv/bin/python run_demo.py
```

Or drive the same pipeline from a browser instead of the terminal:

```bash
.venv/bin/python run_web.py
```

Then open `http://127.0.0.1:8000`. The UI runs each stage with live progress, shows the manifest as a sortable table, and prints retrieval scores beside every answer. It adds no dependencies — FastAPI and uvicorn are already in the pinned set — and loads no external CSS, fonts, or scripts, so it works with the wifi off exactly like the terminal path.

Individual stages, for recovering from a failure mid-demo without redoing the work that already succeeded:

```bash
.venv/bin/python run_demo.py --stage 1
```

```bash
.venv/bin/python run_demo.py --ask "What is the total due on invoice INV-2026-0412?"
```

## Features

- **Port and model discovery at startup.** Foundry Local's port is ephemeral and its model IDs are hardware-specific variants. Nothing is hardcoded; both are resolved at runtime.
- **Schema-validated extraction.** Every manifest record passes Pydantic validation. Failures get one corrective retry, then are recorded explicitly rather than dropped.
- **Grounding guardrail.** Stage 3 refuses to answer outside retrieved context, including when the context holds the right kind of fact about the wrong person.
- **Source attribution.** Every answer names the file it came from.
- **Two-model comparison harness.** 19 cases across four categories, run against both chat models, with per-category pass rates and median latency.
- **Offline proof.** `verify_offline.py` blocks every non-loopback socket and runs the whole pipeline through it.
- **No vector database.** Ten documents do not need one; the index is a JSON file and retrieval is a cosine sort.
- **Terminal or browser.** `run_demo.py` for the projector, `run_web.py` for a local web UI that streams stage progress over server-sent events and shows retrieval scores per answer. Same stage code behind both.

## How it works

```
documents/*.txt
      |
      v
  STAGE 1  read_file -> write_manifest, both forced tool calls
      |    Pydantic validation, one corrective retry
      v
  output/manifest.json
      |
      v
  STAGE 2  paragraph chunking (~400 tokens, 60-token overlap)
      |    local embeddings, Stage 1 metadata attached
      v
  output/index.json
      |
      v
  STAGE 3  embed question -> cosine top-4 -> grounded answer or NOT FOUND
```

### Stage 1, in detail

Each document gets a two-turn tool conversation. The model is asked for `read_file` (it supplies the filename, which is checked against the requested one), the tool result is fed back, and then the model is asked for `write_manifest`, whose arguments *are* the manifest record. The schema is doing double duty as the extraction format.

The tool definitions live in [`tools.py`](tools.py), kept separate because the pairing of "schema the model sees" with "Python that runs" is the clearest single thing in the project.

### Retrieval

Cosine similarity over 1024-dimensional vectors from `qwen3-embedding-0.6b`, top 4 chunks passed as numbered, filename-labelled context. Linear scan over ~11 chunks costs nothing.

## Example prompts

Single document:

```bash
.venv/bin/python run_demo.py --ask "What medication was Ravi Shah started on?"
```

Spanning two documents — the invoice names the agreement, the agreement holds the rate:

```bash
.venv/bin/python run_demo.py --ask "What is the hourly rate in the agreement that invoice INV-BW-2291 was issued against?"
```

The guardrail, which is the one worth demonstrating live. The corpus contains a home address — it just belongs to someone else:

```bash
.venv/bin/python run_demo.py --ask "What is Amelia Hart's home address?"
```

## Design principles

**Force the tool call; do not hope for it.** Phi-4-mini never volunteers a tool call. Measured over 10 attempts with `tool_choice="auto"` it produced zero, replying "I'm unable to read or inspect files directly" — and then hallucinating an answer. With `tool_choice` naming the function, 10 out of 10 were well-formed with exact arguments. The pipeline decides *which* tool runs; the model decides *what goes in it*. That split is also what makes the demo deterministic enough to run live.

**The validator is the deterministic layer, not the model.** A 3.8 GB model drifts. Rather than prompt harder, every record is validated and every failure is either corrected on one retry or recorded as a failure. A manifest that is quietly one document short is the worst outcome on stage.

**Put instructions where the model will actually read them.** Foundry Local forwards the *structure* of a tool schema — property names, types, enums, the required list — but not the `description` strings. Careful descriptions changed nothing; moving the same words into the system prompt fixed a misclassification immediately.

**Refusal needs a reason to fire.** "Answer only from context" is not enough when retrieval hands the model a near-miss. Asking for Amelia Hart's address returned a *different person's* address from a different document until the prompt was told explicitly that the right kind of fact about the wrong subject is not an answer.

## Key concepts learned

- **A capability flag is a claim, not a guarantee.** Foundry reports `supportsToolCalling: true` for Phi-4-mini. True, but only under forced `tool_choice`.
- **Tool-call parsing is a property of the transport, not the model.** The same model, same request, parsed correctly on non-streaming `/v1/chat/completions` and came back as raw `<tool_call>` text on both `/v1/responses` and the streamed path.
- **Small models fill flat schemas and ignore nested ones.** With the extracted fields nested under a `fields` object, Phi-4-mini returned it empty on all 10 documents while still writing a good summary. Flattened, it filled them in.
- **Optional means omitted.** The model emits *only* the properties named in `required`. Every field it should attempt has to be required, with an empty-string convention for "not stated".
- **Reasoning models need headroom to reach a tool call.** qwen3-4b spent its whole 200-token budget on `<think>` and got truncated before emitting the call. At 600 tokens it succeeded, having used 212.
- **Bigger did not win.** The 4B reasoning model scored lower and ran five times slower than the 3.8B instruct model.

### Model comparison

Run on an M5 Pro, 24 GB. **Run it yourself before choosing** — the answer depends on the machine:

```bash
.venv/bin/python evals/run_evals.py
```

| Category | phi-4-mini | qwen3-4b |
|---|---|---|
| classification | 7/7 (100%) 5.3s | 6/7 (86%) 27.4s |
| extraction | 6/6 (100%) 5.3s | 6/6 (100%) 27.4s |
| grounding_answer | 3/3 (100%) 2.4s | 3/3 (100%) 8.0s |
| grounding_refusal | 2/3 (67%) 2.2s | 2/3 (67%) 9.2s |
| **Overall** | **18/19 (95%) 5.3s** | **17/19 (89%) 27.4s** |

Latency is the median per case. `phi-4-mini` goes on stage: better accuracy, and five times faster.

## Known constraints

### `agent-framework-foundry-local` is unusable — use the OpenAI-compatible endpoint

**This is the most useful thing in this repo for anyone else hitting it.**

`agent-framework-foundry-local` is a stale beta (`1.0.0b260730`) that pins `foundry-local-sdk` below 1.0. The installed 0.5.1 SDK shells out to `foundry service start` — a command the 0.10.x CLI renamed to `foundry server`. The result is:

```
RuntimeError: Httpx client is not set
```

The pin conflict is not resolvable by reinstalling. **Do not import from `agent_framework.foundry` or `foundry_local`.** Talk to the OpenAI-compatible HTTP endpoint at `{base}/v1` with the `openai` package instead.

### Agent Framework's chat clients do not work against Foundry Local either

Tested, and worth knowing before you spend an afternoon on it:

| Client | Transport | Tool calls parsed? |
|---|---|---|
| `OpenAIChatClient` | `/v1/responses` | No — returns `<\|tool_call\|>` as message text |
| `OpenAIChatCompletionClient` | `/v1/chat/completions`, streamed | No — returns `<tool_call>` in the content stream |
| raw `openai` client | `/v1/chat/completions`, non-streamed | **Yes** |

Foundry Local accepts `tools` on all three paths and only parses the model's tool-call tokens back into structured `tool_calls` on the last one. Agent Framework streams by default, so both of its clients land on a broken path. This project therefore uses the raw `openai` client, as [`model_call.py`](model_call.py) documents.

### Nothing auto-loads

Both `/v1/chat/completions` and `/v1/embeddings` return HTTP 400 for a model that is not resident:

```
Model 'qwen3-embedding-0.6b-generic-gpu' is not loaded.
Please load the model before getting an EmbeddingsClient.
```

Every stage calls `ensure_loaded()` first. This is the cold start you see on the console, and it is why the pipeline announces it rather than appearing to hang.

### Memory

24 GB unified memory with roughly 6 GB free will not hold both chat models at once. The eval harness unloads one before loading the other. Stage 3 holds one chat model plus the 515 MB embedding model, which fits comfortably.

### Remaining accuracy gaps

Honest ones, visible in the eval output: on invoices Phi-4-mini puts the billed *company* in `person_name`, and it answers "who is the chief executive" from a `Head of People` signature line rather than refusing.

## Extension ideas

- Swap the JSON index for a real vector store once the corpus outgrows a linear scan.
- Add a PII redaction stage between 1 and 2, using the `pii_types` Stage 1 already records.
- Route by document type — send contracts to a clause extractor, invoices to a totals checker.
- Add a confidence score per manifest record and gate low-confidence documents for review.
- Try a larger local model and rerun `evals/run_evals.py` to see where the accuracy/latency curve bends.

## More detail

- [`tools.py`](tools.py) — the three tool definitions and why they are shaped this way
- [`model_call.py`](model_call.py) — the streaming and `tool_choice` findings, in code
- [`foundry_endpoint.py`](foundry_endpoint.py) — port and model discovery
- [`schemas.py`](schemas.py) — the validation contract
- [`evals/cases.py`](evals/cases.py) — the 19 eval cases and what each is testing
- [`web/server.py`](web/server.py) — the local web UI's API, and how blocking stages are streamed as events
- [Foundry Local documentation](https://learn.microsoft.com/azure/ai-foundry/foundry-local/)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)

## License

MIT — see [LICENSE](../../LICENSE).
