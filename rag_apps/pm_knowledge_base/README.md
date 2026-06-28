# 📚 PM Knowledge Base

> A RAG system that lets you ask questions across PM frameworks, articles, and newsletter archives.

---

## What it does

PM Knowledge Base is a Retrieval Augmented Generation (RAG) system built over a curated corpus of product management knowledge. Ask it anything — it retrieves the most relevant content and generates a grounded, cited answer.

The knowledge base includes:
- Classic PM frameworks (RICE, Jobs-to-be-Done, Shape Up, CIRCLES, etc.)
- Articles from [AI from the Inside](https://manishlad.substack.com)
- Curated PM writing from across the web

**Example queries:**
- *"What's the right prioritization framework for an early-stage B2B product?"*
- *"How do I write a PRD that engineers actually want to read?"*
- *"What does Shape Up say about writing pitches?"*

---

## Tech Stack

- **Claude API** — generation + embeddings
- **Vector store** — Chroma (local) or Supabase pgvector (cloud)
- **Python** — ingestion pipeline
- **Streamlit or Next.js** — frontend

---

## Getting Started

```bash
# Install dependencies
pip install -r requirements.txt

# Set up environment variables
cp .env.example .env
# Add your keys to .env

# Ingest documents into the vector store
python ingest.py

# Run the app
streamlit run app.py
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SUPABASE_URL` | Supabase project URL (if using pgvector) |
| `SUPABASE_ANON_KEY` | Supabase anon key (if using pgvector) |

---

## How to Extend This

- Add **your own documents** to the `/docs` folder and re-run `ingest.py`
- Swap Chroma for **Supabase pgvector** for a cloud-hosted vector store
- Add **source citations** in the UI so every answer links back to the original article
- Build an **agentic RAG** layer that decides when to retrieve vs. answer from context

---

## Related

- 📬 Newsletter writeup: *coming soon on [AI from the Inside](https://manishlad.substack.com)*
- 🗂️ Back to [all projects](../../README.md)
