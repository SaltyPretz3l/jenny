---
kind: operations-doc
last_reviewed: 2026-10-18
---

# Jenny CLI

`jenny` is an agent-first command on the same runtime as the desktop app. It runs one prompt (or an interactive sitting) against a local engine, with Jenny's tools, sessions and permission policy, and reports a fixed result shape and exit code that scripts and other agents can rely on. It keeps its own profile, separate from the desktop app's, runs local engines only (no cloud engines, no ChatGPT or Codex sign-in) and stores no credentials.

## Where it is

An installed Jenny ships the command in `resources/bin`, next to (not inside) the app:

| Platform | Command |
|---|---|
| Windows (per-user installer) | `%LOCALAPPDATA%\Programs\jenny\resources\bin\jenny.cmd` |
| Linux (deb) | `/opt/Jenny/resources/bin/jenny` |
| macOS (experimental build) | `/Applications/Jenny.app/Contents/Resources/bin/jenny` |

Call it by its full path, or add that `bin` directory to your `PATH`:

- Windows: add `%LOCALAPPDATA%\Programs\jenny\resources\bin` to your user `Path` (System Properties > Environment Variables), then open a new terminal.
- Linux: the desktop app's own launcher is also named `jenny`, so the CLI directory must come first: `export PATH="/opt/Jenny/resources/bin:$PATH"`.
- macOS: `export PATH="/Applications/Jenny.app/Contents/Resources/bin:$PATH"`.
- AppImage: the mount path changes on every launch, so the shim is only usable after `./Jenny-<version>.AppImage --appimage-extract`, at `squashfs-root/resources/bin/jenny`. The deb is the supported Linux route.

Install from the app (Windows): Settings > Profile, data & updates > About & Updates has a "Command-line tool" row showing the installed `bin` path. "Add to PATH" appends that directory to your user `Path` (never the system `Path`) and "Remove from PATH" takes it out again; open a new terminal afterwards. Uninstalling Jenny removes the entry too (an update keeps it). On Linux and macOS the row shows the `export` line above instead, and from a source checkout it points to `npm link`.

The shim runs the installed Jenny executable as Node (`ELECTRON_RUN_AS_NODE=1`) on the CLI inside `resources/app.asar`, so no separate Node install is needed and the CLI always matches the installed app.

From a source checkout, run `node cli/main.js ...` (Node 20 or newer, the repository `.venv` for the sidecar), or `npm link` once to put `jenny` on your `PATH` through the `package.json` `bin` entry.

## Commands

```
jenny [options] [prompt]          one prompt; no prompt on a terminal starts the interactive loop
jenny sessions list [--all] [--limit <n>] [--json]
jenny sessions show <session-id> [--limit <n>] [--json]
jenny sessions rm <session-id> [--json]
jenny config list [--show-origin] [--json]
jenny config get <key> [--json]
jenny config set <key> <value> [--json]   (an empty value removes the key)
jenny mcp serve [run options]
jenny completion bash|zsh|powershell
jenny doctor [--json]
jenny help
```

Hot-path options (`jenny --help` lists all of them):

