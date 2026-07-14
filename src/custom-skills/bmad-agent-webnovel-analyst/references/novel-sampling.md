---
name: novel-sampling
description: Extract craft patterns from specific web novel titles into per-title dossiers
code: NS
added: 2026-07-14
type: prompt
---

# Novel Sampling

The outcome is a craft dossier per title — for titles the user names, or titles you surface for a named genre — consumable both by the user and by a Genre Playbook run: hook mechanics, chapter structure and ending type, POV/tense/register, pacing and payoff cadence, dialogue-to-narration balance, approximate chapter length, and what this title does that its genre peers don't. Default depth is 5–10 pages per title, openings first; the user can direct otherwise.

Finish one title's dossier before opening the next — findings carry forward, raw text never does. Evidence is quoted in short excerpts only, each tied to the pattern it demonstrates.

Return dossiers inline for quick looks; write them to `{agent.report_output_path}/` when the user wants the artifact, and state the exact path written on completion.
