# jenny-launch

A small native Windows executable that replaces the Python "owned-process
bootstrap" child. The sidecar creates a Job Object, starts this program inside
it with three pipes, assigns it to the Job, and only then writes one framed
request to its stdin. The launcher validates the request, starts the real
target (which is therefore born inside the Job), waits, and exits with the
target's exit code. The Python child (`sidecar/_owned_process_bootstrap.py`)
defines the contract and stays as the fallback.

The launcher contains no Job Object code: the parent owns the Job.

## Command line

- `jenny-launch.exe --version` prints `jenny-launch protocol 1` and exits 0.
- `jenny-launch.exe --owned-process-bootstrap` runs the bootstrap below.
- Anything else: one line on stderr, exit 125.
- Non-Windows builds compile, and the bootstrap exits 125 with one stderr line.

## Protocol 1

Request, read from stdin: a 4-byte big-endian length N (1 to 1048576), then N
bytes of UTF-8 JSON with exactly the keys `argv` (non-empty strings array, first
element not empty), `cwd` (string), `env` (null or an object of strings, order
kept) and `input_data_b64` (null or strict standard base64). No string may
contain U+0000. A duplicate key or non-canonical base64 is rejected. Exactly
4 + N bytes are read; end of input is not awaited.

Target: `CreateProcessW` with the `subprocess.list2cmdline` quoting (and the
`cmd /d /s /c <string>` special case taken verbatim), `cwd` as given, `env`
null to inherit or a Unicode block otherwise. The target gets exactly three
inherited handles (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`): stdin is `NUL` or the
read end of a new pipe, stdout and stderr are the launcher's own (`NUL` if it
has none). No new console, process group or breakaway.

Messages (each followed by CRLF, like the Python child) and exit codes:

| Situation | stderr | exit |
|---|---|---|
| bad request | `owned process bootstrap rejected control payload` | 125 |
| `CreateProcessW` or env block fails | `owned process bootstrap target launch failed` | 126 |
| input write fails (not a broken pipe) | `owned process bootstrap target input failed` | 126 |
| target ran | none | the target's 32-bit exit code |

A broken pipe while writing input (target closed or never read stdin) is not an
error. Intended differences from the Python child: duplicate keys and
non-canonical base64 are rejected; exit codes above 2147483647 are mirrored
exactly instead of being collapsed.

## Build and test

Run from this directory so cargo reads `.cargo/config.toml` (static CRT, so no
Visual C++ runtime DLL is needed):

    cargo fmt --check
    cargo clippy --release --all-targets -- -D warnings
    cargo build --release --locked
    cargo test --release

The binary is `target/release/jenny-launch.exe`. Tests cover the request
parser, the command line against vectors produced by running CPython's
`list2cmdline`, and (Windows only) the built binary end to end.

Dependencies: `serde_json`, `base64`, `windows-sys` (no derive macros).
`payload.rs` and `cmdline.rs` are pure; `spawn.rs` and `handles.rs` hold all
the `unsafe` Win32 code, each block with a `// SAFETY:` comment.
