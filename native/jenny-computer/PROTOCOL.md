# jenny-computer wire protocol, version 1

`jenny-computer` is the native helper shared by row 197 (live run view) and row 196 (computer use). One host
in Electron's main process (`services/computer-helper/`) starts it with `--serve` and speaks this protocol on
its stdin and stdout. The Node constants live in `services/computer-helper/protocol.js`; the Rust ones in
`src/protocol.rs`. A change to either changes this document and the protocol number in the same commit.

## Command line

| Arguments | Behaviour |
|---|---|
| `--version` | Prints exactly `jenny-computer protocol 1` and a line feed to stdout, exits 0 |
| `--serve` | Speaks the protocol below until `shutdown` or the end of stdin |
| anything else | One usage line on stderr, exit 125 |

## Framing

- One JSON object per line, UTF-8, ended by a line feed. Empty lines are ignored.
- A request line is at most 64 KiB. A longer line is discarded up to its line feed and answered with a
  `bad_request` error whose `id` is `null`.
- A reply line can be large (a capture is a base64 PNG of at most 2 MiB, so under 3 MiB of text). The host
  accepts lines up to 4 MiB.
- Replies and events are written whole by one writer, so they never interleave inside a line. Replies come
  in request order, except a `run.stop` reply, which comes when its stop is done and can come after the
  replies of later requests; the host matches replies by `id`. Events can come between any two replies. No
  event of a run (`run.window`, `run.window_state`, `run.exited`) comes before that run's `run.start` reply.

## Messages

Request, from the host:

```json
{"id": 7, "op": "run.stop", "run_id": "r1", "close_timeout_ms": 2000}
```

`id` is a whole number from 0 to 2^53 - 1, chosen by the host. `op` is one of the operations below. Every other
key is an argument of that operation. Unknown arguments are ignored.

Reply, from the helper, one per request:

```json
{"id": 7, "ok": true, "result": {"run_id": "r1", "how": "closed", "exit_code": 0}}
{"id": 7, "ok": false, "error": {"code": "no_such_run", "message": "no run with that id"}}
```

Event, from the helper, unasked:

```json
{"event": "run.exited", "run_id": "r1", "exit_code": 0}
```

A message is told apart by its keys: a reply has `id`, an event has `event`. Messages never carry window
titles, paths or command lines in `message` or `log` text; those appear only in the result fields named below.

## Error codes

| Code | Meaning |
|---|---|
| `bad_request` | Not JSON, not an object, a missing or wrong-typed argument, a line over 64 KiB |
| `unknown_op` | `op` is not in this document |
| `not_available` | The helper runs on a system it does not support (everything but Windows); every operation but `hello` and `shutdown` answers this |
| `not_built` | The operation is named here but this build does not have it (the input, watch and program operations in a build without the `input` feature) |
| `refused` | An input operation was refused by the helper's own check; the error also carries `reason` (see "The guard") |
| `no_such_run` | No run with that `run_id` |
| `run_exists` | `run.start` with a `run_id` that is still running |
| `no_such_window` | The window handle does not name a top-level window that exists |
| `start_failed` | The program could not be started (the message says which step, not the path) |
| `capture_failed` | Windows' capture did not return a frame |
| `too_large` | A capture could not be brought under `max_bytes` even at the smallest size |
| `internal` | Anything else; the helper stays up |

## Shapes used below

- **hwnd**: a window handle as a JSON number (Windows handles fit in 32 bits). Electron's capture source for
  the same window is `window:<hwnd in decimal>:0`.
- **rect**: `{"x": int, "y": int, "width": int, "height": int}` in physical screen pixels on the virtual
  desktop (the helper is per-monitor DPI aware, version 2). `x` and `y` can be negative on a second monitor.
- **run_id**: 1 to 64 characters from `A-Z a-z 0-9 _ -`, chosen by the host.

## Operations

### `hello`

Result: `{"protocol": 1, "version": "<crate version>", "platform": "windows" | "linux" | "macos" | ...,
"available": bool, "built": {"windows": bool, "run": bool, "geometry": bool, "capture": bool, "input": bool}}`.
`built` says which parts this build has, so the host can grey out what is missing with a reason.

### `shutdown`

Result `{}`. Then the helper asks every run's window to close, ends each job that is still alive after its
close timeout, and exits 0. The reply of every `run.stop` still in progress is written before the `shutdown`
reply. The end of stdin does the same at once, without the close step: every job is ended, those of stops in
progress too (each job is created with kill-on-close, so a crashed helper ends them too).

### `windows.list`

Arguments: `run_id` (optional). With it, only the top-level windows of processes in that run's job; without
it, every top-level window.