| Option | Meaning |
|---|---|
| `-p, --print` | Run one prompt non-interactively and exit; the prompt may come from stdin |
| `-c, --continue` / `-r, --resume <id>` | Continue the most recent session, or the given one (`--session-id <id>` is the same as `--resume`) |
| `-m, --model <name>` | Model to use (default: the engine's active model) |
| `--engine <type>` | `ollama` (default), `vllm`, or `openai-compatible` on a loopback address |
| `--output-format <f>` | `text` (default), `json` (the result frame only) or `stream-json` (every frame) |
| `--permission-mode <m>` | `ask` (default) or `plan`; `auto` is refused until it exists |
| `--allowed-tools <ids>` / `--disallowed-tools <ids>` | Tool ids, `tool:action` pairs or simple globs such as `read_*`; comma separated, repeatable |
| `--max-turns`, `--max-output-tokens`, `--max-inference-requests` | Run budgets |
| `--timeout <seconds>` | Cancel the run after this long (default 600) |
| `--cwd <dir>` | Workspace root (default: the current directory) |
| `--profile <dir>` | CLI profile directory |
| `--json` | Machine-readable output for `sessions`, `config`, `doctor` and `-V` |
| `--no-color`, `-V`, `-h` | No colour on stderr; print versions; help |

stdout carries data only and stderr carries diagnostics. A positional prompt and a piped prompt both work: `jenny -p "summarise README.md"` or `type notes.txt | jenny -p`.

## Permissions

Every run has a permission ceiling built from the tools it names. A tool runs without asking only when the run pre-allows it with `--allowed-tools` (or `JENNY_ALLOWED_TOOLS` / `cli.json`); a tool in `--disallowed-tools`, the environment or `cli.json` is refused, and refusals from every layer add up. Anything the run did not name goes to the ask path, and the profile's stored policy can only narrow a run, never widen it.

In print mode and under `mcp serve` nobody is watching, so the ask path is closed: the tool is denied, a question is declined, a plan is not accepted (its text becomes the result), and the turn ends with exit 3. In the interactive loop you are asked: allow once, allow for the rest of this sitting, or deny. Nothing a run decides is saved to the profile. The six desktop-only tools (`delete_file`, `move_file`, `run_command`, `run_temp_script`, `python_execute`, `worktree_delete`) run only when the command line names them exactly; a glob never covers them, and the environment or `cli.json` may not pre-allow them.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | runtime or model error |
| 2 | usage or configuration error |
| 3 | the turn ended on a policy denial |
| 4 | a human decision or input was required |
| 5 | a budget or timeout was reached |
| 6 | the engine or profile is unavailable (retryable) |
| 75 | another Jenny CLI holds the profile (retryable) |
| 130 | interrupted (SIGINT, Ctrl-C) |
| 143 | terminated (SIGTERM) |

A first Ctrl-C or SIGTERM cancels the run cleanly; a second one exits at once.

## Streaming output

`--output-format stream-json` writes one JSON object per line: `init`, then the run's frames (`delta`, `tool_use`, `tool_result`, `decision`, `status` and others), and always exactly one `result` frame last, carrying the subtype, `exit_code`, `session_id`, usage and `permission_denials`. Thinking and tool output frames are opt-in with `--thinking` and `--tool-output`. Every frame has `v`, `kind`, `event_seq`, `run_id` and `session_id`. The frozen schema is `services/cli-host/schemas/cli-v1.json` (contract `cli.v1`): fields are added in later versions, never renamed. The `--json` output of the other commands follows `cli/schemas/commands-v1.json`.

## Serving Jenny to another agent

`jenny mcp serve` is a Model Context Protocol server over stdio with four read-only tools: `jenny_ask` (one turn under the policy fixed at launch; nothing prompts), `jenny_sessions_list`, `jenny_session_read` and `jenny_status`. Run options (`--cwd`, `--model`, `--engine`, `--allowed-tools`, `--profile` and the rest) are fixed when the server starts. The server holds the profile for its whole lifetime, so give it its own `--profile` if you also run `jenny -p` by hand. A client configuration on Windows:

```json
{
  "mcpServers": {
    "jenny": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\jenny\\resources\\bin\\jenny.cmd",
      "args": ["mcp", "serve", "--cwd", "C:\\work\\my-project", "--allowed-tools", "read_file,list_dir"]
    }
  }
}
```

If your client cannot start a `.cmd` file directly, use `"command": "cmd"` with `"/c"` and the path as the first arguments.

## Profile and configuration

The profile defaults to `%APPDATA%\jenny-cli` on Windows and `~/.jenny-cli` elsewhere; `JENNY_PROFILE` or `--profile` points elsewhere. One CLI process holds a profile at a time (another gets exit 75), and the desktop app never opens a CLI profile.

Settings resolve in this order: flags, then the non-secret environment variables (`JENNY_MODEL`, `JENNY_ENGINE`, `JENNY_OUTPUT_FORMAT`, `JENNY_PERMISSION_MODE`, `JENNY_ALLOWED_TOOLS`, `JENNY_DISALLOWED_TOOLS`, `JENNY_TIMEOUT`, `NO_COLOR`), then `<profile>/cli.json`, then the defaults. `jenny config set` writes `cli.json` (keys `model`, `engine`, `output_format`, `permission_mode`, `allowed_tools`, `disallowed_tools`, `timeout_seconds`), and `jenny config list --show-origin` shows which layer set each value. A `cli.json` that is not a small JSON object is a usage error, never ignored.

## jenny doctor

`jenny doctor` (or `--json`) runs read-only checks and exits 0 when all pass, 1 otherwise:

- `node`, `versions`: the Node runtime and the CLI, contract, app and sidecar API versions.
- `runtime`: `source <checkout>` or `packaged <resources directory>`.
- From a source checkout, `sidecar_python` (`JENNY_BACKEND_PYTHON`, else the repository `.venv`) and `sidecar_module` (the `sidecar/` package).
- From an installed copy, `sidecar_binary` instead: the bundled sidecar's manifest, platform and checksum are validated and the binary answers its `--version` probe.
- `workspace`: the `--cwd` directory exists.
- `profile`: the profile can be created and its lock taken (busy means another CLI holds it).
- `engine`, `permissions`: the resolved engine and model, and the run's permission mode and tool lists. The engine is reported, not contacted.

## Known limits

- Windows installed copy: the installed app gives the shim no console input of its own, so the interactive loop opens the terminal's console itself. It needs a terminal on both stdin and stdout: with stdout redirected and no prompt, `jenny` exits 2 with a hint. Print mode, pipes, `mcp serve`, `sessions`, `config`, `doctor`, `completion` and `-V` are unchanged.
- macOS: no Python ships with the app, so the profile lock needs `JENNY_BACKEND_PYTHON` pointing at a Python 3 interpreter. The macOS build is experimental.
- Linux AppImage: extract it first (see above); the deb is the supported route.
- Local engines only: an Ollama `-cloud` model and every cloud engine are refused with exit 2.

See [Building and distribution](../BUILDING.md) for how the command is packaged and [error codes](error-codes.md) for the `CMP-CLI-*` codes in results.
