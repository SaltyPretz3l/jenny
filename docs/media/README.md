---
kind: operations-doc
last_reviewed: 2026-09-07
---

# Demo clips

Short looping clips of the app for the README and other promo material. They are
recorded by the owner-run clip recorder (`scripts/demo/`), not by CI and not by
autonomous agents (it opens a real window).

## What each clip shows

| File | Scene | What you see |
|---|---|---|
| `demo-palette-reel.gif` / `.mp4` | `palette-reel` | A settled chat with a rendered Mermaid diagram, then six of the twelve built-in palettes (dark, light, and the Jenny XJ-9 pair) switched live, with a caption naming each one and the Reactive Grid and Circuit Trace background effects running. |
| `demo-streaming-tools.gif` / `.mp4` | `streaming-tools` | A prompt about a small sample project is typed into the composer and sent: the thinking row streams, the reply streams, `list_dir` and `read_file` run as real tool calls with their results, then the summary lands. |
| `demo-ide-tour.gif` / `.mp4` | `ide-tour` | Switching to the IDE, opening a file from the explorer, Quick Open (Ctrl+P), the git gutter on an uncommitted edit, and the terminal panel. |

## Honesty note

The clips run the app for real (real renderer, real tool loop, real IDE), but
the model behind the streaming and diagram turns is the sidecar's scripted
`replay` engine, not a live language model. The reply text is authored in
`scripts/demo/demo-replay-scripts/*.json`; the tool calls and their results are
genuine. The sample project (`ledger-cli`) is a fixture from
`scripts/demo/demo-fixture.js`, materialized into a throwaway workspace.

A demo-only presentation layer (`scripts/demo/demo-presentation.js`) is injected
for the recording and is not part of the app: the visible cursor and its click
pulse, the caption chips, the palette crossfade, and hiding of the two chrome
pills that only mean something with a live model (the engine lifecycle pill and
the composer model pill). Nothing else in the frame is altered.

## Regenerating (owner-run)

From the repo root, with `npm install` done so `playwright-core` is present and
`ffmpeg` / `ffprobe` on `PATH`:

```bash
npm run demo:record   # three real launches on throwaway profiles; window opens inactive
npm run demo:encode   # frozen-frame check, then GIF (two-pass palette) + MP4 into docs/media/
```

`demo:record` writes `artifacts/demo/<name>.webm` plus a `.meta.json` carrying
the commit SHA, viewport, and timings. `demo:encode` refuses a clip whose frame
count is short, whose unique frames are too few, or whose picture stops changing
well before the end (a fully covered window can stop producing frames), then walks a fixed size ladder until each GIF is under 6 MB.
Leave the window unobstructed while it records. Pass scene ids to either
command to regenerate a subset, e.g. `npm run demo:record -- ide-tour`.

Scene choreography lives in `scripts/demo/demo-scenes.js` (cursor moves, clicks, typed text with a seeded human cadence, captions); the stills harness
is documented in `docs/captures/README.md`.

## Provenance

| Clip | Recorded from commit | Date |
|---|---|---|
| `demo-palette-reel` | working tree of the landing commit (parent `2182c9c8`): includes the Mermaid rendering fixes (async-fence load order, sanitize-hook class stripping, first-change re-theme, cylinder bake-in) and the presentation layer | 2026-09-07 |
| `demo-streaming-tools` | same tree | 2026-09-07 |
| `demo-ide-tour` | same tree | 2026-09-07 |
