# 🤝 Split Smart

> Split expenses with friends using natural language — no mental math, no awkward back-and-forth.

---

## What it does

Split Smart is an AI-powered expense splitting app. Add a bill, describe how to split it in plain English, and it figures out who owes what.

- 👥 **Add friends and groups** — create shared expense groups
- 🧾 **Log shared expenses** — with amounts, categories, and payers
- 🗣️ **Split in natural language** — *"Split the dinner, but Raj had the wine so add ₹500 extra to his share"*
- 🤖 **Smart categorisation** — Claude auto-tags expenses (food, travel, utilities, etc.)
- 💸 **Settle up** — see a clear summary of who owes whom

---

## Tech Stack

- **Next.js** — frontend + API routes
- **Supabase** — database and auth
- **Claude API** — natural language splitting + smart categorisation
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

- Add **payment integration** — UPI, PayPal, or Stripe to settle directly in-app
- Add **receipt scanning** — upload a photo of a bill and auto-extract line items
- Build **group analytics** — who spends the most, what categories dominate
- Add **push notifications** — remind friends when they owe money

---

## Related

- 📬 Newsletter writeup: *coming soon on [AI from the Inside](https://manishlad.substack.com)*
- 🗂️ Back to [all projects](../../README.md)
