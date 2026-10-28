# The jenny command-line tool

jenny is an agent-first command on the same runtime as the desktop app. It runs one prompt, or an interactive sitting, against a local engine with Jenny's tools, sessions and permission policy. It reports a fixed result shape and an exit code that scripts and other agents can rely on.

It keeps its own profile, separate from the desktop app's. It runs local engines only (no ChatGPT or Codex sign-in, no cloud engines) and stores no credentials. The desktop app never opens a CLI profile.

## Installing and finding it

An installed Jenny ships the command in a bin folder next to the app:

- Windows (per-user installer): %LOCALAPPDATA%\Programs\jenny\resources\bin\jenny.cmd
- Linux (deb): /opt/Jenny/resources/bin/jenny
- macOS (experimental): /Applications/Jenny.app/Contents/Resources/bin/jenny

On Windows, open Settings > Profile, data and updates > About and Updates. The Command-line tool row shows the folder. Add to PATH appends it to your user Path (never the system Path), and Remove from PATH takes it out. Open a new terminal afterwards. Uninstalling Jenny removes the entry. On Linux and macOS the row shows an export line to add to your shell profile; on Linux that directory must come before the desktop launcher also called jenny. The AppImage moves on every launch, so the deb is the supported Linux route. From a source checkout, run npm link or node cli/main.js.

No separate Node install is needed; the shim runs the installed Jenny as Node.

## Commands

- jenny [options] [prompt]: run one prompt. With no prompt on a terminal it starts the interactive loop.
- jenny -p "summarise README.md": print mode. Run one prompt non-interactively and exit. The prompt can come from stdin, for example by piping a file.
- jenny sessions list, show and rm: list, read and remove CLI sessions. Use --all and --limit with list.
- jenny config list, get and set: read and write the CLI settings file; an empty value removes the key. list --show-origin shows which layer set each value.
- jenny mcp serve: serve Jenny to another agent over MCP.
- jenny doctor: run read-only checks.
- jenny completion bash, zsh or powershell: shell completion.
- jenny help, jenny -V.

Useful options: -c to continue the most recent session, -r with a session id to resume one, -m for the model, --engine (ollama by default, vllm, or openai-compatible on a loopback address), --output-format (text, json or stream-json), --permission-mode (ask by default, or plan; auto is refused), --allowed-tools and --disallowed-tools, run budgets (--max-turns, --max-output-tokens, --max-inference-requests), --timeout (default 600 seconds), --cwd for the workspace folder (default: the current directory), --profile for a different CLI profile, --json for machine-readable output from sessions, config and doctor, and --no-color. stdout carries data only and stderr carries diagnostics.

## Permissions

Every run has a permission ceiling built from the tools it names. A tool runs without asking only when the run pre-allows it with --allowed-tools (or JENNY_ALLOWED_TOOLS, or the settings file). Anything not named goes to the ask path. A tool named in --disallowed-tools is refused. The profile's stored policy can only narrow a run, never widen it.

- Print mode and mcp serve have nobody watching, so the ask path is closed: the tool is denied, a question is declined, a plan is not accepted, and the turn ends with exit code 3.
- In the interactive loop you are asked: allow once, allow for the rest of this sitting, or deny. Nothing is saved to the profile.
- Six desktop-only tools run only when the command line names them exactly, and a glob never covers them: delete_file, move_file, run_command, run_temp_script, python_execute and worktree_delete.

## Exit codes

0 ok. 1 runtime or model error. 2 usage or configuration error. 3 the turn ended on a policy denial. 4 a human decision or input was required. 5 a budget or timeout was reached. 6 the engine or profile is unavailable (retryable). 75 another Jenny CLI holds the profile (retryable). 130 interrupted (Ctrl-C). 143 terminated (SIGTERM). A first Ctrl-C cancels the run cleanly; a second exits at once.

## Streaming output

--output-format stream-json writes one JSON object per line: an init frame, the run's frames (delta, tool_use, tool_result, decision, status and others), and always exactly one result frame last, carrying the subtype, exit code, session id, usage and permission denials. Thinking and tool output frames are opt-in with --thinking and --tool-output. The format is versioned (contract cli.v1): fields are added in later versions, never renamed.

## Serving Jenny to another agent

jenny mcp serve is an MCP server over stdio with four read-only tools: jenny_ask (one turn under the policy fixed at launch; nothing prompts), jenny_sessions_list, jenny_session_read and jenny_status. Run options such as --cwd, --model, --engine, --allowed-tools and --profile are fixed when the server starts. It holds the profile for its lifetime, so give it its own --profile if you also run jenny -p by hand. In a client's MCP configuration, set the command to the full path of the jenny shim with the arguments mcp serve and your options. If the client cannot start a .cmd file directly on Windows, use cmd with /c and the path as the first arguments.

## Profile and settings

The profile defaults to %APPDATA%\jenny-cli on Windows and ~/.jenny-cli elsewhere; JENNY_PROFILE or --profile points elsewhere. One CLI process holds a profile at a time (another gets exit 75). Settings resolve in this order: flags, then non-secret environment variables (JENNY_MODEL, JENNY_ENGINE, JENNY_OUTPUT_FORMAT, JENNY_PERMISSION_MODE, JENNY_ALLOWED_TOOLS, JENNY_DISALLOWED_TOOLS, JENNY_TIMEOUT, NO_COLOR), then the profile's cli.json, then defaults.

## jenny doctor

jenny doctor (or --json) runs read-only checks and exits 0 when all pass: the Node runtime and versions, whether it is running from source or an installed copy, the sidecar, the workspace folder, whether the profile can be locked (busy means another CLI holds it), and the resolved engine, model and permission mode. The engine is reported, not contacted.

## Known limits

- It cannot attach to a running desktop profile; it has its own profile and its own sessions.
- Windows installed copy: the interactive loop needs a terminal on both stdin and stdout. Print mode, pipes, mcp serve, sessions, config, doctor, completion and -V are unaffected.
- macOS: no Python ships with the app, so the profile lock needs JENNY_BACKEND_PYTHON pointing at a Python 3. The macOS build is experimental.
- Local engines only: an Ollama cloud model or any cloud engine is refused with exit code 2.
