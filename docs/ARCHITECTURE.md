# Jenny Architecture Overview

This is the contributor map for the current desktop and hosted runtime. Start
with WORKSPACE_MANIFEST.md for domain ownership and
NEXT_STEPS.md for status and release gates.

## 1. What Jenny is

Jenny is a local-first AI coding harness with an Electron companion shell.
Ollama and the local OpenAI-compatible engine (including managed llama-server)
run coding workflows, visualizations, and bounded tools. vLLM is another local
engine. ChatGPT sign-in and the Codex CLI engine are explicit optional cloud
routes; selecting them changes where inference runs.

Application services own canonical history, persistence, project authority,
and consent. Conversation files are JSON under the profile's `sessions/`
directory; they are not encrypted by `safeStorage`. Desktop credential storage
uses `safeStorage` through `services/backend/secure-store.js`.

## 2. Application host and Python sidecar

The desktop application uses two cooperating processes:

- **Electron host** — `main.js`, `preload.js`, and `services/` own windows,
  the trusted renderer bridge, canonical conversations, scheduling, approvals,
  and application resources. `renderer/` presents those services.
- **Python sidecar** — launched as `python -m sidecar`, owns engine requests,
  prompt assembly, the bounded tool loop, and documented memory/diagnostic
  subsystems. Turn execution is request-local; it does not own conversation
  history.

The host and sidecar communicate through JSON-RPC 2.0 over stdio with
`Content-Length` framing. `sidecar/protocol.py` owns the vocabulary and
`API_VERSION = "2026-08-17"`; `services/backend/sidecar-client.js` pins the
paired version and adds `accept_version` to versioned requests.
`sidecar/runtime/framing.py` bounds frames before dispatch.

The headless Node host under `server/` composes the same application services
and `ElectronSessionStore` for browser/Docker deployments. HTTP/SSE endpoints
are authenticated service operations. The browser and sidecar do not become
history owners. Hosted secrets and tool isolation follow the approved boundary
in AGENTS.md and the hosted runtime
manifest.

## 3. Application services and renderer

- `main.js` composes the desktop lifecycle through `services/main/` and creates
  context-isolated windows. `preload.js` delegates to `services/ipc-contract.js`
  to expose the typed `window.jennyShell` bridge.
- `services/backend/backend-service.js` composes managed sidecar transport,
  engines, canonical chat streaming, persistence, and diagnostics. The optional
  Codex CLI composition fence is documented in
  Backend Composition-Seam Lane.
- `services/projects/` and `services/session-runtime/` own project authority,
  durable work, scheduling, resource admission, continuation, and recovery.
  Transport cancellation requests cleanup; it does not prove that a producer
  stopped or release uncertain capacity.
- `services/tools/` owns the tool manifest, permission store, and Electron
  executors. Workspace, artifact, preview, image-generation, update, and
  scheduler services remain at their existing service boundaries.
- `renderer/app.js` and `renderer/app/` compose the renderer. `renderer/chat/`
  owns chat presentation; `renderer/shell/` owns shell/controllers;
  `renderer/features/` owns feature views; `renderer/shared/` owns UI utilities;
  `renderer/inventory/` owns reusable raw HTML primitives.

For per-surface routes use Electron Wiring and
UI / UX. Read the Chat UI map
before broad chat markup/style searches.

## 4. Python ownership

Dependency direction is `sidecar/server.py` → `sidecar/ai/container.py` →
`sidecar/ai/routing/router.py` → subsystems. `sidecar/ai/` never imports Electron
(`main.js`, `services/`) or renderer modules.

