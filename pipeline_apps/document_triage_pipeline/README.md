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

`documents/` holds 21 synthetic documents — four of each classifiable type, plus one whose type is genuinely ambiguous:

| Type | Count | Examples |
|---|---|---|
| `offer_letter` | 4 | employment offer, promotion, internship, interim engagement |
| `invoice` | 4 | goods, consultancy, advisory, utility |
| `contract` | 4 | master services agreement, NDA, employment contract, commercial lease |
| `medical_note` | 4 | clinic consultation, discharge summary, GP referral, occupational health |
| `id_document` | 4 | driving licence, passport page, HR onboarding record, NI number letter |
| *ambiguous* | 1 | a letter of intent that is part offer, part contract |

Entities recur across documents on purpose, so questions can require two sources: Marcus Delaney signs one offer letter and has his own employment contract; the Calder invoice bills against the letter of intent; Jonah Pike's internship offer and his National Insurance letter are separate files; Northgate's lease covers the address on its invoices.

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

Then open `http://127.0.0.1:8000`. The UI runs each stage with live progress, shows the manifest as a table, and prints retrieval scores beside every answer. It loads no external CSS, fonts, or scripts, so it works with the wifi off exactly like the terminal path.

The UI serves two separate collections, switched by the tabs at the top:

- **Demo corpus** — the curated 21. Read-only, and what the talk runs on.
- **My documents** — drag in your own. They are classified, extracted, chunked, embedded, and become answerable, exactly like the demo set.

