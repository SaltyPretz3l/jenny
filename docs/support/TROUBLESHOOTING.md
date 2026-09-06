---
kind: docs-index
last_reviewed: 2026-08-19
status: active
---

# Troubleshooting

Common symptoms grouped by surface. Each entry: what you see, the most
common cause, and how to recover. The developer-facing error code registry
at [docs/operations/error-codes.md](../operations/error-codes.md) is the
source of truth for `CMP-*` codes; this page translates them to user-facing
language.

## Windows blocks the installer ("Windows protected your PC")

**Symptom.** SmartScreen interrupts the installer or the first app launch.

**Common cause.** The build is not code-signed — expected for every release
today, not a sign of tampering.

**Recovery.** Click **More info → Run anyway**. To verify the download
first, compare its SHA-256 hash against the table in the release's
`RELEASE_NOTES.md` (PowerShell: `Get-FileHash .\Jenny-Setup-x64.exe`).

## macOS refuses to open the app

**Symptom.** "Apple could not verify 'Jenny Shell' is free of malware," or
the app "is damaged and can't be opened."

**Common cause.** Gatekeeper quarantine on the unsigned, best-effort macOS
build.

**Recovery.** Right-click **Jenny Shell.app** → **Open** → **Open**. If that
option doesn't appear, clear the quarantine flag:
`xattr -dr com.apple.quarantine "/Applications/Jenny Shell.app"`. Reminder:
the macOS build is untested by the maintainer, and auto-update is disabled
there — new versions are a manual download.

## Model download fails or stalls

**Symptom.** The setup wizard's pull stops with an error, or progress stays
at 0%.

**Common cause.** Not enough free disk (the default model needs ~6 GB plus
headroom), a network interruption, or Ollama not yet running.

**Recovery.** Check free disk space, confirm Ollama is running
(`ollama list` in a terminal), and press the pull button again — pulls
resume. If the failure repeats, run
`ollama pull hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M` in a terminal to see
the raw error, and file an issue with that output if it isn't
self-explanatory.

## Sidecar not ready / "Backend offline"

**Symptom.** The status bar shows "Backend offline" or "Sidecar starting,"
and messages don't send. Sometimes paired with a `CMP-MODE-*` toast.

**Common cause.** The Python sidecar process is still starting (cold-start
takes a few seconds) or has crashed mid-handshake. The Electron shell
waits on a managed-sidecar lifecycle before chat is usable.

