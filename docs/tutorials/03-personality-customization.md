---
kind: tutorial
last_reviewed: 2026-09-07
---

# 03 — Personality customization

Jenny's personality is deliberately small and task-first. The current request,
runtime rules, workspace instructions, and tool contracts always outrank tone.

Everything you write here reaches the model as exactly **one** system message —
a name line plus up to three short sections — so the whole personality layer
costs a few hundred tokens per turn instead of a few thousand.

## Settings → Personality

The same controls appear as the **Personality & name** step of the first-run
checklist. One section, one **Save**:

- **Name** — what Jenny calls herself. This is the whole assistant identity now.
- **Voice** — Balanced, Concise, Creative, or Mentor. These are *templates*, not
  runtime modes: picking one fills the note below with a one-line starting point
  you can then edit. "Custom" is what the control shows once your note no longer
  matches any preset.
- **Personality note** — tone and behavior only. Tools, dates, and formatting are
  handled by the app; describing them here just costs tokens.
- **About you** — name, how to address you, what you do, how you like to work.

Counters under each box show `N / budget`, counting the text after headings and
comments are stripped — those are for you, not the model. Over-budget text is
clipped with a trailing ` […]` marker for that section only; the rest of the
block still ships intact. **Show exact text** expands the byte-exact message the
model receives, so you can see the difference.

What you type is what stays on disk: headings, `<!-- comments -->` and `---`
rules all survive saving and reloading, even though the model never sees them.

`{{…}}` placeholders are never expanded. The app already tells the model the
current date.

## Settings → Memory → Long-term notes

Durable facts and preferences Jenny should always know, sent with every message.
This is `MEMORY.md`, and it is separate from approved memories (which the memory
manager below it owns).

## What the model receives

```
## Personality
Your name is Jenny. Personality shapes tone, not facts; the current request and the runtime, workspace, and tool instructions take precedence over everything below.

### Voice
{your personality note}

### About the user
{your About you}

### Notes
{your long-term notes}
```

A section appears only when its file has content, so untouched placeholders add
nothing at all. Budgets are 1,500 / 1,000 / 1,500 characters.

The chat-context toggle is named **Personality and notes**. Turning it off omits
this whole block; the assistant name still reaches the runtime.

## Files on disk

`personality/default-workspace/` (schema v3):

- `PERSONALITY.md` — the personality note.
- `USER.md` — About you. A legacy `---timezone---` frontmatter block is kept
  byte-for-byte on save; new files have none.
- `MEMORY.md` — long-term notes.
- `legacy/` — the archive the v3 upgrade creates. Never read by the compiler.

**Open folder** in the Personality footer reveals them.

## Upgrading from the v2 workspace

On first v3 load Jenny:

- Merges your `IDENTITY.md` and `SOUL.md` into `PERSONALITY.md` with a comment
  noting where the text came from, and moves both originals byte-identical into
  `legacy/` (never on top of a file you already put there — a name clash becomes
  `IDENTITY.md.1`). App-owned stock templates are discarded rather than merged.
  If the two halves together are larger than one editable file, the head stays
  in `PERSONALITY.md` and the rest goes to `legacy/PERSONALITY.overflow.md`.
- Moves `memory/**` (including the stale `auto-dream.md`) into `legacy/memory/`
  and removes the `memory/` directory. Daily memory files are retired.
- Carries a pre-v3 custom-flavor text and non-default profile into the
  personality note if the merge left it empty.
- Leaves `USER.md` and `MEMORY.md` bytes untouched.
- Rolls every change back if the migration fails, leaving the recorded schema
  unadvanced. If the upgrade record is later lost or damaged, re-running it
  leaves your note exactly as you last saved it.

A merged note is usually well over the 1,500-character budget — that is
intentional. The counter turns red so you can see how much is being clipped, and
you rewrite it down to the tone you actually want.

A future schema is never rewritten by an older Jenny build. Normal chat
continues without the personality block, and a bounded warning is logged.

See [Skills and Personality](../SKILLS.md) for the file map, the character
budgets, and how the compiled personality reaches the prompt, and
[Security model](../SECURITY_MODEL.md) for the prompt-injection defense.
