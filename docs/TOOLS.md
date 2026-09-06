# Built-in Tools Reference

This document describes the tools Jenny can call. The canonical descriptors live in [`services/tools/tool-manifest.json`](../services/tools/tool-manifest.json) (Electron-owned manifest, manifest schema v2) and [`sidecar/ai/tools/`](../sidecar/ai/tools/) (sidecar-owned implementations); this reference is the human-facing summary. Tool input schemas come solely from the manifest via `sidecar/ai/tools/catalog.py` — the sidecar builtin modules no longer carry their own legacy schema constants.

Tools are grouped by family below. Jump to the relevant section when you need to know what a tool does, when Jenny will call it, what approval and security surface it carries, and where its source lives.

## Tool families

| Guide | Tools | Approval | Notes |
|---|---|---|---|
| [Filesystem](#filesystem) | `read_file`, `write_file`, `edit_file`, `glob_files`, `list_dir`, `grep_search` | Mutations require approval; reads are read-only | Workspace root must be set; mutations require a matching `read_file` snapshot |
| [Git](#git) | `git_status`, `git_log`, `git_diff`, `git_show` | Read-only | All four are bounded read-only views into a git repo within the workspace |
| [Web](#web) | `web_search`, `fetch_url` | Read-only with SSRF guards | Off by default; gated by the `web` config toggle |
| [Python runtime](#python) | `python_execute` | Approval required | Off by default; sandboxed (Job Object on Windows; rlimits on POSIX); Windows-only currently |
| [Shell](#shell) | `run_command`, `run_temp_script`, `check_background_job`, `stop_background_job` | Approval required for execution/stop; status readback is read-only | Off by default; fail-closed shell classifier and owned process-tree lifecycle |
| [Artifacts](#artifacts) | `create_artifact`, `mermaid_generate` | `create_artifact` requires approval; `mermaid_generate` is read-only | Artifacts live under `.jenny/artifacts` for the session; Mermaid renders as an inline chat chart plus a reusable `.mmd` artifact |
| [Todo](#todo) | `todo_write`, `todo_read` | Read-only / in-session state | Off by default; gated by the `todo` config toggle |
| [Diagnostics](#diagnostics) | `jenny_status`, `tool_search` | Read-only | Runtime status and deferred-tool discovery; not for source-code questions |
| [Connections](#connections) | `connections_list` | Read-only | On by default; reports configured remote surfaces without probing the network or exposing secrets |
| [Distillation](#distill) | `run_command` output mode | Existing command approval | Off by default; errors-first compression with `read_file` recovery from a persisted complete capture |
| [Knowledge](#knowledge) | `knowledge_search`, `knowledge_view`, `knowledge_exec` | Read-only | Off by default; gated by `tools_knowledge_enabled`; deterministic grep/read over user-registered folders — no index, no embeddings |
| [Home](#home) | `home`, `task_board` | Writes are auto; `home` deletes need a `confirm` round-trip | On by default; gated by `tools_home_enabled` / `tools_task_board_enabled`; `home` covers the Home calendar, reminders, and a read-only scratchpad view; `task_board` adds durable, identity-addressed `add`/`update`/`complete`/`list` tasks into the same persisted Open Loops store, badged `agent_task`, and requires the model to complete a task when its tracked work is finished |
| [Skills](#skills) | `load_skill` | Read-only | On by default; gated by `tools_load_skill_enabled`; reads a bundled/user/project skill's `SKILL.md` body by name+scope — the only tool that can reach skill scope roots outside the tools workspace root |
| [Workspace](#workspace) | `workspace_present`, `preview_test`, `verify` | Mixed | `workspace_present` and `preview_test` are read-only and on by default; `workspace_present` asks the IDE to show a preview/File Map/change diff (request, not outcome); `preview_test` loads one workspace HTML file in a hidden network-isolated one-shot sandbox and reports render state and console/page errors; `verify` runs one of the user's own saved Test Runner configurations (side-effecting, default off) |
| [Runtime interaction](#runtime) | `ask_user`, `exit_plan_mode` | `ask_user` waits for answers; `exit_plan_mode` uses plan approval | Electron-owned, workspace-independent turn interaction; the `ask_user` inline card lands in W2-S2 |

## How tool availability works

A tool is available to the model when:

1. Its `availability.config_flag` is `null` or its config flag is enabled in [feature settings](../services/feature-settings-service.js).
2. Its `availability.workspace_required` is `false` or `tools_workspace_root` is set in [shell config](../services/shell-config-state.js). Tools-needing workspace are blocked when no root is chosen — this is intentional fail-closed behavior.
3. The current platform is allowed (some tools, like `python_execute`, are Windows-only today).
4. The current `safety_mode` permits it. `paranoid` mode requires per-call approval for every side-effecting tool; `strict` mode tightens web tool access.

When a tool is filtered out by token budget pressure, `tool_search` can re-expose it on demand — see [Diagnostics](#diagnostics).

## Approval and fingerprinting

Every approval request carries an `ApprovalPlan` fingerprint covering the tool contract, arguments, system prompt, message history, model identity, sampling parameters, remaining iterations, and execution context. If any of these change between request and approval, the user sees a "what changed" prompt before the side-effecting call proceeds. The fingerprint is the security guarantee, not the dialog copy.

For explicit read-only research sub-agents, approval plans extend with a ninth component (`parent_approval_plan_hash`) that anchors the child request to its parent. It does not authorize side effects; research children force `allow_side_effects=false`.

**Saved decisions.** The approval card's *Always allow* persists through [`services/tools/tool-permission-store.js`](../services/tools/tool-permission-store.js): when the approved call names a path target (`path`, else `file_path`) it writes an `auto` rule scoped to that tool **and** that path prefix (`always-allow:<tool>:<hash>`); a call without a path target (`run_command`, `python_execute`, `fetch_url`, ...) flips the whole tool to `auto`. Both evaluators ([`tool-policy-evaluator.js`](../services/tools/tool-policy-evaluator.js) and [`sidecar/ai/tools/policy.py`](../sidecar/ai/tools/policy.py)) honour the `path_prefix` match. Every saved decision is listed under **Settings > Tools > Approval rules**, where *Remove* clears the per-tool policy or deletes the rule so Jenny asks again next time.

**Truncated arguments are never repaired into a side-effecting call.** The healing net ([`sidecar/ai/tools/tool_call_healing.py`](../sidecar/ai/tools/tool_call_healing.py)) can close an unterminated string or an unclosed object the model never finished. Spelling-only repairs (fences, smart quotes, trailing commas) still dispatch, but a call whose arguments needed `closed_string` or `closed_brace` runs only when the tool's declared action is read-only; otherwise [`tool_call_repair_policy.py`](../sidecar/ai/routing/tool_call_repair_policy.py) fails that one call with `CMP-LOOP-0002` and an explanation so the model re-sends complete JSON while its sibling calls still run. An unknown descriptor counts as side-effecting. The vLLM path never heals and is unchanged.

## Handler loading and tool settings

Builtin tool handlers are **resolved lazily, on first invocation**. `build_tool_bindings` in
[`sidecar/ai/tools/registry.py`](../sidecar/ai/tools/registry.py) binds each tool name to a small
proxy from `_lazy_tool_handler(module, handler)`, which imports the handler module the first time
that tool actually runs. Importing the registry therefore no longer pulls the whole handler graph
into the process at startup (219 -> 129 modules; the sidecar server import went 548 -> 533, and
7 of 8 handler modules are no longer resident after it).

Two consequences matter if you are editing these tools:

- **Configuration lives beside the handler, not inside it.** Each `configure_*` entry point and the
  mutable settings container it writes now live in a `*_settings.py` sibling (for example
  `shell_settings.py`), so the registry can apply configuration without importing handlers. The
  container is a **single shared mutable object** — handlers import the container and read through
  it at call time. Never import a scalar out of it at module import time and never rebind it, or
  `configure_*` will silently stop taking effect.
- **The lazy target is a (module, handler) string pair.** A typo would surface when a user runs the
  tool rather than at import.
  [`tests/sidecar/ai/tools/test_lazy_tool_bindings.py`](../tests/sidecar/ai/tools/test_lazy_tool_bindings.py)
  forces every binding to resolve so that stays a build failure, and
  `KNOWN_DYNAMIC_ENTRYPOINT_IMPORTS` in `scripts/checks/check_sidecar_reachability.py` records the
  dynamic edges so the reachability gate still walks these modules.

## Source pointers

- Electron-side tool registry: [`services/tools/tool-registry.js`](../services/tools/tool-registry.js), [`services/tools/tool-manifest.json`](../services/tools/tool-manifest.json).
- Sidecar-side tool catalog: [`sidecar/ai/tools/catalog.py`](../sidecar/ai/tools/catalog.py).
- Shared filesystem mutation state and diff metadata helpers: [`sidecar/ai/tools/builtins/file_state.py`](../sidecar/ai/tools/builtins/file_state.py).
- Pre-change snapshot capture for Workspace IDE side-by-side diffs: [`sidecar/ai/tools/builtins/pre_change_snapshot.py`](../sidecar/ai/tools/builtins/pre_change_snapshot.py).
- LSP workspace/file URI containment helpers: [`sidecar/ai/tools/builtins/lsp/paths.py`](../sidecar/ai/tools/builtins/lsp/paths.py).
- Built-in MCP server (exposes Electron-owned tools to MCP clients): [`sidecar/ai/mcp/builtin_server.py`](../sidecar/ai/mcp/builtin_server.py).
- Builtin MCP snapshot leases: [`sidecar/ai/mcp/builtin_snapshot_leases.py`](../sidecar/ai/mcp/builtin_snapshot_leases.py) retains bounded full-read capabilities per server generation/session/workspace without persisting file content.
- Approval plan fingerprint: [`sidecar/runtime/approval_plan.py`](../sidecar/runtime/approval_plan.py).
- Sanitization pipeline (tool outputs and arguments): [`sidecar/ai/tools/sanitization.py`](../sidecar/ai/tools/sanitization.py); see [docs/SECURITY_MODEL.md](SECURITY_MODEL.md).
- Concurrency model and cancellation: docs/operations/CONCURRENCY_MODEL.md.

## Contents

- [Filesystem](#filesystem)
- [Shell](#shell)
- [Python](#python)
- [Git](#git)
- [Web](#web)
- [Artifacts](#artifacts)
- [Knowledge](#knowledge)
- [Workspace](#workspace)
- [Runtime](#runtime)
- [Diagnostics](#diagnostics)
- [Connections](#connections)
- [Distill](#distill)
- [Home](#home)
- [Skills](#skills)
- [Todo](#todo)

## Filesystem

Seven tools for reading, modifying, and deleting files inside the workspace root. All filesystem tools require `tools_workspace_root` to be set; without it they are blocked fail-closed.

`write_file` requires a matching read snapshot. The model must call `read_file` (full read, no `offset`/`limit`) on the target before overwriting — the snapshot's size, mtime, and SHA-256 are recorded and matched at write time, so it cannot clobber a file it never read. Overwriting is a full-content replacement with no per-edit anchor, so the snapshot is the only stale-write guard and stays mandatory. The recorded snapshot is applied automatically from that in-conversation read (resolved through the same `path`/`file_path` aliases the mutation tools accept), so the model does **not** pass `expected_read_snapshot` itself.

Builtin MCP reads also receive an opaque, eight-hour process-local `snap_*` lease. Full bytes remain backend-retained for snapshot validation even when model-visible output is truncated; `snapshot_scope`, `write_eligible`, and `content_display_truncated` are independent metadata. Partial reads never authorize writes. Leases are scoped to the MCP generation, managed Jenny session, and workspace path, capped at 512 entries, and invalidated by successful mutations.

`edit_file` treats the read snapshot as **optional**. Its `old_string` must uniquely match the current file, which is itself a stale-write guard: when a snapshot is present (auto-injected from a prior full `read_file`) it still runs the strong size/mtime/SHA-256 check, but when none is available — the file was never read, or a preceding `write_file`/`edit_file` invalidated the cached snapshot — the edit is anchored to the freshly re-read content instead of hard-failing. This is what makes the tool usable by local models that do not reliably read-before-edit. A genuinely stale edit — where `old_string` no longer matches, or matches ambiguously — still fails with an actionable no-match / ambiguous-match error rather than silently clobbering newer content; concurrent writers that changed a *different* region are preserved because the tool applies to current content. Fallback applications are observable: successful results carry `metadata.read_snapshot_validated` (`true` when the snapshot check ran, `false` on the content-anchored path) and emit an `ai.tools.edit_file.content_anchored_apply` event.

Successful changed `write_file` and `edit_file` results include additive `metadata.diff` V1 data with bounded summary fields, hashes, truncation state, and inline hunks when the diff fits the configured caps. Hunk lines follow unified-diff conventions, including the `\ No newline at end of file` marker after any final line lacking a trailing newline (added, removed, or unchanged context alike) so renderers can reconstruct either side byte-exactly. If diff generation fails, the file mutation still succeeds, `metadata.diff.review_state` is `failed`, and `metadata.warnings[]` includes `diff_generation_failed`.

**Encoding contract (strict BOM-free UTF-8, 2026-07-11):** `read_file` and every existing-file text mutation (`write_file`, `edit_file`, and `apply_patch` update) require valid UTF-8 without a byte-order mark. cp1252/Latin-1, UTF-16/32, UTF-8 BOM, mixed encodings, malformed/truncated multibyte sequences, and binary content fail closed with zero bytes changed. Paginated reads validate the complete byte stream incrementally, including bytes outside the selected window, while preserving valid codepoints split across I/O chunks. `apply_patch` delete remains byte-oriented and may delete a non-UTF-8 file because it never re-encodes the preimage. Rollback uses a conditional atomic replacement: if the current postimage or parent/leaf identity changed, Jenny preserves the external state and reports that path as uncertain.

### `read_file` (alias `Read`)

Read the contents of a file.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Notes:** PDF page selection (`pages: "1-3,5"`) is feature-gated behind the `imageRead` config toggle. Default is text only.
- **Errors:** written for model recovery — a missing path reports `path does not exist: <path>` and points at `list_dir`/`glob_files`; a directory path reports `path is a directory, not a file: <path>` and points at `list_dir`. Unknown tool names get the per-request available-tool list appended to the error observation.
- **Parameters:** `path` (required), `offset` (line number), `limit` (max lines), `pages` (PDF range, when enabled).
- **Source:** [`sidecar/ai/tools/builtins/filesystem_content.py`](../sidecar/ai/tools/builtins/filesystem_content.py).

### `write_file` (alias `Write`)

Write UTF-8 content to a file, creating it if necessary. Overwriting requires a matching `read_file` snapshot from a full read.

- **Approval:** required.
- **Side-effecting:** yes.
- **Workspace required:** yes.
- **Notes:** Ordinary file tools refuse reserved `.jenny` state — the check runs on the resolved workspace-relative path, case-insensitively (`.JENNY/x`, `./.jenny/x` and absolute paths into the store are all refused with `CMP_TOOL_INVALID_PATH`), and it runs before the read-snapshot precondition, so an existing `.jenny` file is refused as reserved rather than as "not read". Use [`create_artifact`](#create_artifact-alias-createartifact) for session artifacts. Accepts both `path`/`content` and legacy `file_path`/`file_content` aliases. Changed writes attach bounded structured diff metadata.
- **Parameters:** `path` and `content` (or aliases) required. Overwriting an existing file requires a prior full `read_file`; the resulting `expected_read_snapshot` is injected automatically, so the model should not set it manually.
- **Source:** [`sidecar/ai/tools/builtins/filesystem_content.py`](../sidecar/ai/tools/builtins/filesystem_content.py).

### `edit_file` (alias `Edit`)

Apply a targeted search-and-replace edit to an existing file. A prior `read_file` snapshot is **optional** — see the mutation note at the top of this section for how the content-anchored fallback keeps stale-write protection.

- **Approval:** required.
- **Side-effecting:** yes.
- **Workspace required:** yes.
- **Notes:** Gated by `tools_edit_file_enabled`. The `old_string` must be unique unless `replace_all: true` is set explicitly. Match preserves indentation; do not include the line-number prefix from `read_file` output in `old_string`. Changed edits attach bounded structured diff metadata.
- **No-match recovery:** when `old_string` is not found, the error reports the bounded longest matching prefix, escaped first-difference context, CRLF/LF-only diagnosis, whitespace-only matches, and a bounded line-numbered closest region. The message is assembled by `file_state.build_no_match_message`, which delegates to [`edit_hints.py`](../sidecar/ai/tools/builtins/edit_hints.py).
- **Parameters:** `file_path`, `old_string`, `new_string` required; `replace_all` optional. A full `read_file` snapshot is injected automatically when one is available (and still enforced strictly then), but is **not** required — the edit applies as long as `old_string` uniquely matches the current file. The model should not set `expected_read_snapshot` itself.
- **Source:** [`sidecar/ai/tools/builtins/edit_file.py`](../sidecar/ai/tools/builtins/edit_file.py).

### `delete_file` (alias `Delete`)

Delete a workspace file or directory. The target is moved to `.jenny/trash/<timestamp>/` (reversible) rather than permanently erased.

- **Approval:** required.
- **Side-effecting:** yes.
- **Workspace required:** yes.
- **Notes:** Gated by `tools_delete_file_enabled` (default on). Refuses the workspace root and anything under `.jenny/`; deleting a directory requires `recursive: true`. Recovery is moving the target back out of `.jenny/trash`. Accepts the legacy `file_path` alias. Safer than `apply_patch`'s hard unlink or a shell `rm`.
- **Parameters:** `path` (required); `recursive` (required to delete a directory).
- **Source:** [`sidecar/ai/tools/builtins/delete_file.py`](../sidecar/ai/tools/builtins/delete_file.py).

### `move_file`

Move or rename workspace files and directories in a validated batch.

- **Approval:** required.
- **Side-effecting:** yes.
- **Workspace required:** yes.
- **Notes:** Gated by `tools_move_file_enabled` (default on). Accepts 1-100 source/destination pairs and validates the complete batch before moving anything. Missing destination parents are created. Existing destinations are refused unless `overwrite: true`; overwritten files are checkpointed under `.jenny/backups` first. Existing directory destinations and cross-volume moves are always refused. Sources and destinations under `.jenny`, self-nesting directory moves, duplicate or chained paths, and same-path moves are refused. A race after validation stops the batch and reports every moved and unmoved entry without attempting rollback; an interrupted batch may leave empty destination directories. Successful file and directory moves attach plural bounded structured rename metadata with the original path recorded as `old_path`.
- **Parameters:** `moves` (required non-empty array of `{source, destination}` objects, maximum 100); `overwrite` (optional, default false). A single top-level `source` and `destination` pair is also accepted; the batch and single-pair forms cannot be combined.
- **Source:** [`sidecar/ai/tools/builtins/move_file.py`](../sidecar/ai/tools/builtins/move_file.py).

### `glob_files` (alias `Glob`)

Find files matching a glob pattern.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Notes:** Gated by `tools_glob_enabled`. Returns up to 100 results sorted by modification time (newest first). The scan itself is bounded — at most 10,000 files or 2 seconds, whichever comes first — and the output states which limit truncated it (`result_limit`, `scan_limit`, or `time_budget`) so a partial listing is never mistaken for a complete one.
- **Parameters:** `pattern` (required), `path` (search root, defaults to workspace root).
- **Source:** [`sidecar/ai/tools/builtins/glob_files.py`](../sidecar/ai/tools/builtins/glob_files.py).

### `list_dir`

List directory contents.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Notes:** Files include a binary human-readable size column (`[F] name  4.2K`); `?` marks a file whose size could not be read, while directories have no size column. Listings scan at most 10,000 entries, retain at most 500, and emit at most 14,000 entry characters. `total_size_bytes` sums only listed files with known sizes; `size_unknown_entries` is present only when at least one listed file had an unreadable size, so a short total is never silent. The size column costs roughly eight characters per file, so a large directory reaches the 14,000-character budget sooner than it did without sizes (measured: ~370 to ~316 visible entries on a 1,393-entry tree); the truncation is always reported via `truncated` and `truncation_reason`.
- **Parameters:** `path` (defaults to workspace root).
- **Source:** [`sidecar/ai/tools/builtins/filesystem_listing.py`](../sidecar/ai/tools/builtins/filesystem_listing.py).

### `grep_search` (alias `Grep`)

Search file contents using a regular expression.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Notes:** Gated by `tools_grep_enabled`. Bounded by `max_results` (≤500), `context_lines` (≤10), and a total runtime budget. Incomplete scans return matches collected so far plus `scan_complete: false`, scanned/candidate counts, searched root, and a narrowing hint; an incomplete zero-match scan is never presented as “no matches.” Matching runs in a reusable subprocess worker with separate startup and per-file regex budgets.
- **Parameters:** `pattern` (required), `path`, `include_glob`, `ignore_case`, `context_lines`, `max_results`.
- **Source:** [`sidecar/ai/tools/builtins/grep_search.py`](../sidecar/ai/tools/builtins/grep_search.py) owns tool orchestration and the isolated worker protocol; [`grep_search_file.py`](../sidecar/ai/tools/builtins/grep_search_file.py) owns bounded file scanning and output rendering.

### Security notes

- Real-path validation prevents symlink and junction escape outside the workspace root. Lexical-path checks alone are not enough; the workspace boundary check resolves real paths.
- Tool outputs are sanitized through [`sidecar/ai/tools/sanitization.py`](../sidecar/ai/tools/sanitization.py) before returning to the model — prompt-injection patterns in file contents are filtered.
- Read paths cannot escape the workspace root even via traversal (`../`).
- Checkpoint results identify snapshots by workspace-relative, versioned display paths only — no absolute filesystem paths leave the checkpoint layer.

## Shell

Four tools for running scripts/commands and inspecting or stopping background commands. Off by default and tightly bounded behind a fail-closed classifier.

### `run_command` (alias `Bash`)

Run a shell command from within the workspace root.

- **Approval:** required (side-effecting).
- **Side-effecting:** yes.
- **Workspace required:** yes.
- **Gated by:** `tools_shell_enabled` (off by default).
- **Notes:** Default timeout 10s, max 600s. `run_in_background: true` returns a `job_id` that `check_background_job` polls and `stop_background_job` can terminate. The tool result's metadata also carries the spawned PID (`background_job_pid`) over the trusted sidecar channel; Electron's background-job tracker binds its kill authority to that registration-time PID only — the workspace-writable `status.json` is display-only status and can never retarget a kill. Every foreground and background child is owned by the shared process service: POSIX process groups or Windows Job Objects contain descendants, timeout/abort/shutdown terminate the owned tree, stdout and stderr drain concurrently under a 4 MiB aggregate capture budget, and additive byte counters disclose discarded overflow. Windows termination also runs a PID-lineage tree-kill backstop before closing the Job Object so descendants that did not inherit Job membership are still reclaimed. At most four background jobs may be active or starting at once. The advertised command string is executed whole by the platform shell — `cmd.exe /d /s /c` on Windows, `/bin/sh -c` on POSIX — resolved through `PATH` before the owned process starts, so a missing interpreter fails closed with `CMP_TOOL_IO_FAILED` rather than at spawn time. Handing the shell the intact string is what makes pipes, redirection, and quoted executable paths with spaces (for example `"C:\Program Files\Python311\python.exe" script.py`) behave as written; it also means the classifier — not an argv split — is the layer that must see every command in a compound chain. On Windows the owned process also inherits a PATH guaranteed to contain `%SystemRoot%\System32\WindowsPowerShell1.0`: that directory is a PATH entry separate from `System32`, so a launcher that trims PATH could leave `cmd.exe` resolvable while `powershell` was not, failing an otherwise valid command on a Windows-first app. The entry is appended only when it is real and not already present, so a host with its own ordering is left untouched.
- **Parameters:** `command` (required), `cwd`, `timeout_seconds`, `run_in_background`, `expected_exit_codes`.
- **Failure contract:** a failing command carries `CMP_TOOL_EXECUTION_FAILED` (`CMP-TOOL-0008`) like every other tool failure, so the model and the error surfaces never see a failure without a code. When the shell's own stderr says the executable was not recognized (`'x' is not recognized...` on `cmd.exe`, `x: command not found` on POSIX), the payload gains a `hint` naming the resolved absolute path when one exists — and the canonical `powershell.exe` location as a special case — instead of leaving the model to guess a path and burn a turn announcing the retry.
- **Source:** [`sidecar/ai/tools/builtins/shell.py`](../sidecar/ai/tools/builtins/shell.py); shared owner at [`owned_process.py`](../sidecar/ai/tools/builtins/owned_process.py) with Win32 containment in [`sidecar/runtime/process_job.py`](../sidecar/runtime/process_job.py) — re-exported through [`owned_process_windows.py`](../sidecar/ai/tools/builtins/owned_process_windows.py), which stays this transport's single import site — and the child-side bootstrap in [`_owned_process_bootstrap.py`](../sidecar/_owned_process_bootstrap.py); classifier at [`shell_security.py`](../sidecar/ai/tools/builtins/shell_security.py) with platform separator grammar in [`shell_command_split.py`](../sidecar/ai/tools/builtins/shell_command_split.py).
- **Windows spawn path:** each owned process is launched by first spawning a small bootstrap child into the Job Object and only then releasing the real target argv to it over stdin, so a target can never start outside its containment. That bootstrap child is re-entered as a fresh interpreter on every spawn, so it is deliberately kept stdlib-only in [`sidecar/_owned_process_bootstrap.py`](../sidecar/_owned_process_bootstrap.py) rather than living under `builtins/` — importing the tool package there charged every git subprocess a full tool-runtime import and silently starved the sub-second git budgets in `repo_delta` and `workspace_manifest`. Gated by `tests/sidecar/test_owned_process_bootstrap_import_cost.py`. The Job Object wrapper itself was moved to the dependency-free `sidecar/runtime/process_job.py` leaf when image-gen provisioning needed the same containment for its `pip`/`venv`/download trees — a second ctypes copy would have been a third implementation in this repo, and handle widths and assignment-failure handling are exactly where duplicates drift into correctness bugs. That leaf is now the repo's ONLY Job Object (2026-07-31): `sidecar/runtime/subprocess_manager.py` had kept a private `_WindowsJobObject` with UNPINNED `restype`s - the exact defect `process_job.py` exists to prevent, since an unpinned `restype` defaults to C `int` and truncates a 64-bit `HANDLE` into a job that reports success and contains nothing. That copy is deleted; the manager and its two other importers (the codex-CLI engine transport, the LSP transport in [`lsp/protocol.py`](../sidecar/ai/tools/builtins/lsp/protocol.py)) all take `WindowsJobObject` from `process_job.py` now.

### `run_temp_script`

Run multi-line platform shell content through the same approval, classifier, cancellation, output bounds, and owned-process containment as `run_command`, without creating repository scratch files.

- **Approval / side effects:** required; side-effecting.
- **Runtime:** writes an exclusive `.cmd` (Windows) or `.sh` (POSIX) in an OS temporary directory outside the repository, invokes it with `cmd.exe` or `/bin/sh`, and removes the directory in `finally`.
- **Privacy:** the temporary path is never returned. Cleanup failure emits bounded warning metadata without changing the completed process result.
- **Parameters:** `script` (required), workspace-contained `cwd`, `timeout_seconds`, `expected_exit_codes`, optional `language` (`python`, `powershell`, `cmd`, `sh`, …). Background mode is intentionally unsupported.
- **Language sniff:** when `language` is omitted the script would run as `cmd`/`sh`, so a body that obviously is Python (`import`/`from`/`def`/`print(` lines), JavaScript (`const|let|var … =`, `console.log(`, `require(`), or PowerShell (`$var =`, `Write-Host`/`Write-Output`) is refused with `CMP_TOOL_COERCED_ARGS_REJECTED` and told which `language` to pass (a real shell script that trips the sniff passes `language: cmd` or `sh` explicitly). An explicit `language` always wins; nothing is written or executed on refusal.
- **Gated by:** `tools_shell_enabled` and the Bash composer preference.
- **Source:** [`sidecar/ai/tools/builtins/temp_script.py`](../sidecar/ai/tools/builtins/temp_script.py).

### `check_background_job`

`job_id` must be the exact 12-character lowercase hexadecimal identifier returned
by `run_command`; whitespace-padded, malformed, or oversized values are refused.
Status files use bounded schema version 1. Missing-version status from older
releases remains readable through the strict legacy codec; malformed, future,
duplicate-field, oversized, or identity-mismatched payloads fail closed with a
bounded reason code and never echo untrusted status content.

Check status and output of a background shell job.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Gated by:** `tools_shell_enabled`.
- **Parameters:** `job_id` (returned by `run_command` with `run_in_background: true`).
- **Job-ID contract (2026-07-10, WIDE-011):** `job_id` must be exactly 12 lowercase hex characters (the format `run_command` mints); anything else is refused before any path is assembled, closing traversal/absolute/UNC/separator escapes. The job directory is revalidated against symlink/reparse redirection (a redirected directory reads as `not_found`), `status.json` reads are capped at 256 KiB, and a non-object or malformed status body is a typed "corrupt" result rather than a crash.
- **Lifecycle contract (2026-07-11, WIDE-015/WIDE-041):** initial status-publication failure synchronously terminates and removes the spawned process before returning a typed refusal. Terminal status-publication failure preserves the validated result in a bounded 64-entry in-memory fallback, while an old unowned `running` record is reconciled to `failed` after restart rather than remaining permanently live.
- **Source:** [`sidecar/ai/tools/builtins/shell.py`](../sidecar/ai/tools/builtins/shell.py) and [`shell_background.py`](../sidecar/ai/tools/builtins/shell_background.py).

### `stop_background_job`

Stop a background shell job owned by the current workspace and return its terminal status. The request reaches the same owned-process cancellation event used by timeout and turn cancellation, so descendants are terminated through the existing process-group or Windows Job Object boundary. Repeating the call after terminal settlement safely returns the recorded status without signaling another process.

- **Approval:** required (side-effecting).
- **Side-effecting:** yes.
- **Workspace required:** yes.
- **Gated by:** `tools_shell_enabled` and the Bash composer preference.
- **Parameters:** `job_id` (returned by `run_command` with `run_in_background: true`).
- **Ownership contract:** only an active job registered under the current canonical workspace root may be signaled. A job id from another workspace or a stale unowned `running` record fails closed; terminal jobs are idempotent readback.
- **Source:** [`sidecar/ai/tools/builtins/shell.py`](../sidecar/ai/tools/builtins/shell.py) and [`shell_background.py`](../sidecar/ai/tools/builtins/shell_background.py).

### Shell classifier

Every command is parsed by the fail-closed classifier in [`shell_security.py`](../sidecar/ai/tools/builtins/shell_security.py) before execution. Because the whole command string reaches a real shell, the classifier — not an argv split — is what stops a safe-looking leader from smuggling a riskier tail. Compound splitting therefore models the *active platform's* grammar in [`shell_command_split.py`](../sidecar/ai/tools/builtins/shell_command_split.py): `cmd.exe` treats a lone `&` and CR/LF as separators, escapes with caret, and gives single quotes no grouping meaning, while POSIX shells honour both quote styles and escape with backslash. Every segment is classified independently and the most restrictive verdict wins. The classifier rejects:

- Pipe-to-shell patterns (`curl ... | sh`, `wget ... | bash`).
- Encoded payloads (base64, hex, urlencode in suspicious positions).
- Blocked-pattern regex (privilege escalation, system modification, recursion bombs).
- Ambiguous `git` subcommands (`git checkout`, `git fetch`) without explicit approval.

Approval-required even with `tools_shell_enabled` on:

- False-safe interpreters (`python`, `node`, `ruby`, `perl`) — these can shell out arbitrarily.
- Package managers (`pip`, `npm`, `cargo`, `gem`) — these can run install hooks.
- Compilers (`gcc`, `clang`, `rustc`) — long-running, can produce executables.
- Fetchers (`curl`, `wget`, `Invoke-WebRequest`) — outbound network.
- Stream redirectors (`tee`, `patch`) — can write outside expected paths.

### Safety modes

- `normal` — shell runs under the classifier above.
- `strict` — same as normal, plus tighter web-tool blocking (separate from shell).
- `paranoid` — every shell call requires per-call approval, even for previously-approved patterns.

### Security notes

- The classifier is intentionally false-safe: when in doubt, require approval. False positives are preferable to false negatives.
- Output is bounded before response assembly; byte counters report captured and discarded totals, and any persisted overflow uses the guarded workspace store.
- Process ownership is shared across shell and read-only Git calls. Active and queued work are capped, both pipes are drained incrementally, and cleanup owns descendants through `atexit`, timeout, abort, and shutdown.
- Approval-plan fingerprint includes the full command string and `cwd`, so command edits between request and approval re-prompt.

## Python

A sandboxed local Python execution surface for data analysis, calculations, and visualization. Off by default and currently Windows-only.

### `python_execute`

Execute Python code in a sandboxed subprocess.

- **Approval:** required (side-effecting).
- **Side-effecting:** yes.
- **Workspace required:** no.
- **Gated by:** `tools_python_runtime_enabled` (off by default).
- **Platforms:** `win32` only at present.
- **Notes:** Returns text output plus optional inline charts and tables. The runtime ships with a curated package set (NumPy, Pandas, Matplotlib, etc.); arbitrary `pip install` is not exposed.
- **Parameters:** `code` (required).
- **Source:** [`sidecar/ai/tools/builtins/python_runtime/`](../sidecar/ai/tools/builtins/python_runtime/) — the typed failures live in `errors.py` and the embeddable-interpreter pip bootstrap in `pip_bootstrap.py`, split out of `interpreter.py` to keep it under the file-size ceiling and to let the bootstrap raise those errors without importing `interpreter` back. `interpreter` re-exports every name from `errors`, so existing `interpreter.PythonRuntime*Error` references still resolve to the same classes.

### Packaged runtime

- Windows releases use the pinned CPython 3.13.14 x64 embeddable distribution
  and a complete hash-locked `cp313` wheelhouse. First use does not require a
  package-index connection.
- The official embeddable distribution omits `venv` and `ensurepip`. Jenny
  copies the verified interpreter into the user-owned staged runtime and
  extracts pip only from the verified bundled wheel before installing the
  curated package set with `python -m pip --no-index`. Development resolves
  the bundle under `<repo>/vendor`; packaged launches resolve it under the
  Electron resources root. Electron's development `resourcesPath` is not used
  as a packaging signal.
- Copy validation follows the bundled `python.exe` entrypoint rather than the
  packaging host's native virtual-environment layout.
- Readiness records both the top-level package pins and transitive runtime-lock
  fingerprint, then validates imports. A changed lock, stale marker, missing
  package, or interrupted install rebuilds through the existing atomic staging
  path instead of accepting a partially ready environment.
- Concurrent first use is serialized per runtime path inside the sidecar before
  taking the existing cross-process bootstrap file lock. This avoids Windows
  sharing races during lock cleanup while preserving cross-process exclusion;
  per-path in-process lock entries are removed after their final waiter exits.
- Release packaging fails before Electron Builder when the interpreter,
  wheelhouse, target tags, manifests, lock fingerprints, or file hashes are
  absent or inconsistent. See
  [`BUILDING.md`](BUILDING.md).

### Sandbox model

The Python runtime runs each invocation in a fresh subprocess with hard limits:

- **Windows:** Job Object isolation (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`, `JOB_OBJECT_LIMIT_BREAKAWAY_OK` denied so child processes are killed when the job ends). See [`job_object.py`](../sidecar/ai/tools/builtins/python_runtime/job_object.py).
- **POSIX (when implemented):** `setsid()` for process-group isolation; `RLIMIT_AS` (memory), `RLIMIT_NOFILE` (file descriptors), `RLIMIT_CPU` (timeout + 5s grace), `RLIMIT_CORE = 0` (no core dumps).
- **Filesystem:** ephemeral working directory, scrubbed after execution. There is no broader filesystem jail — see threat model below.
- **Network:** no isolation. The Python sandbox does not block outbound network calls.
- **Environment:** minimal (`PATH`, locale only); secrets and Jenny-internal env vars are stripped.
- **Scientific worker pools:** native BLAS/OpenMP worker counts are pinned to
  one so package imports fit predictably inside the configured memory limit.

### Threat model

The runtime is hardened against accidental memory exhaustion, runaway CPU, and zombie subprocess leaks. It is **not** a security boundary against deliberate adversarial code:

- No filesystem jail. Arbitrary code can read or write outside the workspace within the host's filesystem permissions.
- No network isolation. Code can make outbound HTTP requests, open sockets, etc.
- No syscall filter (no seccomp, no AppContainer).

Treat `python_execute` as "what you would let your local Python REPL do," gated behind explicit approval. See [`docs/SECURITY_MODEL.md`](SECURITY_MODEL.md#python-runtime-threat-model) for the full posture.

### Security notes

- Approval is per-call; the approval-plan fingerprint includes the code argument, so any change between request and approval re-prompts.
- Output is sanitized before returning to the model (secrets, prompt-injection patterns, long inline data URIs).
- Subprocess cleanup is `atexit` + SIGTERM with a 1.5s grace period before SIGKILL.

## Git

Four read-only views into a git repository inside the workspace root. None of the tools mutate the repo — there is intentionally no `git_commit`, `git_push`, or `git_checkout` in Jenny's built-in surface. Mutating git operations go through the [shell tool](#shell) under approval.

All git tools require `tools_workspace_root` to be set and operate within that root or a workspace-relative `cwd`.

### `git_status`

Show the working tree status.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Parameters:** `cwd` (optional workspace-relative repo path).
- **Source:** [`sidecar/ai/tools/builtins/git_ops.py`](../sidecar/ai/tools/builtins/git_ops.py).

### `git_log`

Show recent commit history.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Parameters:** `cwd`, `max_count`.
- **Source:** [`sidecar/ai/tools/builtins/git_ops.py`](../sidecar/ai/tools/builtins/git_ops.py).

### `git_diff`

Show a bounded diff for the working tree or index.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Notes:** `staged: true` shows index diffs; `ref` diffs against an arbitrary ref; `path` filters to a file or directory.
- **Parameters:** `cwd`, `staged`, `ref`, `path`.
- **Source:** [`sidecar/ai/tools/builtins/git_ops.py`](../sidecar/ai/tools/builtins/git_ops.py).

### `git_show`

Show a bounded patch view for a commit.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** yes.
- **Parameters:** `cwd`, `ref` (defaults to `HEAD`).
- **Source:** [`sidecar/ai/tools/builtins/git_ops.py`](../sidecar/ai/tools/builtins/git_ops.py).

### Security notes

- Subprocess invocations use the same owned process service as shell commands: POSIX process groups or Windows Job Objects contain descendants, stdout/stderr drain concurrently under the aggregate capture budget, timeout/shutdown terminate the tree, and global active/queued quotas prevent unbounded process fan-out. A pathological history cannot force an unbounded parent-side capture.
- Ambiguous git subcommands routed through the shell classifier (e.g., `git checkout` vs. `git fetch`) require approval — see the [shell tool](#shell) for the classifier behavior.

## Web

Two tools for live web access: search and URL fetch. Both are read-only from the model's perspective but make outbound network requests, so they are off by default. Enable in Settings → Tools (the `web` toggle).

The web tools have a strong SSRF (server-side request forgery) defense: URL validation, private and local host/IP rejection, DNS pinning, and redirect revalidation. The fetch path enforces a 1 MB content cap and a 30-requests-per-minute sliding-window rate limiter.

### `web_search`

Search the web for information.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** no.
- **Gated by:** `tools_web_enabled` (off by default).
- **Notes:** Returns sanitized search results. `allowed_domains` and `blocked_domains` filter results. The DuckDuckGo path tries the Instant-Answer API first, then falls back to scraping the `html.duckduckgo.com/html/` and `lite.duckduckgo.com/lite/` endpoints (POST, browser-like headers, one bounded retry on a 202/403/429 challenge honoring `Retry-After`); all fallback result metadata passes an unsafe-URL filter. A bot challenge that blocks every endpoint is reported as a `success=false` "temporarily blocked" result (distinct from a genuine empty result), and the message makes clear the network is still available. Search results are never cached — the 15-minute TTL cache below is `fetch_url`-only, and providers must not add their own.
- **Parameters:** `query` (required), `allowed_domains`, `blocked_domains`, `timeout_s` (1–30).
- **Source:** [`sidecar/ai/tools/builtins/web.py`](../sidecar/ai/tools/builtins/web.py) (tool entrypoint + provider dispatch); the DuckDuckGo search subsystem (Instant-Answer + HTML/lite scrape and the metadata URL safety filter) lives in the [`web_ddg.py`](../sidecar/ai/tools/builtins/web_ddg.py) sibling (2026-07-04 pure-structural split, byte-identical).

### `fetch_url`

Fetch content from a URL and return sanitized text or markdown.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** no.
- **Gated by:** `tools_web_enabled` (off by default).
- **Notes:** Content is sanitized through [`sanitize_tool_output`](../sidecar/ai/tools/sanitization.py). Hidden HTML comments, long inline data URIs, and prompt-injection patterns are filtered. `max_chars` caps the returned content (200–20,000). HTML is converted to markdown via `html2text` when available.
- **Parameters:** `url` (required), `max_chars`, `timeout_s` (1–30).
- **Source:** [`sidecar/ai/tools/builtins/web.py`](../sidecar/ai/tools/builtins/web.py).

### Safety modes

- `normal` — both tools available when enabled.
- `strict` — web tools blocked; the toggle has no effect.
- `paranoid` — web tools blocked AND every other side-effecting tool requires per-call approval.

See [`safety_mode`](../sidecar/ai/config.py) for the active runtime knob.

### Security notes

- Private network ranges (RFC 1918 + link-local + metadata services like `169.254.169.254`) are rejected before any DNS lookup.
- IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are always treated as non-public — a classic SSRF-filter bypass shape, and their stdlib classification varies across Python 3.11.x patch versions.
- IPv6 tunnel forms that wrap an IPv4 address — 6to4 (`2002::/16`), Teredo (`2001::/32`), and ISATAP (RFC 5214) — are additionally rejected when the IPv4 they embed is non-public. This is a veto on top of the wrapper's own range classification, not a replacement for it; IPv4-mapped addresses stay rejected outright without inspecting the embedded value. ISATAP carries no reserved prefix — its `0000:5efe` / `0200:5efe` interface identifier can appear under any `/64` — so that arm is a pattern match rather than a decode, and is deliberately gated on the embedded address: a public IPv6 host is only ever rejected if its identifier both matches a marker and trails a non-public IPv4. The NAT64 well-known prefix `64:ff9b::/96` and the CGNAT shared address space `100.64.0.0/10` are rejected by explicit membership; the stdlib does not classify the latter as private. This blocks tailnet and carrier-grade-NAT destinations by default — set `tools_web_allow_private_addresses` to opt back in. That setting also governs the MCP `sse` transport URL and OAuth `token_url`, so a self-hosted MCP endpoint on such an address is reachable under the same opt-in; it relaxes the address-class check only, never DNS pinning or the redirect refusal.
- DNS resolution is pinned: the resolved IP at validation time is the IP used for the actual request, preventing DNS rebinding.
- Redirects revalidate the destination host; redirects into private networks are rejected. A hop whose destination fails the URL safety policy is reported as a settled, non-retryable policy block (the same classification as a rejected first hop), not as a retryable fetch failure, and the error message never echoes the redirect target — it comes from an attacker-controlled `Location` header.
- Cached fetches honor the 15 min / 50 MB per-fetch cache cap.
- A search-provider base URL rejected by the URL safety policy returns a generic error payload; the specific reason (bad scheme, embedded credentials, non-public resolved address, DNS failure) is logged as a bounded, host-free WARN so a refused self-hosted instance stays diagnosable without echoing the configured host.
- DuckDuckGo instant-answer citations and `source_url` metadata classify address literals with the same `_is_public_ip` the fetch path uses, so a citation can never display an address `fetch_url` would refuse. The check is unconditional — `tools_web_allow_private_addresses` widens what may be fetched, never what is rendered as a citation.
- See [docs/SECURITY_MODEL.md](SECURITY_MODEL.md#prompt-injection-defense) for the sanitizer details.

### Implementation notes

- 2026-07-17: the unused `read_url_bytes` compatibility helper was removed from
  `sidecar/ai/tools/builtins/web_http.py` (desloppify SC-07). No tool behavior,
  schema, or security-path change — the live fetch path never used it.

## Artifacts

Two tools for generating session-scoped artifacts: scratch documents and Mermaid diagrams. Both surface in Jenny's artifact panel; Mermaid diagrams additionally render as an inline chart in the chat timeline.

### `create_artifact` (alias `CreateArtifact`)

Create a session-scoped scratch document or script under `.jenny/artifacts`.

- **Approval:** required (side-effecting), except for the bounded Plan Mode document capability below.
- **Side-effecting:** yes.
- **Workspace required:** yes.
- **Notes:** Use this for plans, notes, helper scripts, or anything the user might want to reference later in the session. When the content is HTML (a `.html`/`.htm` file name/extension, or `language: "html"`), the artifact renders as a **live, network-isolated sandboxed in-app preview** — this is the supported way to display HTML/JS to the user in-app (there is no `file://` browsing or local HTTP server in this environment). See **HTML document artifacts** below. **Do not** use [`write_file`](#write_file-alias-write) for new files under `.jenny/artifacts` — that path is owned by the artifact service.
- **Parameters:** `artifact_kind` (`document` or `script`), `title`, `content` required; `file_name`, `language`, `extension` optional.
- **Source:** [`sidecar/ai/tools/builtins/artifacts.py`](../sidecar/ai/tools/builtins/artifacts.py); Electron-side artifact service in [`services/backend/`](../services/backend/).

#### Plan Mode document capability

Plan Mode exposes a narrowed `create_artifact` schema and automatically executes only the built-in default `ask` decision for an eligible inert document. The contract is fail-closed:

- `artifact_kind` must be `document` and UTF-8 content must be at most 512 KiB.
- Every supplied classifier must agree. Allowed final extensions are `.md`, `.markdown`, `.txt`, `.mmd`, `.mermaid`, `.json`, `.yaml`, `.yml`, and `.csv`; allowed language hints are Markdown, plain text, Mermaid, JSON, YAML, and CSV aliases.
- HTML, SVG, XML, CSS, JavaScript, TypeScript, Python, shell content, and every `script` artifact remain approval-gated outside Plan Mode and are blocked by the automatic Plan Mode path.
- Explicit policy `ask` or `deny`, request-level tool disabling, tool preferences, and paranoid safety mode remain authoritative.

The capability uses the existing guarded `.jenny/artifacts/<session-id>/` store. A sidecar-only reserved argument is frozen with an approval plan after validation, stripped at model/replay/MCP ingress, removed before handler dispatch, and never persisted or exposed as model input.

### `mermaid_generate`

Generate a Mermaid diagram that renders as an inline chart in the chat timeline and is saved as a reusable `.mmd` artifact.

- **Approval:** none (read-only — the diagram is rendered, not executed).
- **Side-effecting:** no.
- **Workspace required:** no — but a workspace + session let the diagram persist as a first-class `.mmd` artifact (see **Artifact** below); without them it still renders inline from the JSON tool output.
- **Gated by:** `tools_mermaid_enabled` (off by default).
- **Notes:** This is the primary path for chat diagrams — the result row renders the chart expanded in the timeline (fenced Mermaid code blocks remain a fallback for throwaway sketches). The full Mermaid source — diagram type declaration plus all nodes and connections — must be in the `prompt` parameter. The classic `graph` header (e.g. `graph TD`, `graph LR`) is recognized as verbatim source alongside the `diagram_type` aliases; a prompt that already starts with a recognized header is preserved exactly rather than rebuilt into a placeholder diagram.
- **Limits:** input source is capped at 4,000 characters and generated Mermaid output at 12,000 characters.
- **Inline rendering:** the timeline tool-result row emits the same `markdown-mermaid-block` wrapper used for fenced Mermaid blocks, so the chart renders expanded in the conversation with the raw JSON and Mermaid source behind collapsed disclosures. A successful result is held during active streaming and between model calls, then rendered after a normal final answer or after terminal cancellation/error/interruption evidence even when no final assistant text exists.
- **Artifact:** when a workspace and session are present, the diagram is also written to `.jenny/artifacts/<session-id>/<title>.mmd` with `language: "mermaid"` and rendered in the artifact panel via the generated-file Mermaid path (the session id is injected by the execution layer's `_jenny_session_id` allowlist). Persistence is best-effort: if the workspace/session is unavailable only the inline JSON tool output (`{"mermaid": …, "diagram_type": …}`) is returned, which still renders the inline chart.
- **Plan Mode:** the first-party manifest capability permits only the existing `.mmd` save while all other read-only/write restrictions remain in force. Approval resumes reuse the frozen per-call capability, so a live Plan Mode toggle cannot drift an unrelated pending plan.
- **Parameters:** `prompt` (required), `diagram_type` (one of `flowchart`, `sequence`, `class`, `state`, `er`, `journey`, `gantt`, `pie`, `mindmap`, `timeline`, `gitGraph`, `quadrantChart`), `title`, `render_hint`.
- **Source:** [`sidecar/ai/tools/builtins/mermaid.py`](../sidecar/ai/tools/builtins/mermaid.py); shared artifact writer (`build_text_artifact_metadata`) in [`sidecar/ai/tools/builtins/artifacts.py`](../sidecar/ai/tools/builtins/artifacts.py).

### Artifact storage

Artifacts live under `.jenny/artifacts/<session-id>/` for the duration of the session. They are not part of the workspace's source tree; the workspace boundary check excludes `.jenny/` from filesystem-tool path resolution. The artifact panel UI lets the user copy, save, or delete them.

### Markdown document artifacts

Markdown documents created with `create_artifact` render in Jenny's universal artifact reader when the artifact uses `language: "markdown"` or a `.md` / `.markdown` file name. The same reader is used for reviews, implementation plans, walkthroughs, notes, and reports; these are presentation conventions, not separate artifact schemas.

Recommended tool parameters for reusable documents:

```json
{
  "artifact_kind": "document",
  "language": "markdown",
  "extension": ".md"
}
```

Use consistent Markdown structures for recurring artifact shapes:

- **Code Review:** H1 title, scope table, issues found with severity and file references, fenced code or diff snippets, "What Looks Good", and severity summary.
- **Implementation Plan:** H1 title, short summary, "User Review Required" callout when needed, grouped proposed changes with `[MODIFY]` / `[ADD]` file markers, and verification commands.
- **Walkthrough:** H1 title, goal/context, ordered steps, decision points, expected result, and troubleshooting notes.

Supported portable callouts are Markdown blockquotes whose first line is one of:

```markdown
> [!IMPORTANT]
> Decision or blocker text.

> [!CAUTION]
> High-risk warning text.

> [!WARNING]
> Risk or compatibility warning.

> [!NOTE]
> Useful context.

> [!TIP]
> Optional helpful guidance.
```

### HTML document artifacts

HTML documents created with `create_artifact` render as a **live in-app preview** when the artifact is classified as HTML — a `.html` / `.htm` file name/extension, or `language: "html"`. The preview runs inside a network-isolated sandboxed iframe (`srcdoc`, no external network, no `file://`, no local server), so it is the supported mechanism for showing HTML/JS output to the user in-app. `browser_open` is **not** — it opens a hidden automation session that is never shown to the user, and its `file://` support requires a configured tools workspace root that may be unset.

Recommended tool parameters for a viewable HTML page:

```json
{
  "artifact_kind": "document",
  "language": "html",
  "extension": ".html"
}
```

Gated by `artifact_html_preview` (default-on). When the flag is off the artifact still saves and appears in the panel; only the inline live-preview affordance is withheld.

### Security notes

- `create_artifact` normally requires approval because it writes to disk. The approval-plan fingerprint covers the artifact kind, title, content, target file name, and any trusted Plan Mode capability frozen for that call.
- `mermaid_generate` is rendered client-side (inline chat chart + artifact panel) via Mermaid.js. The renderer sandboxes the SVG output; arbitrary script tags inside the diagram source are stripped.
- Both tools' outputs are sanitized for prompt-injection patterns before being added to chat history.

## Knowledge

A deterministic, vector-free knowledge layer: three read-only tools that
search and read a set of **user-registered document folders** ("knowledge
roots"). Everything is filesystem/grep-backed — no index, no vector DB, no
embeddings (the `no_vector_db` decision stays respected; a semantic tranche
is a separate owner-gated plan).

| Tool | What it does | Approval |
|---|---|---|
| `knowledge_search` | Regex search across the registered folders, reusing `grep_search`'s pure-Python worker (per-file timeout subprocess) scoped per root | Read-only |
| `knowledge_view` | Paginated document read; text streams line windows, pdf/docx/xlsx/pptx/ipynb dispatch to the rich-file inspect adapters | Read-only |
| `knowledge_exec` | Bounded pure-Python `ls` / `tree` / `find` over the corpus | Read-only |

### Availability

- Sidecar flag `tools_knowledge_enabled` (default **off**) plus registered
  roots in `knowledge_roots`. Both flow from the Electron knowledge registry
  (`services/knowledge-service.js`, `knowledge.json`) through the managed
  sidecar config channel; the Electron surface is gated by the internal
  `knowledge_layer` feature flag (default **off**).
- `workspace_required` is `false` — knowledge roots are independent of the
  tools workspace root.
- Flag off ⇒ the three descriptors are filtered from the catalog and the
  handlers are never bound; the model cannot see or call them.

### Security surface

- **Root scoping is the hard boundary.** Every access resolves through a
  per-root `WorkspaceGuard`: real-path containment (traversal `../` and
  symlink/junction escapes rejected), symlinked directories never followed
  during iteration.
- Registration-time sensitive-path blocking (`.ssh`/`.aws`/browser profiles
  etc.) happens in the Electron registry; the sidecar re-validates
  containment on every call regardless.
- Untrusted document content is bounded: snippet 280 chars, line render 500
  chars, output 20 KB per call, corpus traversal capped (5000 files/call,
  30 s runtime budget), sources capped at 20.
- Results carry the `web_search`-shaped source refs with 1-based `kb:N` ids:
  `{"id": "kb:1", "path": "<root-label>/relative", "title", "snippet",
  "source_type": "knowledge"}` — ready for the inline-citations chip surface
  (chips require a follow-up to accept path-based refs; the normalizer
  currently keeps only http/https `url` refs).

### Addressing documents

Paths are label-prefixed and relative: `project-x/spec.md` means the file
`spec.md` inside the registered folder whose label is `project-x` (labels
are folder basenames, deduplicated `docs`, `docs-2`, …). With exactly one
registered folder the prefix may be omitted. Absolute paths are accepted
only when they resolve inside a registered root.

### Source pointers

- Implementations: [`sidecar/ai/tools/builtins/knowledge/`](../sidecar/ai/tools/builtins/knowledge/)
  (`roots.py` state + path resolution, `search.py`, `view.py`, `exec_ops.py`).
- Registration: `_add_knowledge_bindings` in
  [`sidecar/ai/tools/registry.py`](../sidecar/ai/tools/registry.py) —
  rich-file adapters are injected there so the knowledge package stays
  within the import-fanout cap.
- Electron registry: [`services/knowledge-service.js`](../services/knowledge-service.js).
- Tests: `tests/sidecar/ai/tools/test_knowledge.py` (scoping, escapes,
  bounds, adapter dispatch), `tests/sidecar/ai/tools/test_registry.py`
  (flag-off parity), `tests/knowledge-service.test.js` (registry).

## Workspace

Three Electron-owned tools let Jenny work with the user's own workspace
surfaces: `workspace_present` asks the user's IDE to show something;
`preview_test` verifies an HTML file actually renders — without showing the
user anything at all; `verify` runs one of the user's own saved Test Runner
configurations and reports the verdict. The first two are read-only; `verify`
executes a command, but only ever one the user authored.

All three are declared in [`services/tools/tool-manifest.json`](../services/tools/tool-manifest.json)
with `owner: "electron"`, reach the model through the managed sidecar's
`electron_tool_bridge`, and require a configured tools workspace root.

### `workspace_present`

Requests that the workspace IDE presents a surface: `view="preview"` renders a
supported file (markdown/mermaid/self-contained HTML), `view="file_map"` opens
the dependency File Map with an optional reveal path, and `view="change_diff"`
opens one recorded Jenny change for review.

- **Request, not outcome.** The renderer may coalesce the request or hold it
  behind a non-stealing affordance while the user is typing; there is no
  renderer acknowledgment channel. The tool therefore reports
  `presentation_state: "deferred"` / `render_state: "not_started"` — the
  `shown`/`dismissed` and `loaded`/`failed` values are reserved for a future
  ack channel (W8-S2).
- Validation order is security-sensitive: workspace root required → tool-root/
  IDE-root realpath match → view → path → real-path containment (symlink and
  junction escapes rejected) → stat/binary/size gates for previews → exactly
  one presentation event.
- Failures are structured, snake_case, and never echo absolute paths.
- Source: [`services/tools/builtin/workspace-present-tool.js`](../services/tools/builtin/workspace-present-tool.js),
  [`services/workspace-presentation-service.js`](../services/workspace-presentation-service.js).
- Flag: `tools_workspace_present_enabled` (internal, default on,
  `JENNY_ENABLE_TOOLS_WORKSPACE_PRESENT=0` to roll back).

### `preview_test`

Loads one workspace `.html`/`.htm` file in a hidden, sandboxed, one-shot
window and reports what happened: render state, error-level console messages,
page errors, and per-event status for up to ten bounded click/type
interactions at a chosen viewport preset (desktop/mobile/tablet). Built for
the "I just wrote this HTML artifact — does it actually work?" verification
loop (tool-contract spec Part 7, W8-S4).

Threat model (deliberately narrower than the retired `browser_*` family):

- **Workspace files only, network off.** The window opens with
  `strictWorkspaceOnly`, under which every URL that is not a contained
  workspace `file://` target — external HTTP(S) *and* localhost HTTP — is
  denied at `webRequest`, `will-navigate`, `will-redirect`, and window-open,
  and the top-level URL is re-validated before load.
- **No caller scripts.** Interactions use fixed selector-probe scripts from
  [`services/browser-interaction-utils.js`](../services/browser-interaction-utils.js);
  the tool never calls the eval surface.
- **One-shot.** The hidden window is opened, probed, and closed inside a
  single call; no session handle is ever exposed to the model.
- **Untrusted output.** Console and page-error text is page-controlled:
  whitespace-flattened and length-bounded before it enters the transcript,
  and still untrusted content once there.
- **Pixel summary and opt-in screenshot.** Every run reports a coarse render
  summary computed from a thumbnail no wider than 160 px: dominant color,
  distinct colors, a 3x3 grid, and a `blank` / `near-uniform` / `mixed`
  verdict. Set `screenshot: true` to attach the full PNG as a session artifact.
- Source: [`services/tools/builtin/preview-test-tool.js`](../services/tools/builtin/preview-test-tool.js)
  on the [`services/browser-session-service.js`](../services/browser-session-service.js)
  substrate (hidden `BrowserWindow` lifecycle, nonce'd in-memory partition,
  sandboxed webPreferences, URL policy in
  [`services/browser-url-policy.js`](../services/browser-url-policy.js)).
- Flag: `tools_preview_test_enabled` (internal, default on,
  `JENNY_ENABLE_TOOLS_PREVIEW_TEST=0` to roll back).

### `verify`

Runs one of the user's own saved Workspace IDE Test Runner configurations and
reports the verdict. `action: "list"` returns the saved configurations with each
one's last status and which one is the verification gate; `action: "run"` executes
one by `config_id`; `action: "gate"` runs whichever one the user designated as the
gate. All three return pass/fail counts plus the failing output. Built for the
"I said this works — did I check?" loop: prefer it over `run_command` for running
the project's tests.

- **The model picks a configuration, never a command.** There is no argument
  passthrough and no command composition, so the string that executes is always
  one the user wrote in their own IDE. That bound — not an approval prompt — is
  why the built-in policy default is `auto`, the same argument as `home`. The
  descriptor stays honest (`read_only: false`, `side_effecting: true`, since
  tests write snapshots and coverage), and a user policy rule still overrides
  the default in either direction.
- **The turn always completes.** A refusal the turn should survive — most often
  `CMP-TESTRUNNER-0010` (`ALREADY_RUNNING`, i.e. the user's own run holds the
  single-run lock) or a runner rejection — comes back as a non-error `skipped`
  result telling the model to report the change as unverified. A suite that ran
  and *failed* is likewise not a tool error: it is a reported verdict. Nothing
  here can strand a turn or withhold a final response.
- **Bounds live in the service, not the tool.**
  [`services/workspace-test-runner-service.js`](../services/workspace-test-runner-service.js)
  owns the single-run lock, the realpath cwd-inside-root check, the
  default-timeout floor, history, and summary parsing. Output tails are captured
  bounded and token-masked by the runner and are opt-in on the returned record
  (`includeOutput`), so the renderer's own run path is unchanged; the tool
  re-bounds them to 4,000 characters and withholds them entirely on a pass.
- **`action: "gate"` exists for the turn-finalization gate.** It answers "run
  the gate, and what does the user want done on failure?" in one bridge round
  trip, so the designation never has to be threaded through the managed-sidecar
  config. A workspace with no designated gate answers `no_gate_configured`,
  which is a non-error. At most one configuration can hold the designation, and
  that is enforced in `normalizeConfigs` rather than in the UI.
- **Every run this tool starts is attributed.** The service records
  `initiator: 'jenny'` on the history record (absent, not null, on the user's
  own runs, so nothing pre-existing changes shape), and the Test Runner panel
  renders it as `by Jenny · 2m ago` beside the status pill, with a 2px accent
  tick above the run's bar in the history strip. A gate run also carries its
  1-based `attempt` -- a **harness-only argument** the sidecar's finalization
  hook sets and the model-facing schema deliberately omits -- so the panel can
  say `attempt 1 of 2` / `Failed after 2 attempts`. A gate run the user's own
  run pre-empted (`ALREADY_RUNNING`) leaves a terminal `skipped` history record,
  which is the only way the panel can show `Skipped`; the user's own
  double-click still records nothing.
- **The verdict rides the result metadata onto the chat timeline.** `status`,
  `action`, `config_id`, `run_status`, `passed_count`, `failed_count`,
  `duration_ms`, `attempt`, `gate_on_failure` are enough for the tool row's
  meta slot to read `Gate · Failed · 4 of 142 · 21.4s · attempt 2` without a
  second call (`tool-call-utils.js::formatToolResultMeta`).
- Source: [`services/tools/builtin/verify-tool.js`](../services/tools/builtin/verify-tool.js).
- Flag: `tools_verify_enabled` (internal, **default off**,
  `JENNY_ENABLE_TOOLS_VERIFY=1` to register it).

### The verification gate

Separate from the tool, and separately flagged: when a turn has mutated the
workspace with the typed file tools and the model is about to finish,
[`sidecar/ai/routing/verification_gate.py`](../sidecar/ai/routing/verification_gate.py)
runs the designated gate and hands a failing verdict back so the model fixes it
instead of claiming success. It hooks
`tool_loop_finalize.py::_handle_final_response` immediately before the turn
settles, and reuses `auto_checkpoint.py`'s mutation vocabulary rather than
tracking mutations a second time.

- **The gate can never prevent a turn from completing.** No bridge, no designated
  gate, the user's own run holding the single-run lock, a timeout, an `MCPError`,
  a malformed result, an exhausted retry cap — every one of those degrades to one
  honest sentence appended to the model's own response. A failing gate is never a
  terminal error and never a `StopEvent`. This is the opposite of a CI gate: it
  exists to stop false "done" claims, not to withhold work.
- **Retry capacity is a carve-out, not the model's budget.** The local chat loop
  is only 8 iterations, so the gate grants itself at most `GATE_MAX_RETRIES` (1)
  extra iterations through `_ToolLoopRun.grant_gate_iteration()`. A grant that
  goes unused is handed straight back, so the model never inherits the slack. The
  main loop is a `while`, not `for ... in range(...)`, precisely so a mid-run
  grant takes effect.
- **Two caps, two jobs.** `gate_iterations_granted` caps extra iterations (1);
  `gate_attempts` caps how many times the suite may run per turn (2 — the first
  check plus the post-fix re-check). They coincide in the retry flow but not in
  report-only mode, where the grant is always returned.
- **The trigger set is narrower than auto-checkpoint's**: `write_file`,
  `edit_file`, `delete_file`, `move_file` — deliberately not `run_command`, since
  `git status` is not a mutation and firing a suite after every shell call is
  pure latency. A failed mutation does not count, and a turn where the model
  already ran `verify` green does not re-run it.
- **Failing output is distilled, then bounded.** `distill_gate_output` reuses the
  build/test/lint filters behind `run_command` (every error line verbatim, pass
  parades collapsed) with no `OmissionStore` — the model has no call id to
  recover a gate omission through, so the marker is plain prose. It falls back to
  raw output on any miss or exception.
- **On-failure mode is per-workspace and user-authored**: `retry` (default) or
  `report`, stored on the gate configuration itself in
  `services/workspace-test-runner-config.js`. The Test Runner panel's
  persistent gate header (`renderer/features/renderer-ide-test-runner-gate-utils.js`)
  is where both are set: a select naming the gate configuration (or `Off`), the
  latest Jenny-run verdict, and the on-failure select (`Retry once` /
  `Report only`). "Retry once" is the copy for `GATE_MAX_RETRIES = 1`: the
  first check plus one post-fix re-check, so the exhausted state reads
  `Failed after 2 attempts`.
- **The closing note counts attempts honestly.** After a retry that still
  fails: *still did not pass after 2 attempts*. In report-only mode: *did not
  pass after this change; no fix was attempted*.
- Flag: `verification_gate` (internal, **default off**,
  `JENNY_ENABLE_VERIFICATION_GATE=1`). Also requires `tools_verify_enabled`,
  since the gate reaches the runner through the `verify` tool.

## Runtime

The runtime interaction family contains Electron-owned tools that pause or redirect the current
managed-sidecar turn without performing workspace mutations.

### `ask_user`

`ask_user` presents one to four structured questions and blocks the current tool result until the
user answers or declines. It is read-only, available in ordinary and Plan Mode turns, and does not
require a workspace root or configuration flag. Each question carries a stable id, prompt, optional
choice strings, and `allow_other` / `multi_select` presentation hints.

The manifest keeps only structural validation so verbose model output reaches Electron. The
Electron handler clamps prompts, ids, options, and returned answers before emitting the
`user_questions_requested` event over the existing chat-stream seam. Answers resume the same tool
call with a compact Q/A transcript and `metadata.result_kind: "user_questions_answered"`; decline
is a successful result with `user_questions_declined`. Stream cancellation settles the waiter as a
decline. The inline renderer card is delivered by W2-S2; W2-S1 owns only the manifest, waiter,
bridge, and IPC response surface.

### `exit_plan_mode`

`exit_plan_mode` submits a bounded implementation plan for review while Plan Mode is active. It
uses the existing three-way approval flow: approve, approve and continue automatically, or reject
with feedback. Approval persists the session's Plan Mode transition before returning success;
rejection leaves Plan Mode active so the model can revise the proposal.

Both tools execute through `tool.execute_electron`. `ask_user` inherits the normal read-only
`auto` policy default because its own question card is the interaction boundary; it does not need
or receive the special policy override used by `exit_plan_mode`.

## Diagnostics

Two model-facing diagnostics/discovery tools cover runtime introspection: `jenny_status` and `tool_search`. Both are read-only and workspace-independent. The lower-level harness snapshot remains an internal Electron/sidecar diagnostic service, not a model tool. These surfaces are not for answering source-code or repository-architecture questions — those should be answered by reading the code directly.

### `jenny_status`

Returns a read-only Jenny status snapshot across backend, runtime, harness, logs, cost, schemas, automations, and budget posture. This is the single Electron-owned model facade over the internal diagnostic services.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** no.
- **Notes:** Composes from `BackendService.getJennyStatus()`. Sensitive details (paths, tokens, raw provider payloads) are redacted before return. Use the `recent_log_limit` to bound returned log entries.
- **Parameters:** `session_id` (optional, scopes cost details), `recent_log_limit` (1–50), `include_harness` (optional, defaults to true).
- **Source:** [`services/tools/builtin/jenny-status-tool.js`](../services/tools/builtin/jenny-status-tool.js); composer at [`services/backend/jenny-status-composer.js`](../services/backend/jenny-status-composer.js).

Output structure (additive; missing facets are `unavailable`, never thrown):

- `backend` — lifecycle state, app version, managed sidecar status.
- `runtime` — lifecycle state, sidecar/Electron version compatibility.
- `harness` — current harness snapshot (mode, model, prompt experiment assignment).
- `logs` — recent error distribution, sample warnings/errors, log entry IDs for trace deep-links.
- `cost` — recent turn usage, session-scoped totals when `session_id` is set.
- `schemas` — every persisted schema's owner/version/forward-policy from the schema-version registry.
- `budgets` — pressure/budget facets (input readiness, P50/P95/P99 phase percentiles).
- `tool_observability` — per-tool latency, error counts, slow-operation watchlist.
- `automations` — compact counts and bounded recent failure summaries from Electron-owned scheduler automation records; no task specs, local paths, or result refs.
- `runtime.lifecycle` — managed sidecar lifecycle state beyond `starting/ready/error`.

### Diagnostics Overview runtime inventory

Diagnostics Overview obtains its bounded Runtime Inventory through the existing `harness.inspect` preload bridge. The snapshot summarizes runtime/model profile, offered tools, memory, skills, workspace, shell, and prompt-experiment state. Missing, malformed, partial, and unavailable facets render explicitly; a failed refresh clears the prior snapshot so the UI cannot preserve a stale healthy claim.

This inventory remains an internal renderer diagnostic surface, not a model-facing tool ID. The former Harness and Dev Tools Settings sections and the internal Codex diagnostic reviewer were removed. The ChatGPT subscription plugin owns the replacement ChatGPT workflow, while the optional Codex CLI product engine continues to use its independent setup/auth/runtime services.

Legacy `.jenny-diagnostics` folders created by the retired reviewer are user data. Jenny neither reads nor deletes them automatically.

### `tool_search`

Search for available tools by keyword query. Use this when a tool you need is not in your current loaded tool list.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** no.
- **Notes:** Token-budget filtering can defer-load tools when the active set grows too large. `tool_search` re-exposes them on demand. Use `select:ToolName` for exact lookup, plain keywords for fuzzy search, or `+keyword` to mark a term as required.
- **Parameters:** `query` (required), `max_results` (1–25, default 5).
- **Source:** [`sidecar/ai/tools/tool_search.py`](../sidecar/ai/tools/tool_search.py) plus the runtime handler at [`sidecar/ai/tools/tool_search_handler.py`](../sidecar/ai/tools/tool_search_handler.py); budget filter at [`sidecar/ai/routing/tool_budget_filter.py`](../sidecar/ai/routing/tool_budget_filter.py).

### When to use which

- "What can Jenny do right now in this session?" → answer from the model-visible `## Executable Tools` capability digest for the current request.
- "What is the system's health right now?" → `jenny_status`.
- "I need a tool that isn't loaded." → `tool_search`.
- "Why is this tool failing?" → check `jenny_status` (logs, tool_observability), then read the source.
- "What runtime components are active?" → open Diagnostics Overview and inspect Runtime Inventory.

### Security notes

- Both model-facing tools are read-only. Their outputs use the same bounded result pipeline as other tools.
- `jenny_status` failures fail open as `unavailable` facets rather than throwing — the user-facing health surface should always render even if one upstream is broken.

## Connections

`connections_list` is a model-callable, read-only snapshot of the online services the current session is configured to use. It helps the user decide whether to share sensitive information before that information is sent to a remote engine, web provider, or remote MCP server.

The tool takes no arguments and does not probe DNS, open sockets, contact providers, or inspect updater state. It reports:

- the active post-fallback engine and whether it is local or remote;
- whether `web_search` and `fetch_url` are enabled, including the configured search provider and a sanitized SearXNG base URL when applicable;
- configured MCP servers using non-stdio transports, with sanitized hosts;
- plugin network access as `not reported by the host` when the request has no host-provided plugin inventory;
- background model-catalog and updater traffic that does not carry chat messages; and
- `Offline lockdown: ON (this session)` as the first line when the current request is locked down.

There is no `Connections this session:` header; every output row is a plain bullet. The output is deterministic for a given configuration and request. URLs are reduced to safe hosts or base URLs without credentials, query strings, or fragments; API keys, tokens, auth fields, provider payloads, and local paths are never included. `stdio` MCP servers are local processes and are intentionally omitted from the online connection list.

The canonical descriptor is in [`services/tools/tool-manifest.json`](../services/tools/tool-manifest.json). The implementation is [`sidecar/ai/tools/builtins/connections.py`](../sidecar/ai/tools/builtins/connections.py), registered through [`sidecar/ai/tools/registry.py`](../sidecar/ai/tools/registry.py) and hosted by the builtin MCP subprocess.

## Distill

Deterministic, zero-LLM, flag-gated compression of noisy shell command output. When
`tools_distill_enabled` is on, `run_command` renders recognized test / build / lint output
**errors-first**: every error/failure/traceback line survives verbatim while pass/progress
"parade" lines collapse into bounded omission markers. Whenever content is omitted,
the complete bounded capture is persisted and the marker points to its workspace-relative
path for paginated recovery with `read_file`.

The feature is **off by default**. With it off, `run_command`'s payload
(`stdout`, `stderr`, `full_output_path`, `exit_code`) is byte-identical to before. It is
additive: the existing large-output disk spill (`full_output_path`) is unchanged.

Bounds and edge behavior (flag on): a cheap filter sniff runs before the redaction
pipeline, so unrecognized commands (`ls`, `git status`, …) pay nothing; inputs larger than
~2M chars skip distillation entirely. Distilled output that still exceeds the shell tool's
20k-char payload cap is truncated as usual, while the complete bounded capture remains
available at `full_output_display_path` for `read_file` pagination.

Distillation runs on stdout/stderr that has already passed the sanitization **redaction**
primitives (secrets, injection, data-URIs), so neither the model-visible view nor the store
ever holds an un-redacted secret. Any filter/store error falls back to the raw (sanitized)
output — nothing is lost.

The omitted bytes live in a workspace-scoped, schema-versioned, WAL SQLite omission store at
`.jenny/omissions/omissions.db`: content-addressed 12-hex refs (sha256), zlib-compressed,
with a 7-day TTL and a 50 MB size-cap pruned opportunistically on write. It is a clean-room
reimplementation of the *pattern* behind repowise's distill capability — behavioral spec only.

### Configuration

- `tools_distill_enabled` (default `false`) — enables the `run_command` distillation path.
  It writes recoverable full-output captures to disk, so it ships **off**; the owner flips the
  default after soak.

## Home

One tool — `home` — covers every Home surface Jenny is allowed to touch: the
Home calendar, proactive reminders, and a read-only view of the Home
scratchpad. It is registered behind the default-on `tools_home_enabled` feature
flag (`JENNY_ENABLE_TOOLS_HOME=0` rolls it back by never registering it) and
executes in Electron through the existing `tool.execute_electron` bridge.

### Why one tool and not six

Six near-identical tool ids (`calendar_list`, `calendar_create`, …) would burn
six catalog slots on one small, tightly-related surface, and models pick more
reliably between values of an `action` enum than between sibling tool names
that differ by one word. The schema is a single flat object with
`additionalProperties: false`; fields that do not apply to the chosen action
are simply omitted.

### Actions

| Action | Purpose | Key fields |
|---|---|---|
| `calendar_list` | List calendar occurrences in a window | `range_start`, `range_end` (both optional; default is the service's -7d..+60d window) |
| `event_upsert` | Create or update a calendar event | `id` (omit to create), `title`, `start`, `end`, `all_day`, `category`, `notes`, `recurrence` |
| `event_delete` | Delete a calendar event | `id`, `confirm` |
| `reminder_upsert` | Create or update a proactive reminder | `id` (omit to create), `label`, `prompt`, `remind_at` |
| `reminder_delete` | Delete a reminder | `id`, `confirm` |
| `scratchpad_read` | Read the Home scratchpad notes | — |

Times are **local wall-clock naive strings**, never ISO instants with a zone:
`start`/`end` are `YYYY-MM-DDTHH:MM`. `remind_at` is overloaded on purpose —
`YYYY-MM-DDTHH:MM` produces a one-shot (`once_at`) reminder and a bare `HH:MM`
produces a daily one (`daily_at`). Anything else is refused rather than
coerced; a reminder that silently lands on the wrong cadence is worse than an
error the model can correct.

Nothing in Jenny *fires* reminders. They surface on Home as manual nudges, so
`reminder_upsert` never schedules background work.

Bounds mirror the underlying schemas: event `title` 200 chars, `notes` 2000,
500 events total; reminder `label` 200, `prompt` 4000, 50 reminders total.
Over-long text is clipped at the tool boundary (and the result says so) rather
than thrown back, because the underlying reminder service rejects an oversized
payload outright.

### The confirm contract

Deletes are the one destructive action, and they self-gate rather than leaning
on the approval dialog:

1. `home` is called with `action: "event_delete"` and an `id`. Nothing is
   mutated. The result carries `metadata.status: "confirmation_required"` and
   content naming exactly what would be deleted.
2. Jenny confirms with the user in the conversation.
3. `home` is called again with `confirm: true`. Only now does the delete
   happen, and only now is a journal entry written.

A delete for an unknown id fails structurally at step 1, so the confirmation
prompt can never name a record that does not exist. Existence is checked
against the full events array (`HomeAssistantService.readEvent`), not against
`calendar_list`'s expanded occurrences — those only cover the -7d..+60d window,
so a precheck that read them would refuse to delete an event three months out
that the calendar service can find perfectly well.

Two things `event_delete` does **not** do:

- **It is not an occurrence delete.** `id` addresses the event *series*, so
  deleting a recurring event removes every occurrence, not the one the user was
  looking at. There is no "this event only" delete through the tool; say so
  before confirming a recurring event.
- **Undo does not restore the same id.** `CalendarService` owns id minting, so
  undoing a deleted event re-creates it with all its fields under a **new** id.
  Any id the model is holding from before the delete is dead afterwards.

### An unknown id is never an implicit create

`event_upsert` and `reminder_upsert` both refuse (`reason: "not_found"`, naming
the id) when the `id` given matches no existing record. Neither falls through to
the create branch. **To create, omit `id`** — that is the only way to create.

The two entities fail differently without that rule, and both failures are bad:

- a calendar event would be created under a **freshly minted** id, leaving the
  user with a duplicate of a record the model meant to edit;
- a reminder would be created under **the invented id itself**, because the
  reminder normalizer honours whatever id it is handed — a defaults-filled
  09:00 daily reminder with an empty prompt, addressed by an id nothing else
  knows about.

### Attribution and undo

Every write goes through `HomeAssistantService`
([`services/home-assistant-service.js`](../services/home-assistant-service.js)),
never the calendar or shell-config services directly. That facade does three
things per mutation:

- stamps `sourceKind: 'assistant'` plus a bounded `sourceId` on the entity **at
  creation only**, so any Home surface can badge who created a record. An
  assistant edit of an existing record carries that record's attribution pair
  through unchanged: a record the user created stays unattributed, and a record
  Jenny created keeps pointing at the call that created it, not the one that
  edited it. The chip is permanent and undismissable, so it answers "who made
  this", never "who touched it last" — the undo journal answers recency, and
  its affordance expires honestly when the entry leaves the ring;
- delegates to the same service the user's own edits use, so there is exactly
  one normalizer and one persistence path;
- appends an entry to the undo journal at
  `<userData>/home-ai-journal.json` recording the **inverse** operation plus a
  `postHash` fingerprint of the entity as Jenny left it.

The journal is a small ring: at most 20 undoable ("live") entries, oldest
evicted first. Writing to an entity again stamps that entity's earlier live
entry `supersededAt`, so an undo can never rewind past a later change.

`undo(entryId)` refuses — doing nothing and returning `{ ok: false, reason }` —
in exactly three cases:

| `reason` | Meaning |
|---|---|
| `already_undone` | The entry was undone before. |
| `superseded` | A later Jenny write to the same record replaced it. |
| `changed_since` | The record's current normalized state no longer matches `postHash` — the user edited it, and an undo would clobber their edit. |

A successful undo executes the inverse through the same services (delete a
create, restore a delete, re-apply the prior snapshot for an update) and stamps
`undoneAt`. Restoring a deleted **calendar event** re-creates it with a fresh
id, because `CalendarService` owns id minting; restored **reminders** keep
their own id. Either way the entry is terminal — undo is never chained.

#### When the journal itself fails to write

The entity store is the source of truth; journaling is the recoverable half. If
the journal append fails *after* the entity write has landed, the call still
returns success with `metadata.journaled: false`, and the result text says the
write cannot be undone from Home. Failing the call instead would tell the model
its write failed, and its retry would create a duplicate record. Such a write is
still attributed (`sourceKind: 'assistant'`, when it created the record) — it is
simply not undoable.

The journal store persists before it swaps the new ring into memory, so a failed
write leaves memory identical to disk rather than stranding a `supersededAt`
stamp for an entry that was never recorded.

The renderer reads the journal over `home.getAiJournal` and triggers a revert
over `home.undoAiEntry`; `home.onAiChanged` pushes `{ journal, proactive }`
whenever the journal moves. Calendar and reminder entity state keep riding
their existing `calendar.onChanged` / proactive channels.

### Why the scratchpad is read-only

`scratchpad_read` has no write counterpart, by owner decision for v1. The
scratchpad is the user's own free-writing surface; letting the model edit it in
place would put Jenny's text and the user's text in the same undifferentiated
blob, with no per-note attribution to badge and no natural undo unit. Calendar
events and reminders are discrete records, which is what makes attribution and
one-click undo tractable there.

### Deliberate v1 deferral: no custom chat card

`home` returns plain text plus `metadata.result_kind: 'home'`; it does **not**
render a bespoke chat card. That is deferred on purpose. The undo affordance
lives on Home, where the change is visible next to the record it touched, and a
second undo surface inside the transcript would have to answer questions the
Home strip already answers (what happens when the record changed since, what
happens after a restart, which of two cards owns the record). Shipping the
journal + the Home strip first keeps one owner for undo. The
`metadata.result_kind` token is already in place for a card to key off later.

### Approval policy

`home` is not `read_only` (it writes), so without an explicit default it would
fall through to `ask` on every call. It is instead defaulted to `auto` in
`DEFAULT_TOOL_DEFAULTS`
([`services/tools/tool-policy-evaluator.js`](../services/tools/tool-policy-evaluator.js)):
its writes only touch Jenny's own Home surfaces, every one is attributed and
one-click-undoable, and the destructive case already gates itself behind the
confirm round-trip above. A user policy rule still overrides the default in
either direction.

Because it is not read-only, `home` is unavailable inside read-only requests
(research subagents, Plan Mode). Two layers enforce that, and both are needed:

- Electron's tool executor blocks it before dispatch.
- The sidecar withholds it from the assembled catalog, so it is never
  *advertised* in a read-only request. `home` is the one manifest entry that is
  `read_only: false` **and** `side_effecting: false` (its writes are attributed
  and undoable, which is why approval policy leaves it on auto), so the
  read-only availability gate in
  [`sidecar/ai/tools/assembly.py`](../sidecar/ai/tools/assembly.py) excludes
  an explicit `read_only: false` alongside its `side_effecting` check. Without
  that, the model would see `home` in Plan Mode, call it, and burn a turn on a
  refusal it could not have predicted.

### Source pointers

- Tool descriptor and dispatch: [`services/tools/builtin/home-tool.js`](../services/tools/builtin/home-tool.js).
- Action handlers: [`services/tools/builtin/home-tool-actions.js`](../services/tools/builtin/home-tool-actions.js).
- Attribution + undo facade: [`services/home-assistant-service.js`](../services/home-assistant-service.js).
- Journal ring and retention: [`services/home-ai-journal-store.js`](../services/home-ai-journal-store.js).
- Canonical descriptor: [`services/tools/tool-manifest.json`](../services/tools/tool-manifest.json).

### Task board

`task_board` is a second Home-family tool, registered behind the default-on
`tools_task_board_enabled` feature flag (`JENNY_ENABLE_TOOLS_TASK_BOARD_ENABLED=0`
rolls it back) and executing in Electron through the same
`tool.execute_electron` bridge as `home`. Where `home` owns the calendar,
reminders, and scratchpad, `task_board` gives the model a durable, checkable
task list: it writes into the same persisted Open Loops follow-up store the
Home widget already renders, tagged `sourceKind: 'agent_task'`, rather than
inventing a second, parallel task surface.

When a session starts from a task, its normalized task identity is persisted as
`linked_task_id` (and included in renderer-facing session summaries) beside the
unsent task brief in `composer_draft`. The brief names the task id, and the
canonical tool description obligates the model to call `complete` with that id
once the tracked work is finished instead of leaving the task open.

#### Actions

| Action | Purpose | Key fields |
|---|---|---|
| `add` | Create a new task | `title` (required), `notes`, `status` — omit `id`; the tool mints and returns one |
| `update` | Edit an existing task's title, notes, or status | `id` (required), `title`, `notes`, `status` |
| `complete` | Check a task off | `id` (required) |
| `list` | List every `agent_task` record | — (returns bounded plain text: id / title / status / sourceKind per line) |

Every mutation is addressed by `id`, never a whole-list replace — two
concurrent writers cannot clobber each other the way a `todo_write`-style
atomic replace would. `add` refuses an explicit `id` (the tool always mints
one); `update` and `complete` refuse an unrecognized `id` with a clean
`not_found` error rather than creating a record — the same "no implicit
create" rule `home`'s `event_upsert`/`reminder_upsert` follow. `title` and
`notes` are bounded to the same schema caps a user-authored follow-up gets
(200 / 4000 characters).

#### Why Open Loops and not a new store

`agent_task` was already an allowed `sourceKind` in the follow-up schema
([`services/shell-config-followups-schema.js`](../services/shell-config-followups-schema.js))
with its own Home badge and source label in
[`services/companion-service.js`](../services/companion-service.js), but had no
producer — every write path into Open Loops was user-initiated (the per-message
"Save to Open Loops" action, the scratchpad). `task_board` is that producer. It
reuses `upsertFollowUp` / `updateFollowUp` / `activateFollowUp` /
`resolveFollowUp` on `ShellConfigService`
([`services/shell-config-followup-actions.js`](../services/shell-config-followup-actions.js))
rather than adding a second, disconnected task surface: the record is durable
across a sidecar restart (it lives in Electron's shell-config store, not
sidecar process memory), already has a working Home widget, and is already
editable, deferrable, archivable, and deletable through the existing follow-up
actions. `todo_write`/`todo_read` remain the ephemeral, in-session, per-turn
scratch list they were designed as; they are not promoted or changed by this
tool.

#### Approval policy

`task_board`'s manifest declares per-action side-effect metadata (`add`,
`update`, `complete` are side-effecting; `list` is not), so without an explicit
default the mutating actions would fall through to `ask` on every call. It
is instead defaulted to `auto` in `DEFAULT_TOOL_DEFAULTS`
([`services/tools/tool-policy-evaluator.js`](../services/tools/tool-policy-evaluator.js)) —
the same argument as `home`: every write only touches the user's own Open
Loops store, is badged `agent_task` so its origin is always visible, and stays
editable/deletable through the existing UI. A user policy rule still overrides
the default in either direction.

#### Source pointers

- Tool descriptor and dispatch: [`services/tools/builtin/task-board-tool.js`](../services/tools/builtin/task-board-tool.js).
- Open Loops mutation methods: [`services/shell-config-followup-actions.js`](../services/shell-config-followup-actions.js).
- Schema and bounds: [`services/shell-config-followups-schema.js`](../services/shell-config-followups-schema.js).
- Canonical descriptor: [`services/tools/tool-manifest.json`](../services/tools/tool-manifest.json).

## Skills

One tool for loading the full body of a skill advertised in the system prompt's "Available Skills" index.

### `load_skill`

Read a bundled/user/project skill's `SKILL.md` body by name and scope.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** no. Skill scope roots (bundled/user/project) are configured independently of the tools workspace root — see [Storage](#storage) below.
- **Gated by:** `tools_load_skill_enabled` (default on).
- **Parameters:** `name` (required) — the skill's directory slug as shown in the index, e.g. `load_skill(name="mermaid-artifact-workflow", scope="bundled")`, not the human-readable frontmatter title. `scope` (optional, `bundled` | `user` | `project`) — disambiguates when the same slug exists in more than one scope; when omitted, resolution tries `bundled`, then `user`, then `project` and returns the first match.
- **Errors:** an invalid `name` (path separators, leading `.`, empty) or invalid `scope` value is rejected before any filesystem access (`CMP-TOOL-0004`). A `name`/`scope` combination that does not resolve to an indexed skill returns `CMP-TOOL-0040` with the list of currently available `scope/name` pairs.
- **Source:** [`sidecar/ai/tools/builtins/skills.py`](../sidecar/ai/tools/builtins/skills.py).

### Why this tool exists

The context builder's skill index (`sidecar/ai/context/builder_skills.py`) lists every discovered skill as one summary line and instructs the model to load the skill's full `SKILL.md` before following it. Skill content lives in scope roots — the app-bundled `skills/` directory, plus optional user and project roots resolved in `sidecar.ai.container._resolve_skill_scopes` — that sit outside the tools workspace root. Every filesystem tool (`read_file`, `glob_files`, ...) is confined to the workspace root by `WorkspaceGuard` (`sidecar/ai/tools/workspace.py`), so before this tool existed a model had no way to actually read an indexed skill's instructions: the index promised detail the model had no path to reach.

`load_skill` is the dedicated, `WorkspaceGuard`-free read path for exactly that file. It resolves strictly against the configured scope roots — never the tools workspace root, never an arbitrary path — validates the requested name as a single, separator-free directory segment, and re-validates the resolved path stays a direct child of its scope root before reading.

### When Jenny uses this

Every indexed entry under "Available Skills" in the system prompt now names the exact call to make, e.g.:

```
- Mermaid Artifact Workflow: Produce a Mermaid diagram plus a reusable artifact. [Allowed tools: mermaid_generate] (load with load_skill(name="mermaid-artifact-workflow", scope="bundled"))
```

Jenny calls `load_skill` with that name and scope before following the skill's instructions. Skills marked `always: true` in frontmatter are inlined directly into the prompt and never need `load_skill` — only indexed (on-demand) skills do.

### Storage

Scope roots are resolved once per sidecar configuration, not read per call:

- **bundled** — the app-shipped `skills/` directory (`services/main/runtime-service-composition.js`).
- **user** and **project** — optional roots resolved by `sidecar.ai.container._resolve_skill_scopes`, forwarded to the builtin-tools subprocess as `--skill-<scope>-root` / `--skill-<scope>-enabled` CLI args (see `sidecar.ai.container._default_mcp_servers`) since scope roots are paths, not secrets.

A scope with no configured root, or with its `skills_<scope>_enabled` flag off, is skipped entirely — `load_skill` never advertises or reads from a disabled scope. Likewise a skill whose id (`<scope>/<slug>`) is in the per-skill disable list (Settings ▸ Skills; `skills_disabled_ids`) is omitted from the index and refused with `CMP_TOOL_SKILL_NOT_FOUND`.

## Todo

Two tools for managing an in-session todo list. Off by default; gated by the `todo` config toggle. The list is session-scoped — it does not persist across sessions and is not the same surface as the renderer's task list.

### `todo_write`

Replace the in-session todo list atomically.

- **Approval:** none.
- **Side-effecting:** yes (mutates session state, but session-only).
- **Workspace required:** no.
- **Gated by:** `tools_todo_enabled` (off by default).
- **Notes:** This is a full replace, not an append. Pass the entire list each call. Each todo has `content` and a `status` of `pending`, `in_progress`, or `completed`.
- **Parameters:** `todos` (required, full list).
- **Source:** [`sidecar/ai/tools/builtins/todo.py`](../sidecar/ai/tools/builtins/todo.py).

### `todo_read`

Read the current in-session todo list.

- **Approval:** none (read-only).
- **Side-effecting:** no.
- **Workspace required:** no.
- **Gated by:** `tools_todo_enabled`.
- **Parameters:** none.
- **Source:** [`sidecar/ai/tools/builtins/todo.py`](../sidecar/ai/tools/builtins/todo.py).

### When Jenny uses these

The todo tools support multi-step work where Jenny needs to track progress visibly. Typical pattern:

1. Jenny writes an initial todo list at the start of a non-trivial task.
2. As each step completes, she writes the list again with that item flipped to `completed`.
3. The user sees the live progress through the renderer's session state.

Trivial single-step tasks should not produce a todo list — the tool is meant for genuinely multi-step work where progress visibility helps.

### Storage

Todos live in sidecar runtime memory for the active session. They are not persisted to disk and do not appear in `turn_events[]`. The list resets when the session ends or when `todo_write` is called with an empty array.

## MCP servers: plugin-declared vs user-configured

Both forms add external MCP tools to Jenny, but they have different owners and
trust lifecycles. A plugin-declared server is part of an installed plugin. A
user-configured server is a standalone connection the user adds directly to
their Jenny profile.

| | Plugin-declared MCP | User-configured MCP |
|---|---|---|
| Configuration owner | The plugin developer declares an `mcp_descriptor` contribution in the plugin manifest; its signed content is committed with the plugin generation. | The user owns a row in `mcp-servers.json` under Jenny's Electron user-data directory. |
| Installation | It arrives through the plugin install/update flow and is reviewed in that plugin's detail drawer. | The user supplies the stdio command and arguments or gated-SSE endpoint, then tests the exact configuration. |
| Trust unit | Jenny applies publisher/package verification, plugin permissions and policy, advisories, quarantine, and the immutable plugin generation. The MCP descriptor remains plugin state. | Jenny records approval for the normalized server configuration and the inspected advertised-tools digest. Only rows that are both approved and enabled are forwarded to the sidecar. |
| Changes | Updating, rolling back, disabling, quarantining, or uninstalling the plugin moves or removes the descriptor with that plugin generation. | Editing the row invalidates its trust. Material tool-surface drift disables the row and returns it to pending review. |
| Storage | It is never copied into `mcp-servers.json`. | It remains independent of every plugin generation. |

### Who is trusted

Installing a plugin means trusting its verified publisher/package and granting
the permissions requested by that plugin. Its MCP server participates in that
plugin's lifecycle; it is not a shortcut around plugin review. Native MCP
contributions are trusted native applications rather than sandboxes, so their
host-level authority deserves the same scrutiny as any other installed native
program.

For a standalone server, the user is the installer and trust decision-maker.
Jenny requires inspection and approval of the exact server configuration
before enablement, binds that approval to the advertised tool surface, and
requires review again after configuration or material tool-surface drift. The
server still runs with the host permissions of its process; MCP approval does
not make third-party code a sandbox.

See [Adding an MCP server](tutorials/02-adding-mcp-server.md) for the standalone
`mcp-servers.json` walkthrough and [Plugin Security & Trust
Model](PLUGIN_SECURITY.md) for the full trust and lifecycle rules.

### Which one to choose

Choose a plugin-declared MCP contribution when the server is an inseparable
part of a versioned extension and should install, update, roll back, quarantine,
and uninstall with that extension. Plugin authors declare it; users should not
copy it into standalone configuration.

Choose user-configured MCP when connecting one Jenny profile to a server the
user selects and operates independently of any plugin. This is the appropriate
path for a local stdio server or approved remote endpoint that should remain
under the user's direct configuration and trust review.
