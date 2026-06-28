# 🧠 PM Agent

> Give it a PRD — get Jira tickets, a comms plan, and a risk summary. Automatically.

---

## What it does

PM Agent is an autonomous AI agent built for product management workflows. Feed it a Product Requirements Document (PRD) and it will:

- 🎫 **Generate Jira-ready tickets** — epics, stories, and tasks with acceptance criteria
- 📣 **Draft a comms plan** — stakeholder update, launch announcement, team brief
- ⚠️ **Surface risks** — flags assumptions, dependencies, and open questions from the PRD

Built with Claude's tool use API — the agent decides what to do and in what order, not a hardcoded pipeline.

---

## Tech Stack

- **Claude API** (tool use / agents)
- **Next.js** — frontend
- **Supabase** — storage
- **TypeScript**

---

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Add your keys to .env

# Run locally
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Environment Variables

See `.env.example` for all required variables.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |

---

## How to Extend This

- Add a **Jira integration** to push tickets directly via the Jira REST API
- Add **Slack output** to post the comms plan to a channel
- Support **multiple input formats** — meeting notes, user research, feature requests
- Add an **eval layer** to score ticket quality

---

## Related

- 📬 Newsletter writeup: *coming soon on [AI from the Inside](https://manishlad.substack.com)*
- 🗂️ Back to [all projects](../../README.md)
