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
| `demo-streaming-tools.gif` / `.mp4` | `streaming-tools` | A prompt about a small sample project is typed into the composer and sent: the thinking row streams, the reply streams, `list_dir` and `read_file` run as real tool calls with their results, then the summary lands. |
| `demo-assistant-edit.gif` / `.mp4` | `assistant-edit` | A code change asked for in chat: `read_file` runs on its own, `edit_file` stops at the approval block until the cursor allows it once, the structured diff card lands and is opened, and the reply confirms the change. |
| `demo-calendar-week.gif` / `.mp4` | `calendar-week` | The Home tool from chat: an event and a reminder are written, the week is read back, the reply summarizes it, and the clip ends on the Home agenda with the new entries beside the seeded week. |
| `demo-ide-tour.gif` / `.mp4` | `ide-tour` | Switching to the IDE, opening a file from the explorer with the git gutter on an uncommitted edit, the terminal panel running the sample project's tests, then the chat dock opened beside the editor and a question about the open file answered in place. |
| `demo-palette-reel.gif` / `.mp4` | `palette-reel` | A settled chat with a rendered Mermaid diagram, then six of the twelve built-in palettes (dark, light, and the Jenny XJ-9 pair) switched live, with a caption naming each one and the Reactive Grid and Circuit Trace background effects running. |

## Honesty note

The clips run the app for real (real renderer, real tool loop, real IDE, real
terminal), but the model behind every chat turn is the sidecar's scripted
`replay` engine, not a live language model. The reply text is authored in
`scripts/demo/demo-replay-scripts/*.json` (the calendar script and prompt carry
relative date tokens so "this week" is the recording week); the tool calls,
their results, the approval stop, the diff, the calendar writes, and the test
run in the terminal are genuine. The sample project (`ledger-cli`) is a fixture
from `scripts/demo/demo-fixture.js`, materialized into a throwaway workspace at
`%PUBLIC%\ledger-cli` (a neutral path, since the terminal prompt shows it).

The throwaway profile is seeded (`scripts/demo/demo-profile.js`) with history
so the frame is not empty: eight past chats for the sidebar, written through
the app's own session store from `scripts/demo/demo-sessions.js`; four
calendar events for the recording week; and an always-allow policy for the
`home` tool so the calendar clip's writes do not stop for approval (the edit
clip keeps the default policy, which is why `edit_file` waits).

A demo-only presentation layer (`scripts/demo/demo-presentation.js`) is injected
for the recording and is not part of the app: the visible cursor and its click
pulse, the caption chips, the palette crossfade, the engine lifecycle pill
hidden (it only means something with a live model), and two pins for chrome
the scripted engine cannot drive itself: the titlebar CPU / GPU / VRAM figures
are painted to representative in-use values (the replay engine never touches
the GPU, so the real figures would read idle), and the composer model pill is
relabelled `ornith15 · 9b · Med`, the local model the clips stand in for.
Nothing else in the frame is altered.

## Regenerating (owner-run)

From the repo root, with `npm install` done so `playwright-core` is present and
`ffmpeg` / `ffprobe` on `PATH`:

```bash
npm run demo:record   # five real launches on throwaway profiles; window opens inactive
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
| `demo-streaming-tools` | working tree of the landing commit (parent `e82c0939`): seeded history, pinned telemetry and model label, device scale 1.75 | 2026-09-07 |
| `demo-assistant-edit` | same tree | 2026-09-07 |
| `demo-calendar-week` | same tree | 2026-09-07 |
| `demo-ide-tour` | same tree | 2026-09-07 |
| `demo-palette-reel` | same tree | 2026-09-07 |
