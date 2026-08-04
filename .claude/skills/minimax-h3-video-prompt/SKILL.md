---
name: minimax-h3-video-prompt
description: >
  Write, structure, and debug video generation prompts for MiniMax H3 (Hailuo) in the model's
  native rewrite format — either the integrated_multimodal_description / overall_soundscape /
  non_diegetic_music fields used for text-to-video and keyframe modes (T2VA, I2VA, FL2VA, L2VA),
  or the six-section subject_definitions / summary / retention_analysis / detailed_description
  format used for full-reference mode with <Subject>, <Picture>, <Video>, and <Audio> labels.
  Use this skill whenever the user is drafting or fixing a prompt for MiniMax H3 or Hailuo video
  generation — including when they only sketch a shot idea, hand over a first or last frame, want
  a character, scene, or voice carried over from a reference image or video, or ask why their
  generated clip dropped a line of dialogue, ignored a camera move, or lost a character's
  appearance across a cut. Trigger even when they never name the model or the field format.
---

# MiniMax H3 Video Prompt Writing

MiniMax H3 takes prompts as a set of named fields, not as free-form prose. A vivid paragraph
will still generate something, but the controls that matter — cut timing, which character is
speaking, whether a sound is audible to the characters or only to the audience, what carries
over from a reference image — attach to specific fields and tags. Writing outside that structure
means those levers simply aren't connected to anything.

There are two output formats. Choosing between them is the first decision and the one most
often gotten wrong, so it's worth being deliberate before writing a single line.

## Step 1: Which output format?

The test is what role the user's reference assets play:

> **Is the asset a *frame of the output*, or a *source of material for* the output?**

A frame means the image literally appears in the finished video at a known timestamp — it's the
first frame, the last frame, a keyframe. Nothing is being extracted from it; it *is* part of the
result. That's **base mode**.

A source of material means something is being lifted out of the asset and reused as a tracked
entity — this person, this room, this jacket, this voice, this camera rhythm — and the asset
itself never appears as a frame. That's **full-reference mode**.

| Situation | Format |
|---|---|
| Text only, no assets | Base mode (T2VA) |
| Image is the video's first frame, last frame, or both | Base mode (I2VA / FL2VA / L2VA) |
| A person, animal, object, scene, costume, style, or pose is reused from an asset | Full-reference |
| A source video is being edited, extended, or continued | Full-reference |
| An audio track is copied, or its timbre / music style / beat is referenced | Full-reference |
| One subject is assembled from several assets (looks from an image, motion from a video) | Full-reference |
| An image is a storyboard that plans shots rather than supplying a frame | Full-reference |

The boundary is sharper than it first looks, and the same image can land on either side:

- *"Here's a photo of her by the window — animate it, she looks up"* → the photo is frame zero.
  **Base mode, I2VA.**
- *"Here's a photo of her — now put her on a beach at sunset"* → she is being extracted from the
  photo and placed somewhere the photo never showed. The photo is not a frame of the output.
  **Full-reference**, with her as `<Subject 1>`.

When a task genuinely does both — continuing from a source video *and* landing on a supplied
last frame — it's full-reference, and the summary's task-type prefix combines both roles
(`[video continuation + keyframe completion]`).

## Step 2: Read the matching reference

**Base mode** → read `references/base-mode.md`. It's self-contained.

**Full-reference mode** → read **both** `references/reference-mode.md` **and**
`references/base-mode.md`. This is not optional and it's easy to miss: the full-reference guide
deliberately covers only the labels, the analysis sections, and how it differs from base mode.
Everything about shot numbering, camera vocabulary, speaker IDs, dialogue tags, and sound
handling lives in the base guide and is shared verbatim. Reading only the full-reference guide
leaves you writing the body of the prompt from guesswork.

## Step 3: In base mode, pick the sub-mode from the frames supplied

