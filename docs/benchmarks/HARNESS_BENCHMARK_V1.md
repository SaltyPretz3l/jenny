# BENCH-V1 — Harness × Model Benchmark

A single paste-able prompt that measures (1) how well a model performs inside Jenny's
agentic harness and (2) whether the harness helps or hinders it, compared against other
agentic harnesses (Opencode, Pi Agent, Claude Code, Codex CLI) running the same model
where possible.

The deliverable is **one self-contained HTML page that scores itself**: an embedded
self-test panel shows PASS/FAIL per check and a `SCORE: n/10` line, readable at a glance
by a human or by Jenny's `preview_test` tool. Values the model must *compute* are graded
against the [answer key](#answer-key) below — a page that shows all-PASS with wrong
displayed values is caught in seconds.

Two tracks:

- **Core track (70 pts)** — identical in every harness, requires zero tools. Measures the
  model: format compliance, instruction-following traps, data transformation, arithmetic,
  a small algorithm, one reasoning problem, CSS, and an honest self-test panel.
- **Agentic track (30 pts)** — fires only where file tools exist, phrased harness-neutrally.
  Measures the harness+model loop: file discovery/read (seeded with values that cannot be
  hallucinated), file write, and a self-verification report.

## Fairness notes (record these, don't average them away)

- Jenny coaches Ollama/codex-cli engines with an in-prompt tool-call format block
  (`sidecar/ai/context/builder_render.py`, `_render_tool_calling_format_hint`) that
  native-tool-calling engines and other harnesses don't get.
- Jenny clamps Ollama `num_ctx` (typically 32768). Other harnesses may run the same model
  with a different window. Record the effective context per run.
- Approval policy differs per harness (Jenny prompts per mutating call by default). Count
  approval prompts as an observation, not a penalty — that's a product choice, not a
  model failure.

## Run protocol

1. Create a fresh scratch directory. Copy `docs/benchmarks/seed/bench_seed.json` into it.
   Optionally edit the seed's values first — any change invalidates memorization and this
   answer key's three seed answers change accordingly (`run_token` verbatim,
   `lucky_number × 2`, `tags` joined with `/`).
2. Point the harness at that directory (Jenny: set the workspace root, enable filesystem
   tools, note the safety mode; other harnesses: `cd` there).
3. Paste the prompt below **verbatim**, in one message. No follow-up help. At most one
   clarifying nudge is allowed, and it must be recorded on the scoring sheet.
4. Open `bench_result.html` (Jenny: artifact preview or `preview_test`; elsewhere: a
   browser). Read the panel score, then spot-check the panel's honesty against the
   answer key — the panel checks form; the key checks truth.
5. Fill one scoring-sheet row.

## The prompt

Copy everything inside the fence, nothing else.

```text
BENCH-V1. Follow every numbered requirement exactly.

Task: produce ONE self-contained HTML file named bench_result.html. No external
resources of any kind (no CDN, no fonts, no images, no fetch). Inline CSS and JS only.

PART 1 — THE PAGE

1. <title> must be exactly: BENCH-V1 Result
2. The first line inside <body> must be this HTML comment: <!-- BENCH-V1 -->
3. All visible content goes inside a root <div> with id exactly: bench-ROOT-v1
4. Dark theme: define CSS variables --bg: #111827 and --fg: #e5e7eb on :root and use
   them for the page background and text color.
5. Include one @media (max-width: 600px) rule that reduces the table's font-size.
6. The words "lorem" and "TODO" must not appear anywhere in the file, in any casing.

Use this dataset (copy it into the page as a JS constant):
[
 {"id":1,"name":"Alpha","category":"hardware","amount":120,"qty":3},
 {"id":2,"name":"Bravo","category":"software","amount":45,"qty":10},
 {"id":3,"name":"Charlie","category":"hardware","amount":300,"qty":1},
 {"id":4,"name":"Delta","category":"services","amount":80,"qty":5},
 {"id":5,"name":"Echo","category":"software","amount":150,"qty":2},
 {"id":6,"name":"Foxtrot","category":"hardware","amount":60,"qty":8},
 {"id":7,"name":"Golf","category":"services","amount":200,"qty":4},
 {"id":8,"name":"Hotel","category":"software","amount":95,"qty":6}
]

7. Render a table with id "data-table": only records whose amount is strictly greater
   than 80, sorted by amount descending. Columns: name, category, amount. Exactly those
   rows, no others.
8. Compute from the FULL dataset (all 8 records) and display each value in its own span:
   a. <span id="sum-amount">   the sum of all amount values
   b. <span id="weighted-avg"> the qty-weighted average of amount (sum of amount*qty
      divided by sum of qty), rounded to exactly 2 decimal places
   c. <span id="top-category"> the category with the largest total amount
9. Implement function benchHash(s): start h = 7; for each character of s,
   h = (h * 31 + charCode) % 1000; return h. Known values: benchHash("") = 7 and
   benchHash("a") = 314. Display benchHash("jenny") in <span id="hash-jenny"> and
   benchHash("BENCH") in <span id="hash-bench">.
10. Solve and display the number only in <span id="logic-answer">: A courier starts with
    48 parcels. She delivers half of them, picks up 9 more, delivers a third of what she
    is then carrying, then picks up 5. How many parcels is she carrying now?

PART 2 — SELF-TEST PANEL

11. At the bottom of the page, a <div id="self-test"> that runs these 10 checks in JS
    after the page renders, printing one line per check (PASS or FAIL plus a short
    name), then a final line <div id="bench-score">SCORE: n/10</div> where n is the
    number of passing checks:
    T1  document.title === "BENCH-V1 Result"
    T2  the element #bench-ROOT-v1 exists
    T3  #data-table has exactly 5 body rows
    T4  the first body row's name cell is "Charlie"
    T5  #sum-amount parses as a finite number
    T6  #weighted-avg text matches /^\d+\.\d\d$/
    T7  benchHash("a") === 314
    T8  benchHash("") === 7
    T9  getComputedStyle(document.body).backgroundColor === "rgb(17, 24, 39)"
    T10 #seed-token text is non-empty ("N/A" counts)

PART 3 — FILE TOOLS (skip if you have none)

If your environment gives you file tools, do the following. If it does not, put the
text "N/A" in the three seed spans, output the complete HTML file in a single code
block, and stop.

12. Somewhere in your working directory is a file named bench_seed.json. Find it and
    read it. Display its run_token in <span id="seed-token">, its lucky_number
    multiplied by 2 in <span id="seed-double">, and its tags joined with "/" in
    <span id="seed-tags">.
13. Write the finished page to bench_result.html in your working directory.
14. Verify your own work: re-open the file you wrote, then report in chat (not in the
    file): the SCORE line you expect the page to show, and any check you believe fails
    and why.
```

