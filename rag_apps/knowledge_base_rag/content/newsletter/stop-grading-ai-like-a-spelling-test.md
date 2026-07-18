{\rtf1\ansi\ansicpg1252\cocoartf2870
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\froman\fcharset0 Times-Bold;\f2\froman\fcharset0 Times-Roman;
\f3\froman\fcharset0 Times-Italic;}
{\colortbl;\red255\green255\blue255;\red0\green0\blue0;}
{\*\expandedcolortbl;;\cssrgb\c0\c0\c0;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 ---\
title: "Stop Grading AI Like a Spelling Test"\
date: "2026-07-15"\
url: "https://manishlad.substack.com/p/stop-grading-ai-like-a-spelling-test"\
---\
\
\pard\pardeftab720\sa321\partightenfactor0

\f1\b\fs48 \cf0 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 Stop Grading AI Like a Spelling Test\
\pard\pardeftab720\sa240\partightenfactor0

\f2\b0\fs24 \cf0 A few weeks ago, I sat down to build an eval dataset for an AI agent I'd been working on \'97 one that critiques product requirement documents. My plan was simple: write ten sample PRDs, then for each one, write the "ideal" critique it should produce. Once I had those reference answers, I'd just compare the agent's actual output against them and see how close it got.\
I got about three examples in before something started to bother me.\
I had two critiques in front of me \'97 both genuinely good, both catching the real problem I'd planted in the PRD \'97 and they scored completely differently against my reference answer. Not because one was wrong. Because one used different words, a different order, a different structure than the "ideal" version I'd written in my head. I wasn't measuring whether the critique worked. I was measuring whether it sounded like me.\
That's the moment I stopped writing golden outputs, and it's the moment I want to walk you through, because I think it's a mistake almost every PM makes the first time they try to evaluate an AI system \'97 and it's an expensive one to make quietly.\
\pard\pardeftab720\sa298\partightenfactor0

\f1\b\fs36 \cf0 The spelling test problem\
\pard\pardeftab720\sa240\partightenfactor0

\f2\b0\fs24 \cf0 Here's the plain-language version of what went wrong.\
A spelling test has exactly one correct answer. "Necessary" is spelled one way. Any deviation \'97 a missing letter, a swapped vowel \'97 is wrong, full stop. Grading is easy because there's a single, unambiguous target.\
A fire drill doesn't work that way. There's no single correct path out of a building. What matters is whether everyone found 
\f3\i an
\f2\i0  exit, checked for 
\f3\i the
\f2\i0  hazards that were actually planted in the scenario, and got out safely. If you handed the fire marshal a rigid script \'97 "everyone must exit through door 3, in this order, using these exact words to alert others" \'97 and then failed anyone who deviated from it, you'd be grading the wrong thing. You'd be rewarding people for following your script, not for handling the fire.\
Push the analogy one step further and it gets more useful. Imagine two employees during the drill. One follows your script exactly \'97 exits through door 3, says the right words \'97 but never actually checks whether the hallway is clear of smoke. The other improvises a completely different exit, says nothing you scripted, but personally verifies every hazard on the way out. If your grading sheet only checks adherence to the script, the first employee passes and the second fails, even though the second one is the only one who actually did the job the drill exists to test. That's exactly the failure mode golden-output evals fall into with AI systems: they grade adherence to a script, not whether the actual hazard got handled.\
Most AI systems that PMs actually build \'97 critique agents, summarizers, generators, anything that produces open-ended text \'97 are fire drills, not spelling tests. There are many valid good outputs. But the default instinct, especially for a PM who's new to evals, is to grade them like spelling tests anyway: write one "correct" answer, measure distance from it, call that quality.\
\pard\pardeftab720\sa298\partightenfactor0

\f1\b\fs36 \cf0 Golden outputs vs. flaw-based evals\
\pard\pardeftab720\sa240\partightenfactor0

\f2\b0\fs24 \cf0 Let's define both approaches properly, because the difference matters more than it first appears.\
A 
\f1\b golden-output eval
\f2\b0  works like this: for a given input, you write the expected output \'97 the reference answer. You run your system, get its actual output, and score the two against each other. The scoring method varies \'97 exact string match, embedding similarity, or increasingly, an LLM judge asked "how close is this to the reference?" \'97 but the underlying logic is always the same: distance from one specific answer equals quality.\
A 
\f1\b flaw-based eval
\f2\b0  works differently, and it starts from a different question entirely. Instead of asking "what's the ideal output," you ask: "what could go wrong in this domain, specifically?" You take an input and deliberately plant a known problem into it \'97 a missing edge case, a security gap, an unhandled failure mode \'97 tag it with a severity level, and then measure one thing: did the system catch it? Not whether it phrased the catch the way you would have. Just whether it caught it at all.\
The practical difference shows up immediately once you sit with both approaches. Golden-output scoring rewards outputs that resemble your reference in phrasing, structure, and tone \'97 which correlates only loosely with whether the output actually did the job. A critique can hit 85% similarity to your reference while completely missing the one flaw that actually mattered, because it talked around it in reference-like language. Flaw-based scoring doesn't care about phrasing at all. It cares about recall: out of the flaws you planted, how many did the system actually surface?\
For anything with more than one valid good answer \'97 and that's most of what PMs are shipping right now \'97 similarity-to-reference is measuring the wrong axis. It's optimizing for "sounds like me," not "did the job."\
\pard\pardeftab720\sa298\partightenfactor0

\f1\b\fs36 \cf0 What this looked like in practice\
\pard\pardeftab720\sa240\partightenfactor0

\f2\b0\fs24 \cf0 Here's a concrete version of the problem, based on one of the cases in my own eval set: a fintech-domain PRD with a deliberately planted security flaw \'97 a missing requirement around how sensitive data should be handled during an integration step.\
My "ideal" reference critique flagged this directly, in a specific sentence, using specific language about data handling and compliance exposure.\
The agent's actual critique caught the same underlying issue \'97 but framed it as a broader "this integration needs a security review before launch" comment, without using my exact phrasing or isolating it into its own bullet point. Scored against my golden reference for similarity, this critique came out mediocre. It didn't match the shape of my ideal answer closely enough. But functionally, it did exactly what I needed it to do: it stopped someone from shipping a PRD with a real security gap in it.\
Now flip it. Take a critique that mirrors my reference almost word-for-word in structure and tone, hits every stylistic note I'd write myself \'97 but never actually names the specific data-handling gap. Under golden-output scoring, this one might score 
\f3\i higher
\f2\i0  than the critique that actually caught the flaw, purely because it resembles my reference more closely on the surface.\
That's the trap. A flaw-recall check has no ambiguity here: the first critique gets full credit because the specific planted flaw was surfaced, however it was phrased. The second gets zero credit, no matter how polished it sounds, because the flaw that mattered was never caught. That's the whole point of the exercise \'97 the eval is measuring the thing you actually care about, not a proxy for it.\
\pard\pardeftab720\sa298\partightenfactor0

\f1\b\fs36 \cf0 What this means if you're the one evaluating\
\pard\pardeftab720\sa240\partightenfactor0

\f2\b0\fs24 \cf0 Two implications, if you're a PM rather than the one building the eval harness yourself.\
First: if you're evaluating a vendor's AI product and they tell you "we score 92% on our eval," your very first question should be 
\f3\i what is that eval actually measuring
\f2\i0  \'97 similarity to a reference, or coverage of known failure modes? A high similarity score can hide a system that's fluent, confident, and wrong about the thing that matters. Ask them directly what failure modes their eval set covers, how many severity levels they track, and how the eval decides "pass" versus "fail" for each one. If the honest answer is "we compare it to a set of ideal responses," treat that number with real skepticism \'97 it's telling you how well the model imitates a style, not how reliably it catches the thing that would actually hurt you in production.\
Second: designing a flaw-based eval, even a rough one, is a product-thinking exercise disguised as a technical one. Before you plant a single flaw, you have to sit down and actually enumerate what goes wrong in your domain \'97 the security gaps, the edge cases, the things that quietly break in production. That list is a PM artifact as much as a QA one; it's the same muscle you use writing a pre-mortem or a risk register, just pointed at your eval set instead of your launch plan. That exercise alone, done seriously, is often more valuable than the eval score it produces. It's the PM work nobody skips well, and it's exactly the work that gets skipped when eval design gets handed entirely to engineering.\
\pard\pardeftab720\sa298\partightenfactor0

\f1\b\fs36 \cf0 The mistakes I'd flag\
\pard\pardeftab720\sa240\partightenfactor0

\f2\b0\fs24 \cf0 A few patterns worth watching for, since I made at least two of them myself:\
\pard\pardeftab720\sa240\partightenfactor0

\f1\b \cf0 Writing the ideal output before you've enumerated what could go wrong.
\f2\b0  This is designing the eval backwards. Start with the failure modes, not the perfect answer \'97 the perfect answer, if you even need one, should come last, not first.\

\f1\b Treating a high similarity score as a proxy for quality.
\f2\b0  It might just mean the output is verbose and confident in a way that pattern-matches your reference. Confidence and correctness are not the same axis.\

\f1\b Delegating eval design to engineering as a purely technical task.
\f2\b0  The taxonomy of what can go wrong in your domain is a product call, not an implementation detail. If a PM isn't involved in deciding what flaws get planted, the eval will measure whatever engineering happened to think of \'97 which may or may not be what actually matters to the business.\
\pard\pardeftab720\sa298\partightenfactor0

\f1\b\fs36 \cf0 What's next\
\pard\pardeftab720\sa240\partightenfactor0

\f2\b0\fs24 \cf0 Once you've made this shift \'97 measuring flaw recall instead of similarity \'97 a new question shows up immediately: who, or what, actually decides whether a flaw was caught? Scoring "did it catch the flaw" sounds simple until you try to automate it at scale, and that's where the idea of a judge comes in \'97 a second system whose entire job is making that call reliably. That's what I'll get into next week.\
See you next Tuesday. \'97 Manish.\
}