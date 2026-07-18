---
title: "Who Judges the Judge?"
date: "2026-07-22"
url: "https://manishlad.substack.com/p/who-judges-the-judge"
placeholder: true
---

# Who Judges the Judge?

> **Placeholder article.** This is stand-in content used to demonstrate the RAG
> pipeline across more than one document. Replace it with a real newsletter
> export (same frontmatter shape) before shipping. It sketches the intended
> follow-up to "Stop Grading AI Like a Spelling Test" but is not a finished piece.

Last week I argued for measuring flaw recall instead of similarity to a golden output. That shift raises an obvious question I promised to pick up: once "did it catch the flaw?" is the thing you're scoring, *who decides* whether the flaw was caught? At a handful of examples you can eyeball it yourself. At a few hundred, run nightly, you can't — so people reach for an LLM judge: a second model whose only job is to read the system's output and the planted flaw and return a pass or fail.

## The judge is a system too

The trap is treating the judge as ground truth. It isn't. It's another AI system with its own failure modes — it can be lenient, it can be inconsistent, it can be swayed by a confident tone. A judge that rubber-stamps everything as "pass" gives you a beautiful dashboard and zero signal.

So the judge needs its own eval. The cleanest way I've found: hand-label a small trusted set — a few dozen outputs you've scored yourself — and measure the judge against *that*. You're not asking "is the judge right in general," you're asking "does the judge agree with me on cases where I already know the answer." Agreement rate on that trusted set is the judge's own quality metric.

## Make the judge's job small

A judge asked "is this a good critique?" will be vague and unreliable. A judge asked "does this text mention the specific data-handling gap described here: <flaw>? Answer yes or no with a one-line reason" is doing something narrow enough to be consistent. The lesson mirrors the one about the systems being judged: the more open-ended the question, the noisier the score. Constrain the judge to a binary, flaw-specific decision and its agreement with human labels climbs.

## What's next

Next week: turning this into a cheap nightly harness — running the judge over a flaw set on every prompt change, and catching regressions before they ship. — Manish.
