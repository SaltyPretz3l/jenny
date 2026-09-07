---
kind: docs-index
last_reviewed: 2026-09-07
status: active
---

# Troubleshooting

Common symptoms grouped by surface. Each entry: what you see, the most
common cause, and how to recover. The developer-facing error code registry
at [docs/operations/error-codes.md](../operations/error-codes.md) is the
source of truth for `CMP-*` codes; this page translates them to user-facing
language.

Two places to look before filing anything:

- **The titlebar health indicator.** It reports whether the backend, engine,
  and model are ready, and its tooltip names the failing part.
- **`<userData>/diagnostics/`** (Windows: `%APPDATA%\jenny\diagnostics\`).
  Any turn that ends abnormally writes a dated JSON dump there. Process logs
  are next to it under `logs/`.

## Install and launch

### Windows blocks the installer ("Windows protected your PC")

**Symptom.** SmartScreen interrupts the installer or the first app launch.

**Common cause.** The build is not code-signed, which is expected for every
release today and not a sign of tampering.

**Recovery.** Click **More info → Run anyway**. To verify the download
first, compare its SHA-256 hash against the table in the release's
`RELEASE_NOTES.md` (PowerShell: `Get-FileHash .\Jenny-Setup-x64.exe`).

### macOS refuses to open the app

**Symptom.** "Apple could not verify 'Jenny' is free of malware," or the
app "is damaged and can't be opened."

**Common cause.** Gatekeeper quarantine on the unsigned, best-effort macOS
build.

**Recovery.** Open **System Settings → Privacy & Security** and click
**Open Anyway** next to the blocked-app notice. On older macOS, right-click
**Jenny.app** → **Open** → **Open**. If neither option appears, clear the
quarantine flag: `xattr -dr com.apple.quarantine "/Applications/Jenny.app"`.
The macOS build is untested by the maintainer, auto-update is disabled
there, and the sandboxed Python tool is Windows-only.

### Crash on startup

**Symptom.** Jenny exits or shows the Electron crash screen before the main
window paints.

**Common cause.** A migration on the session store, memory store, or
personality config failed because of a corrupted JSON file.

**Recovery.** Look under `<userData>/diagnostics/` for the most recent
dump. Per the corruption policy in
[docs/operations/versioning-and-migration.md](../operations/versioning-and-migration.md),
corrupted JSON files are renamed with a `.corrupt-<timestamp>` suffix and
re-initialized; if the rename didn't happen, manually rename the suspect
file and relaunch. File an issue with the diagnostic dump if this
reproduces.

### Setup says "Setup Not Ready" or a step keeps failing

**Symptom.** A checklist step reports **Needs attention**, or finishing
setup fails.

**Common cause.** The backend is still starting, or the step depends on one
you skipped (pulling a model needs Ollama; validating an endpoint needs a
running server).

**Recovery.** Wait for the titlebar health indicator, press **Re-check** on
the engine scene, and retry the step. **Finish later** keeps your progress.
You can reopen the checklist any time from **Settings → Local Profile &
Setup → Run setup again**.

## Engines and models

### Ollama installer fails during setup

**Symptom.** The **Local engine** scene reports that the Ollama download or
install did not complete.

**Common cause.** A network interruption, or the installer's SHA-256 hash
did not match the expected value (Jenny refuses to run it in that case).

**Recovery.** Press **Install Ollama** again. If it fails twice, install
Ollama from [ollama.com/download](https://ollama.com/download) yourself and
press **Re-check**. On macOS the button always links there.

### Ollama tray app conflict

**Symptom.** A toast asks you to quit the Ollama tray app, or the engine
restarts and models unload unexpectedly.

**Common cause.** The Ollama desktop/tray app is running its own server on
the same port as the one Jenny manages, so the two fight over the port and
over loaded models.

**Recovery.** Quit the Ollama tray app (the icon in the notification area or
menu bar) and let Jenny manage Ollama. Jenny will start it when needed.

### Model download fails or stalls

**Symptom.** The pull stops with an error, or progress stays at 0%.

**Common cause.** Not enough free disk (the default model needs about 6 GB
plus headroom), a network interruption, or Ollama not yet running.

**Recovery.** Check free disk space, confirm Ollama is running
(`ollama list` in a terminal), and press pull again; pulls resume. If the
failure repeats, run
`ollama pull hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M` in a terminal to see
the raw error, and file an issue with that output if it isn't
self-explanatory.

### Ollama unreachable / model list is empty

**Symptom.** The health indicator shows the engine as down, or the model
picker is empty.

**Common cause.** The Ollama service isn't running on the configured port
(default `localhost:11434`), or the model you selected hasn't been pulled.

**Recovery.** Verify `ollama list` shows your model. Start Ollama if it's
not running. **Settings → Models** covers installed models and engine
recovery. To change the engine host or port, or to re-run the hardware
recommendation, open **Settings → Local Profile & Setup → Run setup again**
and use the **Validate your endpoint** and **Pull a local model** steps.

### Model load race / "Model is starting"

**Symptom.** The first message after switching models hangs for 10–60
seconds before producing any output.

**Common cause.** The local engine is loading the model weights into RAM or
VRAM. This is normal on a cold start.

**Recovery.** Wait for the first token. Subsequent turns will be fast. If
first-token latency consistently exceeds 60 seconds, walk through
[First visible token is slow](#first-visible-token-is-slow).

### "Model failed" in the titlebar

**Symptom.** The health indicator turns red with **Model failed** after
choosing a model, and chat is blocked.

**Common cause.** The model does not fit in VRAM or RAM, or the managed
`llama-server` could not start it (an unsupported GGUF, or a projector
file missing for a vision model).

**Recovery.** Open **Settings → Model library**. The fit estimate on each
row says whether it fits your hardware; pick a smaller quantization or a
smaller model. For a `llama-server` model, press **Restart llama-server**
in the tune drawer after adjusting the context window. If the restart
fails, the message says the setting was saved but is not live; the next
model switch applies it.

### llama-server restart failed after changing the context window

**Symptom.** "llama-server restart failed. The setting was saved and is not
live yet."

**Common cause.** The new context window needs more memory than is free,
or another process is holding the GPU.

**Recovery.** Lower the context window or close GPU-heavy apps, then press
**Restart llama-server** again. The saved value applies on the next
successful start.

### The model can't see my image

**Symptom.** The composer says "Remove the image or choose a vision model to
send."

**Common cause.** The active model is text-only (the default Ornith 1.5 9B
is).

**Recovery.** Switch to a vision model such as Gemma 4 E4B from the model
picker, or remove the attachment. On the managed `llama-server` a vision
model also needs its projector (mmproj) file; Jenny attaches it
automatically when it sits next to the GGUF.

### Every turn errors on a long conversation

**Symptom.** Turns fail with a context or budget error, or Jenny compacts
the conversation repeatedly.

**Common cause.** The conversation has outgrown the model's context window.
Jenny summarises earlier context mid-turn, but a very small window on a
very long chat can still trip.

**Recovery.** Start a new session for a new topic, raise the context window
for the model in the library's tune drawer if your memory allows, or pick a
model with a larger window. The composer's context meter shows how full
the window is.

## Chat and tools

### Backend not ready / "Backend stopped"

**Symptom.** The health indicator shows the backend as starting or stopped,
and messages don't send. Sometimes paired with a `CMP-MODE-*` toast.

**Common cause.** The Python sidecar process is still starting (a cold
start takes a few seconds) or has crashed mid-handshake.

**Recovery.** Wait 10 seconds; if it persists, restart the app. If the
issue reproduces, capture the diagnostic dump from
`<userData>/diagnostics/` and file an issue. Developer reference:
[Sidecar crashed mid-turn — how to diagnose](#sidecar-crashed-mid-turn--how-to-diagnose).

### Approval card never appears, or the turn hangs after I answer it

**Symptom.** A tool call shows "Awaiting approval" with no card visible, or
you approve and nothing continues; eventually it errors with a
`CMP-APPROVAL-*` code.

**Common cause.** The approval wait (10 minutes) expired, or the renderer
lost the request.

**Recovery.** Press **Cancel** on the turn and resend the prompt. If cards
consistently don't appear, capture the diagnostic dump. Developer
reference: [Tool is stuck in approval](#tool-is-stuck-in-approval).

### A tool that used to run now asks for approval

**Symptom.** A call you approved with **Always allow** stops at the card
again.

**Common cause.** Rules are scoped to the tool **and** the path it named. A
call on a different path is a new decision. Destructive shell commands
always ask, even under **Auto**.

**Recovery.** Approve again, or review the saved rules under **Settings →
Tools → Approval rules**.

### "Workspace root not set" / tools are blocked

**Symptom.** File, shell, or git tool calls refuse to run with a `CMP-TOOL-*`
code mentioning the workspace root.

**Common cause.** No workspace root is configured. Jenny gates those tools
behind an explicit folder so tool calls can't write to arbitrary
directories.

**Recovery.** Choose a folder under **Settings → Tools → Workspace root**.
The tools become available immediately. If a specific capability is still
off, check **Settings → Tools → Optional capabilities**.

### Turn stopped on the tool or iteration budget

**Symptom.** The reply ends early with a **Resume this turn** button.

**Common cause.** The turn hit the per-turn tool-call or iteration budget.
This is a safety stop, not an error.

**Recovery.** Press **Resume** (or Enter from an empty composer) to
continue from where it stopped.

### "Turn stopped: session locked."

**Symptom.** Sending fails with that message and the session shows an
offline-lockdown badge.

**Common cause.** The session was locked down offline for the rest of its
life. Lockdown is deliberate and permanent for that session.

**Recovery.** Start a new session. The locked session stays readable.

### `python_execute` is unavailable

**Symptom.** "python runtime is only available on Windows in this build,"
or the tool fails while bootstrapping its runtime.

**Common cause.** The sandboxed Python runtime is Windows-only in 1.0. On
Windows, a bootstrap failure is usually the runtime's first-run pip install
failing offline, a wheelhouse integrity check failing, or a stale lock from
an interrupted first run.

**Recovery.** On Windows, retry once; the bootstrap is bounded and reports
a specific reason on repeat failures. Make sure the capability is on under
**Settings → Tools → Optional capabilities**. On macOS and Linux use the
shell tools instead.

### Chat stream stuck / spinner won't go away

**Symptom.** The thinking indicator persists after the model has clearly
finished; the assistant row stops updating but never closes.

**Common cause.** A terminal stream event was dropped between the sidecar
and the renderer. The turn data is persisted, but the renderer didn't get
the close signal.

**Recovery.** Switch sessions and back; the renderer rehydrates the
persisted turn on remount. If the spinner reappears immediately, capture
the diagnostic dump and file an issue.

### An MCP connection shows Failed or Review required

See the troubleshooting section of
[Adding an MCP server](../tutorials/02-adding-mcp-server.md#troubleshooting).

### A plugin won't install

**Symptom.** "Install plugin" rejects the package, or an installed plugin
stays inactive.

**Common cause.** The package is not a `.jenny-plugin` file, or it declares
a privileged kind (full-host provider, native panel) without a valid
signature. Unsigned plugins are labelled and confined to the developer
profile; privileged kinds are refused without a signature.

**Recovery.** Check the message on the Plugins card. For a plugin you are
building, follow [docs/plugins/PACKAGING_AND_SIGNING.md](../plugins/PACKAGING_AND_SIGNING.md).
A freshly installed plugin is inactive until you enable it.

## Data and updates

### Update check fails

**Symptom.** **Check for Updates** reports that the update check failed.

**Common cause.** No network, or the GitHub releases endpoint is
unreachable. On macOS updates are disabled by design.

**Recovery.** Retry later. Manual download from the
[releases page](https://github.com/SaltyPretz3l/jenny/releases) always
works; verify the SHA-256 hash against `RELEASE_NOTES.md`.

### Archive or restore failed

**Symptom.** Archive creation stops, a saved archive is not offered, or
restore reports `CMP-DATA-0006` through `CMP-DATA-0009`.

**Recovery.** Keep live data in place. Confirm the archive directory
contains `COMPLETE`, do not edit its files, and retry the passphrase
locally. An archive without `COMPLETE` or with edited payloads is
intentionally rejected. If the profile already contains chats or
attachments, use the per-session importer instead of a full restore. See
[Uninstall and Data Recovery](../operations/UNINSTALL_AND_DATA_RECOVERY.md).

### Uninstall reports incomplete cleanup

**Symptom.** The receipt reports retained or failed targets with
`CMP-DATA-0010`.

**Recovery.** Close programs that may hold Jenny files, keep the receipt,
and retry the official helper. Unknown `.companion` children, shared
models, and unselected workspace data are expected to remain. Do not
manually delete a broad profile or runtime root unless every remaining path
has been identified.

## Runbooks

Deeper diagnostic walkthroughs for contributors working on Jenny's backend;
each assumes familiarity with the codebase and links straight to source.
File links are to the current tree; line numbers are deliberately omitted
because they drift.

## Model won't load / keeps unloading

### Symptoms

- Ollama or `llama-server` shows "starting" but never reaches "serving".
- Model loads, generates one turn, then unloads (`keep_alive` expired).
- Engine exits mid-turn with `connection refused` or `502 Bad Gateway`.
- `harness.inspect` shows `engine.ready: false` while the UI claims the
  engine is up.
- Process log: `CUDA out of memory`, `MALLOC failed`, a Windows SEH
  exception from Ollama.

### Background

Jenny runs local-first engines managed by Electron:

- **Ollama** — [services/backend/ollama-process-manager.js](../../services/backend/ollama-process-manager.js), shutdown at [services/backend/ollama-shutdown.js](../../services/backend/ollama-shutdown.js), env at [services/backend/ollama-env.js](../../services/backend/ollama-env.js), tray-app conflict detection at [services/backend/ollama-tray-conflict.js](../../services/backend/ollama-tray-conflict.js).
- **Managed `llama-server`** — capabilities probe at [services/backend/llama-server-capabilities.js](../../services/backend/llama-server-capabilities.js), speculative decoding at [services/backend/llama-server-acceleration.js](../../services/backend/llama-server-acceleration.js); see [docs/operations/LLAMA_SERVER_ACCELERATION.md](../operations/LLAMA_SERVER_ACCELERATION.md).
- **vLLM** — [services/backend/vllm-process-manager.js](../../services/backend/vllm-process-manager.js).
- **OpenAI-compatible** — external, not managed; Jenny only points at a URL.
- Lifecycle dispatch: [services/backend/local-engine-lifecycle.js](../../services/backend/local-engine-lifecycle.js), status at [services/backend/local-engine-status.js](../../services/backend/local-engine-status.js).

Sidecar side:

- [sidecar/ai/engines/ollama_runtime.py](../../sidecar/ai/engines/ollama_runtime.py)
- [sidecar/ai/engines/openai_compatible.py](../../sidecar/ai/engines/openai_compatible.py) (also the `llama-server` and vLLM request shape)
- [sidecar/ai/engines/local_server_props.py](../../sidecar/ai/engines/local_server_props.py) — `/props` probe for the served context window

Hardware probe:

- [sidecar/runtime/hardware_profile.py](../../sidecar/runtime/hardware_profile.py)
- [sidecar/runtime/hardware_vram_usage.py](../../sidecar/runtime/hardware_vram_usage.py) — VRAM probe; a probe failure is silent (stub `{available: False}`)

### Triage

#### 1. Check VRAM / RAM

Open Task Manager / `nvidia-smi` and read current utilization. Rough
ceilings for a single 24 GB GPU:

| Model class | Approx VRAM (Q4 GGUF / FP16) |
|---|---|
| 7B–9B | 5–6 GB / 16 GB |
| 12B–13B | 8–9 GB / 28 GB (too big) |
| 27B–35B | 18–20 GB / 72 GB (multi-GPU) |

If another app (a browser, a game) is holding the GPU, Ollama falls back to
CPU silently; `llama-server` and vLLM refuse to start.

#### 2. Check the engine is actually running

Windows:

```bash
tasklist | findstr "ollama\|llama-server\|vllm\|python"
```

POSIX:

```bash
ps aux | grep -E "ollama|llama-server|vllm|python"
```

If the engine process is missing but Jenny thinks it's up, state is stale.
Both managed engines keep a state file under `{userData}` and sweep stale
PIDs on the next `start()` (see the process managers above).

#### 3. Probe the endpoint

- Ollama: `curl http://localhost:11434/api/tags` — must return `{"models": [...]}`
- `llama-server` / vLLM / OpenAI-compatible: `curl <base URL>/v1/models` — must return a model list
- `llama-server` context window: `curl <base URL>/props` — per-slot `n_ctx`, not the training value

If HTTP answers but Jenny says the engine is down, check the sidecar engine
factory at [sidecar/ai/engines/factory.py](../../sidecar/ai/engines/factory.py)
and the provider registry at
[sidecar/ai/engines/provider_registry.py](../../sidecar/ai/engines/provider_registry.py);
a mismatched engine type produces exactly this.

#### 4. Keeps-unloading pattern

Ollama: check `keep_alive` in the request shape; override through the
engine env passthrough at [services/backend/ollama-env.js](../../services/backend/ollama-env.js)
or Ollama's own config. Also rule out the tray-app conflict: two Ollama
servers on one port evict each other's models.

`llama-server` and vLLM unload only on process exit. If they reload between
turns, the process is crashing and being restarted; read the stderr tail in
`{userData}/logs/` (secrets are sanitized).

#### 5. OpenAI-compatible specifics

Custom servers (LM Studio, text-generation-webui, a hand-run llama.cpp)
return non-standard error shapes, and the generic engine error can hide the
real cause (wrong endpoint, missing model, unsupported JSON shape). Inspect
raw HTTP from `curl` against the endpoint to rule out a shape mismatch.

#### 6. Context overflow

If the model loads but every turn errors, the prompt may exceed the context
window. `apply_budget_check` at
[sidecar/ai/context/token_budget.py](../../sidecar/ai/context/token_budget.py)
uses a priority chain: engine metadata → the configured context length →
a fixed fallback. A long history on a small-context model trips this before
mid-turn compaction can help.

### Common causes

| Symptom | Likely cause | Fix |
|---|---|---|
| CUDA OOM at load | Model too big for VRAM | Pick a smaller quant or model; the library's fit estimate is the guide |
| "No CUDA device" with GPU present | Driver mismatch or Ollama CPU fallback | Update the driver; check `CUDA_VISIBLE_DEVICES` in the engine env |
| HTTP 502 on first turn | Engine still warming | Wait for the cold load; re-probe the endpoint |
| Model loads, unloads immediately | `keep_alive` too short, tray-app conflict, or a `llama-server`/vLLM crash | Check the Ollama env; quit the tray app; read the stderr tail |
| Engine missing after an Electron crash | Orphaned state | The stale-PID sweep on next start handles both managed engines |

### Escalation

Capture the hardware profile (`harness.inspect` → `hardware`), engine logs
(`{userData}/logs/`), VRAM probe output, model id, and the last 200 lines of
the engine's stderr. Note the Windows build / macOS version / Linux distro.

### Related

- [sidecar/ai/engines/README.md](../../sidecar/ai/engines/README.md) — engine contract
- [docs/operations/LLAMA_SERVER_ACCELERATION.md](../operations/LLAMA_SERVER_ACCELERATION.md) — managed `llama-server` acceleration and its kill switch

## First visible token is slow

### Symptoms

- The user hits Send; the textbox clears but nothing renders for > 1.5 s.
- The reasoning indicator spins indefinitely; the first `chat.token` never
  arrives, or arrives late.
- `click → first visible token` is well above the warm-model target (a few
  hundred milliseconds for a warm small model on Ollama).

### The measurement spine

Every latency question reduces to "which of the six timing splits is big?"

1. Renderer send → Electron context assembly start
2. Context assembly start → sidecar request sent
3. Sidecar request sent → provider request start
4. Provider request start → first chunk
5. First chunk → first visible token
6. First visible token → final persistence

Each has a named marker in the performance summary below.

### Triage order

#### 1. Capture `chat.performance_turn_summary`

A single-turn summary emitted from
[services/backend/managed-sidecar-chat.js](../../services/backend/managed-sidecar-chat.js).
Contains:

- `traceId`, `streamId`, `sessionId`
- `ms_pre_flight_total`, `ms_context_assembly_elapsed`, `ms_assembly_completed_to_summary_emit`
- Per-contributor timings (personality / memory / Git / linked-session / attachments)
- Model resolution, prepared-message count, tool-schema count

If `ms_context_assembly_elapsed` is > 200 ms, the blank time is in Electron
pre-flight, not the provider. If it's < 60 ms and the user still waits
> 1 s, the provider is slow.

#### 2. Isolate the contributor

Per-contributor markers inside the assembly envelope:

- `chat.memory_recall_completed` — [services/backend/chat-stream-context-assembly.js](../../services/backend/chat-stream-context-assembly.js)
- `chat.git_context_resolved`
- `chat.linked_session_recall_completed`

If a single contributor dominates, jump to its sub-runbook:

| Dominator | Read |
|---|---|
| Memory recall | [Memory recall is surfacing wrong memories](#memory-recall-is-surfacing-wrong-memories) |
| Git context | [services/backend/git-context-utils.js](../../services/backend/git-context-utils.js) — hard timeout, diff cap, concurrent `gitExec` calls |
| Personality compile | [sidecar/ai/context/builder.py](../../sidecar/ai/context/builder.py) — mtime-keyed cache; staleness recompiles the bootstrap |
| Attachments | [services/attachment-service.js](../../services/attachment-service.js), [services/attachment-asset-store.js](../../services/attachment-asset-store.js) |

#### 3. Provider-side

If the Electron pre-flight is tight, inspect the provider diagnostics:

- Ollama: [sidecar/ai/engines/ollama_runtime.py](../../sidecar/ai/engines/ollama_runtime.py) — `_record_provider_request`, `_record_first_chunk`, `_record_visible_output`, `_complete_provider_request`
- OpenAI-compatible (`llama-server`, vLLM): [sidecar/ai/engines/openai_compatible.py](../../sidecar/ai/engines/openai_compatible.py) — the same calls through `TurnDiagnosticsStore`

Key splits inside the provider:

- `provider_request_start → first_chunk` high → cold model, large prompt, slow engine config
- `first_chunk → first_visible_output` high → a reasoning-heavy model filtering through the thinking guard ([sidecar/ai/thinking_guard.py](../../sidecar/ai/thinking_guard.py), [sidecar/runtime/reasoning_status.py](../../sidecar/runtime/reasoning_status.py))

#### 4. IPC transit

`chat.first_notification_forwarded` fires once per stream from
[services/chat-stream-bridge.js](../../services/chat-stream-bridge.js) when
the first notification crosses the main-process → renderer boundary.
Compare its timestamp against the sidecar-side first emission to isolate
IPC transit cost.

### Common contributors

| Source | Typical size | Fix |
|---|---|---|
| Cold model | dominates the first-chunk split on a cold load | warm the model before Send; pin with `keep_alive` |
| Long chat history | grows with message count | check the prompt-cache boundary at [sidecar/ai/context/prompt_cache.py](../../sidecar/ai/context/prompt_cache.py); keep the persona stable |
| Memory recall on a large corpus | contributor timing dominates pre-flight | recall results are cached for 60 s per composite key |
| Git repo with a huge diff | capped with a timeout | if the timeout is hit consistently, narrow the diff range |
| Personality bootstrap mtime miss | recompile on every turn | avoid live-editing the personality files mid-session |
| Plan-mode tool bloat | large tool-schema payload | inspect `tool_schema_count` in the performance summary |

### Escalation

Capture the `{streamId}.json` turn-diagnostic dump plus the
`chat.performance_turn_summary` line. Include engine name, model id, prompt
length (`prepared_message_count`), and hardware class (CPU/RAM/GPU).

## Memory recall is surfacing wrong memories

### Current architecture

`MemoryService` in `sidecar/ai/memory/service.py` is the request-time
authority. Electron sends only `chat.send.params.memory_policy`; it does
not perform or cache recall. The sidecar retrieves FTS5 lexical candidates
across title, lesson, and excerpt, applies deterministic family/recency
scoring, merges one recent response-style record when policy permits,
deduplicates by SHA-256 digest, and emits at most one five-record/256-token
JSON-data overlay.

Explicit `memory_policy.enabled: false` suppresses both store recall and
legacy `learning_context`. Approval resume reuses the already-frozen
working messages and never re-queries memory.

### Triage

1. Call backend-only `memory.status`. Confirm `available`, `schema_version`,
   `recall_index`, `recall_partial`, content-free counts, storage state, and
   `degraded_reasons`. Status never returns memory text, digests, prompts,
   or local paths.
2. If `recall_index` is `bounded_scan`, verify packaged SQLite FTS5 support.
   The fallback is correct but slower. Run
   `python scripts/observe/benchmark_memory_recall.py` on the release
   reference host and record FTS5 and fallback separately.
3. If `recall_partial` is true, the incomplete result was omitted from
   prompt injection. Investigate host I/O pressure rather than treating the
   empty overlay as a relevance result.
4. Use explicit `memory.recall` with the same bounded query to reproduce
   lexical ordering. An exact match older than the newest 500 rows must
   still be found at the 10,000-row bound.
5. Check whether a recent response-style memory legitimately won
   precedence. Re-run with `include_response_style: false` to isolate
   lexical recall.

### Delete and suppression behavior

Deleting an approved memory atomically removes matching pending copies,
writes a digest-only suppression tombstone, and prevents extraction and
rule suggestions from re-learning it. An explicit later `memory.save`
removes the tombstone and counts as re-approval. There is no Electron
recall cache to invalidate; restarting Jenny does not change this.

### Store health and recovery

Malformed individual rows are removed from active tables and represented by
bounded metadata-only quarantine (`CMP-MEM-0008`); valid rows continue
working. Future schemas fail closed and remain untouched. If physical
DB+WAL+SHM pressure cannot be relieved by derived-data cleanup, approved
rows remain intact and new or growing writes fail with `CMP-MEM-0007`.

Use `python scripts/dev/memory_store_doctor.py <db>` for read-only offline
inspection. Quarantine export is explicit. Restore, delete, and physical
compaction require an explicit `--backup` path and refuse to overwrite an
existing backup. Keep Jenny stopped during repair.

### Escalation evidence

Capture the request/stream correlation id, `memory.status`, benchmark JSON,
and the explicit recall result. Do not collect raw prompt logs,
fingerprints, memory text, provider payloads, or local database paths.
Relevant owners:

- `sidecar/ai/memory/service.py`
- `sidecar/ai/memory/store_approved.py`
- `sidecar/ai/memory/recall_scoring.py`
- `sidecar/runtime/request_dispatch_memory.py`
- `docs/operations/versioning-and-migration.md`

## Sidecar crashed mid-turn — how to diagnose

### Symptoms

- The chat stream stops suddenly with a transport error or a bare `-32603`.
- The renderer shows a stuck spinner, or the last assistant turn never
  finalizes.
- After relaunch, the same session shows an orphaned active turn that
  never resolves.
- Process logs show a Python traceback or an abrupt SIGTERM on `python` /
  `python.exe`.

### Triage spine

Work top to bottom. Each step either confirms the crash or narrows the
blast radius.

#### 1. Capture the `streamId`

Every correlated log line carries `streamId`. Grab it from:

- The renderer devtools console (`chat.send_initiated` / `chat.send_first_event`)
- `chat.performance_turn_summary` in the Electron main log
- The turn-diagnostic dump if the turn terminated non-completed

#### 2. Run the observation kit

One command merges Electron and sidecar logs into a single timeline for
the turn:

```bash
npm run observe -- --stream-id <streamId>
```

The script at scripts/observe/timeline.js
reads Electron shell-log rotations, sidecar NDJSON rotations, and the
turn-diagnostic snapshot JSON, then merge-sorts by `ts`.

#### 3. Inspect the turn-diagnostic dump

On any non-`completed` terminal, the managed runtime writes a snapshot to:

```
{userData}/diagnostics/{yyyy-mm-dd}/{streamId}.json
```

Written fire-and-forget from
[services/backend/turn-diagnostic-dump.js](../../services/backend/turn-diagnostic-dump.js);
the sidecar emits the payload via `harness.turn_diagnostic` at
[sidecar/runtime/request_dispatch_harness.py](../../sidecar/runtime/request_dispatch_harness.py).

Fields to check first:

- `terminal_status` — `cancelled` / `timeout` / `runtime_error` tells the shape of the failure.
- `error.code` — look it up in [docs/operations/error-codes.md](../operations/error-codes.md).
- `provider_diagnostics.first_chunk_ts` — if null, the provider never spoke; the sidecar or engine, not the model, is the likely culprit.

#### 4. Check Electron-owned active-turn state

The canonical recovery marker is the session's persisted `active_turn` in
[services/backend/electron-session-store.js](../../services/backend/electron-session-store.js).
A turn is live only while its `stream_id` also has a controller in
`BackendService.activeStreams`;
[services/backend/backend-active-turn-state.js](../../services/backend/backend-active-turn-state.js)
projects that paired state to the renderer. The sidecar intentionally
exposes no active-turn registry or inspection RPC.

#### 5. Check reconciliation

On startup,
[services/backend/managed-sidecar-reconciliation.js](../../services/backend/managed-sidecar-reconciliation.js)
sweeps persisted managed-session markers. A marker with a matching live
Electron controller is preserved; a controller-less marker is settled as an
orphan. Look for `backend.active_turn_reconcile_*` diagnostics when a store
read or per-session settle fails.

#### 6. Read the process logs

Rotated under `{userData}/logs/` by
[services/process-log-writer.js](../../services/process-log-writer.js).
Grep by `streamId`:

```bash
rg -n "<streamId>" {userData}/logs/
```

Look for the last emission before silence: `chat.sidecar_request_settled`,
the final `chat.thinking` / `chat.token`, or a `TransportError`.

### Common causes and pointers

| Symptom | Likely cause | File |
|---|---|---|
| Transport error, no Python traceback | sidecar killed externally (task manager, anti-virus) | [services/backend/sidecar-manager.js](../../services/backend/sidecar-manager.js), [services/backend/sidecar-shutdown.js](../../services/backend/sidecar-shutdown.js) |
| `CMP_CHAT_STREAM_FAILED` but no visible error | unclassified Python exception wrapped post-hoc | [sidecar/runtime/request_dispatch.py](../../sidecar/runtime/request_dispatch.py) |
| OOM / segfault on a model load | VRAM / RAM exhaustion | [Model won't load / keeps unloading](#model-wont-load--keeps-unloading) |
| Stale approval-plan cache entry after a crash | reconciliation did not clear it | [sidecar/runtime/approval_plan.py](../../sidecar/runtime/approval_plan.py) |
| Orphaned `python.exe` on Windows | Job Object not attached (dev/debug launch) | [sidecar/runtime/subprocess_manager.py](../../sidecar/runtime/subprocess_manager.py) |

### Recovery

1. Kill any orphaned `python.exe` / `python` processes bound to the app install.
2. Relaunch Jenny; the managed sidecar lifecycle brings the sidecar back up.
3. Reconciliation settles stale sessions automatically. If a session still
   shows a stuck turn, open it and click Cancel; `chat.cancelStream` forces
   the terminal transition.

### Escalation

- If you can reproduce on a bare-bones prompt: file a crash report with
  `{streamId}.json`, the observe-kit output, and the last 500 lines of
  `shell.log`.
- If the sidecar crashes before emitting `chat.sidecar_request_sent`, the
  Electron pre-flight is the suspect, not the sidecar.

## Tool is stuck in approval

### Symptoms

- The sidecar emits `tool.request_approval` but the renderer never shows the card.
- The card appears, the user clicks Approve or Deny, but the turn never resumes.
- The turn hangs until the 600-second approval timeout fires (then classified `CMP-APPROVAL-0003 / timeout`).

### Background

`tool.request_approval` is the **blocking** exception to Jenny's
fire-and-forget notification contract: every other RPC is a notification,
but approval is a request/response. Constraints:

- 600-second sidecar-side timeout for GUI approvals: `TOOL_APPROVAL_TIMEOUT_SECONDS` in [sidecar/server.py](../../sidecar/server.py)
- 30-second timeout for headless mode: `_APPROVAL_TIMEOUT_SECONDS` in [sidecar/runtime/headless.py](../../sidecar/runtime/headless.py)
- Cancel-responsive: the approval wait loop checks `cancel_handle.cancelled` on every iteration in [sidecar/runtime/approval.py](../../sidecar/runtime/approval.py); blocking reads unblock via `ApprovalResponseCancelledError` within one reader tick.

### Triage

#### 1. Identify where it is stuck

Three stages in the approval handoff. Each has a distinct symptom.

| Stage | Symptom | Files |
|---|---|---|
| Sidecar emit | No `tool.request_approval` in sidecar logs | [sidecar/ai/routing/tool_loop.py](../../sidecar/ai/routing/tool_loop.py) (pre-approval cancel check), [sidecar/runtime/approval.py](../../sidecar/runtime/approval.py) |
| Transport to renderer | Sidecar emits but Electron never forwards | [services/backend/sidecar-client.js](../../services/backend/sidecar-client.js) (`onApprovalRequest` callback), [services/chat-stream-bridge.js](../../services/chat-stream-bridge.js), [services/backend/chat-stream-tool-handling.js](../../services/backend/chat-stream-tool-handling.js) |
| Renderer UI | Request arrives but no card shows | `renderer/chat/renderer-stream-handler-tools.js`, `renderer/chat/renderer-approval-block.js` |

Correlate by `tool_call_id` in the request payload.

#### 2. Inspect the approval-plan cache

The sidecar caches the execution fingerprint and approval plan keyed by
`(request_id, call_id)` in
[sidecar/runtime/approval_plan.py](../../sidecar/runtime/approval_plan.py)
with a 5-minute TTL (see [sidecar/runtime/multiplexer.py](../../sidecar/runtime/multiplexer.py)).
If a previous turn died mid-approval, the cache entry lives until the TTL
expires or a successful replacement evicts it.

#### 3. Force-cancel

If the turn is stuck, the user can click Cancel. Electron sends
`chat.cancelStream` ([services/ipc-contract.js](../../services/ipc-contract.js)), which:

1. Delivers the cancel control frame through the multiplexer ([sidecar/runtime/multiplexer.py](../../sidecar/runtime/multiplexer.py)).
2. Flips `cancel_handle.cancelled`; the pending approval read unblocks with `ApprovalResponseCancelledError` within one tick.
3. Raises at the next `runtime.raise_if_cancelled()` checkpoint in the tool loop.
4. Settles the pending approval row on the Electron side, persists the terminal status, and clears the matching session `active_turn`; the sidecar releases only request-local state.

#### 4. Check the response shape

Typedefs `ToolApprovalResponse` and `ToolApprovalResponseResult` live in
[services/ipc-contract.js](../../services/ipc-contract.js). The schema
owner is [sidecar/protocol.py](../../sidecar/protocol.py) plus
`sidecar/runtime/approval.py::approval_decision_from_response`. A malformed
response is rejected at the sidecar boundary and surfaces as
`CMP-APPROVAL-0002 / malformed_decision`.

### Denied vs. errored

`denied` is a controlled non-error terminal: the tool call never executed
and the loop continues with a synthetic tool result describing the denial.
`errored` is distinct (the tool executed and threw).

### Common causes

| Cause | Fix |
|---|---|
| Renderer crashed before approval; sidecar still waiting | User clicks Cancel; the cancel handle unblocks the approval read |
| `tool_call_id` mismatch between request and response | Check `chat-stream-tool-handling.js`; verify the response `tool_call_id` threads through unchanged |
| Preload bridge regression | Trace the decision from `renderer/chat/renderer-approval-block.js` through the preload bridge to `services/backend/chat-stream-tool-handling.js` (`tool_approval_resolved`) |
| Sidecar restart mid-approval | Reconciliation sweeps stale entries; if not, wait 5 min for the approval-plan cache TTL |

### Escalation

Capture the 20 lines around `tool.request_approval` from both the sidecar
log and the Electron main log, plus the turn-diagnostic dump. Include
`tool_call_id`, `request_id`, and `stream_id`.

### Related

- [sidecar/runtime/approval.py](../../sidecar/runtime/approval.py) — approval state machine
- [sidecar/runtime/approval_plan.py](../../sidecar/runtime/approval_plan.py) — plan cache and fingerprints
- [docs/operations/error-codes.md](../operations/error-codes.md) — `CMP-APPROVAL-*` codes

## Where to file what's not here

- Symptoms not covered above → open an issue at
  [github.com/SaltyPretz3l/jenny](https://github.com/SaltyPretz3l/jenny)
  with OS, model runtime, reproduction steps, and the diagnostic dump.
- Security findings → see [SECURITY.md](../../SECURITY.md).
- "Is this expected behavior?" → check [FAQ.md](FAQ.md) first.
