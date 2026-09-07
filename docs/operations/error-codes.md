# CMP-* Error Code Registry

**Schema version:** 1
**Last reconciled:** 2026-08-12

This is the single source of truth for every `CMP-<DOMAIN>-<NNNN>` error code emitted by Jenny's sidecar (Python) and backend services (Node). Codes are wire-stable identifiers attached to error payloads (`error_code` field) so that the renderer and ops tooling can route, classify, and surface failures consistently.

## Source-of-truth pointers

| Layer | File | Scope |
|---|---|---|
| Python sidecar | [sidecar/ai/error_codes.py](../../sidecar/ai/error_codes.py) | Canonical Python constants, including numeric `CMP-<DOMAIN>-<NNNN>` codes and deterministic-harness sentinel codes |
| Node backend | [services/backend/error-codes.js](../../services/backend/error-codes.js) | Canonical Node peer constants for Electron-owned transport, transcript, tool, persistence, artifact, proactive, companion, and recovery-classifier codes |
| Base exception | [sidecar/exceptions.py](../../sidecar/exceptions.py) | `CompanionError(code, message, retryable=...)` |

## Schema

Each row in the per-domain tables below has the following columns:

- **Constant** â€” Python or Node identifier as defined in the source-of-truth file.
- **Wire code** â€” the literal `CMP-<DOMAIN>-<NNNN>` string emitted on the wire.
- **Meaning** â€” one-line description of the failure condition.
- **Retryable** â€” `Yes` (transient; retry policy will re-attempt), `No` (terminal; surface to user), `Conditional` (depends on caller context).
- **Terminal classification** â€” how the chat/tool runtime classifies the error: `runtime_error`, `denied`, `cancelled`, `timeout`, `preempted`, `question_batch`, or `internal` (never reaches user).
- **User-visible message** â€” what the renderer shows; `internal-only` if the code never escapes the sidecar.
- **Example raise site** â€” `path:line` of one representative raise site (not exhaustive). `DEAD` means the code is defined but not raised anywhere outside its definition file.

---

## SETUP — `CMP-SETUP-NNNN` (4 codes)

Electron-owned onboarding endpoint and acquisition failures. Results are bounded
IPC envelopes; provider payloads, installer output, and local paths are excluded.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `SETUP_ERROR_CODES.ENDPOINT_INVALID` | `CMP-SETUP-0001` | Endpoint input, response, catalog, persistence, or bridge is invalid/unavailable | Conditional | `ipc_result` | Bounded validation or retry guidance | [services/setup-endpoint-service.js](../../services/setup-endpoint-service.js) |
| `SETUP_ERROR_CODES.ENDPOINT_TIMEOUT` | `CMP-SETUP-0002` | Endpoint validation exceeded its bounded deadline | Yes | `ipc_result` | "Endpoint validation timed out." | [services/setup-endpoint-service.js](../../services/setup-endpoint-service.js) |
| `SETUP_ERROR_CODES.CONFIG_REFRESH_FAILED` | `CMP-SETUP-0003` | Saved engine settings could not be applied or the refreshed runtime could not confirm a usable route | Yes | `ipc_result` | Bounded refresh/readiness retry guidance | [services/setup-service.js](../../services/setup-service.js) |
| `SETUP_ERROR_CODES.TERMINATION_FAILED` | `CMP-SETUP-0004` | Owned setup child-process termination could not be confirmed | Yes | `ipc_result` | "The setup process could not be confirmed stopped." | [services/ollama-pull-service.js](../../services/ollama-pull-service.js) |

---

## DATA - `CMP-DATA-NNNN` (10 codes)

Electron-owned archive, restore, and uninstall lifecycle failures. These cross
IPC only as bounded `{code, reason}` objects; local paths, passphrases, prompts,
and archive contents are never included. Their `ipc_result` terminal class is
an Electron result envelope, not a chat/tool terminal event.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `DATA_ERROR_CODES.INVALID_REQUEST` | `CMP-DATA-0001` | Invalid, canceled-after-commit, or malformed lifecycle request | No | `ipc_result` | "The data operation request was invalid." | [services/data-lifecycle/data-lifecycle-service.js](../../services/data-lifecycle/data-lifecycle-service.js) |
| `DATA_ERROR_CODES.BUSY` | `CMP-DATA-0002` | Another lifecycle operation holds the mutex | Yes | `ipc_result` | "Another data operation is already running." | [services/data-lifecycle/data-lifecycle-service.js](../../services/data-lifecycle/data-lifecycle-service.js) |
| `DATA_ERROR_CODES.UNSAFE_PATH` | `CMP-DATA-0003` | Path, traversal, device name, ADS, link, junction, or containment check failed | No | `ipc_result` | "Jenny refused an unsafe path." | [services/data-lifecycle/archive-format.js](../../services/data-lifecycle/archive-format.js) |
| `DATA_ERROR_CODES.SOURCE_UNREADABLE` | `CMP-DATA-0004` | A selected source is unreadable, not regular, or changed twice | Conditional | `ipc_result` | "A source file could not be archived safely." | [services/data-lifecycle/archive-service.js](../../services/data-lifecycle/archive-service.js) |
| `DATA_ERROR_CODES.INSUFFICIENT_SPACE` | `CMP-DATA-0005` | Destination lacks estimated bytes plus reserve | Yes | `ipc_result` | "The archive destination needs more free space." | [services/data-lifecycle/archive-service.js](../../services/data-lifecycle/archive-service.js) |
| `DATA_ERROR_CODES.AUTHENTICATION_FAILED` | `CMP-DATA-0006` | Passphrase is wrong or encrypted content/tag is damaged | Yes | `ipc_result` | "Archive authentication failed." | [services/data-lifecycle/archive-format.js](../../services/data-lifecycle/archive-format.js) |
| `DATA_ERROR_CODES.ARCHIVE_CORRUPT` | `CMP-DATA-0007` | Archive is incomplete, malformed, tampered, colliding, or over bounds | No | `ipc_result` | "This archive is incomplete or damaged." | [services/data-lifecycle/archive-service.js](../../services/data-lifecycle/archive-service.js) |
| `DATA_ERROR_CODES.UNSUPPORTED_VERSION` | `CMP-DATA-0008` | Archive or KDF version is not allowlisted | No | `ipc_result` | "This Jenny archive version is not supported." | [services/data-lifecycle/archive-format.js](../../services/data-lifecycle/archive-format.js) |
| `DATA_ERROR_CODES.RESTORE_CONFLICT` | `CMP-DATA-0009` | Full restore target is not meaningfully fresh | No | `ipc_result` | "Use session import because this profile already contains data." | [services/data-lifecycle/restore-service.js](../../services/data-lifecycle/restore-service.js) |
| `DATA_ERROR_CODES.CLEANUP_INCOMPLETE` | `CMP-DATA-0010` | One or more selected owned targets could not be removed | Yes | `ipc_result` | "Cleanup was incomplete; review the receipt and retry." | [services/data-lifecycle/cleanup-service.js](../../services/data-lifecycle/cleanup-service.js) |

---

## TOOL â€” `CMP-TOOL-NNNN` (43 codes, 0 dead)