Uploads accept `.txt`, `.md`, `.csv`, `.pdf`, `.docx`, `.rtf`, `.html`, and `.odt`, up to 20 MB each. Each collection keeps its own manifest and index, so uploading nothing disturbs the demo corpus or the eval suite. Uploads are gitignored.

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
- **Two-model comparison harness.** 43 cases across four categories, run against both chat models, with per-category pass rates and median latency.
- **Offline proof.** `verify_offline.py` blocks every non-loopback socket and runs the whole pipeline through it.
- **No vector database.** Twenty-one documents do not need one; the index is a JSON file and retrieval is a cosine sort.
- **Terminal or browser.** `run_demo.py` for the projector, `run_web.py` for a local web UI that streams stage progress over server-sent events and shows retrieval scores per answer. Same stage code behind both.
- **Two answering engines, side by side.** Stage 3 runs on **Microsoft Agent Framework** by default, or on the raw `openai` client. Both use phi-4-mini, so the only variable is the stack. The framework path holds a conversation across turns; the raw path is stateless. Switch in the UI or with `--engine`. See [Agent Framework: where it works and where it does not](#agent-framework-where-it-works-and-where-it-does-not).
- **Conversational follow-ups.** On the Agent Framework engine, "and what was the VAT on it?" resolves against the previous question. The raw engine has no memory and answers it from whatever retrieval happens to return — the contrast is one click apart.
- **Bring your own documents.** Drop PDFs, Word files, or plain text into the UI and they run through the identical three stages. PDF via `pypdf`, Word and RTF via the macOS `textutil` built-in — both entirely offline.

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
           either engine: Agent Framework (conversational) or raw client
```

### Stage 1, in detail

Each document gets a two-turn tool conversation. The model is asked for `read_file` (it supplies the filename, which is checked against the requested one), the tool result is fed back, and then the model is asked for `write_manifest`, whose arguments *are* the manifest record. The schema is doing double duty as the extraction format.

The tool definitions live in [`tools.py`](tools.py), kept separate because the pairing of "schema the model sees" with "Python that runs" is the clearest single thing in the project.

### Retrieval

Cosine similarity over 1024-dimensional vectors from `qwen3-embedding-0.6b`, top 4 chunks passed as numbered, filename-labelled context. Linear scan over 23 chunks costs nothing.

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

The same question against the raw engine, to compare stacks on one answer:

```bash
.venv/bin/python run_demo.py --ask "What is the total due on invoice INV-2026-0412?" --engine raw
```

**Follow-up questions are a browser-only feature.** Each `--ask` is a fresh process, so the CLI has no conversation to remember. In the UI, on the Agent Framework engine, ask these in order and the pronouns resolve:

1. What is the total due on invoice INV-2026-0412? → `GBP 4,820.00`
2. And what was the VAT on it? → `GBP 776.00`
3. Who was it billed to? → `Halden Robotics Ltd`
4. What were the payment terms? → `Net 30`

Switch to the raw engine and ask question 2 on its own to see the difference: with no memory, it answers from whichever invoice retrieval happens to surface.

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
- **PDF layout padding is not free.** A PDF laid out in fixed-width columns extracts with every line padded to the page width — 1.9x to 2.7x the character count of the same document as text, none of it content. One padded invoice made Phi-4-mini produce no tool call at all, three times out of three, where the unpadded original always worked. Collapsing runs of spaces fixed it and cut Stage 1's input roughly in half. Only extracted formats are normalised; author-written `.txt` keeps its whitespace, because the demo corpus relies on aligned invoice tables.
- **Reasoning models need headroom to reach a tool call.** qwen3-4b spent its whole 200-token budget on `<think>` and got truncated before emitting the call. At 600 tokens it succeeded, having used 212.
- **Bigger did not win.** The 4B reasoning model matched the 3.8B instruct model's score and took four times as long to get there.
- **A small corpus flatters a guardrail.** On 10 documents the refusal rate looked like 2/3. Adding 11 more documents — without touching the prompt — took it to 2/4, because the extra documents gave retrieval more near-misses to offer. The guardrail did not get worse; the test got honest.

### Model comparison

Run on an M5 Pro, 24 GB. **Run it yourself before choosing** — the answer depends on the machine:

```bash
.venv/bin/python evals/run_evals.py
```

43 cases over the 21-document corpus:

| Category | phi-4-mini | qwen3-4b |
|---|---|---|
| classification | 21/21 (100%) 6.1s | 20/21 (95%) 23.3s |
| extraction | 11/12 (92%) 6.1s | 12/12 (100%) 23.3s |
| grounding_answer | 6/6 (100%) 2.5s | 6/6 (100%) 8.4s |
| grounding_refusal | 2/4 (50%) 2.2s | 2/4 (50%) 7.6s |
| **Overall** | **40/43 (93%) 6.1s** | **40/43 (93%) 23.3s** |

Latency is the median per case. The two models are level on accuracy and `phi-4-mini` is roughly four times faster, so it goes on stage.

## Known constraints

### `agent-framework-foundry-local` is unusable — use the OpenAI-compatible endpoint

**This is the most useful thing in this repo for anyone else hitting it.**

`agent-framework-foundry-local` is a stale beta (`1.0.0b260730`) that pins `foundry-local-sdk` below 1.0. The installed 0.5.1 SDK shells out to `foundry service start` — a command the 0.10.x CLI renamed to `foundry server`. The result is:

```
RuntimeError: Httpx client is not set
```

The pin conflict is not resolvable by reinstalling. **Do not import from `agent_framework.foundry` or `foundry_local`.** Talk to the OpenAI-compatible HTTP endpoint at `{base}/v1` with the `openai` package instead.

### Agent Framework: where it works and where it does not

**It works for generation, and it brings conversation.** Stage 3 runs through Agent Framework by default — [`stage3_agentframework.py`](stage3_agentframework.py) — against the same local endpoint and the same model as the raw path:

```bash
.venv/bin/python run_demo.py --ask "What is the total due on invoice INV-2026-0412?" --engine raw
```

On single questions the two engines are indistinguishable in quality. Measured over the ten grounding cases with identical retrieval and prompt, when the framework path was still on qwen3-4b: 8/10 either way, same two failures, 3.3x slower. **The framework does not change what the model says.**

Where it earns its place is the second question. The raw engine builds a fresh message list every time, so it has no idea what "it" means:

| | Agent Framework | raw client |
|---|---|---|
| "What is the total due on invoice INV-2026-0412?" | GBP 4,820.00 | GBP 4,820.00 |
| "And what was the VAT **on it**?" | **GBP 776.00** | the VAT off an unrelated invoice |
| "Who was **it** billed to?" | **Halden Robotics Ltd** | — |
| "What were the payment terms?" | **Net 30** | — |

Two things make that work, and both were measured rather than assumed. The retrieval query is conversation-aware, because a follow-up embedded alone is a poor search — prepending the previous question lifted the right document from 0.339 to 0.591. And the model is phi-4-mini on both sides: qwen3-4b answered turn two correctly then collapsed on turn three into "The question is not the question" repeated until it hit the token ceiling, and the framework's own `ContextWindowCompactionStrategy` did not rescue it.

Latency grows with the conversation as history accumulates — roughly 8s on the first question and 28s by the fourth.

**It does not work for tool calling.** Stage 1 needs structured tool calls, and neither Agent Framework client can deliver them here:

| Client | Transport | What happens |
|---|---|---|
| `OpenAIChatClient` | `/v1/responses` | Returns `{"name": "read_file", "arguments": "{}"}` — the **arguments are discarded**. The framework then calls the function with nothing in it, hits three consecutive errors, and stops |
| `OpenAIChatCompletionClient` | `/v1/chat/completions` | The model emits a valid call, sometimes with a malformed extra brace; Foundry's parser rejects it and returns it as plain text |
| raw `openai` client, non-streamed | `/v1/chat/completions` | **Works**, which is why Stage 1 uses it |

The first row is the one that ends the argument. It is not a prompt problem — five prompt variants, two token budgets, two and three tools, with and without `default_options`, all produced zero successful calls. An argument that never arrives cannot be recovered downstream.

So this project uses Agent Framework exactly where it earns its place, and the raw client where the framework cannot go. [`model_call.py`](model_call.py) documents the raw path; [`stage3_agentframework.py`](stage3_agentframework.py) documents the framework one.

### Nothing auto-loads

Both `/v1/chat/completions` and `/v1/embeddings` return HTTP 400 for a model that is not resident:

```
Model 'qwen3-embedding-0.6b-generic-gpu' is not loaded.
Please load the model before getting an EmbeddingsClient.
```

Every stage calls `ensure_loaded()` first. This is the cold start you see on the console, and it is why the pipeline announces it rather than appearing to hang.

### Memory

Both chat models and the embedding model together are about 7.2 GB, and on a 24 GB machine all three stay resident — measured with 4.3 GB still free. Switching answering engines mid-demo therefore costs nothing, which is the point: the web server tries to open an engine and only evicts the other model if that actually fails, rather than unloading on principle and paying a ten-second model load on every switch.

The eval harness is the exception and unloads deliberately, so each model's timings are measured without the other competing for memory.

On a tighter machine, expect one chat model plus the 515 MB embedding model to be the working set.

### Uploaded documents are classified against a fixed six-type list

`DocumentType` is a closed enum — offer letter, invoice, contract, medical note, ID document, unknown — chosen for the demo corpus. Upload something outside it, such as board minutes, and Stage 1 correctly returns `unknown`. That is the schema working as designed rather than a bug, but if you point this at your own document set, widen the enum in [`schemas.py`](schemas.py) and the type definitions in `stage1_ingest.SYSTEM_PROMPT` to match. Extraction, indexing, and grounded answering are unaffected and work on any document.

Scanned PDFs are also rejected on upload: there is no OCR here, so a PDF with no embedded text layer reports that rather than indexing an empty document.

### The grounding guardrail leaks when the subject's own document looks similar

This is the most important limitation in the project, and the eval measures it rather than hiding it: **refusal passes 2 of 4 cases on both models.**

The two that fail:

- *"What is Declan Moss's home address?"* returns **Nadia Okonkwo's** address. Declan's passport transcription is the top-ranked passage (0.515) and is dense with identity fields, but holds no address; the only address in context belongs to someone else, and the model takes it.
- *"How many days of annual leave does Seren Vaughn get?"* returns **28 days** from Marcus Delaney's employment contract, which out-ranked Seren's own engagement letter (0.380 against 0.377).

The same question shape passes for Amelia Hart, so the guardrail is inconsistent rather than absent. It holds when the subject's own document contains nothing address-shaped, and breaks when that document is topically adjacent to the wrong answer.

A stricter prompt was tried and rejected. It fixed the Seren Vaughn case and broke a valid one — the Carrow Business Park rent started returning `NOT FOUND` — leaving the score unchanged at 8/10 while making the demo refuse a fair question. Over-refusal reads as broken on stage, so the shipped prompt is the more permissive one.

The real fix is architectural rather than a wording change: filter retrieved chunks to those whose text actually mentions the subject before they reach the prompt, or verify after the fact that the answer's source chunk names the subject. Both are in [Extension ideas](#extension-ideas).

### Remaining accuracy gaps

On invoices Phi-4-mini puts the billed *company* in `person_name`. On the Calder invoice it extracts `reference` as `LOI-CAL-2026-03`, the letter-of-intent reference quoted in the body, rather than the invoice's own `INV-CS-3310` — a fair mistake, since the document carries two references and only the field definition says which one is wanted.

## Extension ideas

- **Fix the guardrail leak properly.** Filter retrieved chunks to those whose text mentions the question's subject before building the prompt, or add a verification pass that checks the answering chunk names the subject. This is the highest-value change in the list — see [Known constraints](#the-grounding-guardrail-leaks-when-the-subjects-own-document-looks-similar).
- Swap the JSON index for a real vector store once the corpus outgrows a linear scan.
- Add a PII redaction stage between 1 and 2, using the `pii_types` Stage 1 already records.
- Route by document type — send contracts to a clause extractor, invoices to a totals checker.
- Add a confidence score per manifest record and gate low-confidence documents for review.
- Try a larger local model and rerun `evals/run_evals.py` to see where the accuracy/latency curve bends.

## More detail

- [`tools.py`](tools.py) — the three tool definitions and why they are shaped this way
- [`model_call.py`](model_call.py) — the streaming and `tool_choice` findings, in code
- [`stage3_agentframework.py`](stage3_agentframework.py) — the Agent Framework engine, its conversation handling, and the two async traps behind it
- [`foundry_endpoint.py`](foundry_endpoint.py) — port and model discovery
- [`schemas.py`](schemas.py) — the validation contract
- [`evals/cases.py`](evals/cases.py) — the 43 eval cases and what each is testing
- [`web/server.py`](web/server.py) — the local web UI's API, and how blocking stages are streamed as events
- [Foundry Local documentation](https://learn.microsoft.com/azure/ai-foundry/foundry-local/)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)

## License

MIT — see [LICENSE](../../LICENSE).