**Recovery.** Wait 10 seconds; if "Sidecar starting" persists, try
restarting the app. If the issue reproduces, capture the diagnostic dump
from `<userData>/diagnostics/` and file an issue. Developer reference:
[Sidecar crashed mid-turn — how to diagnose](#sidecar-crashed-mid-turn--how-to-diagnose).

## Ollama unreachable

**Symptom.** Chat shows "Engine unreachable" or model selection is empty.

**Common cause.** The Ollama service isn't running on the configured port
(default `localhost:11434`), or you're trying to use a model that hasn't
been pulled yet.

**Recovery.** Verify `ollama list` shows your model. Start Ollama if it's
not running. Settings → Engines lets you change the host / port. The setup
wizard's hardware scan (Settings → Account & Setup) re-recommends a model
that fits your machine.

## Approval timeout

**Symptom.** A tool call shows "Awaiting approval" indefinitely with no
modal visible, then eventually errors with a `CMP-TOOL-*` code.

**Common cause.** The approval modal was dismissed or closed before the
sidecar's approval-wait window expired.

**Recovery.** Resend the prompt. If approval modals consistently don't
appear, check Settings → Personality for free-form / preview content that
might be blocking the dialog, and capture the diagnostic dump for the
stream.

## Model load race / "Model is starting"

**Symptom.** The first message after switching models hangs for 10–60
seconds before producing any output.

**Common cause.** The local engine is loading the model weights into RAM /
VRAM. This is normal on cold-start.

**Recovery.** Wait for the first token. Subsequent turns will be fast.
If first-token latency consistently exceeds 60 seconds, walk through
[First visible token is slow](#first-visible-token-is-slow).

## Chat stream stuck / spinner won't go away

**Symptom.** The "thinking" indicator persists after the model has clearly
finished — the assistant row stops updating but no `complete` marker
arrives.

**Common cause.** A terminal stream event (`complete` / `error` /
`stream_reset`) was dropped between the sidecar and the renderer. The
turn data is persisted, but the renderer didn't get the close signal.

**Recovery.** Switch sessions and back. The renderer rehydrates the
persisted `turn_events[]` on remount via
`renderer/chat/renderer-stream-rehydrate.js`, which rebuilds the visible
state. If the spinner reappears immediately, capture the diagnostic dump
and file an issue.

## "Workspace root not set"

**Symptom.** Filesystem / shell tool calls refuse to run with a
`CMP-TOOL-*` code mentioning workspace root.

**Common cause.** No workspace root is configured — Jenny gates
filesystem / shell tools behind an explicit workspace selection so tool
calls can't write to arbitrary directories.

**Recovery.** Settings → Workspace lets you choose a folder. The tool
calls will become available immediately.

## Crash on startup

**Symptom.** Jenny exits or shows the Electron crash screen before the
main window paints.

**Common cause.** A migration on the session store, memory store, or
personality config failed because of a corrupted JSON file.

**Recovery.** Look under `<userData>/diagnostics/` for the most recent
dump. Per the FileJsonStore corruption policy in
[docs/operations/versioning-and-migration.md](../operations/versioning-and-migration.md),
corrupted JSON files are renamed with a `.corrupt-<timestamp>` suffix
and re-initialized; if the rename didn't happen, manually rename the
suspect file and relaunch. File an issue with the diagnostic dump if
this reproduces.

## Archive or restore failed

**Symptom.** Archive creation stops, a saved archive is not offered, or restore
reports `CMP-DATA-0006` through `CMP-DATA-0009`.

**Recovery.** Keep live data in place. Confirm the archive directory contains
`COMPLETE`, do not edit its files, and retry the passphrase locally. An archive
without `COMPLETE` or with edited payloads is intentionally rejected. If the
profile now contains chats or attachments, use the per-session importer instead
of full restore. See
[Uninstall and Data Recovery](../operations/UNINSTALL_AND_DATA_RECOVERY.md).

## Uninstall reports incomplete cleanup

**Symptom.** The receipt reports retained or failed targets with
`CMP-DATA-0010`.

**Recovery.** Close programs that may hold Jenny files, keep the receipt, and
retry the official helper. Unknown `.companion` children, shared models, and
unselected workspace data are expected to remain. Do not manually delete a
broad profile or runtime root unless every remaining path has been identified.

## Runbooks

Deeper diagnostic walkthroughs for contributors working on Jenny's backend;
each assumes familiarity with the codebase and links straight to source.

## Model won't load / keeps unloading

### Symptoms

- Ollama or vLLM shows "starting" but never reaches "serving".
- Model loads, generates one turn, then unloads (`keep_alive` expired).
- Engine exits mid-turn with `connection refused` or `502 Bad Gateway` from the provider.
- `harness.inspect` shows `engine.ready: false` despite UI claiming the engine is up.
- Process log: `CUDA out of memory`, `MALLOC failed`, Windows SEH exception from Ollama.

### Background

Jenny runs local-first engines managed by Electron:

- **Ollama** — [services/backend/ollama-process-manager.js](../../services/backend/ollama-process-manager.js), shutdown at [services/backend/ollama-shutdown.js](../../services/backend/ollama-shutdown.js), env at [services/backend/ollama-env.js](../../services/backend/ollama-env.js)
- **vLLM** — [services/backend/vllm-process-manager.js](../../services/backend/vllm-process-manager.js)
- **OpenAI-compatible** — external, not managed; Jenny only points at a URL
- Lifecycle dispatch: [services/backend/local-engine-lifecycle.js](../../services/backend/local-engine-lifecycle.js), status at [services/backend/local-engine-status.js](../../services/backend/local-engine-status.js)

Sidecar side:
- [sidecar/ai/engines/ollama_runtime.py](../../sidecar/ai/engines/ollama_runtime.py)
- [sidecar/ai/engines/vllm_engine.py](../../sidecar/ai/engines/vllm_engine.py)
- [sidecar/ai/engines/openai_compatible.py](../../sidecar/ai/engines/openai_compatible.py)

Hardware probe:
- [sidecar/runtime/hardware_profile.py](../../sidecar/runtime/hardware_profile.py)
- [sidecar/runtime/hardware_vram_usage.py](../../sidecar/runtime/hardware_vram_usage.py) — VRAM probe; finding O2 notes probe failure is silent (stub `{available: False}`)

### Triage

#### 1. Check VRAM / RAM

Open Task Manager / `nvidia-smi` and read current utilization. Common ceilings for a single 24 GB GPU:

| Model class | Approx VRAM (Ollama Q4 / vLLM FP16) |
|---|---|
| 7B–8B | 5 GB / 16 GB |
| 13B | 9 GB / 28 GB (too big) |
| 30B–36B | 20 GB / 72 GB (multi-GPU) |

If another app (Chrome, game) is holding the GPU, Ollama will fall back to CPU silently. vLLM will refuse to start.

#### 2. Check engine is actually running

Windows:

```bash
tasklist | findstr "ollama\|vllm\|python"
```

POSIX:

```bash
ps aux | grep -E "ollama|vllm|python"
```

If the engine process is missing but Jenny thinks it's up, state is stale. vLLM landed a state-file mirror in Bundle 5E at `{userData}/vllm-process.json` with stale-PID sweep on next `start()` ([services/backend/vllm-process-manager.js:173-193](../../services/backend/vllm-process-manager.js)); Ollama has the equivalent sweep at [services/backend/ollama-process-manager.js:287-304](../../services/backend/ollama-process-manager.js).

#### 3. Probe the endpoint

- Ollama: `curl http://localhost:11434/api/tags` — must return `{"models": [...]}`
- vLLM: `curl http://localhost:8000/v1/models` — must return a model list
- OpenAI-compatible: `curl <your base URL>/v1/models`

If HTTP returns but Jenny says the engine is down: check the sidecar engine factory at [sidecar/ai/engines/factory.py](../../sidecar/ai/engines/factory.py) and engine registry at [sidecar/ai/engines/provider_registry.py](../../sidecar/ai/engines/provider_registry.py) — a mismatched engine type would produce this.

#### 4. Keeps-unloading pattern

Ollama: check `keep_alive` in the request shape. Default may be too short; override via engine env at [services/backend/ollama-env.js](../../services/backend/ollama-env.js) or Ollama's own config.

vLLM: unloads only on process exit — if it reloads between turns, the process is crashing and being restarted. Check vLLM stderr tail in Jenny's process logs (`{userData}/logs/`). Bundle 5B sanitizes secrets in the stderr tail.

#### 5. OpenAI-compatible specifics

Finding O11: custom base URLs (llama.cpp server, LM Studio, text-generation-webui) return non-vLLM error shapes. Generic `VLLMEngine` errors may hide the real cause (wrong endpoint, missing model, unsupported JSON shape). Inspect raw HTTP from `curl` against the endpoint to rule out shape mismatch.

#### 6. Context overflow

If the model loads but every turn errors: prompt may exceed the context window. `apply_budget_check` at [sidecar/ai/context/token_budget.py](../../sidecar/ai/context/token_budget.py) uses a priority chain: engine metadata → `RuntimeConfig.context_length` → 200 k fallback (documented at docs/operations/resource-budgets.md#token-budget-constants-closes-o3). A very long chat history on a small-context model trips this.

### Common causes

| Symptom | Likely cause | Fix |
|---|---|---|
| CUDA OOM at load | Model too big for VRAM | Pick smaller Q-level or different model |
| "No CUDA device" with GPU present | Driver mismatch or Ollama fallback to CPU | Update driver; check `CUDA_VISIBLE_DEVICES` in engine env |
| HTTP 502 on first turn | Engine still warming | Wait for cold-load to finish; re-probe the endpoint |
| Model loads, unloads immediately | `keep_alive` too short; or vLLM crash | Check Ollama env; read vLLM stderr tail |
| Engine missing after Electron crash | Orphaned state | Stale-PID sweep on next start handles both engines |

### Escalation

Capture hardware profile (`harness.inspect` → `hardware`), engine logs (`{userData}/logs/`), VRAM probe output, model id, and the last 200 lines of the engine's stderr. Note Windows build / macOS / Linux distro.

### Related

- [sidecar/ai/engines/README.md](../../sidecar/ai/engines/README.md) — engine contract
- docs/operations/resource-budgets.md — token budgets, VRAM notes
- BACKEND_PROMPT_LIFECYCLE_REVIEW.md — Sidecar Engines — finding O2 (silent VRAM probe failure), O11 (OpenAI-compat hints)

## First visible token is slow

### Symptoms

- User hits Send; the textbox clears but nothing renders for > 1.5 s.
- Reasoning indicator spins indefinitely; first `chat.token` never arrives (or arrives late).
- SLO targets in BACKEND_PROMPT_LIFECYCLE_REVIEW.md are exceeded: `click → first visible token` P50 > 450 ms for a warm small Ollama 8B.

### The measurement spine

Every latency question reduces to "which of the six timing splits is big?" Spine from the review doc:

1. Renderer send → Electron context assembly start
2. Context assembly start → sidecar request sent
3. Sidecar request sent → provider request start
4. Provider request start → first chunk
5. First chunk → first visible token
6. First visible token → final persistence

Each has a named marker. The canonical source is the review doc's **Timing Markers** section.

### Triage order

#### 1. Capture `chat.performance_turn_summary`

Single-turn summary emitted from [services/backend/managed-sidecar-chat.js:471](../../services/backend/managed-sidecar-chat.js). Contains:

- `traceId`, `streamId`, `sessionId`
- `ms_pre_flight_total`, `ms_context_assembly_elapsed`, `ms_assembly_completed_to_summary_emit`
- Per-contributor timings (personality / memory / Codex auth / Git / linked-session / attachments)
- Model resolution, prepared-message count, tool-schema count

If `ms_context_assembly_elapsed` is > 200 ms, the blank time is in Electron pre-flight, not the provider. If it's < 60 ms and the user still waits > 1 s, the provider is slow.

#### 2. Isolate the contributor

Per-contributor markers inside the assembly envelope:

- `chat.memory_recall_completed` — [services/backend/chat-stream-context-assembly.js:165-179](../../services/backend/chat-stream-context-assembly.js)
- `chat.git_context_resolved`
- `chat.linked_session_recall_completed` — added in Bundle 1

If a single contributor dominates, jump to its sub-runbook:

| Dominator | Read |
|---|---|
| Memory recall | [Memory recall is surfacing wrong memories](#memory-recall-is-surfacing-wrong-memories) + [services/backend/chat-stream-context-assembly.js:23-42](../../services/backend/chat-stream-context-assembly.js) (60 s composite-key cache) |
| Git context | [services/backend/git-context-utils.js](../../services/backend/git-context-utils.js) — hard 5 s timeout, 4 kB diff cap, four concurrent `gitExec` calls via `Promise.all` |
| Personality compile | [sidecar/ai/context/builder.py:416-469](../../sidecar/ai/context/builder.py) — mtime-keyed cache; staleness recompiles the bootstrap |
| Attachments | [services/attachment-service.js](../../services/attachment-service.js), [services/attachment-asset-store.js](../../services/attachment-asset-store.js) — see docs/operations/resource-budgets.md#attachment-caps |

#### 3. Provider-side

If the Electron pre-flight is tight, inspect the provider diagnostics:

- Ollama: [sidecar/ai/engines/ollama_runtime.py:228,279,396](../../sidecar/ai/engines/ollama_runtime.py) — `_record_provider_request`, `_record_first_chunk`, `_record_visible_output`, `_complete_provider_request`
- vLLM: [sidecar/ai/engines/vllm_engine.py:435,499,584,689-733](../../sidecar/ai/engines/vllm_engine.py) — same calls via `TurnDiagnosticsStore`
- OpenAI-compatible: shared diagnostics via the vLLM subclass at [sidecar/ai/engines/openai_compatible.py](../../sidecar/ai/engines/openai_compatible.py)

Key splits inside the provider:
- `provider_request_start → first_chunk` high → cold model, large prompt, slow engine config
- `first_chunk → first_visible_output` high → reasoning-heavy model filtering through the thinking guard ([sidecar/ai/thinking_guard.py](../../sidecar/ai/thinking_guard.py), [sidecar/runtime/reasoning_status.py](../../sidecar/runtime/reasoning_status.py))

#### 4. IPC transit

Added in Bundle 1: `chat.first_notification_forwarded` fires once per stream from [services/chat-stream-bridge.js:165-185](../../services/chat-stream-bridge.js) when the first notification crosses the main-process → renderer boundary. Compare its timestamp against the sidecar-side first emission to isolate IPC transit cost.

### Common contributors

| Source | Typical size | Fix |
|---|---|---|
| Cold Ollama model | dominates first-chunk split on cold load | warm the model before Send; pin with `keep_alive` |
| Long chat history | growth with N messages | check prompt-cache boundary at [sidecar/ai/context/prompt_cache.py:35-60](../../sidecar/ai/context/prompt_cache.py); ensure persona is stable |
| Memory recall large corpus | contributor timing dominates pre-flight | Bundle 1 composite-key cache reuses 60 s; clear via `backend-memory.js::clearMemoryRecallCache()` |
| Git repo with huge diff | capped at 4 kB + 5 s timeout | if consistently hitting timeout, exclude the repo or narrow diff range |
| Personality bootstrap mtime miss | recompile on every turn | if mtimes keep changing (e.g., live-edit), consider a content hash — see Bundle 1 conditional item |
| Plan-mode tool bloat | large tool-schema payload | inspect `tool_schema_count` in performance summary |

### SLO reference

See BACKEND_PROMPT_LIFECYCLE_REVIEW.md — Per-phase latency budgets for P50/P95 targets. Dev-only Diagnostics settings pane (`diagnostics.phasePercentiles.get`) shows rolling P50/P95 for every phase ([services/backend/phase-percentiles-aggregator.js](../../services/backend/phase-percentiles-aggregator.js)).

### Escalation

Capture `{streamId}.json` turn-diagnostic dump plus `chat.performance_turn_summary` line. Include engine name, model id, prompt length (`prepared_message_count`), and hardware class (CPU/RAM/GPU).

### Related

- BACKEND_PROMPT_LIFECYCLE_REVIEW.md — Bundle 1

## Memory recall is surfacing wrong memories

### Current architecture

`MemoryService` in `sidecar/ai/memory/service.py` is the request-time authority.
Electron sends only `chat.send.params.memory_policy`; it does not perform or
cache recall. The sidecar retrieves FTS5 lexical candidates across title,
lesson, and excerpt, applies deterministic family/recency scoring, merges one
recent response-style record when policy permits, deduplicates by SHA-256
digest, and emits at most one five-record/256-token JSON-data overlay.

Explicit `memory_policy.enabled: false` suppresses both store recall and legacy
`learning_context`. Approval resume reuses the already-frozen working messages
and never re-queries memory.

### Triage

1. Call backend-only `memory.status`. Confirm `available`, `schema_version: 7`,
   `recall_index`, `recall_partial`, content-free counts, storage state, and
   `degraded_reasons`. Status never returns memory text, digests, prompts, or
   local paths.
2. If `recall_index` is `bounded_scan`, verify packaged SQLite FTS5 support.
   Fallback is correct but slower. Run
   `python scripts/observe/benchmark_memory_recall.py` on the release reference
   host and record FTS5 and fallback separately.
3. If `recall_partial` is true, the incomplete result was omitted from prompt
   injection. Investigate host I/O pressure rather than treating the empty
   overlay as a relevance result.
4. Use explicit `memory.recall` with the same bounded query to reproduce lexical
   ordering. An exact match older than the newest 500 rows must still be found at
   the 10,000-row bound.
5. Check whether a recent response-style memory legitimately won precedence.
   Re-run with `include_response_style: false` to isolate lexical recall.

### Delete and suppression behavior

Deleting an approved memory atomically removes matching pending copies, writes a
digest-only suppression tombstone, and prevents extraction/rule suggestions from
re-learning it. An explicit later `memory.save` removes the tombstone and counts
as re-approval. There is no Electron recall cache to invalidate and restarting
Jenny should not change this behavior.

### Store health and recovery

Malformed individual rows are removed from active tables and represented by
bounded metadata-only quarantine (`CMP-MEM-0008`); valid rows continue working.
Future schemas fail closed and remain untouched. If physical DB+WAL+SHM pressure
cannot be relieved by derived-data cleanup, approved rows remain intact and new
or growing writes fail with `CMP-MEM-0007`.

Use `python scripts/dev/memory_store_doctor.py <db>` for read-only offline
inspection. Quarantine export is explicit. Restore, delete, and physical
compaction require an explicit `--backup` path and refuse to overwrite an
existing backup. Keep Jenny stopped during repair.

### Escalation evidence

Capture the request/stream correlation id, `memory.status`, benchmark JSON, and
the explicit recall result. Do not collect raw prompt logs, fingerprints, memory
text, provider payloads, or local database paths. Relevant owners:

- `sidecar/ai/memory/service.py`
- `sidecar/ai/memory/store_approved.py`
- `sidecar/ai/memory/recall_scoring.py`
- `sidecar/runtime/request_dispatch_memory.py`
- `docs/operations/versioning-and-migration.md`

## Sidecar crashed mid-turn — how to diagnose

### Symptoms

- Chat stream stops suddenly with a transport error or bare `-32603`.
- Renderer shows a stuck spinner or last assistant turn never finalizes.
- After relaunch, the same session shows an "orphaned" active turn that never resolves.
- Process logs show a Python traceback or an abrupt SIGTERM on `python` / `python.exe`.

### Triage spine

Work top to bottom. Each step either confirms the crash or narrows the blast radius.

#### 1. Capture the `streamId`

Every correlated log line carries `streamId`. Grab it from:

- Renderer devtools console (`chat.send_initiated` / `chat.send_first_event`)
- `chat.performance_turn_summary` (Electron main log — see [services/backend/managed-sidecar-chat.js:471](../../services/backend/managed-sidecar-chat.js))
- The turn-diagnostic dump if the turn terminated non-completed

#### 2. Run the observation kit

One command merges Electron + sidecar logs into a single timeline for the turn:

```bash
npm run observe -- --stream-id <streamId>
```

The script at scripts/observe/timeline.js reads Electron shell-log rotations, sidecar NDJSON rotations, and the turn-diagnostic snapshot JSON, then merge-sorts by `ts`. If the crash has a reproducible stream id, this is the fastest path to a timeline.

#### 3. Inspect the turn-diagnostic dump

On any non-`completed` terminal, the managed runtime writes a snapshot to:

```
{userData}/diagnostics/{yyyy-mm-dd}/{streamId}.json
```

Schema: docs/operations/turn-diagnostic-schema.md. Fire-and-forget from [services/backend/managed-sidecar-chat.js](../../services/backend/managed-sidecar-chat.js); sidecar emits the payload via `harness.turn_diagnostic` at [sidecar/runtime/request_dispatch_harness.py](../../sidecar/runtime/request_dispatch_harness.py).

Fields to check first:
- `terminal_status` — `cancelled` / `timeout` / `runtime_error` tells the shape of the failure.
- `error.code` — look it up in [docs/operations/error-codes.md](../operations/error-codes.md).
- `provider_diagnostics.first_chunk_ts` — if null, the provider never spoke; sidecar or engine, not model, is the likely culprit.

#### 4. Check Electron-owned active-turn state

The canonical recovery marker is the session's persisted `active_turn` in
[services/backend/electron-session-store.js](../../services/backend/electron-session-store.js).
A turn is live only while its `stream_id` also has a controller in
`BackendService.activeStreams`; [services/backend/backend-active-turn-state.js](../../services/backend/backend-active-turn-state.js)
projects that paired state to the renderer. The sidecar intentionally exposes no
active-turn registry or inspection RPC.

#### 5. Check reconciliation

On startup, [services/backend/managed-sidecar-reconciliation.js](../../services/backend/managed-sidecar-reconciliation.js)
sweeps persisted managed-session markers. A marker with a matching live Electron
controller is preserved; a controller-less marker is settled as an orphan. Look for
`backend.active_turn_reconcile_*` diagnostics when a store read or per-session settle
fails.

#### 6. Read the process logs

Rotated under `{userData}/logs/` (default `1 MB × 5 files` per [services/process-log-writer.js:19-34](../../services/process-log-writer.js)). Grep by `streamId`:

```bash
rg -n "<streamId>" {userData}/logs/
```

Look for the last emission before silence: `chat.sidecar_request_settled`, the final `chat.thinking` / `chat.token`, or a `TransportError`.

### Common causes and pointers

| Symptom | Likely cause | File |
|---|---|---|
| Transport error, no Python traceback | sidecar killed externally (task manager, anti-virus) | [services/backend/sidecar-manager.js](../../services/backend/sidecar-manager.js), [services/backend/sidecar-shutdown.js](../../services/backend/sidecar-shutdown.js) |
| `CMP_CHAT_STREAM_FAILED` but no visible error | unclassified Python exception wrapped post-hoc | [sidecar/runtime/request_dispatch.py:716-724](../../sidecar/runtime/request_dispatch.py) (B3) |
| OOM / segfault on a model load | VRAM / RAM exhaustion | [Model won't load / keeps unloading](#model-wont-load--keeps-unloading) |
| Stale `_APPROVAL_PLAN_CACHE` entry after crash | reconciliation did not clear it | [sidecar/runtime/approval_plan.py](../../sidecar/runtime/approval_plan.py), finding D1 |
| Orphaned `python.exe` on Windows | Job Object not attached (dev/debug launch) | [sidecar/runtime/subprocess_manager.py](../../sidecar/runtime/subprocess_manager.py) |

### Recovery

1. Kill any orphaned `python.exe` / `python` processes bound to the app install.
2. Relaunch Jenny — `managed-sidecar-lifecycle` brings the sidecar back up.
3. Reconciliation settles stale sessions automatically; if a session still shows a stuck turn, open it and click Cancel — `chat.cancelStream` forces the terminal transition.

### Escalation

- If you can reproduce on a bare-bones prompt: file a crash report with `{streamId}.json`, the observe-kit output, and the last 500 lines of `shell.log`.
- If the sidecar crashes before emitting `chat.sidecar_request_sent`: the Electron pre-flight is the suspect, not the sidecar.

### Related

- BACKEND_PROMPT_LIFECYCLE_REVIEW.md — Scenario "Sidecar crash/reconnect"

## Tool is stuck in approval

### Symptoms

- Sidecar emits `tool.request_approval` but the renderer never shows the prompt.
- Approval prompt appears, user clicks Approve or Deny, but the turn never resumes.
- Turn hangs until the 600-second approval timeout fires (then classified `CMP-APPROVAL-0003 / timeout`).

### Background

`tool.request_approval` is the **blocking** exception to Jenny's fire-and-forget notification contract — every other RPC is a notification, but approval is a request/response. Constraints:

- 600-second sidecar-side timeout for GUI approvals: `TOOL_APPROVAL_TIMEOUT_SECONDS = 600.0` at [sidecar/server.py:43](../../sidecar/server.py)
- 30-second timeout for headless mode: `_APPROVAL_TIMEOUT_SECONDS = 30.0` at [sidecar/runtime/headless.py:54](../../sidecar/runtime/headless.py)
- Cancel-responsive: the approval wait loop checks `cancel_handle.cancelled` on every iteration at [sidecar/runtime/approval.py:108-173](../../sidecar/runtime/approval.py); blocking reads unblock via `ApprovalResponseCancelledError` within one reader tick.

### Triage

#### 1. Identify where it is stuck

Three stages in the approval handoff. Each has a distinct symptom.

| Stage | Symptom | Files |
|---|---|---|
| Sidecar emit | No `tool.request_approval` in sidecar logs | [sidecar/ai/routing/tool_loop.py:585](../../sidecar/ai/routing/tool_loop.py) (pre-approval cancel check), [sidecar/runtime/approval.py](../../sidecar/runtime/approval.py) |
| Transport to renderer | Sidecar emits but Electron never forwards | [services/backend/sidecar-client.js](../../services/backend/sidecar-client.js) (`onApprovalRequest` callback), [services/chat-stream-bridge.js](../../services/chat-stream-bridge.js), [services/backend/chat-stream-tool-handling.js](../../services/backend/chat-stream-tool-handling.js) |
| Renderer UI | Request arrives but no prompt shows | `renderer-stream-handler-tools.js`, `renderer-approval-block.js` |

Correlate by `tool_call_id` in the request payload.

#### 2. Inspect the approval-plan cache

The sidecar caches execution fingerprint + approval plan keyed by `(request_id, call_id)` at [sidecar/runtime/approval_plan.py](../../sidecar/runtime/approval_plan.py) (5 min TTL via [sidecar/runtime/multiplexer.py:19](../../sidecar/runtime/multiplexer.py)). If a previous turn died mid-approval, the cache entry lives until TTL expires or a successful replacement evicts it. Sign: two concurrent turns see the same `tool_call_id`; after finding D1 the rekeying to `(request_id, call_id)` means this should not collide in practice.

#### 3. Force-cancel

If the turn is stuck, the user can click Cancel — Electron sends `chat.cancelStream` ([services/ipc-contract.js:682](../../services/ipc-contract.js)), which:

1. Multiplexer ([sidecar/runtime/multiplexer.py](../../sidecar/runtime/multiplexer.py)) delivers the cancel control frame.
2. `cancel_handle.cancelled` flips → pending approval read unblocks with `ApprovalResponseCancelledError` within one tick.
3. Loop runtime raises at the next `runtime.raise_if_cancelled()` checkpoint (see Bundle 2 trace at [sidecar/ai/routing/tool_loop.py:362,432,585,716,770](../../sidecar/ai/routing/tool_loop.py)).
4. Electron settles the pending approval row, persists terminal status, and clears
   the matching session `active_turn`; the sidecar releases only request-local state.

Cancel SLO target: P50 40 ms, P95 120 ms (BACKEND_PROMPT_LIFECYCLE_REVIEW.md — Per-scenario end-to-end budgets).

#### 4. Check the response shape

Typedef `ToolApprovalResponse` + `ToolApprovalResponseResult` at [services/ipc-contract.js](../../services/ipc-contract.js) (added in Bundle 4 / finding J1). Schema owner is [sidecar/protocol.py](../../sidecar/protocol.py) + `sidecar/runtime/approval.py::approval_decision_from_response`. A malformed response from a custom renderer will be rejected at the sidecar boundary and surface as `CMP-APPROVAL-0002 / malformed_decision`.

### Denied vs. errored

`denied` is a controlled non-error terminal — the tool call never executed and the loop continues with a synthetic tool-result describing the denial. `errored` is distinct (tool executed and threw).

### Common causes

| Cause | Fix |
|---|---|
| Renderer crashed before approval; sidecar still waiting | User clicks Cancel — cancel handle unblocks approval read |
| `tool_call_id` mismatch between request and response | Check `chat-stream-tool-handling.js` — verify the response `tool_call_id` threads through unchanged |
| Network or preload bridge regression | Grep `services/auxiliary-ipc-handlers.js` for `chat:approval-response` routing |
| Sidecar restart mid-approval | Reconciliation sweeps stale entries; if not, wait 5 min for approval-plan cache TTL |

### Escalation

Capture the 20 lines around `tool.request_approval` from both sidecar log and Electron main log, plus the turn-diagnostic dump. Include `tool_call_id`, `request_id`, `stream_id`.

### Related

- [sidecar/runtime/approval.py](../../sidecar/runtime/approval.py) — approval state machine
- [sidecar/runtime/approval_plan.py](../../sidecar/runtime/approval_plan.py) — plan cache + fingerprints
- [docs/operations/error-codes.md](../operations/error-codes.md) — `CMP-APPROVAL-*` codes
- BACKEND_PROMPT_LIFECYCLE_REVIEW.md — Cancellation and approval — findings B1, B2

## Where to file what's not here

- Symptoms not covered above → open an issue at
  [github.com/SaltyPretz3l/jenny](https://github.com/SaltyPretz3l/jenny)
  with OS, model runtime, reproduction steps, and the diagnostic dump.
- Security findings → see [SECURITY.md](../../SECURITY.md).
- "Is this expected behavior?" → check [FAQ.md](FAQ.md) first.