| Frames given | Mode | Instruction line |
|---|---|---|
| None | T2VA | No instruction line; start at `integrated_multimodal_description` |
| First only | I2VA | Yes — see base guide §2.1 |
| First and last | FL2VA | Yes — and prefer a single shot so the model can interpolate |
| Last only | L2VA | Yes — infer a plausible opening, then converge on the frame |

When there is an instruction line it goes first, alone, followed by one blank line. Durations in
it are written to exactly two decimals (`8.00`, not `8` or `8.0`).

## Things that are easy to get wrong

These come straight from the guides, but they're the points where a fluent-sounding draft
quietly stops matching the spec.

**Language.** Everything is written in English — except dialogue and lyrics inside `<d>`, and
text physically visible in the scene, which stay in their original language, word for word,
punctuation included. Translating a Chinese neon sign into English changes what gets rendered on
screen.

**Diegetic vs. non-diegetic.** The split is about who can hear it, not what it sounds like. A
character's radio, a busker, a ringtone, someone singing — the characters hear those, so they
belong in the description body alongside the action. `non_diegetic_music` is only the score the
audience hears and the characters cannot. Getting this backwards is the most common way an audio
plan comes out wrong.

**`overall_soundscape` is ambience and physical sound only** — wind, footsteps, fabric, impacts,
breathing, laughter. No dialogue, no singing, no music. Those are already placed elsewhere, and
repeating them here double-specifies them.

**`N/A` is a real value.** Use it for `non_diegetic_music` whenever there's no score — that's
common and correct. For `overall_soundscape`, use it only when the user explicitly asked for
total silence.

**Describe music physically, not emotionally.** Instrumentation, tempo, rhythm, dynamics. Not
"melancholy" or "builds tension" — those describe the intended effect rather than the sound, and
give the model nothing to act on.

**Speaker IDs.** `(S1)`, `(S2)` are assigned in the order vocal events actually occur in the
finished video, then reused for that voice forever after. Characters who never make a sound get
no ID at all. In full-reference mode a speaking subject carries both labels together —
`<Subject 2> (S1)` — because one identifies who they look like and the other identifies whose
voice it is.

**Shot timing.** `[Shot 1]` never carries a timestamp. Every later shot opens with a strictly
increasing `At MM:SS.mmm,` that falls inside the video's duration. If the only change between two
shots is distance or a slight angle, that's camera motion, not a cut — cuts should deliver new
information.

**Camera motion reads as prose.** "The camera pushes in with small amplitude at slow speed toward
the letter" — not a bare tag list bolted onto the end of a sentence. Amplitude and speed are
omitted when they're unremarkable; stating "medium amplitude at normal speed" adds nothing.

**Don't summarize the plot.** Especially in full-reference `detailed_description`, the failure
mode is writing a synopsis plus a list of which reference maps to what. Every sentence should
name something a viewer would actually see or hear at that moment.

## Before handing the prompt back

Read the draft once against these, since they're mechanical and cheap to check:

- Every field present, in the order the guide gives, nothing renamed
- Cut timestamps strictly increasing and inside the duration; `[Shot 1]` has none
- Every `<d>` block holds only a language tag and the user's exact words
- Every speaker ID traces to an established voice; no ID appears without an introduction
- No sound is specified in two places at once
- In full-reference mode: every label defined in `subject_definitions` also appears in
  `retention_analysis` with a relationship marker, and no new label was invented in `summary`

If the user supplied dialogue, quote it back to them alongside the finished prompt so they can
confirm it survived intact — verbatim preservation is the constraint most likely to be violated
without anyone noticing until the video comes back wrong.

## Provenance

Both reference files are unmodified copies of MiniMax's official guides, so they can be diffed
against upstream when the model updates:

- `references/base-mode.md` — `docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md`
- `references/reference-mode.md` — `docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md`

Both from `huggingface.co/MiniMaxAI/MiniMax-H3`, retrieved 2026-08-04.
