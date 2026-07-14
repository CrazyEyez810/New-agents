---
name: genre-playbook
description: Full research pipeline — genre best practices plus top-title sampling, synthesized into a drafting-ready playbook
code: GP
added: 2026-07-14
type: prompt
---

# Genre Playbook

The outcome is a playbook written to `{agent.report_output_path}/<genre>-playbook-<YYYY-MM-DD>.md` that an AI drafting pipeline can load as grounding context with no other source — something writing chapter one tomorrow follows it directly. That consumer sets the bar: every craft finding is a directive with its evidence base attached ("End ≥80% of chapters on an open loop — observed in 5/5 samples"), secondhand folklore is labeled as hypothesis with its source, and the report closes with a **Grounding Block** — a condensed, self-contained directive set that survives being pasted alone into a drafting prompt.

Because a full run samples several titles across many pages, name the platform and ranking you are about to prioritize in one clinical line before committing to it, and proceed unless corrected — the wrong platform poisons the whole evidence base for a cross-platform genre (romance, romantasy), and this costs one sentence to prevent.

Work both evidence streams before synthesizing:

- **The genre's discourse** — reader communities, author retrospectives, platform guides: the promise the genre makes, what its readers punish and reward, which tropes are load-bearing versus optional.
- **The genre's practice** — the current top 3–5 titles by live platform ranking (record which list and when), sampled 5–10 pages each with openings prioritized. Finish structured notes on each title before opening the next; carry notes forward, never raw text. Where the host supports subagents, a reader per title (each returning a dossier) parallelizes the reads and keeps raw chapter text out of your context by construction — the serial pass is the portable fallback, not the only way.

Cover at minimum: the reader promise and payoff cadence; structural norms (chapter length, hook and chapter-end mechanics, POV/tense); opening conventions; prose register; trope obligations; and packaging (title/blurb/tag patterns). Where discourse and samples disagree, the disagreement is a first-class finding.

A methodology line is mandatory: which titles, which platform ranking, sample sizes, access date, and any substitutions made for paywalled titles — the consumer must know what the evidence is. If primary sampling cannot be done at all — no usable rankings, fetch blocked, genre too niche to rank — say so plainly and offer a discourse-only playbook marked as unvalidated hypothesis throughout, rather than emitting a report that reads as evidence-backed when it isn't.

On completion, state the exact path you wrote and inline the Grounding Block in your closing message, so a headless caller has a usable result without a second read.