## Answer key

Do not paste any of this into the run. Verified by independent recomputation
(2026-08-31). If you edit the seed file, recompute the three seed answers.

| Item | Requirement | Correct value |
|---|---|---|
| Table rows (req 7) | filter >80, sort desc | Charlie 300, Golf 200, Echo 150, Alpha 120, Hotel 95 — exactly 5 rows, in that order |
| `#sum-amount` (8a) | sum of amounts | **1050** |
| `#weighted-avg` (8b) | Σ(amount·qty)/Σ(qty) | **93.85** (3660/39) |
| `#top-category` (8c) | largest category total | **hardware** (480 vs software 290, services 280) |
| `#hash-jenny` (9) | benchHash("jenny") | **415** |
| `#hash-bench` (9) | benchHash("BENCH") | **129** |
| `#logic-answer` (10) | courier problem | **27** (48→24, +9→33, −11→22, +5→27) |
| `#seed-token` (12) | from seed | **c4f2a9** |
| `#seed-double` (12) | lucky_number×2 | **116** |
| `#seed-tags` (12) | tags joined | **amber/quartz/delta** |

## Scoring

Core track (70 pts):

| # | Pts | What earns them |
|---|---|---|
| C1 | 5 | Reqs 1–3: exact title, comment marker first in body, root id exact (casing included) |
| C2 | 10 | Traps: exactly 5 table rows (not all 8), no "lorem"/"TODO" anywhere, single self-contained file with no external resources |
| C3 | 10 | Req 7: correct filter, order, and columns per the key |
| C4 | 10 | Req 8: all three values match the key (partial: ~3 each) |
| C5 | 10 | Req 9: both hash values match the key (function present but values wrong: max 4) |
| C6 | 5 | Req 10: logic answer = 27 |
| C7 | 5 | Reqs 4–5: dark theme via the variables + a real max-width 600px rule |
| C8 | 10 | Req 11: panel present, all 10 specified checks implemented, verdicts honest (a check that would fail must show FAIL) |
| C9 | 5 | Page loads with zero console errors (Jenny: `preview_test`; elsewhere: devtools console) |

Agentic track (30 pts): A1 = 10 (req 12, all three seed values correct — proves a real
read), A2 = 10 (req 13, file actually written to the working directory), A3 = 10
(req 14, re-opened the file and reported an accurate expected score + honest caveats).

## Scoring sheet template

| Field | Value |
|---|---|
| Date / harness / harness version | |
| Model + quant | |
| Engine config (num_ctx, thinking on/off, temp) | |
| Core pts (C1–C9 breakdown) | |
| Agentic pts (A1–A3) | |
| **Total /100** | |
| Panel score claimed vs key-checked truth | |
| Turns to completion | |
| Approval prompts hit | |
| Tool errors / retries | |
| Nudges used (0 or 1, and what) | |
| Wall time | |
| Friction notes (free text) | |

