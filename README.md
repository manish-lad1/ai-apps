# 🤖 AI Apps by Manish Lad

> A collection of AI apps built by an AI PM — agents, RAG systems, MCP servers, and utility tools.
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

## 📂 Projects

### 🤖 AI Agents

| Project | What it does | Stack |
|---|---|---|
| [🧠 PM Agent](./ai_agents/pm_agent/) | Give it a PRD → get Jira tickets, a comms plan, and a risk summary | Claude API, Tool Use, Next.js |

---

### 📀 RAG Apps

| Project | What it does | Stack |
|---|---|---|
| [📚 PM Knowledge Base](./rag_apps/pm_knowledge_base/) | Ask questions across PM frameworks, articles, and newsletter archives | Claude API, RAG, Embeddings |

---

### 🔌 MCP Apps

| Project | What it does | Stack |
|---|---|---|
| 🚧 Coming soon | — | — |

---

### 🛠️ Utility Apps

| Project | What it does | Stack |
|---|---|---|
| [💰 Finance Tracker](./utility_apps/finance_tracker/) | Track income, expenses, goals — with a natural language query layer | Next.js, Supabase, Claude API |
| [🤝 Split Smart](./utility_apps/split_smart/) | Split expenses with friends using natural language | Next.js, Supabase, Claude API |

---

## 🚀 Getting Started

Each project is self-contained. The general flow for any project:

```bash
# 1. Clone the repo
git clone https://github.com/manish-lad1/ai-apps.git

# 2. Navigate to the project you want
cd ai-apps/utility_apps/finance_tracker

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
