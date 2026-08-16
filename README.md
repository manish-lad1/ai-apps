# 🤖 AI Apps by Manish Lad

> A collection of AI apps built by an AI PM — agents, pipelines, crews, RAG systems, MCP servers, and utility tools.
> Practical, forkable, and built to learn from.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Claude](https://img.shields.io/badge/Built%20with-Claude-orange)](https://www.anthropic.com)
[![Newsletter](https://img.shields.io/badge/Newsletter-AI%20from%20the%20Inside-blue)](https://manishlad.substack.com)

---

## 👋 About This Repo

I'm Manish — an AI Product Manager with 6 years of shipping AI products. This repo is where I build in public.

Every project here is:
- **Real** — tools I actually use or problems I've personally faced
- **Forkable** — clone it, run it, extend it however you like
- **Documented** — each project has setup instructions and notes on how to take it further

Each build also gets a writeup in my newsletter **[AI from the Inside](https://manishlad.substack.com)** — where I write about what it actually takes to build AI products, for PMs who want to do the same.

---

## 🏷️ Naming Convention

Project folders follow `<artifact_or_domain>_<pattern_suffix>` — the first part names what it does, the suffix names how it's built, so the architecture is visible from the folder name alone, before opening the README.

| Suffix | Signals | Lives in |
|---|---|---|
| `_agent` | A single AI agent, possibly multi-step internally (e.g. a draft → self-critique → refine loop) | `ai_agents/` |
| `_crew` | Multiple distinct agents contesting or debating the *same* question at the same level — symmetric, order-independent | `crew_apps/` |
| `_pipeline` | Multiple distinct agents passing an artifact forward through fixed, ordered stages — may include human approval gates or asymmetric generator/critic loops within a stage | `pipeline_apps/` |
| `_rag` | Retrieval-augmented generation | `rag_apps/` |
| `_mcp` | An MCP server — exposes tools, not itself an agent | `mcp_apps/` |
| *(plain name)* | A general utility app, AI-driven or not | `utility_apps/` |

**Telling `_agent`, `_crew`, and `_pipeline` apart:**
- One model looping with itself (draft → critique → refine) is still `_agent` — the loop is internal to a single agent's process.
- `_pipeline` is forward-only: each stage hands its output to the next, agents don't see each other's reasoning, and order matters. A pipeline stage can still contain a human approval gate, or an asymmetric generator/critic loop (one agent drafts, another reviews and sends it back) — that's still forward motion, just paused or cycled within a stage.
- `_crew` is peer contest: agents engage the same artifact at the same level, and the result is a genuine function of their disagreement — removing one doesn't shorten the process, it changes what the answer means.
- Agents fanning out to work independent sub-questions in parallel, then getting aggregated (no interaction between them), is *decomposition* — a sub-pattern that lives inside a `_pipeline` stage, not a suffix of its own.

---

## 📂 Projects

### 🤖 AI Agents

| Project | What it does | Stack |
|---|---|---|
| [🧠 PRD Critique Agent](./ai_agents/prd_critique_agent/) | Drafts a PRD from a rough idea, critiques its own draft against a PM review rubric, then refines it — every stage visible, runs on a local model or the Claude API | Claude API, Ollama, Next.js |
| [🧾 Form Builder Agent](./ai_agents/form_builder_agent/) | Turns a plain-language description into a live, working form — refine it conversationally, then export as React or HTML | Claude API, Ollama, Next.js |

---

### 🔀 Pipeline Apps
 
| Project | What it does | Stack |
|---|---|---|
| [🧩 Idea Research Pipeline](./pipeline_apps/idea_research_pipeline/) | Turns a product idea into an approved research plan, fans out parallel agents to research each question, then generates a report that critiques and revises itself before flagging contradictions across sources | Claude API, Ollama, Next.js |
| [🗂️ Document Triage Pipeline](./pipeline_apps/document_triage_pipeline/) | Classifies a folder of documents, extracts key fields and flags personal data behind a validating schema, embeds everything locally, then answers questions from retrieved context only — replying `NOT FOUND` rather than guessing. Runs entirely offline | Foundry Local, Phi-4-mini, Python, FastAPI |

---

### 📀 RAG Apps

| Project | What it does | Stack |
|---|---|---|
| [📚 Knowledge Base RAG](./rag_apps/knowledge_base_rag/) | Retrieval-augmented Q&A that answers only from retrieved passages and cites every claim — ask a built-in newsletter + repo corpus, or upload your own files/URLs into an ephemeral session KB | Claude API, Voyage, Ollama, Next.js |

---

### 🔌 MCP Apps

| Project | What it does | Stack |
|---|---|---|
| [🔍 GitHub Insights MCP](./mcp_apps/github_insights_mcp/) | A read-only MCP server exposing GitHub repo insight tools (structure, activity, issues/PRs) to any MCP client, plus a demo chat UI that spawns it and shows the LLM's tool calls live | TypeScript, `@modelcontextprotocol/sdk`, Octokit, Next.js |

---

### 🛠️ Utility Apps

| Project | What it does | Stack |
|---|---|---|
| 🚧 Coming soon | — | — |

---

## 🚀 Getting Started

Each project is self-contained. The general flow for any project:

```bash
# 1. Clone the repo
git clone https://github.com/manish-lad1/ai-apps.git

# 2. Navigate to the project you want
cd ai-apps/rag_apps/knowledge_base_rag

# 3. Install dependencies
npm install          # for Next.js projects
# or
pip install -r requirements.txt   # for Python projects

# 4. Set up environment variables
cp .env.example .env
# Fill in your API keys in .env

# 5. Run the project
npm run dev
# or follow the project-specific README
```

**Follow the `README.md` inside each project folder** for specific setup steps, environment variables, and how to extend it.

---

## 📬 Newsletter

Each project in this repo gets a writeup in **[AI from the Inside](https://manishlad.substack.com)** — real lessons from building AI products, for PMs who want to do the same. Published every Tuesday.

---

## 📄 License

MIT — free to use, modify, and distribute. See [LICENSE](./LICENSE) for details.

---

## 🤝 Contributing

Found a bug? Have an idea? Open an issue or submit a pull request — contributions are welcome.

If you fork and build something cool, I'd love to hear about it.

---

*Built by [Manish Lad](https://github.com/manish-lad1) · [LinkedIn](https://www.linkedin.com/in/manishlad) · [Newsletter](https://manishlad.substack.com)*