| Area | Canonical starts | Responsibility |
|---|---|---|
| Process and wire | `sidecar/runtime/request_dispatch.py`, `multiplexer.py`, `chat.py` | Framed dispatch, bounded workers, cancellation, reverse requests, terminal notifications |
| Engines | `sidecar/ai/engines/factory.py`, `provider_registry.py`, `catalog.py` | Lazy engine selection, model discovery, normalized provider streaming, fail-closed fallback |
| Routing | `sidecar/ai/routing/router.py`, `tool_loop.py`, `loop_runtime.py` | Request context, bounded generation/tool execution, quotas, cancellation/deadlines |
| Context | `sidecar/ai/context/builder.py`, `messages.py`, `token_budget.py`, `compaction.py`, `turn_context.py` | Trusted prompt assembly, history admission, budgets/compaction, prefix-stable local turn context |
| Tools and MCP | `sidecar/ai/tools/catalog.py`, `registry.py`, `policy.py`, `sidecar/ai/mcp/` | Manifest-derived schemas, lazy builtins, approval policy, sanitization, bounded MCP transports |
| Memory | `sidecar/ai/memory/`, `sidecar/runtime/memory.py` | Versioned SQLite memory, bounded recall, approved suggestions and management |
| Diagnostics | `sidecar/runtime/diagnostics.py`, `turn_diagnostics.py`, `resource_monitor.py` | Redacted logs, bounded request/provider evidence and resource supervision |

Process-global or durable sidecar state requires an explicit bounded owner.
Container generations, provider caches, memory, MCP transports and diagnostic
stores are examples; cancellation handles and message buffers remain
request-local. See Concurrency Model.

## 5. Tool authority and approval

`services/tools/tool-manifest.json` is the canonical descriptor/schema source.
Availability depends on configuration, platform, project/workspace authority,
run mode, host policy, and request-level tool switches. Workspace-required tools
are unavailable without an explicitly bound root; workspace-independent chat,
interaction and status tools may remain available.

`sidecar/ai/tools/policy.py` and the application approval owner apply deny/auto/ask
policy. `tool.request_approval` is a blocking reverse JSON-RPC request.
`tool.execute_electron` executes application-owned tools; `runtime.operation`
performs internal application admission and settlement, never a model tool.
Actual IO rechecks captured authority and physical path containment. Tool results
are bounded and sanitized before model-visible admission.

`delegate` provides synchronous bounded read-only research. Approved durable
runs may expose `session_spawn`, `session_wait`, and `session_result` through the
application-owned child-work contract. Both preserve parent authority and budget;
see Sub-Agent Runtime Design and
[Session runtime operations](operations/session-runtime.md).

## 6. Streaming and persistence

`sidecar/protocol.py` lists allowed notifications. Core examples are `chat.token`,
`chat.thinking`, phase events, `tool.executing`, `tool.result`, `agent.progress`,
`chat.done`, `chat.error`, and canonical `turn.event`. `chat.stream_reset` is a
transport signal with explicit segment-preservation rules. `tool.output_chunk`
and `context.usage` are ephemeral and never canonical history.

Electron correlates stream events, finalizes canonical turn events, and settles
messages through its existing terminal/persistence owners. Split session store
schema is **v22**; turn-event log version is **4**. Forward-version guards
preserve newer files and refuse writes. Durable Send acknowledges saved work
before an actual stream starts; explicit resume and cleanup confirmation are
separate transitions.

Managed startup is ready for chat only after sidecar attachment and `model_ready`.
One initialization flight per process uses bounded inactivity/absolute deadlines;
model-acquisition failure remains observable and retryable as `model_unavailable`.

## 7. Security and further reading

Desktop windows use CSP and context isolation. Workspace IO validates real paths
and handles, approval fingerprints bind the execution context, web tools enforce
outbound destination/size/deadline limits, and logs exclude raw secrets and tool
arguments. Credential encryption does not imply transcript encryption or command
isolation. Hosted command policy uses its separately gated offline worker.

- Project Contract Details — vocabulary and ownership contracts.
- [Built-in Tools](TOOLS.md) — tool surfaces and approval behavior.
- [Security Model](SECURITY_MODEL.md) — sanitization and Python execution threat model.
- Structured Logging Contract — retained diagnostic evidence.
- [Versioning and Migration](operations/versioning-and-migration.md) — schema and compatibility policy.
- WORKFLOW.md — focused checks and owner-run qualification gates.
- docs/INDEX.md — detailed documentation routes.