Tool-execution failures: approval denials, workspace policy violations, IO errors, validation failures from built-in tools.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_TOOL_APPROVAL_DENIED` / `TOOL_ERROR_CODES.APPROVAL_DENIED` (Node) | `CMP-TOOL-0001` | User denied a tool approval prompt | No | `denied` | "Tool execution was denied." | [sidecar/runtime/headless.py:384](../../sidecar/runtime/headless.py#L384) |
| `CMP_TOOL_DISABLED` / `TOOL_ERROR_CODES.DISABLED` (Node) | `CMP-TOOL-0002` | Tool blocked by current mode policy | No | `runtime_error` | "Tool is disabled in this mode." | [sidecar/ai/tools/policy.py:18](../../sidecar/ai/tools/policy.py#L18) |
| `CMP_TOOL_OUTSIDE_WORKSPACE` | `CMP-TOOL-0003` | Path resolves outside the workspace root | No | `runtime_error` | internal-only | [sidecar/ai/tools/workspace.py:74](../../sidecar/ai/tools/workspace.py#L74) |
| `CMP_TOOL_INVALID_PATH` | `CMP-TOOL-0004` | Path argument failed validation | No | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/edit_file.py:44](../../sidecar/ai/tools/builtins/edit_file.py#L44) |
| `CMP_TOOL_UNKNOWN` / `TOOL_ERROR_CODES.UNKNOWN` (Node) | `CMP-TOOL-0005` | Tool name not registered | No | `runtime_error` | "Unknown tool: {name}." | [services/tools/tool-executor.js:79](../../services/tools/tool-executor.js#L79) |
| `CMP_TOOL_IO_FAILED` | `CMP-TOOL-0006` | Underlying file IO raised | Conditional | `runtime_error` | "File operation failed: {detail}." | [sidecar/runtime/file_locking.py:32](../../sidecar/runtime/file_locking.py#L32) |
| `CMP_TOOL_COMMAND_BLOCKED` / `TOOL_ERROR_CODES.COMMAND_BLOCKED` (Node) | `CMP-TOOL-0007` | Shell command blocked by allowlist or malformed approval request blocked by backend guard | No | `denied` | internal-only | [services/backend/chat-stream-tool-handling.js](../../services/backend/chat-stream-tool-handling.js) |
| `CMP_TOOL_EXECUTION_FAILED` / `TOOL_ERROR_CODES.EXECUTION_FAILED` (Node) | `CMP-TOOL-0008` | Generic tool runtime error | Conditional | `runtime_error` | internal-only | [services/tools/tool-executor.js](../../services/tools/tool-executor.js) |
| `CMP_TOOL_COERCED_ARGS_REJECTED` | `CMP-TOOL-0010` | Coerced argument rejected by tool | No | `runtime_error` | internal-only | [sidecar/ai/tools/contracts.py:211](../../sidecar/ai/tools/contracts.py#L211) |
| `CMP_TOOL_PYTHON_NOT_AVAILABLE` | `CMP-TOOL-0011` | Python runtime tool unavailable | No | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/python_runtime/tool.py:53](../../sidecar/ai/tools/builtins/python_runtime/tool.py#L53) |
| `CMP_TOOL_PYTHON_EXECUTION_FAILED` | `CMP-TOOL-0012` | Python runtime tool raised | Conditional | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/python_runtime/tool.py:39](../../sidecar/ai/tools/builtins/python_runtime/tool.py#L39) |
| `CMP_TOOL_CAP_EXCEEDED` | `CMP-TOOL-0013` | Per-tool call cap exceeded | No | `runtime_error` | internal-only | [sidecar/ai/routing/tool_loop.py:971](../../sidecar/ai/routing/tool_loop.py#L971) |
| `CMP_TOOL_TODO_INVALID` | `CMP-TOOL-0014` | Todo list payload invalid | No | `runtime_error` | "Todo list update failed: {detail}." | [sidecar/ai/tools/builtins/todo.py:46](../../sidecar/ai/tools/builtins/todo.py#L46) |
| `CMP_TOOL_TODO_OVERFLOW` | `CMP-TOOL-0015` | Todo list exceeds max items | No | `runtime_error` | "Todo list capacity exceeded." | [sidecar/ai/tools/builtins/todo.py:51](../../sidecar/ai/tools/builtins/todo.py#L51) |
| `CMP_TOOL_BACKGROUND_NOT_FOUND` | `CMP-TOOL-0016` | Background shell handle not found | No | `runtime_error` | "Background task not found." | [sidecar/ai/tools/builtins/shell.py:343](../../sidecar/ai/tools/builtins/shell.py#L343) |
| `CMP_TOOL_READ_SNAPSHOT_REQUIRED` | `CMP-TOOL-0018` | Edit needs prior Read snapshot | No | `runtime_error` | "Read the file before editing it." | [sidecar/ai/tools/builtins/file_state.py:213](../../sidecar/ai/tools/builtins/file_state.py#L213) |
| `CMP_TOOL_STALE_READ_SNAPSHOT` | `CMP-TOOL-0019` | Edit's read snapshot is stale | Yes | `runtime_error` | "File changed since last read; re-read and retry." | [sidecar/ai/tools/builtins/file_state.py:222](../../sidecar/ai/tools/builtins/file_state.py#L222) |
| `CMP_TOOL_MERMAID_VALIDATION` | `CMP-TOOL-0020` | Mermaid diagram failed validation | No | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/mermaid.py:99](../../sidecar/ai/tools/builtins/mermaid.py#L99) |
| `CMP_TOOL_MERMAID_UNSUPPORTED_TYPE` | `CMP-TOOL-0021` | Unsupported mermaid diagram type | No | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/mermaid.py:145](../../sidecar/ai/tools/builtins/mermaid.py#L145) |
| `CMP_TOOL_MERMAID_FORMAT` | `CMP-TOOL-0022` | Mermaid output format invalid | No | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/mermaid.py:332](../../sidecar/ai/tools/builtins/mermaid.py#L332) |
| `CMP_TOOL_MERMAID_OUTPUT_TOO_LARGE` | `CMP-TOOL-0023` | Mermaid render too large | No | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/mermaid.py:338](../../sidecar/ai/tools/builtins/mermaid.py#L338) |
| `CMP_TOOL_MERMAID_INTERNAL` | `CMP-TOOL-0024` | Mermaid internal renderer error | Conditional | `runtime_error` | internal-only | [sidecar/ai/tools/builtins/mermaid.py:446](../../sidecar/ai/tools/builtins/mermaid.py#L446) |
| `CMP_TOOL_APPLY_PATCH_PARSE_FAILED` | `CMP-TOOL-0025` | apply_patch envelope/section grammar invalid | No | `runtime_error` | "Patch could not be parsed: {detail}." | retired with `apply_patch` (replaced by `edit_file` in 1.0.0); constant kept in [sidecar/ai/error_codes.py](../../sidecar/ai/error_codes.py) |
| `CMP_TOOL_APPLY_PATCH_PREIMAGE_MISMATCH` | `CMP-TOOL-0026` | Hunk preimage did not match file contents | No | `runtime_error` | "Patch preimage did not match file contents." | retired with `apply_patch` (replaced by `edit_file` in 1.0.0); constant kept in [sidecar/ai/error_codes.py](../../sidecar/ai/error_codes.py) |
| `CMP_TOOL_APPLY_PATCH_PARTIAL_ROLLBACK` | `CMP-TOOL-0027` | apply_patch rolled back partially; some files left in uncertain state | No | `runtime_error` | "Patch failed; some files could not be restored." | retired with `apply_patch` (replaced by `edit_file` in 1.0.0); constant kept in [sidecar/ai/error_codes.py](../../sidecar/ai/error_codes.py) |
| `CMP_TOOL_APPLY_PATCH_TARGET_EXISTS` | `CMP-TOOL-0028` | apply_patch Add target already exists | No | `runtime_error` | "Cannot add file: target already exists." | retired with `apply_patch` (replaced by `edit_file` in 1.0.0); constant kept in [sidecar/ai/error_codes.py](../../sidecar/ai/error_codes.py) |
| `CMP_TOOL_APPLY_PATCH_TARGET_MISSING` | `CMP-TOOL-0029` | apply_patch Update/Delete target missing | No | `runtime_error` | "Cannot modify file: target does not exist." | retired with `apply_patch` (replaced by `edit_file` in 1.0.0); constant kept in [sidecar/ai/error_codes.py](../../sidecar/ai/error_codes.py) |
| `CMP_TOOL_SUBAGENT_INVALID_PROMPT` | `CMP-TOOL-0030` | A delegate task or hidden legacy prompt is blank, malformed, or exceeds its UTF-8 bound | No | `runtime_error` | "Sub-agent prompt invalid." | [sidecar/ai/routing/delegate_contracts.py](../../sidecar/ai/routing/delegate_contracts.py) |
| `CMP_TOOL_SUBAGENT_INVALID_GRANTS` | `CMP-TOOL-0031` | Delegate arguments conflict, contain unknown fields, or use an ambiguous task-object shape; hidden legacy grant validation uses the same code | No | `runtime_error` | "Sub-agent grants invalid." | [sidecar/ai/routing/delegate_contracts.py](../../sidecar/ai/routing/delegate_contracts.py) |
| `CMP_TOOL_SUBAGENT_DEPTH_LIMIT` | `CMP-TOOL-0032` | `delegate` or a hidden legacy executor was called from inside another sub-agent | No | `runtime_error` | "Sub-agents cannot nest." | [sidecar/ai/routing/delegate_contracts.py](../../sidecar/ai/routing/delegate_contracts.py) |
| `CMP_TOOL_SUBAGENT_MUTATING_REQUIRES_WORKTREE` | `CMP-TOOL-0033` | A single-child or batch task requested a mutating family unavailable in the read-only MVP | No | `runtime_error` | "Mutating sub-agent requires a worktree." | [sidecar/ai/routing/subagent_run.py](../../sidecar/ai/routing/subagent_run.py) |
| `CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED` | `CMP-TOOL-0034` | Parent-derived child deadline or configured iteration safety ceiling was exhausted; delegate accepts a nonblank work-limit final as partial, while deadline without an answer, blank/hard exhaustion, and hidden legacy invalid finalization fail | No | `runtime_error` | Deadline: "Sub-agent reached the parent turn deadline before producing an answer." Work limit: "Sub-agent exceeded its budget." | [sidecar/ai/routing/subagent_scheduler.py](../../sidecar/ai/routing/subagent_scheduler.py) |
| `CMP_TOOL_RICH_FILES_MIME_MISMATCH` | `CMP-TOOL-0035` | rich-file adapter received wrong MIME prefix | No | `runtime_error` | "File type does not match the requested adapter." | [sidecar/ai/tools/builtins/rich_files/base.py](../../sidecar/ai/tools/builtins/rich_files/base.py) |
| `CMP_TOOL_RICH_FILES_TOO_LARGE` | `CMP-TOOL-0036` | rich-file source exceeds the per-call byte limit | No | `runtime_error` | "File exceeds the rich-file size limit." | [sidecar/ai/tools/builtins/rich_files/base.py](../../sidecar/ai/tools/builtins/rich_files/base.py) |
| `CMP_TOOL_RICH_FILES_UNSUPPORTED` | `CMP-TOOL-0037` | rich-file MIME could not be determined for an adapter requiring it | No | `runtime_error` | "Unsupported file type for this adapter." | [sidecar/ai/tools/builtins/rich_files/base.py](../../sidecar/ai/tools/builtins/rich_files/base.py) |
| `CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING` | `CMP-TOOL-0038` | rich-file adapter optional dependency (Pillow/PyMuPDF/...) not installed | No | `runtime_error` | "Optional dependency missing for this file type." | [sidecar/ai/tools/builtins/rich_files/base.py](../../sidecar/ai/tools/builtins/rich_files/base.py) |
| `CMP_TOOL_POLICY_DENIED` / `TOOL_ERROR_CODES.POLICY_DENIED` (Node) | `CMP-TOOL-0039` | Tool permission policy denied execution before approval/dispatch | No | `denied` | "Tool was denied by policy." | [sidecar/ai/routing/tool_loop.py](../../sidecar/ai/routing/tool_loop.py), [services/tools/tool-executor.js](../../services/tools/tool-executor.js) |
| `CMP_TOOL_SKILL_NOT_FOUND` | `CMP-TOOL-0040` | `load_skill` was called with a name/scope that does not resolve to an indexed skill | No | `runtime_error` | "unknown skill '{name}'. Available skills: ..." | [sidecar/ai/tools/builtins/skills.py](../../sidecar/ai/tools/builtins/skills.py) |
| `CMP_TOOL_COMMAND_ABORTED` | `CMP-TOOL-0041` | `run_command` subprocess tree was terminated because the user cancelled the turn (cooperative MCP `notifications/cancelled`) | No | `runtime_error` | "command aborted by user cancellation" | [sidecar/ai/tools/builtins/shell.py](../../sidecar/ai/tools/builtins/shell.py) |
| `CMP_TOOL_APPROVAL_WINDOW_DROPPED` | `CMP-TOOL-0042` | Call was admitted into the turn's tool budget but fell outside the approval resume window, so it was never dispatched | No | `runtime_error` | "Tool was not executed: it was not part of the approved execution window for this turn." | [sidecar/runtime/chat_resume.py](../../sidecar/runtime/chat_resume.py) |
| `CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND` | `CMP-TOOL-0043` | Requested worktree baseline is missing, expired, evicted, or belongs to another session/repository | No | `runtime_error` | "Worktree baseline is missing or expired; capture a new workspace_change_baseline." | [sidecar/ai/tools/builtins/worktree_change_tracking.py](../../sidecar/ai/tools/builtins/worktree_change_tracking.py) |
| `CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED` / `TOOL_ERROR_CODES.PLACEHOLDER_ARGUMENTS_REJECTED` (Node) | `CMP-TOOL-0044` | Model echoed the schema example instead of real arguments (the whole argument object is the generated minimal example and that example contains a `<string>`/`<value>` placeholder, or -- for a side-effecting or descriptor-less tool -- any argument value is such a placeholder); settled before dispatch so the call never reaches the pre-mutation auto-checkpoint | No | `runtime_error` | "Tool '{name}' was not executed: the arguments are the schema example placeholders, not real values. Supply real arguments, or if no tool is needed, answer the user directly." | [sidecar/ai/routing/tool_call_execution.py](../../sidecar/ai/routing/tool_call_execution.py) |
| `CMP_TOOL_PRECONDITION_UNMET` | `CMP-TOOL-0045` | A declared tool precondition (e.g. `git_repo` for the git read tools and worktree change tracking) is unmet at call time; the tool stays listed but blocked until the precondition is satisfied | No | `runtime_error` | "'{cwd}' is not a git repository..." (git ops) / "worktree tracking requires a git repository within the workspace" | [sidecar/ai/tools/builtins/git_ops.py](../../sidecar/ai/tools/builtins/git_ops.py) |

## MEM â€” `CMP-MEM-NNNN` (9 codes, 0 dead)

Approved-memory store: persistence, validation, schema migration.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_MEMORY_FAILED` | `CMP-MEM-0001` | Memory operation failed (generic) | Conditional | `runtime_error` | "Memory operation failed." | [sidecar/ai/memory/store.py:124](../../sidecar/ai/memory/store.py#L124) |
| `CMP_MEMORY_FINGERPRINT_CONFLICT` | `CMP-MEM-0002` | Memory fingerprint collision | No | `runtime_error` | "Duplicate memory entry." | [sidecar/ai/memory/store.py:698](../../sidecar/ai/memory/store.py#L698) |
| `CMP_MEMORY_INVALID_KIND` | `CMP-MEM-0003` | Lesson kind not recognized | No | `runtime_error` | "Invalid memory kind: {kind}." | [sidecar/runtime/memory.py:113](../../sidecar/runtime/memory.py#L113) |
| `CMP_MEMORY_NOT_FOUND` | `CMP-MEM-0004` | Memory id not found | No | `runtime_error` | "Memory entry not found." | [sidecar/ai/memory/store.py:482](../../sidecar/ai/memory/store.py#L482) |
| `CMP_MEMORY_SCHEMA_MIGRATION` | `CMP-MEM-0005` | Schema migration failed | No | `runtime_error` | "Memory database upgrade failed." | [sidecar/ai/memory/store_migrations.py:65](../../sidecar/ai/memory/store_migrations.py#L65) |
| `CMP_MEMORY_FAMILY_UNRESOLVED` | `CMP-MEM-0006` | Memory family lookup failed | No | `runtime_error` | "Memory family unresolved." | [sidecar/runtime/memory.py:126](../../sidecar/runtime/memory.py#L126) |
| `CMP_MEMORY_CAPACITY_EXCEEDED` | `CMP-MEM-0007` | Physical SQLite capacity is exhausted; existing approved rows are preserved | Yes | `runtime_error` | "Memory storage capacity exceeded." | [sidecar/ai/memory/store.py](../../sidecar/ai/memory/store.py) |
| `CMP_MEMORY_ROW_QUARANTINED` | `CMP-MEM-0008` | One malformed legacy row was quarantined while the store remained available | No | `runtime_error` | "A malformed memory row was quarantined." | [sidecar/ai/memory/store.py](../../sidecar/ai/memory/store.py) |
| `CMP_MEMORY_BACKGROUND_TIMEOUT` | `CMP-MEM-0009` | A bounded background memory worker exceeded its deadline | Yes | `runtime_error` | "A background memory task timed out." | [sidecar/runtime/subprocess_manager.py](../../sidecar/runtime/subprocess_manager.py) |

## MODE â€” `CMP-MODE-NNNN` (1 active code, 1 retired number)

Companion-mode policy violations.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| (retired) | `CMP&#8209;MODE&#8209;0001` | Retired; number reserved | - | - | - | Retired |
| `CMP_MODE_TOOL_BLOCKED` | `CMP-MODE-0002` | Tool blocked by current mode | No | `runtime_error` | "This tool is unavailable in {mode} mode." | [sidecar/ai/tools/assembly.py:151](../../sidecar/ai/tools/assembly.py#L151) |

## MCP â€” `CMP-MCP-NNNN` (9 codes, 0 dead)

External MCP server integration.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_MCP_CONFIG_INVALID` | `CMP-MCP-0001` | MCP config payload invalid | No | `runtime_error` | "MCP server config invalid: {detail}." | [sidecar/ai/config.py:300](../../sidecar/ai/config.py#L300) |
| `CMP_MCP_SSE_DISABLED` | `CMP-MCP-0002` | SSE transport disabled | No | `runtime_error` | "MCP SSE transport disabled." | [sidecar/ai/config.py:317](../../sidecar/ai/config.py#L317) |
| `CMP_MCP_TOOL_NOT_FOUND` | `CMP-MCP-0003` | MCP tool not advertised | No | `runtime_error` | "MCP tool not found: {name}." | [sidecar/ai/mcp/client.py:152](../../sidecar/ai/mcp/client.py#L152) |
| `CMP_MCP_SERVER_FAILED` | `CMP-MCP-0004` | MCP server returned error | Conditional | `runtime_error` | "MCP server error: {detail}." | [sidecar/ai/mcp/builtin_server.py:216](../../sidecar/ai/mcp/builtin_server.py#L216) |
| `CMP_MCP_PROTOCOL_FAILED` | `CMP-MCP-0005` | MCP protocol violation | No | `runtime_error` | "MCP protocol error." | [sidecar/ai/mcp/builtin_server.py:180](../../sidecar/ai/mcp/builtin_server.py#L180) |
| `CMP_MCP_RESOURCE_UNSUPPORTED` | `CMP-MCP-0006` | MCP resource cannot be returned inline | No | `runtime_error` | "MCP resource is unsupported." | [sidecar/ai/mcp/client.py:795](../../sidecar/ai/mcp/client.py#L795) |
| `CMP_MCP_RESOURCE_NOT_FOUND` | `CMP-MCP-0007` | MCP resource id is unknown for this server | No | `runtime_error` | "MCP resource not found." | [sidecar/ai/mcp/client.py:775](../../sidecar/ai/mcp/client.py#L775) |
| `CMP_MCP_RESOURCE_INVALID` | `CMP-MCP-0008` | MCP resource request is malformed | No | `runtime_error` | "MCP resource request is invalid." | [sidecar/ai/mcp/client.py:742](../../sidecar/ai/mcp/client.py#L742) |
| `CMP_MCP_TOOL_SURFACE_CHANGED` | `CMP-MCP-0009` | Approved MCP server advertised a materially different tool surface | No | `runtime_error` | "MCP tool review is stale; review this connection again." | [sidecar/ai/mcp/client.py](../../sidecar/ai/mcp/client.py) |

## CTX â€” `CMP-CTX-NNNN` (2 codes, 0 dead)

Context-builder failures: skill loading, workspace, compaction.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_CTX_SKILL_INVALID` | `CMP-CTX-0001` | Skill manifest invalid | No | `runtime_error` | "Skill {name} failed to load." | [sidecar/ai/context/builder.py:172](../../sidecar/ai/context/builder.py#L172) |
| `CMP_CTX_BUDGET_EXHAUSTED` | `CMP-CTX-0002` | Context remains over budget after compaction or runtime-overlay reinsertion | No | `runtime_error` | Bounded guidance to start a new thread or reduce active context | [sidecar/ai/routing/chat_decision.py](../../sidecar/ai/routing/chat_decision.py) |

## CFG — `CMP-CFG-NNNN` (1 code, 0 dead)

Configuration / setup preconditions: a required setting is missing (not a runtime fault). Routed by the Node classifier to the `setup` recovery class (Open settings + Open diagnostics), so the card reads "Setup required" instead of borrowing the context-window remediation.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_CFG_WORKSPACE_MISSING` | `CMP-CFG-0001` | Request explicitly enabled only workspace-requiring tools, but no workspace root is configured (the default no-root case degrades silently instead) | No | `runtime_error` | "Every enabled tool requires a workspace root, but none is configured. Set a workspace root in Settings, then try again." | [sidecar/runtime/request_dispatch.py:820](../../sidecar/runtime/request_dispatch.py#L820) |

## LOOP â€” `CMP-LOOP-NNNN` (12 Python + 3 Node peer codes, 0 dead)

Tool-loop runtime: stop conditions, generation failures, validation.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_LOOP_MAX_ITERATIONS` | `CMP-LOOP-0001` | Loop hit max iteration cap | No | `runtime_error` | "Tool loop reached its iteration limit." | [sidecar/runtime/chat.py:873](../../sidecar/runtime/chat.py#L873) |
| `CMP_LOOP_INVALID_TOOL_CALL` / `LOOP_PROTOCOL_ERROR_CODES.INVALID_TOOL_CALL` (Node) | `CMP-LOOP-0002` | Model emitted malformed tool call | No | `runtime_error` | "Invalid tool call from model." | [sidecar/ai/routing/tool_execution.py:121](../../sidecar/ai/routing/tool_execution.py#L121) |
| `CMP_LOOP_GENERATION_FAILED` | `CMP-LOOP-0003` | Generation step raised | Conditional | `runtime_error` | "Generation failed: {detail}." | [sidecar/ai/routing/generation_runtime.py:404](../../sidecar/ai/routing/generation_runtime.py#L404) |
| `LOOP_PROTOCOL_ERROR_CODES.TEXT_AND_TOOL_CALLS` (Node) | `CMP-LOOP-0004` | Assistant returned both text and tool calls | No | `runtime_error` | "Loop protocol error: text and tool calls in same response." | services/backend/tool-loop.js:350 |
| `CMP_LOOP_WALL_CLOCK_EXCEEDED` | `CMP-LOOP-0010` | Wall-clock budget exceeded | No | `timeout` | "Tool loop timed out." | [sidecar/ai/routing/loop_stop.py:118](../../sidecar/ai/routing/loop_stop.py#L118) |
| `CMP_LOOP_BUDGET_EXCEEDED` | `CMP-LOOP-0011` | Token/cost budget exceeded | No | `runtime_error` | "Tool loop budget exceeded." | [sidecar/ai/routing/loop_stop.py:147](../../sidecar/ai/routing/loop_stop.py#L147) |
| `CMP_LOOP_TOOL_INTERRUPTED` (Python) / `LOOP_PROTOCOL_ERROR_CODES.TOOL_INTERRUPTED` (Node) | `CMP-LOOP-0013` | Tool execution interrupted; emitted by recovery to fill orphaned tool_use slots | Yes | `cancelled` | "System error: tool execution interrupted. Retry if needed." | [services/session-recovery-service.js:109](../../services/session-recovery-service.js#L109) |
| `CMP_LOOP_CYCLE_DETECTED` | `CMP-LOOP-0014` | Loop detected repeating cycle | No | `runtime_error` | "Tool loop is repeating itself; stopping." | [sidecar/ai/routing/loop_stop.py:179](../../sidecar/ai/routing/loop_stop.py#L179) |
| `CMP_LOOP_ENGINE_STALLED` | `CMP-LOOP-0015` | Active provider leg produced no new output within its engine-profile inactivity window | Yes | `runtime_error` | Engine-aware retry guidance for a local-model or cloud-provider stall. | [sidecar/ai/routing/tool_loop_run.py](../../sidecar/ai/routing/tool_loop_run.py) |
| `CMP_LOOP_TOOL_INPUT_VALIDATION` | `CMP-LOOP-0016` | Tool args failed schema validation | No | `runtime_error` | "Tool argument validation failed: {detail}." | [sidecar/ai/routing/tool_execution.py:638](../../sidecar/ai/routing/tool_execution.py#L638) |
| `CMP_LOOP_REPEATED_ERRORS` | `CMP-LOOP-0017` | Deterministic harness detected repeated tool errors | No | `runtime_error` | "Tool loop is repeating errors; stopping." | [sidecar/ai/routing/loop_stop.py](../../sidecar/ai/routing/loop_stop.py) |
| `CMP_LOOP_REPEATED_OBSERVATIONS` | `CMP-LOOP-0018` | Deterministic harness detected repeated tool observations | No | `runtime_error` | "Tool loop is repeating observations; stopping." | [sidecar/ai/routing/loop_stop.py](../../sidecar/ai/routing/loop_stop.py) |
| `CMP_LOOP_STUCK_SUSPECTED` | `CMP-LOOP-0019` | Deterministic harness suspected a semantic stuck loop | No | `runtime_error` | "Tool loop appears stuck; stopping." | [sidecar/ai/routing/loop_stop.py](../../sidecar/ai/routing/loop_stop.py) |

## AI â€” `CMP-AI-NNNN` (5 active Python codes + 2 Node peer codes, 2 retired numbers)

Engine layer (model load/connection/generation). Python engine errors flow through the typed exception hierarchy in [sidecar/ai/exceptions.py](../../sidecar/ai/exceptions.py), which sets `error_code` from imported constants in [sidecar/ai/error_codes.py](../../sidecar/ai/error_codes.py). Node peers cover Electron-owned provider classification and managed Ollama preflight paths.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_AI_MODEL_NOT_LOADED` | `CMP-AI-0001` | No model loaded | No | `runtime_error` | "No model is loaded." | [sidecar/ai/engines/ollama.py:738](../../sidecar/ai/engines/ollama.py#L738) |
| `CMP_AI_ENGINE_CONNECTION` / `AI_ERROR_CODES.ENGINE_CONNECTION` (Node preflight peer) | `CMP-AI-0002` | Engine connection lost | Yes | `runtime_error` | "Lost connection to model engine." | [sidecar/ai/exceptions.py:66](../../sidecar/ai/exceptions.py#L66), [services/backend/managed-sidecar-chat-reconnect.js](../../services/backend/managed-sidecar-chat-reconnect.js) |
| `CMP_AI_RATE_LIMIT` / `AI_ERROR_CODES.RATE_LIMIT` (Node classifier peer) | `CMP-AI-0003` | Provider rate-limited | Yes | `runtime_error` | "Rate-limited; retrying..." | [services/backend/chat-error-recovery.js:143](../../services/backend/chat-error-recovery.js#L143) |
| (retired) | `CMP&#8209;AI&#8209;0004` | Retired; number reserved | - | - | - | Retired |
| `CMP_AI_GENERATION` | `CMP-AI-0005` | Generation failed | Conditional | `runtime_error` | "Model generation failed." | [sidecar/ai/engines/ollama_runtime.py:226](../../sidecar/ai/engines/ollama_runtime.py#L226) |
| `CMP_AI_UNSUPPORTED_MODAL` | `CMP-AI-0006` | Unsupported modality | No | `runtime_error` | "This model doesn't support {modality}." | [sidecar/ai/engines/ollama.py:700](../../sidecar/ai/engines/ollama.py#L700) |
| (retired) | `CMP&#8209;AI&#8209;0007` | Retired; number reserved | - | - | - | Retired |

## CHAT â€” `CMP-CHAT-NNNN` (2 Python + 1 Node = 3 codes, 0 dead)

Chat-stream parameter validation and serialization.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_CHAT_INVALID_PARAMS` | `CMP-CHAT-0001` | Chat request payload invalid | No | `runtime_error` | internal-only | [sidecar/runtime/chat.py:1577](../../sidecar/runtime/chat.py#L1577) |
| `CMP_CHAT_STREAM_FAILED` | `CMP-CHAT-0002` | Chat stream failed mid-stream | Conditional | `runtime_error` | "Chat stream failed." | [sidecar/runtime/chat_serialization.py:117](../../sidecar/runtime/chat_serialization.py#L117) |
| `CHAT_PROTOCOL_ERROR_CODES.REASONING_AFTER_VISIBLE` (Node) | `CMP-CHAT-0013` | Reasoning emitted after visible text | No | `runtime_error` | "Transcript protocol error: reasoning after visible text." | [services/backend/chat-stream-managed-runtime.js:246](../../services/backend/chat-stream-managed-runtime.js#L246) |

## BG — `CMP-BG-NNNN` (1 code, 0 dead)

Internal background scheduler RPC validation.

| Constant | Code | Meaning | Retryable? | Terminal state | User-facing default | Primary source |
|---|---|---|---|---|---|---|
| `CMP_BACKGROUND_INVALID_PARAMS` | `CMP-BG-0001` | `background.run` payload invalid | No | `runtime_error` | internal-only | [sidecar/runtime/request_dispatch_background.py](../../sidecar/runtime/request_dispatch_background.py) |

## STREAM - sentinel codes

Provider-stream normalization failures that intentionally do not use the numeric domain schema because they predate the registry reconciliation and are wire-stable deterministic-harness sentinels.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_STREAM_REASONING_ONLY` | `CMP-STREAM-REASONING-ONLY` | Provider produced reasoning deltas but no visible text or tool call | No | `runtime_error` | "The model returned reasoning without an answer." | [sidecar/ai/routing/provider_stream_normalizer.py](../../sidecar/ai/routing/provider_stream_normalizer.py) |
| `CMP_STREAM_INCOMPLETE` | `CMP-STREAM-INCOMPLETE` | Provider stream ended without a clean terminal: EOF before Ollama's `done` chunk or vLLM's `[DONE]` sentinel (`finish_reason=incomplete`), an in-band provider error frame (`finish_reason=error`), or a thinking-budget abort (`finish_reason=thinking_budget`) | Yes | `runtime_error` (`terminal_subcode=stream_incomplete` or `thinking_budget`) | Per-reason: "The response was cut off before it finished ..." / "The model provider reported a stream error ..." / "The model spent its entire thinking budget ..." | [sidecar/ai/routing/tool_loop_finalize.py](../../sidecar/ai/routing/tool_loop_finalize.py), [sidecar/runtime/chat_streaming.py](../../sidecar/runtime/chat_streaming.py) |

## ROUTE - sentinel codes

Routing-layer fail-closed and policy sentinel codes from the deterministic harness.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_ROUTE_TOOL_DISABLED` | `CMP-ROUTE-TOOL-DISABLED` | Native tool is disabled by route policy | No | `runtime_error` | "This tool is disabled." | [sidecar/ai/routing/tool_execution.py](../../sidecar/ai/routing/tool_execution.py) |
| `CMP_ROUTE_FAIL_CLOSED` | `CMP-ROUTE-FAIL-CLOSED` | Routing policy failed closed instead of dispatching an unsafe tool path | No | `runtime_error` | "Tool routing failed closed." | [sidecar/ai/routing/tool_execution.py](../../sidecar/ai/routing/tool_execution.py) |

## APPROVAL - sentinel codes

Approval cancellation sentinel codes surfaced through the existing `chat.error` and `tool.result` paths.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_APPROVAL_REJECTED` | `CMP-APPROVAL-REJECTED` | User rejected a tool approval request | No | `denied` | "Tool execution was denied." | [sidecar/runtime/chat_helpers.py](../../sidecar/runtime/chat_helpers.py) |

## PLUGIN - `CMP-PLUGIN-NNNN` (35 Node codes, pre-allocated)

Plugin-platform control plane (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md).
Codes are pre-allocated at Wave 0 of the execution program; consumers land stage
by stage under docs/manifests/plugin-system.md.
`services/plugins/**` must import from
[services/backend/error-codes.js](../../services/backend/error-codes.js) — inline
literals are banned by `check_error_codes.py`.

Program range allocations (numeric wire-code ranges reserved per packet; new
packets claim the next free 20-block): 0001–0025 control-plane core ·
0026–0035 Stage 5 distribution/network/auth/remote-MCP foundation (below) ·
0101–0120 W1 identity/package · 0121–0140 W2 policy/authority · 0141–0160
W3/W4 store + durability · 0161–0180 W5 invocation + view · 0181–0200 W6
data/compatibility · 0201–0220 Stage 3B lifecycle/IPC/consent.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `PLUGIN_ERROR_CODES.MANIFEST_INVALID` | `CMP-PLUGIN-0001` | Plugin manifest failed contract validation | No | `runtime_error` | "This plugin's manifest is invalid." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION` | `CMP-PLUGIN-0002` | Contract/schema version newer than this Jenny understands | No | `runtime_error` | "This plugin requires a newer version of Jenny." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.ARCHIVE_REJECTED` | `CMP-PLUGIN-0003` | Package archive failed structural/hostile-entry validation | No | `runtime_error` | "This plugin package is malformed and was rejected." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.INTEGRITY_FAILED` | `CMP-PLUGIN-0004` | Content digest disagreement with the verified record | No | `runtime_error` | "This plugin failed integrity verification." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.SIGNATURE_INVALID` | `CMP-PLUGIN-0005` | Canonical signed metadata failed signature verification | No | `runtime_error` | "This plugin's signature could not be verified." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED` | `CMP-PLUGIN-0006` | Publisher identity not in the trusted set | No | `runtime_error` | "This plugin's publisher is not trusted." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.GENERATION_INVALID` | `CMP-PLUGIN-0007` | Control-plane generation failed schema/digest/closure validation | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.POINTER_CORRUPT` | `CMP-PLUGIN-0008` | active-generation pointer unreadable or digest-mismatched | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.EPOCH_REGRESSION` | `CMP-PLUGIN-0009` | Commit epoch not strictly increasing | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.LEASE_BUSY` | `CMP-PLUGIN-0010` | Another lifecycle operation holds the graph mutation lease | Yes | `runtime_error` | "Another plugin operation is in progress." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.EXPECTED_GENERATION_CONFLICT` | `CMP-PLUGIN-0011` | Expected-generation CAS failed at commit | Yes | `runtime_error` | "Plugin state changed underneath this operation; retry." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.IDEMPOTENCY_EXPIRED` | `CMP-PLUGIN-0012` | Operation receipt expired/pruned; replay refused | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE` | `CMP-PLUGIN-0013` | Operation outcome cannot be proven either way | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.FINGERPRINT_MISMATCH` | `CMP-PLUGIN-0014` | Same operation id with a different request fingerprint | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.POLICY_BLOCKED` | `CMP-PLUGIN-0015` | Effective policy denies the requested state/capability | No | `runtime_error` | "Policy blocks this plugin." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.QUARANTINED` | `CMP-PLUGIN-0016` | Integrity/revocation/vulnerability/crash-loop quarantine | No | `runtime_error` | "This plugin is quarantined." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.DEPENDENCY_UNSATISFIED` | `CMP-PLUGIN-0017` | Required dependency missing, blocked, or incompatible | No | `runtime_error` | "A plugin this depends on is unavailable." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.DATA_INCOMPATIBLE` | `CMP-PLUGIN-0018` | Plugin-data schema/migration incompatibility | No | `runtime_error` | "This plugin's data is incompatible with the installed version." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.CLEANUP_PENDING_RESTART` | `CMP-PLUGIN-0019` | Physical cleanup deferred to next restart (locked files) | No | `runtime_error` | "Cleanup will finish after a restart." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.CLEANUP_TERMINATION_FAILED` | `CMP-PLUGIN-0020` | Best-effort process/file cleanup could not be proven | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE` | `CMP-PLUGIN-0021` | Launch-level plugins-off switch active | No | `runtime_error` | "Plugins are disabled in safe mode." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.FEATURE_DISABLED` | `CMP-PLUGIN-0022` | Plugin platform feature flag is off | No | `runtime_error` | "The plugin system is not enabled." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.CONSENT_REQUIRED` | `CMP-PLUGIN-0023` | High-consequence operation lacks main-process consent | No | `runtime_error` | "This action needs explicit confirmation." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.CONSENT_ORIGIN_INVALID` | `CMP-PLUGIN-0024` | Approval did not originate from the consent surface (PLUG-D18) | No | `runtime_error` | internal-only | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.STORE_WRITE_FAILED` | `CMP-PLUGIN-0025` | Durable control-plane write failed | Yes | `runtime_error` | "Saving plugin state failed." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.SOURCE_UNAVAILABLE` | `CMP-PLUGIN-0026` | Selected package/catalog/Git/mirror source is unavailable | Yes | `runtime_error` | "This plugin source is unavailable." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.UPDATE_METADATA_INVALID` | `CMP-PLUGIN-0027` | Catalog, TUF, or advisory metadata failed validation | No | `runtime_error` | "Plugin update metadata is invalid." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.ROLLBACK_OR_FREEZE_DETECTED` | `CMP-PLUGIN-0028` | Version, metadata, or trusted-clock high-water regressed | No | `runtime_error` | "A stale or rolled-back update was blocked." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.ADVISORY_BLOCKED` | `CMP-PLUGIN-0029` | Current advisory or revocation blocks an artifact | No | `runtime_error` | "A security advisory blocks this plugin version." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.REMOTE_AUTH_REQUIRED` | `CMP-PLUGIN-0030` | Remote descriptor requires user authorization | No | `denied` | "This remote plugin connection needs authorization." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.REMOTE_AUTH_FAILED` | `CMP-PLUGIN-0031` | OAuth discovery, validation, exchange, or refresh failed | Yes | `runtime_error` | "Remote plugin authorization failed." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.REMOTE_PROTOCOL_UNSUPPORTED` | `CMP-PLUGIN-0032` | Remote MCP protocol/feature/transport is outside Stage 5 | No | `runtime_error` | "This remote MCP server is not supported." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.REMOTE_TRANSPORT_FAILED` | `CMP-PLUGIN-0033` | Bounded remote MCP request failed | Yes | `runtime_error` | "The remote MCP request failed." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.OPERATION_CANCELLED` | `CMP-PLUGIN-0034` | Stage 5 operation was cancelled before commit | No | `cancelled` | "The plugin operation was cancelled." | [services/plugins/README.md](../../services/plugins/README.md) |
| `PLUGIN_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED` | `CMP-PLUGIN-0035` | Stage 5 hard byte/time/count/queue bound was exceeded | No | `runtime_error` | "This plugin operation exceeded a safety limit." | [services/plugins/README.md](../../services/plugins/README.md) |
| `CMP_PLUGIN_HOST_FAILED` | `CMP-PLUGIN-0036` | Privileged plugin-host authority, transport, frame, or terminal settlement failed | No | `runtime_error` | "The privileged plugin host could not complete this request." | [PLUGIN_SECURITY.md § Privileged plugin full-host operations](../PLUGIN_SECURITY.md#privileged-plugin-full-host-operations) |

## PROACTIVE - `CMP-PROACTIVE-NNNN` (1 Node code, 0 dead)

Electron-owned proactive reminder validation failures.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `PROACTIVE_ERROR_CODES.REMINDER_INVALID` | `CMP-PROACTIVE-0001` | Reminder label/prompt/count exceeds proactive limits | No | `runtime_error` | "Reminder label/prompt/count exceeds the configured limit." | [services/shell-config-service.js](../../services/shell-config-service.js) |

## SPELL - `CMP-SPELL-NNNN` (3 Node codes, 0 dead)

Composer spellcheck context-menu corrections. Chromium spellchecks the composer
natively, but `misspelledWord` / `dictionarySuggestions` are exposed only on the
main-process `webContents.on('context-menu')` event, so the bridge forwards that
slice and owns the two native corrections. Both channels resolve `{ ok, code }`
rather than throwing across the preload seam, so these three are the entire
failure vocabulary.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `SPELLCHECK_ERROR_CODES.INVALID_WORD` | `CMP-SPELL-0001` | Word is absent, non-string, or exceeds the bounded 256-character limit | No | `runtime_error` | "That word could not be corrected." | [services/main/spellcheck-menu-bridge.js](../../services/main/spellcheck-menu-bridge.js) |
| `SPELLCHECK_ERROR_CODES.UNAVAILABLE` | `CMP-SPELL-0002` | Target webContents or the native spellchecker is unavailable, or the sender failed trusted-sender authorization | No | `runtime_error` | "Spellcheck corrections are unavailable in this window." | [services/main/spellcheck-menu-bridge.js](../../services/main/spellcheck-menu-bridge.js) |
| `SPELLCHECK_ERROR_CODES.NATIVE_FAILED` | `CMP-SPELL-0003` | The native replaceMisspelling / addWordToSpellCheckerDictionary call threw | Yes | `runtime_error` | "The correction could not be applied." | [services/main/spellcheck-menu-bridge.js](../../services/main/spellcheck-menu-bridge.js) |

## PERS - `CMP-PERS-NNNN` (3 Node codes, 0 dead)

Personality workspace file writes and the schema v2 -> v3 migration. The
personality IPC surface resolves bounded `{ ok, code, failed }` envelopes rather
than throwing across the preload seam; workspace paths are never included, only
the section id (`personality` / `user` / `memory`).

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `PERSONALITY_ERROR_CODES.SAVE_PARTIAL_FAILURE` | `CMP-PERS-0001` | One of the personality files, or the agent name, could not be written; everything else in the same save landed and the failed target's last-good value is untouched. `failed[]` names the parts (`personality` / `user` / `memory` / `agentName`) | Yes | `ipc_result` | "Some of your personality changes could not be saved." | [services/personality-workspace-service.js](../../services/personality-workspace-service.js) |
| `PERSONALITY_ERROR_CODES.FILE_TOO_LARGE` | `CMP-PERS-0002` | A personality file exceeds the bounded 64 KiB limit on read, would exceed it on write, or is being overwritten while its on-disk copy is over the limit (refused unless the caller passes `force: true`, since an oversized file reads back empty) | No | `ipc_result` | "That file is larger than the 64 KiB personality limit." | [services/personality-workspace-service.js](../../services/personality-workspace-service.js) |
| `PERSONALITY_ERROR_CODES.MIGRATION_ROLLED_BACK` | `CMP-PERS-0003` | The v2 -> v3 workspace migration failed and every journalled mutation was rolled back; the recorded schema stays unadvanced | Yes | `internal` | internal-only (diagnostic) | [services/personality-workspace-migration.js](../../services/personality-workspace-migration.js) |

## COMPANION - `CMP-COMPANION-NNNN` (1 Node code, 0 dead)

Electron-owned Home (formerly Companion Home) follow-up validation failures.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `COMPANION_ERROR_CODES.FOLLOW_UP_INVALID` | `CMP-COMPANION-0001` | Follow-up label/body exceeds companion limits | No | `runtime_error` | "Follow-up label/body exceeds the configured limit." | [services/shell-config-service.js](../../services/shell-config-service.js) |

## SRV â€” `CMP-SRV-NNNN` (1 code, 0 dead)

Service-lifecycle errors.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_SRV_INITIALIZE_FAILED` | `CMP-SRV-0001` | Service initialization failed | No | `runtime_error` | internal-only | [sidecar/runtime/request_dispatch.py:1348](../../sidecar/runtime/request_dispatch.py#L1348) |

## RUNTIME â€” `CMP-RUNTIME-NNNN` (1 code, 0 dead)

Per-stream / per-process resource ceilings (see resource-budgets.md).

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_RESOURCE_EXCEEDED` | `CMP-RUNTIME-0001` | Active turn / process resource ceiling exceeded | Conditional | `runtime_error` | "Resource limit exceeded." | [sidecar/server.py:255](../../sidecar/server.py#L255) |

## PROTO â€” `CMP-PROTO-NNNN` (3 codes, 0 dead)

Protocol version and request identity contracts.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_PROTO_VERSION_MISMATCH` | `CMP-PROTO-0001` | API version mismatch sidecarâ†”backend | No | `runtime_error` | internal-only | [sidecar/runtime/request_dispatch.py:580](../../sidecar/runtime/request_dispatch.py#L580) |
| `CMP_PROTO_DUPLICATE_REQUEST_ID` | `CMP-PROTO-0002` | Duplicate active JSON-RPC request id | No | `runtime_error` | internal-only | [sidecar/server.py:269](../../sidecar/server.py#L269) |
| `CMP_PROTO_INVALID_ENVELOPE` | `CMP-PROTO-0003` | Invalid inbound JSON-RPC envelope | No | `runtime_error` | "Invalid JSON-RPC request." | [sidecar/runtime/rpc.py:57](../../sidecar/runtime/rpc.py#L57) |

## PERSIST â€” `CMP-PERSIST-NNNN` (3 Node codes, 0 dead)

Electron-owned persistence and import/export failures.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `PERSIST_ERROR_CODES.IMPORT_PARSE_ERROR` | `CMP-PERSIST-0001` | Session import payload is not valid JSON | No | `runtime_error` | "Session import failed because the selected file is not valid JSON." | [services/backend/session-export-import.js](../../services/backend/session-export-import.js) |
| `PERSIST_ERROR_CODES.IMPORT_FORMAT_MISMATCH` | `CMP-PERSIST-0002` | Session import payload is not a Jenny session export | No | `runtime_error` | "Session import failed because the selected file is not a Jenny session export." | [services/backend/session-export-import.js](../../services/backend/session-export-import.js) |
| `PERSIST_ERROR_CODES.IMPORT_ATTACHMENT_FAILED` | `CMP-PERSIST-0003` | Session import failed while restoring embedded media | Conditional | `runtime_error` | "Session import failed while restoring media attachment." | [services/backend/session-export-import.js](../../services/backend/session-export-import.js) |

## ARTIFACT - `CMP-ARTIFACT-NNNN` (16 Node codes, 0 dead)

Generated artifact workspace failures from `ArtifactWorkspaceService`.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_MISSING` | `CMP-ARTIFACT-0001` | Tools workspace root is not configured | No | `runtime_error` | "Tools workspace root is not configured." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE` | `CMP-ARTIFACT-0002` | Configured workspace root is not a directory | No | `runtime_error` | "Tools workspace root is unavailable." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.EXTENSION_INVALID` | `CMP-ARTIFACT-0003` | Extension failed shape validation | No | `runtime_error` | "Artifact extension must be a simple file extension." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.PATH_OUTSIDE_ROOT` | `CMP-ARTIFACT-0004` | Artifact metadata path is outside workspace root | No | `runtime_error` | "Artifact path is outside the configured workspace root." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.PATH_OUTSIDE_SCRATCH` | `CMP-ARTIFACT-0005` | Artifact metadata path is outside session scratch dir | No | `runtime_error` | "Artifact path is outside the session scratch directory." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES` | `CMP-ARTIFACT-0006` | Realpath containment check escaped expected parent | No | `runtime_error` | "Artifact real path escapes the session scratch directory." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.NOT_EDITABLE` | `CMP-ARTIFACT-0007` | Artifact is not editable inline | No | `runtime_error` | "Artifact is not editable in Jenny." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.OVERSIZED` | `CMP-ARTIFACT-0008` | Artifact exceeds inline editor cap | No | `runtime_error` | "Artifact exceeds Jenny's 512 KB inline editor limit." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.FILE_UNAVAILABLE` | `CMP-ARTIFACT-0009` | Artifact file is missing/unavailable for action | No | `runtime_error` | "Artifact file is unavailable." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.NOT_FOUND` | `CMP-ARTIFACT-0010` | Artifact id not found in session metadata | No | `runtime_error` | "Artifact not found for this session." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.REVEAL_UNAVAILABLE` | `CMP-ARTIFACT-0011` | Reveal-in-folder implementation unavailable | No | `runtime_error` | "Reveal in folder is unavailable." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.OPEN_UNAVAILABLE` | `CMP-ARTIFACT-0012` | External-open implementation unavailable | No | `runtime_error` | "Open externally is unavailable." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.DANGEROUS_EXTENSION` | `CMP-ARTIFACT-0013` | Artifact extension is unsafe for OS external action | No | `denied` | "Artifact extension is dangerous and cannot be opened externally." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.INVALID_SESSION` | `CMP-ARTIFACT-0014` | Session id is empty after sanitization | No | `runtime_error` | "A valid session id is required for artifact operations." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.INVALID_ARTIFACT_ID` | `CMP-ARTIFACT-0015` | Artifact id argument is empty | No | `runtime_error` | "Artifact id is required." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |
| `ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_STATE_DIR` | `CMP-ARTIFACT-0016` | Configured workspace root is Jenny's own `.jenny` state directory | No | `denied` | "Tools workspace root cannot be Jenny's own internal state directory (.jenny)." | [services/artifact-workspace-service.js](../../services/artifact-workspace-service.js) |

## WORKSPACEFS - `CMP-WORKSPACEFS-NNNN` (24 Node codes, 0 dead)

Workspace IDE page filesystem failures from `WorkspaceIdeService`, `VersionedWorkspaceFileService`, and `workspace-ide-watcher` (renderer-initiated, root-scoped file access). 0008-0009 cover root-generation leases, 0013 strict text encoding, 0021-0023 atomic-write seams, 0030s file ops (create/rename/delete), and 0050s search/watch.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `WORKSPACE_FS_ERROR_CODES.ROOT_MISSING` | `CMP-WORKSPACEFS-0001` | Tools workspace root is not configured | No | `runtime_error` | "No workspace root is configured; choose a workspace folder first." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.PATH_INVALID` | `CMP-WORKSPACEFS-0002` | Path failed the lexical relative-path gate (absolute, drive, UNC, `..`, NUL) | No | `runtime_error` | "Path must be a workspace-relative path." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT` | `CMP-WORKSPACEFS-0003` | Realpath or post-open containment escaped the workspace root (symlink/junction/swap) | No | `runtime_error` | "Path resolves outside the workspace root." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.NOT_FOUND` | `CMP-WORKSPACEFS-0004` | File does not exist in the workspace | No | `runtime_error` | "File not found in the workspace." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.NOT_A_FILE` | `CMP-WORKSPACEFS-0005` | Path is a directory or special file, not a regular file | No | `runtime_error` | "Path is not a regular file." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.NOT_A_DIRECTORY` | `CMP-WORKSPACEFS-0006` | listDirectory target is not a directory | No | `runtime_error` | "Path is not a directory." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.ROOT_INVALID` | `CMP-WORKSPACEFS-0007` | Configured workspace root is missing or not a directory on disk; mutators refuse instead of recreating it | No | `runtime_error` | "The workspace root folder is missing or invalid; re-select the workspace folder." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING` | `CMP-WORKSPACEFS-0008` | Root coordinator refused or invalidated an operation lease during a root transition | Yes | `runtime_error` | "The workspace root is changing; retry after the transition completes." | [services/versioned-workspace-file-service.js](../../services/versioned-workspace-file-service.js) |
| `WORKSPACE_FS_ERROR_CODES.STALE_GENERATION` | `CMP-WORKSPACEFS-0009` | Save request belongs to an older workspace-root generation | No | `runtime_error` | "Reload the file in the current workspace before saving." | [services/versioned-workspace-file-service.js](../../services/versioned-workspace-file-service.js) |
| `WORKSPACE_FS_ERROR_CODES.BINARY` | `CMP-WORKSPACEFS-0010` | NUL byte found in the first 8 KB scan | No | `runtime_error` | "File appears to be binary and cannot be opened as text." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.TOO_LARGE` | `CMP-WORKSPACEFS-0011` | File bytes or proposed text exceed the bounded editor read/write cap (5 MB default) | No | `runtime_error` | "File is too large to open or save in the editor." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.IMAGE_TOO_LARGE` | `CMP-WORKSPACEFS-0012` | Image exceeds the preview read cap (10 MB) | No | `runtime_error` | "Image is too large to preview." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING` | `CMP-WORKSPACEFS-0013` | Existing bytes are not strict UTF-8 text, carry an unsupported BOM, or editor text cannot round-trip safely | No | `runtime_error` | "File is not valid editable UTF-8 text." | [services/versioned-workspace-file-service.js](../../services/versioned-workspace-file-service.js) |
| `WORKSPACE_FS_ERROR_CODES.IMAGE_UNSUPPORTED` | `CMP-WORKSPACEFS-0014` | Versioned media read requested a path whose canonical/requested extension is not on the narrow image MIME allowlist | No | `runtime_error` | "Only supported workspace image files can be opened as images." | [services/versioned-workspace-file-service.js](../../services/versioned-workspace-file-service.js) |
| `WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT` | `CMP-WORKSPACEFS-0020` | On-disk mtime, opaque identity/hash version, or post-open file identity differs from the editor snapshot | Conditional | `runtime_error` | "File changed on disk since it was last loaded." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.ATOMIC_WRITE_FAILED` | `CMP-WORKSPACEFS-0021` | Exclusive temp was durable but atomic replacement failed; cleanup preserves the original target | Conditional | `runtime_error` | "The file could not be replaced atomically; the original was left intact." | [services/versioned-workspace-file-service.js](../../services/versioned-workspace-file-service.js) |
| `WORKSPACE_FS_ERROR_CODES.IO_FAILED` | `CMP-WORKSPACEFS-0022` | A versioned file IO seam failed and was safely bounded/redacted | Conditional | `runtime_error` | "The workspace file operation failed safely." | [services/versioned-workspace-file-service.js](../../services/versioned-workspace-file-service.js) |
| `WORKSPACE_FS_ERROR_CODES.WRITE_QUEUE_FULL` | `CMP-WORKSPACEFS-0023` | Bounded in-process versioned-write queue reached its pending-operation cap | Yes | `runtime_error` | "Too many workspace file writes are pending; retry shortly." | [services/versioned-workspace-file-service.js](../../services/versioned-workspace-file-service.js) |
| `WORKSPACE_FS_ERROR_CODES.EXISTS` | `CMP-WORKSPACEFS-0030` | createFile/createDirectory/rename target already exists | No | `runtime_error` | "A file or folder with that name already exists." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.TRASH_FAILED` | `CMP-WORKSPACEFS-0040` | Recycle-bin move failed or is unavailable (delete never hard-unlinks as a fallback) | Conditional | `runtime_error` | "Could not move the item to the recycle bin." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.WATCH_FAILED` | `CMP-WORKSPACEFS-0050` | Recursive fs.watch on the workspace root could not be created | Conditional | `runtime_error` | "Could not watch the workspace folder for changes." | [services/workspace-ide-watcher.js](../../services/workspace-ide-watcher.js) |
| `WORKSPACE_FS_ERROR_CODES.REVEAL_UNAVAILABLE` | `CMP-WORKSPACEFS-0060` | shell.showItemInFolder is unavailable (test / non-Electron shell) | No | `runtime_error` | "Reveal in File Explorer is unavailable in this shell mode." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.OPEN_UNAVAILABLE` | `CMP-WORKSPACEFS-0061` | shell.openPath is unavailable (test / non-Electron shell) | No | `runtime_error` | "Open in Default App is unavailable in this shell mode." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |
| `WORKSPACE_FS_ERROR_CODES.OPEN_FAILED` | `CMP-WORKSPACEFS-0062` | shell.openPath returned a non-empty error string | No | `runtime_error` | "The OS could not open the item." | [services/workspace-ide-service.js](../../services/workspace-ide-service.js) |

## TERMINAL - `CMP-TERMINAL-NNNN` (4 Node codes, 0 dead)

Workspace IDE integrated terminal. `WorkspaceTerminalService` is the piped
PowerShell session pinned to the tools workspace root; `WorkspacePtyService`
is the real ConPTY sibling (default-off `workspace_pty_terminal` flag,
`@lydell/node-pty`) and adds the `MODULE_LOAD_FAILED` fail-soft code.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `TERMINAL_ERROR_CODES.SPAWN_FAILED` | `CMP-TERMINAL-0001` | Shell executable failed to spawn | Conditional | `runtime_error` | "Could not start the terminal shell." | [services/workspace-terminal-service.js](../../services/workspace-terminal-service.js) |
| `TERMINAL_ERROR_CODES.ROOT_MISSING` | `CMP-TERMINAL-0002` | Tools workspace root is not configured | No | `runtime_error` | "No workspace root is configured; choose a workspace folder first." | [services/workspace-terminal-service.js](../../services/workspace-terminal-service.js) |
| `TERMINAL_ERROR_CODES.NO_SESSION` | `CMP-TERMINAL-0003` | write/signal arrived with no running session | No | `runtime_error` | "No terminal session is running." | [services/workspace-terminal-service.js](../../services/workspace-terminal-service.js) |
| `TERMINAL_ERROR_CODES.MODULE_LOAD_FAILED` | `CMP-TERMINAL-0004` | The `@lydell/node-pty` native module failed to load (missing prebuild / ABI mismatch) | No | `runtime_error` | "The terminal engine could not be loaded." | [services/workspace-pty-service.js](../../services/workspace-pty-service.js) |

## GIT - `CMP-GIT-NNNN` (8 Node codes, 0 dead)

Workspace IDE SCM foundation (`WorkspaceGitService`, the `workspaceGit.*` IPC namespace): default-off, renderer-initiated, root-scoped git access. NOTE: a non-git workspace, a disabled feature flag, and "nothing to commit" are NOT errors - they degrade to clean structured results (`isRepo:false` / `available:false` / `committed:false`); only the codes below are raised.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `WORKSPACE_GIT_ERROR_CODES.ROOT_MISSING` | `CMP-GIT-0001` | Tools workspace root is not configured | No | `runtime_error` | "No workspace root is configured; choose a workspace folder first." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |
| `WORKSPACE_GIT_ERROR_CODES.GIT_NOT_TOPLEVEL` | `CMP-GIT-0004` | Selected root is inside a repository but is not its toplevel; destructive git verbs refuse (carried on `ok:false` structured results, not raised) | No | `runtime_error` | "Git write actions require the workspace root to be the repository's top-level folder." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |
| `WORKSPACE_GIT_ERROR_CODES.PATH_INVALID` | `CMP-GIT-0002` | Path failed the lexical relative-path gate (absolute, drive, `..`, NUL, leading dash) | No | `runtime_error` | "Path must be a workspace-relative path." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |
| `WORKSPACE_GIT_ERROR_CODES.PATH_OUTSIDE_ROOT` | `CMP-GIT-0003` | Realpath containment escaped the workspace root (symlink/junction) | No | `runtime_error` | "Path resolves outside the workspace root." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |
| `WORKSPACE_GIT_ERROR_CODES.REF_INVALID` | `CMP-GIT-0010` | Branch/ref failed the safe-shape validator (branchNameIsSafe/baseRefIsSafe) | No | `runtime_error` | "Invalid branch or ref name." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |
| `WORKSPACE_GIT_ERROR_CODES.LINE_RANGE_INVALID` | `CMP-GIT-0011` | Blame line range out of bounds (start < 1, end < start, or span > 2000) | No | `runtime_error` | "Invalid line range for blame." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |
| `WORKSPACE_GIT_ERROR_CODES.COMMIT_MESSAGE_EMPTY` | `CMP-GIT-0020` | commit() called with a blank message | No | `runtime_error` | "Commit message cannot be empty." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |
| `WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED` | `CMP-GIT-0040` | git subprocess exited non-zero (message token-masked before surfacing) | Conditional | `runtime_error` | "Git command failed." | [services/workspace-git-service.js](../../services/workspace-git-service.js) |

## TESTRUNNER - `CMP-TESTRUNNER-NNNN` (6 Node codes, 0 dead)

Workspace IDE Test Runner (`WorkspaceTestRunnerService`, the `workspaceTestRunner.*` IPC namespace): default-off, renderer-initiated, root-scoped headless test-command execution feeding the Home trend widget. NOTE: a suite that ran and FAILED is NOT an error - it degrades to a structured run record (`status:'failed'`); a process that never started records `status:'error'` with `SPAWN_FAILED` on the record. Only the codes below are raised as a CMP envelope.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING` | `CMP-TESTRUNNER-0001` | Tools workspace root is not configured | No | `runtime_error` | "No workspace root is configured; choose a workspace folder first." | [services/workspace-test-runner-service.js](../../services/workspace-test-runner-service.js) |
| `WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND` | `CMP-TESTRUNNER-0002` | run() called with an unknown test-configuration id | No | `runtime_error` | "That test configuration no longer exists." | [services/workspace-test-runner-service.js](../../services/workspace-test-runner-service.js) |
| `WORKSPACE_TEST_RUNNER_ERROR_CODES.CWD_OUTSIDE_ROOT` | `CMP-TESTRUNNER-0003` | run()'s effective working directory resolves (realpath) outside the workspace root; the run is rejected before any spawn or history write | No | `runtime_error` | "The test working directory must stay inside the workspace." | [services/workspace-test-runner-service.js](../../services/workspace-test-runner-service.js) |
| `WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_ACTIVE_RUN` | `CMP-TESTRUNNER-0004` | saveConfigs() called with a set that drops the configuration with an active run | No | `runtime_error` | "That configuration has an active test run and cannot be removed until it finishes or is stopped." | [services/workspace-test-runner-service.js](../../services/workspace-test-runner-service.js) |
| `WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING` | `CMP-TESTRUNNER-0010` | run() called while a run is already active (single-run lock) | Conditional | `runtime_error` | "A test run is already in progress." | [services/workspace-test-runner-service.js](../../services/workspace-test-runner-service.js) |
| `WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED` | `CMP-TESTRUNNER-0030` | The test command process could not be spawned (ENOENT / bad cwd) | Conditional | `runtime_error` | "Could not start the test command." | [services/backend/workspace-test-runner-runner.js](../../services/backend/workspace-test-runner-runner.js) |

## RUNTASK - `CMP-RUNTASK-NNNN` (4 Node codes, 0 dead)

Workspace IDE Run Scripts (`WorkspaceRunTaskService`, the `workspaceRunTask.*` IPC namespace; UIUX-014): each run/script spawns as its own isolated child process with a main-assigned `taskId` stamped on every data/exit bridge event — completion is the real OS close event, never renderer-inferred from output text. A command that ran and exited non-zero is NOT an error (structured exit payload); only the codes below are raised as a CMP envelope.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `RUN_TASK_ERROR_CODES.ROOT_MISSING` | `CMP-RUNTASK-0001` | Tools workspace root is not configured | No | `runtime_error` | "No workspace root is configured; choose a workspace folder first." | [services/workspace-run-task-service.js](../../services/workspace-run-task-service.js) |
| `RUN_TASK_ERROR_CODES.ALREADY_RUNNING` | `CMP-RUNTASK-0010` | start() called while a task is already active (single-task lock) | Conditional | `runtime_error` | "A task is already running." | [services/workspace-run-task-service.js](../../services/workspace-run-task-service.js) |
| `RUN_TASK_ERROR_CODES.SPAWN_FAILED` | `CMP-RUNTASK-0030` | The task's shell process could not be spawned (ENOENT / bad cwd / empty command) | Conditional | `runtime_error` | "Could not start the task." | [services/backend/workspace-run-task-runner.js](../../services/backend/workspace-run-task-runner.js) |
| `RUN_TASK_ERROR_CODES.NO_TASK` | `CMP-RUNTASK-0040` | start() called on a disposed service (shutdown/root-switch already tore it down) | No | `runtime_error` | "The run-task service has been disposed." | [services/workspace-run-task-service.js](../../services/workspace-run-task-service.js) |

## HARN - `CMP-HARN-NNNN` (1 code, 0 dead)

Headless harness errors (request-dispatch testbed).

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_HARNESS_TURN_NOT_FOUND` | `CMP-HARN-0001` | Harness turn id not found | No | `runtime_error` | "Turn not found." | [sidecar/runtime/request_dispatch_harness.py:234](../../sidecar/runtime/request_dispatch_harness.py#L234) |

## WEB â€” `CMP-WEB-NNNN` (6 codes, 0 dead)

Web-fetch tool: SSRF, rate limiting, fetch failures.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_WEB_SSRF_BLOCKED` | `CMP-WEB-0001` | URL resolves to private IP (SSRF) | No | `runtime_error` | "Blocked: URL resolves to private network." | [sidecar/ai/tools/builtins/web.py:628](../../sidecar/ai/tools/builtins/web.py#L628) |
| `CMP_WEB_RATE_LIMITED` | `CMP-WEB-0002` | Per-host rate limit hit | Yes | `runtime_error` | "Rate-limited; wait before retrying." | [sidecar/ai/tools/builtins/web.py:154](../../sidecar/ai/tools/builtins/web.py#L154) |
| `CMP_WEB_FETCH_FAILED` | `CMP-WEB-0004` | HTTP fetch raised | Conditional | `runtime_error` | "Fetch failed: {detail}." | [sidecar/ai/tools/builtins/web.py:455](../../sidecar/ai/tools/builtins/web.py#L455) |
| `CMP_WEB_REDIRECT_BLOCKED` | `CMP-WEB-0005` | Redirect chain blocked | No | `runtime_error` | "Redirect blocked." | [sidecar/ai/tools/builtins/web.py:647](../../sidecar/ai/tools/builtins/web.py#L647) |
| `CMP_WEB_CONTENT_TOO_LARGE` | `CMP-WEB-0006` | Response exceeds size limit | No | `runtime_error` | "Response too large." | [sidecar/ai/tools/builtins/web.py:446](../../sidecar/ai/tools/builtins/web.py#L446) |
| `CMP_WEB_INVALID_URL` | `CMP-WEB-0007` | URL parse failed | No | `runtime_error` | "Invalid URL: {url}." | [sidecar/ai/tools/builtins/web.py:506](../../sidecar/ai/tools/builtins/web.py#L506) |

## CACHE â€” `CMP-CACHE-NNNN` (1 code, 0 dead)

Prompt-cache instrumentation.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_CACHE_BREAK_DETECTED` | `CMP-CACHE-0001` | Prompt-cache break detected | No | `internal` | internal-only (telemetry) | [sidecar/ai/routing/generation_runtime.py:489](../../sidecar/ai/routing/generation_runtime.py#L489) |

## TSRCH â€” `CMP-TSRCH-NNNN` (2 active codes, 1 retired number)

Tool-search subsystem (deferred-tool resolution).

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| (retired) | `CMP&#8209;TSRCH&#8209;0001` | Retired; number reserved | - | - | - | Retired |
| `CMP_TSRCH_INVALID_QUERY` | `CMP-TSRCH-0002` | Tool search query invalid | No | `runtime_error` | "Tool search query invalid." | [sidecar/ai/tools/tool_search_handler.py:43](../../sidecar/ai/tools/tool_search_handler.py#L43) |
| `CMP_TSRCH_DEFERRED_TOOL` | `CMP-TSRCH-0003` | Tool requires deferred resolution | No | `runtime_error` | "Tool requires search-then-call." | [sidecar/ai/routing/router.py:363](../../sidecar/ai/routing/router.py#L363) |

## CLOUD â€” `CMP-CLOUD-NNNN` (4 codes, 0 dead)

Cloud-engine HTTP layer; raised by the shared provider HTTP service.

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `CMP_CLOUD_RATE_LIMITED` / `CLOUD_ERROR_CODES.RATE_LIMITED` (Node classifier peer) | `CMP-CLOUD-1001` | Cloud provider rate-limited | Yes | `runtime_error` | internal-only | [sidecar/ai/engines/provider_http.py:320](../../sidecar/ai/engines/provider_http.py#L320) (also default `error_code` of `RateLimitError`, [sidecar/ai/exceptions.py:91](../../sidecar/ai/exceptions.py#L91)) |
| `CMP_CLOUD_NETWORK_ERROR` | `CMP-CLOUD-1002` | Cloud network error | Yes | `runtime_error` | internal-only | [sidecar/ai/engines/provider_http.py:235](../../sidecar/ai/engines/provider_http.py#L235) |
| `CMP_CLOUD_HTTP_ERROR` | `CMP-CLOUD-1003` | Cloud HTTP non-2xx | Conditional | `runtime_error` | internal-only | [sidecar/ai/engines/provider_http.py:334](../../sidecar/ai/engines/provider_http.py#L334) |
| `CMP_CLOUD_RESPONSE_PARSE` | `CMP-CLOUD-1004` | Cloud response parse failed | No | `runtime_error` | internal-only | [sidecar/ai/engines/provider_http.py:412](../../sidecar/ai/engines/provider_http.py#L412) |

## SIDECAR ? `CMP-SIDECAR-NNNN` (5 codes, 0 dead)

Node-side transport errors between backend and Python sidecar (timeouts, aborts, process exits, JSON-RPC framing). All defined in [services/backend/error-codes.js](../../services/backend/error-codes.js).

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `SIDECAR_ERROR_CODES.TIMEOUT` | `CMP-SIDECAR-0001` | Sidecar request or model initialization exceeded its inactivity/absolute deadline | Yes | `timeout` | "Local engine timed out." | [services/backend/local-engine-status.js](../../services/backend/local-engine-status.js) |
| `SIDECAR_ERROR_CODES.ABORTED` | `CMP-SIDECAR-0002` | Request explicitly cancelled by caller, shutdown, or disposal | No | `cancelled` | internal-only | [services/backend/sidecar-client.js](../../services/backend/sidecar-client.js) |
| `SIDECAR_ERROR_CODES.PROCESS_EXIT` | `CMP-SIDECAR-0003` | Sidecar process exited mid-request | Yes | `runtime_error` | internal-only | [services/backend/sidecar-client.js:543](../../services/backend/sidecar-client.js#L543) |
| `SIDECAR_ERROR_CODES.TRANSPORT` | `CMP-SIDECAR-0004` | Transport-level framing/encode error | No | `runtime_error` | internal-only | [services/backend/sidecar-client.js:346](../../services/backend/sidecar-client.js#L346) |
| `SIDECAR_ERROR_CODES.RPC` | `CMP-SIDECAR-0005` | JSON-RPC error from sidecar | Conditional | `runtime_error` | internal-only | [services/backend/sidecar-client.js:682](../../services/backend/sidecar-client.js#L682) |

## INTERACTIVE â€” `CMP-INTERACTIVE-NNNN` (6 codes, 0 dead)

Interactive-protocol invariants (mixed-batch detection in chat-stream and tool-loop; Wave F adds the plan-proposal siblings).

| Constant | Wire code | Meaning | Retryable | Terminal class | User message | Example site |
|---|---|---|---|---|---|---|
| `INTERACTIVE_ERROR_CODES.MIXED_TEXT_AND_BATCH` | `CMP-INTERACTIVE-0001` | Both text and batch in one response | No | `runtime_error` | "Interactive protocol error: mixed text and batch." | [services/backend/chat-stream-managed-runtime.js:461](../../services/backend/chat-stream-managed-runtime.js#L461) |
| `INTERACTIVE_ERROR_CODES.INVALID_BATCH_PAYLOAD` | `CMP-INTERACTIVE-0002` | Batch payload structurally invalid | No | `runtime_error` | "Interactive protocol error: invalid batch payload." | [services/backend/chat-stream-managed-runtime.js:469](../../services/backend/chat-stream-managed-runtime.js#L469) |
| `INTERACTIVE_ERROR_CODES.TEXT_AFTER_BATCH` | `CMP-INTERACTIVE-0003` | Text emitted after batch close | No | `runtime_error` | "Interactive protocol error: text after batch." | [services/backend/chat-stream-managed-runtime.js:543](../../services/backend/chat-stream-managed-runtime.js#L543) |
| `INTERACTIVE_ERROR_CODES.MIXED_TEXT_AND_PROPOSAL` | `CMP-INTERACTIVE-0004` | Both text and plan proposal in one turn | No | `runtime_error` | "Interactive protocol error: mixed text and plan proposal in one turn." | [services/backend/chat-stream-managed-runtime-notifications.js](../../services/backend/chat-stream-managed-runtime-notifications.js) |
| `INTERACTIVE_ERROR_CODES.INVALID_PROPOSAL_PAYLOAD` | `CMP-INTERACTIVE-0005` | Plan-proposal payload structurally invalid | No | `runtime_error` | "Interactive protocol error: invalid plan proposal payload." | [services/backend/chat-stream-managed-runtime-notifications.js](../../services/backend/chat-stream-managed-runtime-notifications.js) |
| `INTERACTIVE_ERROR_CODES.INVALID_CONTINUATION` | `CMP-INTERACTIVE-0006` | Continuation token is missing, stale, consumed, or outside the persisted session/batch scope | Conditional | `runtime_error` | "Interactive continuation is no longer valid." | [services/backend/session-turn-actor.js](../../services/backend/session-turn-actor.js) |

---

## Drift inventory

### Dead codes (defined but never raised outside the definition file)

0 total emitted-path dead codes. Retired numbers remain reserved in their domain tables.

Removed from source 2026-07-01 (confirmed zero references to the removed constant names in product code; a few renderer tests still use the bare wire strings as arbitrary fixtures, which the prefix-based renderer classifier handles without a registry lookup): TOOL 0009 and 0017, CTX 0003 through 0005, and WEB 0003 and 0008.

### String-literal codes (raised as bare strings, not constants)

**Zero remaining as of 2026-05-06.** Active backend literal sites are converted to constants; the removed Symphony/Codex registry is no longer part of the active error-code surface. Verification:

```bash
rg -n "['\"]CMP-(SIDECAR|INTERACTIVE|CHAT|LOOP|TOOL)-\d+['\"]" services/backend services/tools --glob '!error-codes.js'
```

The enforced check is now `python scripts/checks/check_error_codes.py`, which rejects quoted full CMP wire-code literals outside the canonical Python and Node registry files.

### Codes raised but undefined

**Zero.** Every wire code emitted in the active codebase resolves to a constant in one of the active source-of-truth files.

---

## Retryability framework

Codes are tagged `Retryable: Yes/No/Conditional` in the tables above. The runtime consumes this via two complementary mechanisms:

1. **`CompanionError.retryable: bool`** â€” set by the raiser. Defined in [sidecar/exceptions.py](../../sidecar/exceptions.py). Default: `False`. Subclasses in [sidecar/ai/exceptions.py](../../sidecar/ai/exceptions.py) override the default per error class (e.g. `EngineConnectionError` and `RateLimitError` default to `True`).

2. **Call-site retry decisions** — the flag is read directly at the boundaries that choose to re-attempt (engine transports, tool dispatch); there is no central retry wrapper.

`Conditional` in the registry means the raise site sets `retryable` based on context (e.g. HTTP 429 â†’ `True`, HTTP 400 â†’ `False` for the same wire code).

---

## User-visible message audit

Errors surface to the renderer through three channels:

1. **`tool.result`** events with `is_error: true` â€” tool failures in the loop. Renderer reads `error_code` and `message` and styles them as a tool error bubble.
2. **`chat.error`** events â€” terminal chat failures. Renderer shows them as a system message with the wire code visible for support.
3. **`runtime_error`** terminal classifier â€” escapes the loop and ends the turn.

### Live-event recovery metadata (error-surfacing EH-W1)

As of the error-surfacing overhaul, the `chat.error` channel (2) and the `runtime_error` terminal classifier (3) emit the same recovery-classifier metadata that previously only the **persist** path attached: `recovery_class`, `category`, `terminal_status`, `retryable`, `recovery_title`, `recovery_hint`, `recovery_actions[]`, and `next_action` / `next_action_label`. The enrichment runs at the emit source ([services/backend/chat-stream-terminal-utils.js](../../services/backend/chat-stream-terminal-utils.js) `enrichTerminalErrorPayloadForEmit`, wrapping `buildAssistantErrorRecoveryFields` from [services/backend/chat-error-recovery.js](../../services/backend/chat-error-recovery.js)), so the renderer's inline `.chat-error-card` renders Retry/Regenerate and recovery copy from live events instead of falling back to the weaker renderer-side classifier. No new wire codes - this is additive metadata on the existing channels.

### Codes whose message is not actionable enough

The following codes surface to the user but their current message reads like a developer log line. Recommended rewording (separate follow-up â€” not part of this bundle):

| Code | Current message (paraphrase) | Recommended rewording |
|---|---|---|
| `CMP-LOOP-0003` | "Generation failed: {detail}." | "The model couldn't complete this turn. Try again or simplify the request." |
| `CMP-LOOP-0014` | "Tool loop is repeating itself; stopping." | "The assistant is stuck in a loop and stopped. Rephrase the request." |
| `CMP-LOOP-0015` | Engine-aware local-model or cloud-provider stall guidance. | "The active provider stopped streaming. Retry; if it persists, adjust the relevant provider or Harness timeout." |
| `CMP-MEM-0002` | "Duplicate memory entry." | "A memory like this already exists. Edit the existing one instead." |
| `CMP-MCP-0004` | "MCP server error: {detail}." | "External tool server returned an error. Check the server logs at {server_name}." |
| `CMP-WEB-0001` | "Blocked: URL resolves to private network." | "Blocked: this URL points to a private/internal address (SSRF protection)." |

### Codes whose message is currently `internal-only` but reach the user

None identified in this pass. All `internal-only` codes today either originate from dead raise sites or are caught/wrapped before reaching the renderer.

---

## Drift-prevention test

**Status:** enforced by `python scripts/checks/check_error_codes.py` and `tests/sidecar/ai/test_error_codes.py`.

**Test slot:** `tests/sidecar/ai/test_error_codes.py`.

**Assertions:**

1. Parse `docs/operations/error-codes.md`, extract every wire code.
2. Import every constant from `sidecar.ai.error_codes`; assert each constant's value is documented.
3. Import the JSON exported by `services/backend/error-codes.js` (via `node -p`) and assert each code is documented.
4. Walk the source tree for raise sites of the form `code=CMP_*` or `error_code: CMP-*-NNNN` (string-literal); fail if any wire code appears outside the active source-of-truth files.
5. Keep dead-code inventory updates in this document when definitions or active emitters change.

This test catches the drift classes that affect runtime contracts: undocumented canonical constants, stale documented codes, and string-literal regressions outside the source-of-truth files.

---

## Change log

- **2026-07-10** - Added versioned workspace-file root-generation, strict UTF-8, and bounded atomic-write seam codes (`CMP-WORKSPACEFS-0008`, `0009`, `0013`, and `0021`-`0023`).
- **2026-07-01** - Wave-1 hygiene re-derivation: corrected the drift inventory (31 claimed dead → 4 actually dead; mermaid, python-runtime, cap, apply-patch, CHAT/SRV/CLOUD/SIDECAR codes were live via aliases), refreshed Example site links, and removed 7 confirmed-dead constants from `sidecar/ai/error_codes.py`.
- **2026-05-23** - Added the Node peer for `CMP-AI-0002` managed Ollama preflight failures and reconciled the AI registry notes with typed sidecar exception imports.
- **2026-05-06** - Phase 4C reconciliation: documented deterministic-harness sentinel codes, promoted remaining backend CMP literals to Node registry constants, added Node AI/CLOUD classifier peers, and enabled registry drift checks.
- **2026-04-26** - Added Node-side ARTIFACT peer constants for canonical `CMP-ARTIFACT-*` wire codes and documented artifact workspace error-code propagation through rejected IPC bridge calls.
- **2026-04-26** â€” Added Node-side TOOL peer constants for canonical `CMP-TOOL-*` wire codes and documented Electron tool-loop propagation of executor `errorCode` values through stream events, turn-event payloads, and persisted `tool_result.error_code`.
- **2026-04-19** â€” Initial registry. Bundle 5A of `BACKEND_PROMPT_LIFECYCLE_REVIEW.md`. Promoted 13 string-literal sites to constants (6 SYM-RPC, 5 backend, 2 in `services/session-recovery-service.js` + `services/backend/turn-diagnostic-dump.js`), created `services/backend/error-codes.js`, audited 138 codes total (42 dead).