Result: `{"windows": [{"hwnd": hwnd, "pid": int, "title": string, "class": string, "visible": bool,
"cloaked": bool, "tool_window": bool, "bounds": rect}]}`. `bounds` is the drawn bounds (see `window.geometry`).
`class` is the window class (`#32770` for a standard dialog, such as the Open and Save dialogs; row 196 asks the
owner before a program's first one in a chat).

### `window.geometry`

Arguments: `hwnd`.

Result:

```json
{"hwnd": 591824, "window": rect, "bounds": rect, "client": rect,
 "offset": {"left": 1, "top": 31, "right": 1, "bottom": 1},
 "dpi": 96, "scale": 1.0, "minimized": false}
```

- `window`: the window rectangle Windows reports, including the invisible resize borders.
- `bounds`: the drawn bounds (DWM's extended frame bounds), title bar included. This is the rectangle row 196's
  pictures and clicks use.
- `client`: the client area, in screen coordinates.
- `offset`: how far each edge of `client` lies inside `bounds`. The live panel crops a `bounds` picture by it;
  row 196's click ring is drawn through it. Computed each time, never assumed (31 and 1 was one reading at 100
  percent).
- `dpi` and `scale` (`dpi / 96`): the window's monitor.

### `window.show`

Arguments: `hwnd`, `mode`: `"front"` (bring the window forward at full size; the owner's "Show window") or
`"behind"` (send it behind other windows without activating it; "Send behind"). Never minimises.
Result `{}`.

### `run.start`

Arguments: `run_id`, `program` (absolute path of the program file, started directly, never through a shell),
`args` (array of strings), `cwd` (absolute folder), `env` (object of string to string: the whole environment
block; the host builds and filters it).

The helper creates the process suspended, puts it in a new job with kill-on-close, resumes it with "show, do
not activate" in its start-up information, and drains its stdout and stderr into a ring of the last 200 lines
and 16 KiB. It then looks for the run's window every 25 ms: the first top-level window of the job that is
visible, not cloaked, not a tool window and not empty. Once found it stops looking and listens to Windows'
events for that window and to the job's notifications. While that window is hidden or cloaked (a splash screen
that hides instead of closing), it looks for another such window of the job about once a second and follows the
first it finds (`run.window`).

Result: `{"run_id": string, "pid": int}`. Errors: `run_exists`, `bad_request`, `start_failed`.

### `run.close`

Arguments: `run_id`. Asks the run's chosen window to close (posts `WM_CLOSE`) and returns at once, without
waiting and without ending the job. The owner's Stop uses it, so a program that shows its own question ("save
before quitting?") can be answered: if `run.exited` has not come after about two seconds, the host offers
"Show window" or "Force stop" (`run.stop` with `close_timeout_ms` 0). Result: `{"run_id": string, "asked":
bool}`; `asked` is false when the run has no chosen window yet or has already exited (nothing is posted).

### `run.stop`

Arguments: `run_id`, `close_timeout_ms` (0 to 10000, default 2000).

Asks the run's window to close; if a process of the job is still alive after the timeout, ends the job.
Result: `{"run_id": string, "how": "closed" | "ended" | "already_ended", "exit_code": int | null}`. The run's
record is dropped as soon as the request is read: from then on `run.output`, `run.close`, `run.list` and
`windows.list` do not know the run, and `run.start` accepts its `run_id` again. Other requests are answered
while the stop runs, so its reply can come after theirs. A bad request or an unknown `run_id` is answered at
once, in order. The reply comes at most 7.5 s after the close timeout, even when the job will not end, which
fits inside the host's close timeout plus 8 s.

### `run.output`

Arguments: `run_id`, `max_lines` (1 to 200, default 200).

Result: `{"run_id": string, "lines": [string], "dropped_bytes": int}`: the newest lines of the ring, oldest
first, and how many bytes the ring has let go since the start. Works after the run has exited, until
`run.stop` drops it.

### `run.list`

Result: `{"runs": [{"run_id": string, "pid": int, "state": "starting" | "running" | "exited",
"hwnd": hwnd | null, "exit_code": int | null, "pids": [int]}]}`. `pids` are the process ids in the run's job
now, the started program and everything it started that is still alive, including a child whose parent has
already ended; an empty array when none is left or the list cannot be read.

### `capture`

Arguments: `hwnd`, `max_long_edge` (64 to 4096, default 1568), `max_bytes` (65536 to 2097152, default
2097152), `area` (`"bounds"` default, or `"client"`).

One frame of that window with Windows' own capture (`Windows.Graphics.Capture`), no capture border, of the
drawn bounds or cropped to the client area, scaled so its long edge is at most `max_long_edge`, encoded as PNG,
and scaled down further until the PNG fits `max_bytes`.

Result: `{"png_base64": string, "width": int, "height": int, "scale": number, "signature": string}`. `scale`
is picture pixels per screen pixel. `signature` is 16 lowercase hex digits, the 64-bit FNV-1a hash of the
scaled RGBA pixels, so two looks at a still screen give the same signature.

### Input, the owner's watch and program names (row 196)

These operations are built behind the cargo feature `input` (row 196's S1). A build without it answers
`not_built` and says `"input": false` in `hello`. The service decides policy: which program a chat has
granted, which programs are never granted, what the model may do. The helper does the last check itself, at
the moment of input, in the same call that injects, so nothing can change between a check in another
process and the input.

#### The guard: `expect`

Every `input.*` operation but `input.release_all` carries an `expect` object:

```json
{"hwnd": 591824, "program": "C:\\Windows\\System32\\notepad.exe",
 "deny_pids": [4100, 4188, 5012], "deny_programs": ["C:\\Program Files\\Jenny\\Jenny.exe"]}
```

- `hwnd`: the granted window.
- `program`: the full path of the program file the grant names, as `program.identify` answered it.
- `deny_pids`: processes never touched, whatever the grant says. The service puts every process of every
  Jenny instance here. At most 256.
- `deny_programs`: program files never touched (Jenny's own, and the never-granted list). At most 256.

Paths are compared without regard to case, after any `\\?\` prefix is removed. Before it injects, the helper
refuses the input when, checked in this order, one of these holds. The error reply carries the reason:
`{"id": 9, "ok": false, "error": {"code": "refused", "reason": "elevated", "message": "..."}}`.

| `reason` | When |
|---|---|
| `no_watch` | The owner's watch is not running (`watch.start`). No input is ever sent without it |
| `owner_active` | The owner has used the keyboard or mouse since the last `watch.resume`, or pressed the Stop chord |
| `secure_desktop` | The desktop taking input is not the owner's desktop: the lock screen, an elevation prompt, the Ctrl+Alt+Del screen |
| `window_gone` | `expect.hwnd` no longer names a window, or (for every operation but `input.focus`) it is minimised or hidden |
| `outside_window` | A point lies outside the window's picture, or a drag's path leaves it |
| `denied` | The window that would get the input belongs to a process in `deny_pids` or a program in `deny_programs` |
| `elevated` | That window's process runs as administrator, or cannot be opened to ask |
| `unidentified` | That window's program cannot be told (a Store app whose own window cannot be found) |
| `wrong_program` | That window belongs to another program than `expect.program` |
| `password_field` | `input.type` or `input.key` while Windows says the focused field is a password field |
| `refused_chord` | `input.key` with a chord on the never list below |
| `not_front` | `input.focus` asked for the window and it did not come to the front |

"The window that would get the input" is, for a pointer action, the top-level window under each point the
action touches (every step of a drag); for `input.type` and `input.key`, the window in front. A Store app's
frame belongs to the app inside it. A point is never moved to make it pass; the action is refused whole.

An action refused before any input was sent sends nothing. An action stopped part-way (the owner moved the
mouse during a drag, the window changed under a drag's path) releases every key and button it pressed, then
answers `refused` with the reason. No operation returns while holding a key or a button: a key held with
`hold_ms` and a drag's button are let go before the reply. `input.release_all` and every exit (`shutdown`,
the end of stdin, an error, the Stop chord, the owner's input) let go of anything still down.

#### Points

A point is `{"x": int, "y": int}` in pixels of the picture `capture` returned for `expect.hwnd` with `area`
`"bounds"`, and every pointer operation carries that picture's `scale` (0.05 to 4). The helper maps it
against the window's drawn bounds at the moment of input: screen x = bounds.x + round(x / scale), likewise y.
A window that moved since the picture keeps the point where it was in the window. A point must lie inside the
picture (0 to width - 1, 0 to height - 1, the size being the bounds times `scale`), or the action is refused
with `outside_window`.

The pointer moves with `SendInput` to absolute positions on the virtual desktop (so a second monitor at
negative coordinates works); the helper reads the cursor back and puts it on the exact pixel if rounding left
it one off. Keys are sent by hardware scan code, which game engines read; text by character.

#### Operations

| Operation | Arguments | Result |
|---|---|---|
| `program.identify` | `hwnd` | `{"hwnd", "pid", "program": string \| null, "kind": "desktop" \| "store" \| "unknown", "elevated": bool}`. `pid` and `program` are the real program's: for a Store app, the app inside its frame. `program` is null and `kind` `"unknown"` when it cannot be told; the service treats that as not grantable |
| `input.focus` | `expect` | Restores the window if minimised, brings it to the front by attaching to the front window's input thread, and checks that it came. `{"front": true}`, or `refused` with `not_front`. Sends no key or click |
| `input.move` | `expect`, `scale`, `point` | `{"screen": {"x", "y"}}`, the screen pixel the pointer went to |
| `input.click` | `expect`, `scale`, `point`, `button` (`"left"` default, `"right"`, `"middle"`), `count` (1 to 3, default 1), `modifiers` (array of `"shift"`, `"ctrl"`, `"alt"`, default none) | `{"screen": {"x", "y"}}` |
| `input.drag` | `expect`, `scale`, `from`, `to`, `button` (default `"left"`), `modifiers`, `duration_ms` (100 to 2000, default 200) | Presses at `from`, moves in steps of at most 16 ms to `to`, releases. `{"from": {"x", "y"}, "to": {"x", "y"}}` in screen pixels |
| `input.scroll` | `expect`, `scale`, `point`, `dy` (-20 to 20 wheel notches, up is positive, default 0), `dx` (-20 to 20, right is positive, default 0); not both 0 | `{"screen": {"x", "y"}}` |
| `input.type` | `expect`, `text` (1 to 2000 characters) | Each character is sent as itself, never through the clipboard; a line feed is the Enter key and a tab the Tab key; any other control character is a `bad_request`. `{"typed": int}` |
| `input.key` | `expect`, `chord`, `hold_ms` (0 to 2000, default 0) | Presses the chord's modifiers, then its key; holds for `hold_ms`; releases in reverse order. `{}` |
| `input.release_all` | none | Lets go of every key and button this helper holds. `{"released": int}` |
| `watch.start` | `stop_chord` (default `"ctrl+alt+shift+f12"`), `move_px` (8 to 100, default 18), `move_ms` (50 to 1000, default 200) | Starts the owner's watch, or restarts it with new settings. `{"stop_chord_registered": bool}`: false when another program holds that chord, and the service says so |
| `watch.stop` | none | Stops the watch and unregisters the Stop chord. `{}` |
| `watch.resume` | none | Clears the owner's-input latch, so input is allowed again. `{}` |
| `watch.state` | none | `{"running": bool, "paused": bool, "last_real_input_ms": int \| null, "stop_chord_registered": bool}`. `last_real_input_ms` is how long ago the owner last pressed a key, pressed a button or moved the mouse (any movement, not only past the threshold); the unattended pause and the away digest read it while a computer turn is live, because Windows' own idle time counts injected input |

A **chord** is lowercase names joined by `+`: zero or more of `ctrl`, `shift`, `alt`, then exactly one key:
`a` to `z`, `0` to `9`, `f1` to `f12`, `enter`, `esc`, `tab`, `space`, `backspace`, `delete`, `insert`,
`home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `minus`, `equals`, `comma`, `period`,
`slash`, `semicolon`, `quote`, `backquote`, `bracketleft`, `bracketright`, `backslash`. Anything else is a
`bad_request`; there is no name for the Windows key. A `stop_chord` needs at least two modifiers, so no key a
program uses on its own can be it.

The **never list** (`refused_chord`), matched whatever other modifiers are added: `ctrl+esc`, `alt+tab`,
`alt+esc`, `alt+space`, `alt+f4`, `ctrl+alt+delete`, `ctrl+v`, `shift+insert`, and the Stop chord in use.
Switching windows is `input.focus`; a program is closed from its own menu; paste is never sent.

#### The owner's watch

`watch.start` starts one thread that does nothing but hold low-level keyboard and mouse hooks and the Stop
chord (registered with Windows, so it fires even with an administrator's window in front). Input marked as
injected is not the owner's. The **latch** is set by a real key press, a real button press, real movement of
at least `move_px` within `move_ms`, or the Stop chord, and stays set until `watch.resume`. While it is set
every input operation answers `refused` with `owner_active`, and an action in progress stops at its next step.

| Event | Fields | When |
|---|---|---|
| `watch.owner_input` | `kind`: `"key"`, `"button"` (a wheel turn included) or `"move"` | The latch went from clear to set by the owner's input (once per setting) |
| `watch.stop_chord` | none | The Stop chord was pressed (every time; it also sets the latch) |

## Events

| Event | Fields | When |
|---|---|---|
| `run.window` | `run_id`, `hwnd`, `source_id` | The run's window was chosen, or replaced after the first one closed (a splash screen, then the real window) |
| `run.window_state` | `run_id`, `hwnd`, `state`: `"minimized"`, `"restored"`, `"moved"`, `"destroyed"` | Windows reports the change |
| `run.exited` | `run_id`, `exit_code` (int or null) | The job's last process ended |
| `log` | `level` (`"info"`, `"warn"`, `"error"`), `message` | Helper diagnostics; no titles, paths or command lines |
