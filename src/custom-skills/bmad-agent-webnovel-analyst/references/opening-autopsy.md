---
name: opening-autopsy
description: First-chapter analysis across a genre's top titles, ending in a chapter-one directive checklist
code: OA
added: 2026-07-14
type: prompt
---

# Opening Autopsy

Openings decide retention in serial fiction — a reader who bounces off chapter one never sees chapter two — so they earn a dedicated lens beyond general sampling.

The outcome is a first-chapter analysis across the genre's current top titles that ends in a **chapter-one directive checklist** an AI drafting pipeline can follow verbatim. For each sampled opening, record what is established and when: the first line's job, what the reader knows by the end of page one, when the genre promise lands, the chapter's length, and its ending mechanic. The checklist states each directive with its observed frequency ("Open in-scene, not with worldbuilding — 5/5 samples"), so the consumer can tell rules from options.

Write the analysis to `{agent.report_output_path}/<genre>-openings-<YYYY-MM-DD>.md` with the same methodology line the playbook requires: titles, ranking source, access date, substitutions.
