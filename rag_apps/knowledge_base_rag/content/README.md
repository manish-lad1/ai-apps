# Built-in corpus content

This folder holds the source material for **built-in mode**. `scripts/ingest.ts`
reads everything here (plus the repo's own READMEs), chunks it, embeds it, and
writes `data/embeddings.json`.

## `newsletter/`

One Markdown file per newsletter article. Each needs frontmatter:

```markdown
---
title: "Article Title"
date: "2026-07-15"
url: "https://manishlad.substack.com/p/slug"
---

# Article Title

Body in Markdown, using ## / ### headings — the chunker splits on those.
```

- `stop-grading-ai-like-a-spelling-test.md` — real article.
- `who-judges-the-judge.md` — **placeholder** (marked `placeholder: true` in its
  frontmatter and flagged in the body). Replace with a real export before shipping.

To add articles, drop more `.md` files in here and re-run `npm run ingest`.

## Repo docs

The ingest script also walks the parent `ai-apps` repo's `README.md` files (root +
each project) so built-in mode can answer questions about the portfolio itself.
That happens automatically from the repo layout — nothing to copy in here. If you
run the app outside the monorepo and the parent READMEs aren't present, ingestion
just skips them and reports how many it found.