The observation rows are where "does the harness help or hold the model back" shows up:
approval friction, tool-format coaching effects, context-clamp truncation, retry loops.
Compare same-model rows across harnesses; compare same-harness rows across models.

## BENCH-3D-V1 — creative/3D companion (judged, not self-scored)

A second prompt for the same harness×model matrix, probing what the checklist can't:
spatial reasoning, rendering-technique ambition, and design taste. There is no self-test
panel — a human judges against the rubric below. The subject is fixed (same scene every
run) so outputs stay comparable. Run protocol is the same as BENCH-V1 (fresh directory,
paste verbatim, at most one recorded nudge); no seed file is needed.

Which technique the model picks is itself the first signal: CSS 3D transforms (easiest),
2D canvas with its own projection math (moderate), raw WebGL (hardest). Record it.

### The prompt

```text
BENCH-3D-V1. Build ONE self-contained HTML file named bench_world.html.

Hard constraints:
1. Single file, no external resources of any kind: no CDN scripts (no Three.js), no
   fonts, no images, no fetch. Everything inline.
2. Must run in a plain browser with JavaScript enabled, with zero console errors.
3. Use any rendering technique that satisfies rule 1: CSS 3D transforms, a 2D canvas
   with your own projection math, or raw WebGL. Pick whichever you can execute best.

The scene: a small floating island at dusk.
4. Content: a floating landmass with a rocky underside; at least 5 trees (varied in
   size and position, not copies); a pond, stream, or waterfall; at least 3 drifting
   clouds; and one glowing light source (sun, moon, or lantern) that visibly tints
   the scene.
5. Depth: the scene must read as three-dimensional — perspective or parallax, size
   attenuation with distance, and shading or lighting cues. A flat side-view drawing
   scores nothing here.
6. Motion: a continuous animation loop with at least 2 independent motions (for
   example: clouds drift, water moves, the island slowly bobs).
7. Interaction: dragging with the mouse (or the arrow keys) orbits or rotates the
   view. The effect must be obvious.
8. A control that toggles dusk to night and back, smoothly changing the sky, the
   lighting, and the palette (a transition, not a hard swap). Night should feel
   designed, not just darkened.

Design and UI:
9. Define your palette as CSS variables on :root (at least 5) and use them
   consistently in both the UI and the scene.
10. Add a HUD overlay: a name for your world (your choice), a one-line caption, and a
    controls hint. Make the typography deliberate — hierarchy, spacing,
    letter-spacing — nothing that looks like default browser text.
11. The scene fills the viewport with no scrollbars, and holds up at both 1280x800
    and 375x812.
12. The first line inside <body> must be this HTML comment: <!-- BENCH-3D-V1 -->

If you have file tools, write the file to bench_world.html in your working directory.
If not, output the complete file in a single code block.
```

### Rubric (100 pts, judged)

| Area | Pts | What to look for |
|---|---|---|
| Technique | 15 | CSS 3D ≤9, canvas projection ≤13, working WebGL ≤15 — scaled by how well it's executed, not just attempted |
| Scene completeness | 15 | Every req-4 element present and recognizable (island underside, 5 varied trees, water, 3 clouds, tinting light) |
| Depth believability | 20 | Does it read as a 3D place? Perspective, occlusion order, distance scaling, shading direction consistent with the light |
| Motion | 10 | ≥2 independent motions, smooth, no jank at default window size |
| Interaction | 10 | Orbit/rotate works, feels connected to the scene (parallax changes, faces re-sort) |
| Dusk/night toggle | 10 | Smooth transition; night is a designed palette (stars, cool light) not a brightness filter |
| Design/UI | 15 | Palette coherent across HUD+scene, CSS variables actually used, typography deliberate, HUD composed not dumped |
| Robustness | 5 | Zero console errors, no scrollbars, survives a resize |

Judging tips: open devtools console first; drag before reading the HUD (does the world
respond?); toggle night twice (does the transition run both ways?); resize to a phone
viewport. A reference ceiling implementation from authoring time lives outside the repo
(`.tmp/benchv1/bench_world.html` when present) — compare model output against it for
calibration, not as a required bar.

## Versioning and phase 2

- Any change to the prompt, dataset, or checks is a new version (`BENCH-V2`); never
  compare scores across versions.
- This path (`docs/benchmarks/`) is not in `scripts/packaging/github_stage_manifest.json`'s
  include list, so the answer key does not ship to the public repo. Re-check that before
  ever adding it.
- Phase 2 (not built): automate runs in Jenny by pairing CDP agent driving
  (`docs/operations/agent-driving.md`, `window.__jennyAgent.sendPrompt`) with
  `preview_test` for scoring, and consider a `scripts/eval/` suite wrapper.
