# Jenny Architecture Overview

This is the top-level architecture map for new contributors. It explains what
Jenny is, how the two processes fit together, and where each subsystem lives.
For deep dives, follow the links in "Where to go next."

## 1. What Jenny is

Jenny is a local-first desktop AI coding companion: a native Electron app
that runs entirely against local models — [Ollama](https://ollama.com/) by
default, [vLLM](https://docs.vllm.ai/) optionally — with no cloud API key and
no cloud round-trip. Conversation history is persisted on-device and
encrypted at rest via Electron's `safeStorage`. Jenny is tuned for what
small-to-mid local models (roughly 12B–35B) can drive reliably: coding
workflows, data-visualization artifacts, and well-scoped, approval-gated tool
calls, wrapped in a light, persistent companion personality ("Comet"). See
[README.md](../README.md) for full product positioning and how Jenny compares
to cloud tools.

## 2. Two-process architecture

Jenny is two processes joined by JSON-RPC:

- **Electron shell** — a thin JS process (`main.js`, `preload.js`,
  `services/`, `renderer/`) that owns the window, IPC, persistence, and UI.
- **Python sidecar** — a stateless-per-request process (`sidecar/`) that owns
  engine routing, prompt assembly, tool execution, and memory. Launched as
  `python -m sidecar`.

The two communicate over **stdio** using **JSON-RPC 2.0** with
**`Content-Length`-prefixed framing** (see
[`sidecar/runtime/framing.py`](../sidecar/runtime/framing.py)) — the same
header-plus-body wire shape used by the Language Server Protocol. Requests,
responses, and one-way notifications (streamed tokens, tool events, etc.) all
travel this single channel.

```
 ┌─────────────────────────┐        JSON-RPC 2.0 over stdio       ┌───────────────────────────┐
 │      Electron shell      │  ───────────────────────────────►   │      Python sidecar        │
 │  main.js / preload.js /  │      Content-Length: <n>\r\n\r\n     │  sidecar/runtime (framing, │
 │  services/ / renderer/   │      {"jsonrpc":"2.0", ...}          │  dispatch, approval) +     │
 │                          │  ◄───────────────────────────────    │  sidecar/ai (engines,      │
 │  (window, IPC, storage)  │   requests / responses / notifies    │  routing, tools, memory)   │
 └─────────────────────────┘                                       └───────────────────────────┘
```

The wire contract is **versioned**. Both sides pin the same string:

- Sidecar: `API_VERSION = "2026-08-17"` in
  [`sidecar/protocol.py`](../sidecar/protocol.py), alongside every JSON-RPC
  method name (`chat.send`, `chat.token`, `tool.request_approval`, etc.) and
  the canonical set of notification methods the sidecar is allowed to emit.
- Electron: the matching `API_VERSION = '2026-08-17'` constant in
  [`services/backend/sidecar-client.js`](../services/backend/sidecar-client.js),
  sent as `accept_version` on every request.

`sidecar/protocol.py` is the single source of truth for method names and
notification shapes; `sidecar-client.js` is the Electron-side client that
speaks it. See
`docs/architecture/BACKEND_SEAM_LANE.md`
for how opt-in backend modules (diagnostics, the Codex CLI product engine)
compose behind `services/backend/backend-service.js` without becoming direct
dependents of the sidecar wire contract.

## 3. Electron shell

The shell is intentionally thin — a window manager, an IPC/persistence layer,
and a renderer — with all model/tool intelligence delegated to the sidecar.

- **`main.js`** — app/window lifecycle: creates the `BrowserWindow` with
  `contextIsolation: true`, wires the sidecar subprocess, and owns top-level
  startup/shutdown sequencing.
- **`preload.js`** — the context-isolated bridge. It uses
  `contextBridge.exposeInMainWorld` to expose a single `window.jennyShell`
  object (built by `services/ipc-contract.js`) to the renderer; the renderer
  never gets raw Node/Electron APIs.
- **`services/`** — the backend seam, organized by concern: `services/backend/`
  (sidecar client `sidecar-client.js`, composition root `backend-service.js`,
  secure storage `secure-store.js`, and the opt-in diagnostic/Codex-CLI lane);
  `services/main/` (window composition, IPC handler registration, the Comet
  overlay controller); `services/tools/` (Electron-side tool-result helpers,
  e.g. structured diffs); `services/proactive/` and `services/dev/`
  (proactive-agent support and dev tooling). Persistence (session store),
  auto-update, and scheduled tasks are also services-owned.
- **`renderer/`** — the UI, organized by feature: `renderer/chat/` (transcript,
  streaming, tool-call rendering, tool-approval prompts), `renderer/features/`
  (artifacts panel, code-review rail, Comet personality/presence, dashboard
  surfaces), `renderer/shell/` (window chrome, bridge wiring), `renderer/app/`
  (bootstrap), `renderer/services/` and `renderer/shared/` (renderer-local
  utilities), `renderer/overlay/` and `renderer/frames/` (the Comet overlay
  window and sandboxed iframe surfaces), `renderer/inventory/`.

See `docs/architecture/BACKEND_SEAM_LANE.md`
for the seam boundary between product runtime code and the opt-in backend
lane, and `docs/manifests/electron-wiring.md` / `docs/manifests/ui-ux.md` for
per-surface ownership.

## 4. Python sidecar

The sidecar is organized into `runtime/` (process- and protocol-level
concerns) and `ai/` (model, tool, and knowledge concerns). `sidecar/ai/` must
not import from `electron/` or `renderer/` — it only knows JSON in, JSON/
notifications out.

**`sidecar/runtime/`** — framing, request dispatch, approval, and turn
lifecycle: `framing.py` / `message_reader.py` / `rpc.py` (wire I/O);
`request_dispatch*.py` (per-method-family dispatch); `approval.py` /
`approval_plan.py` (runtime side of per-tool approval, paired with
`sidecar/ai/tools/policy.py`); `turn_processor.py`, `turn_state.py`,
`turn_retry.py`, `multiplexer.py`, `cooldowns.py`
(request-local event processing, result vocabulary, approval-resume retry,
and cancellation); `chat*.py` (streaming chat pipeline); Electron
owns live active-turn state and crash reconciliation rather than duplicating
it in the sidecar;
`diagnostics.py`, `telemetry.py`, `harness_snapshot.py`,
`turn_diagnostics.py`, `resource_monitor.py` (diagnostics); plus
`subprocess_manager.py`, `parent_watchdog.py` (dies with the Electron
parent), and `electron_tool_bridge.py` (routes tool calls that must execute
Electron-side back across the wire).

**`sidecar/ai/`** subpackages:

- **`engines/`** — `BaseEngine` (`base.py`) plus concrete engines selected
  through `factory.py`'s `create_engine()`: `ollama.py` (default),
  `vllm_engine.py`, `codex_cli.py` (opt-in cloud product engine, gated
  behind explicit configuration), `mock.py`, `replay.py` (fixture-driven,
  used in tests/eval), `openai_compatible.py`. The factory **fails closed to
  `MockEngine`** on any initialization error or unknown `engine_type`, and
  enforces a local-only host policy for the OpenAI-compatible engine
  (loopback/private/link-local resolution only).
- **`routing/`** — the bounded tool loop (`tool_loop.py`, `tool_execution.py`,
  `tool_resolution.py`, `tool_quotas.py`), the generation runtime
  (`generation_runtime.py`), route policy (`route_policy.py`, `router.py`),
  and stuck-loop detection (`stuck_loop_detector.py`), plus iteration
  limits, sequential tool execution, retry, and sub-agent delegation.
- **`context/`** — workspace-aware prompt assembly (`builder.py`, which
  assembles the `BOOTSTRAP` identity/system-prompt block), token budgeting
  and compaction (`token_budget.py`, `compaction.py`), prompt caching, and
  tokenizers.
- **`tools/`** — the tool catalog and contract (`catalog.py`, `registry.py`,
  `policy.py`, `sanitization.py`, `workspace.py`), plus `builtins/`:
  filesystem (`filesystem.py`, `edit_file.py`, `delete_file.py`,
  `glob_files.py`, `grep_search.py`), `shell.py` (+ `shell_security.py`),
  git (`git_ops.py`, `git_tracking.py`), web (`web.py`, `web_http.py`,
  `web_extract.py`), `python_runtime/`, `lsp/`, `rich_files/`.
- **`memory/`** — SQLite-backed store (`store.py`, `store_migrations.py`),
  recall scoring (`recall_scoring.py`), extraction, embeddings, session notes.
- **`personality/`** — profile and sanitized-identity overlay support
  (`sanitization.py`) consumed by prompt assembly.
- **`mcp/`** — the MCP client (`client.py`) and transports
  (`transport_stdio.py`, `transport_sse.py`), plus namespacing and retry
  policy.

Also present: `agents/` (sub-agent/delegation support), `app_profiles/`,
`tasks/`, `utils/`, and `sidecar/audio/` (audio runtime support).

## 5. Tool system & approval

Every tool call goes through a **per-tool, fail-closed approval decision**
(`sidecar/ai/tools/policy.py`, backed by `sidecar/runtime/approval.py`).
Rules are evaluated in a fixed precedence: a matching **deny** rule wins
immediately; otherwise the first matching **auto** rule wins; otherwise the
first matching **ask** rule applies. If nothing matches, the tool falls back
to asking rather than running silently — approval is opt-in, not opt-out.

Tool execution is also bounded by **workspace-root enforcement**
(`sidecar/ai/tools/workspace.py`): file and shell operations that resolve
outside the configured workspace root are rejected with the
`CMP_TOOL_OUTSIDE_WORKSPACE` error code (`CMP-TOOL-0003`, defined in
`sidecar/ai/error_codes.py`). Jenny's tools are blocked entirely until a
workspace root is explicitly chosen.

Tool **results** are sanitized before they reach the model or the transcript
— `sidecar/ai/tools/sanitization.py` bounds and redacts tool-result metadata
so oversized output, secrets, or unexpected shapes don't leak into context or
storage unfiltered.

## 6. Streaming

The sidecar streams a turn as a sequence of typed notifications rather than
one blocking response. Distinct notification types (all enumerated in
`sidecar/protocol.py`'s `ALLOWED_NOTIFICATION_METHODS`) include:

- **`runtime.progress`** — initialize-request-correlated model acquisition and
  loading progress. Electron validates monotonic stage/byte/percent movement
  before it refreshes the inactivity watchdog or exposes lifecycle status.

- **`chat.token`** — streamed assistant text deltas.
- **`chat.thinking`** — streamed reasoning/status deltas (`kind`: `reasoning`
  or `status`).
- **`chat.phase_started` / `chat.phase_completed`** — semantic phase-boundary
  events (reasoning / text / tool_use / tool_result / approval_wait
  transitions).
- **`tool.executing` / `tool.result`** — a tool call starting and finishing.
- **`tool.request_approval`** — the turn pauses for an approval decision
  (an approval-wait boundary).
- **`turn.event`** — an additive canonical turn-event stream layered
  alongside the notifications above during migration.

Orthogonal to all of these is **`chat.stream_reset`** — a transport-level
notification the sidecar emits when a retry/nudge discards accumulated text
mid-stream, telling the renderer to discard its buffer and start fresh. It is
a physical transport concern, not a semantic phase signal, and is handled
independently by the renderer.

Managed startup is ready for chat only after the attached sidecar has spawned
and the configured model has reached `model_ready`. Electron owns one
initialization flight per sidecar process, with a 15-second inactivity timeout
and a 615-second absolute ceiling. Acquisition failure clears the selected
model and leaves the shell in a retryable, observable `model_unavailable`
state; it is not reported as a dead sidecar.

## 7. Other subsystems

- **Skills** (`skills/`) — self-contained capability modules, each with a
  `SKILL.md` (the six bundled skills: `verification-specialist`, `mermaid-artifact-workflow`,
  `deep_research`, `claude_code_delegation`, `humanizer`, `meeting_notes`).
- **Memory approval queue** — suggested memories are queued and require
  explicit save/dismiss, not auto-written (`memory.suggest`,
  `memory.pending.list`, `memory.pending.delete`; `sidecar/ai/memory/`).
- **Personality profiles** — built-in profiles (balanced, concise, creative,
  mentor) plus a free-form field, sanitized before entering the system
  prompt (`sidecar/ai/personality/sanitization.py`).
- **MCP external tools** — MCP client with stdio and SSE transports
  (`sidecar/ai/mcp/`), namespaced alongside built-in tools in the same
  catalog and approval pipeline.
- **Artifacts** — Monaco-based code/file artifacts and Mermaid diagrams,
  the latter sandboxed in an iframe (`renderer-mermaid-utils.js`,
  `mermaid-frame.html`).
- **Comet companion** — the persistent visual companion (`comet/`,
  `renderer/features/renderer-comet*.js`,
  `services/main/comet-overlay-controller.js`), a thin presence layer over
  the same chat/personality state.

## 8. Security posture

- **Workspace-root gating** — tools are inert until a workspace root is
  explicitly chosen; all file/shell paths are validated against it.
- **Per-tool approval** — fail-closed deny/auto/ask policy evaluated on
  every tool call (Section 5).
- **Realpath / symlink boundary checks** — workspace enforcement resolves
  real paths so symlinks can't be used to escape the workspace root, raising
  `CMP_TOOL_OUTSIDE_WORKSPACE` on escape.
- **Tool-result metadata sanitization** — bounds and redacts tool output
  before it reaches model context, transcript, or storage.
- **CSP + context isolation** — `index.html` sets a `Content-Security-Policy`
  meta tag; `main.js` creates the `BrowserWindow` with
  `contextIsolation: true` and a `preload.js` bridge instead of direct
  Node/Electron access from the renderer.
- **SSRF checks on web tools** — the OpenAI-compatible engine factory
  enforces a local-only host policy (loopback/private/link-local only); web
  tool builtins (`sidecar/ai/tools/builtins/web.py`, `web_http.py`) apply
  their own outbound-request checks.
- **`safeStorage`-encrypted history** — conversation/session data and
  secrets are encrypted at rest via Electron's `safeStorage`
  (`services/backend/secure-store.js`), not stored in plaintext.

## 9. Where to go next

- [README.md](../README.md) — product positioning, setup, and how Jenny
  compares to cloud tools.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — dev environment setup and gates to
  run before opening a PR.
- INVENTORY.md — fast subsystem map and current
  surface-by-surface coverage notes.
- docs/INDEX.md — central docs discovery page.
- [docs/adr/](adr/) — accepted Architecture Decision Records for frozen
  design choices.
- [docs/operations/](operations/) — versioning/migration policy, error-code
  registry, policy checks, and other operational references.
- docs/process/TESTING_STRATEGY.md — canonical
  reference for what each test/CI gate covers.
