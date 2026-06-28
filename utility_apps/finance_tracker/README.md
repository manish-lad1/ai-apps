# 💰 Finance Tracker

> A personal finance SaaS — track income, expenses, and goals, with a natural language query layer.

---

## What it does

Finance Tracker is a full-stack personal finance tool built to replace the manual Excel spreadsheet I used to maintain. It lets you:

- 💵 **Track income and expenses** — categorised, dated, and filterable
- 📊 **View dashboards** — spending breakdowns, monthly trends, category summaries
- 🎯 **Set and track goals** — savings targets, spending limits, milestone tracking
- 🗣️ **Query your data in plain English** — *"How much did I spend on food last month?"* powered by Claude

---

## Tech Stack

- **Next.js** — frontend + API routes
- **Supabase** — database and auth
- **Recharts** — data visualisation
- **Claude API** — natural language query layer
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

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `NEXTAUTH_SECRET` | Random secret for auth sessions |

---

## How to Extend This

- Add **recurring transactions** — auto-log monthly bills
- Add **multi-currency support** — useful if you transact in more than one currency
- Build a **weekly digest** — email summary of the week's spending
- Add **investment tracking** — stocks, mutual funds, crypto

---

## Related

- 📬 Newsletter writeup: *coming soon on [AI from the Inside](https://manishlad.substack.com)*
- 🗂️ Back to [all projects](../../README.md)
