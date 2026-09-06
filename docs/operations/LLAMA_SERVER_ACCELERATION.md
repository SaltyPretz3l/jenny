# llama-server Speculative Acceleration (MTP / ngram)

Status: DEFAULT-ON since 2026-09-01 (internal flag `llama_server_acceleration`;
`JENNY_ENABLE_LLAMA_SERVER_ACCELERATION=0` is the kill switch and restores the
pre-program surface byte-for-byte: no probe, no launch args, no engine pills,
no Engine section in the Tune drawer, `engines.updateSettings` ignores
`acceleration`/`managed`). A raw headless A/B is recorded below (2026-09-01);
the owner gates (first in-app A/B, crash -> pill -> next-chat recovery, GUI
smoke of Use on a llama-server model) stay open until recorded here.

## What it is

Speculative decoding for the managed `llama-server` engine only. Two modes:

- `mtp` — multi-token prediction (`--spec-type draft-mtp --spec-draft-n-max N`).
  Two shapes exist per model family: `native` (MTP heads inside the main GGUF —
  Qwen 3.5/3.6 style) and `separate` (a small drafter GGUF next to the main
  model, passed as `--model-draft` — Gemma 4 style).
- `ngram` — self-speculation from the prompt (`--spec-type ngram-cache`), no
  extra weights (its VRAM cost has not been measured; the catalog charges it
  no headroom), supported by every binary since 8846.

Ollama is untouched by this feature: it has no speculative decoding on the
Windows/CUDA runner, and when upstream ships one, Jenny's existing `OLLAMA_*`
env passthrough (`services/backend/ollama-env.js`) adopts it with no code.

## Three-layer eligibility (all fail closed)

1. **Live binary probe** — `services/backend/llama-server-capabilities.js` runs
   `llama-server --help` and parses the `--spec-type` choice list. No
   `draft-mtp` in the list ⇒ MTP is ineligible regardless of config.
   `config/llama-server-runtime.json` records what the feature was last
   validated against; it never drives behavior. Cost: two synchronous child
   processes (`--help` + `--version`, ~100–300 ms total) run once per launch
   with the flag on and a non-off mode, memoized on the binary's mtime+size;
   flag-off launches never probe.
2. **Family catalog** — `config/model-acceleration-catalog.json` (tri-state
   `mtp: yes|unverified|no`, `mtpShape`, `drafterPattern`; parity with
   `sidecar/ai/app_profiles` enforced by
   `tests/sidecar/ai/app_profiles/test_acceleration_catalog_parity.py`).
   `unverified` families launch MTP only via a profile with
   `"allow_unverified": true` (benchmarking posture, not a shipped claim).
3. **Spawn fallback** — if the accelerated spawn fails for any reason other
   than startup abort, `services/main/runtime-shutdown.js` retries exactly once
   with the profile-only args (WARN `llama.server.acceleration_fallback`). A
   wrong catalog entry is a slow start, never a broken app.

Resolution order and reason tokens live in
`services/backend/llama-server-acceleration.js::resolveAccelerationArgs`.
Notable refusals: a profile that already sets `--spec-type`/`--model-draft`
owns speculation outright, and a `--fit off` profile (e.g. the qwen3.8 128K
profile) refuses acceleration because its allocation has zero slack.

## Configuration (per model, in the app)

- Settings > Model library > a model's **Tune** drawer > **Engine** section
  (rendered only with the flag on, for Ollama / openai-compatible models, when
  the `engines` bridge exists): **Run with** `Ollama | llama-server` (the
  llama-server option is enabled once a GGUF is known for the tag - found under
  the model directories below or picked with **Choose...**, a main-process
  `.gguf` open dialog via `llamaServer.chooseGguf`), a **Multi-token
  prediction** switch (enabled only for catalog-verified families; the note
  shows that family's VRAM headroom, e.g. "Uses about 0.5 GB more VRAM" for
  gemma4), and the GGUF path row. **Apply** writes
  `engines.updateSettings({ managed: { enabled: true, perModel: { [key]: { engine, tag, modelPath, mtp: { mode } } } } })`
  BEFORE any model-tuning patch and treats the returned settings as
  authoritative (`key = managedModelKey(tag)`, size tag preserved:
  `gemma4:12b -> gemma4-12b`). Nothing restarts on Apply: the choice is
  launch-scoped and takes effect on the next **Use**.
- The library row shows the choice: `llama-server` / `llama-server . MTP`
  pills, `Serving on :<port>` while the managed server is ready for that exact
  tag (alias match includes the size tag), and `MTP ready` for verified
  families not yet running MTP. **Use** on a llama-server model sends
  `models.load({ model, engine_type: 'openai-compatible' })` ("Starting
  llama-server for ..."): the Ollama model is unloaded (`keep_alive: 0`), the
  server is (re)launched for that GGUF/MTP choice, the sidecar re-initialises
  against it, and only then are `preferredEngineType` and
  `managed.lastUsedTag` persisted. **Use** on an Ollama model stops a live
  managed server first. The old global "Speculative acceleration" toggle is
  gone; the persisted `localEngines.openaiCompatible.acceleration` key stays
  normalized as a legacy default and no longer charges headroom on its own.
- Headroom in the fit math is charged per card only when that card is set to
  llama-server **and** MTP is on **and** the family is verified - the
  catalog's `vramHeadroomMb` when the family sets one, else the 2 GB default.
- Env still wins for bench/dev: `JENNY_LLAMA_SERVER_AUTOSTART` /
  `JENNY_LLAMA_SERVER_PROFILE` / `JENNY_LLAMA_SERVER_MODEL_PATH` override the
  persisted per-model choice for that launch, and a schema-v2 profile's
  `acceleration` block overrides MTP (see
  `config/llama-server-profiles/README.md`). Shipped benchmark profiles:
  `gemma4-12b-qat-accel` (primary; gemma4 is catalog-verified) and
  `ornith15-9b-accel` (`allow_unverified`).
- Model files: `llamaServer.listLocalGgufs` (what the library and drawer
  scan) resolves a GGUF per tag from four sources, in this order:
  `{userData}/models/<sanitized-tag>/` and `.jenny/models/<sanitized-tag>/`
  plus every folder added under Settings > Model library > **GGUF folders**
  (`managed.libraryRoots`, one level deep, `source: root`); the directory of a
  persisted/picked `modelPath` (`persisted`, always listed even when a root
  shares the tag); and, for an Ollama-installed tag with no entry yet,
  Ollama's own blob copy reported by the daemon (`/api/show` modelfile `FROM`
  via the sidecar `models.ollama_blob` request - `source: ollama`, GGUF row
  reads "Ollama's copy"; when a GGUF folder holds a main GGUF of the identical
  byte size the entry points at that folder instead, `source: library`, so a
  co-located `mtp-*.gguf` drafter is found). Ollama lookups are memoised 30 s
  per tag list. So an `ollama pull` alone makes the llama-server option
  selectable (no drafter yet); add the download folder under **GGUF folders**
  or pick the main GGUF with **Choose...** (the dialog opens in the model's
  folder, then the last picked folder, then the first GGUF folder) to get
  MTP. With no path at all the hint reads "Choose... the .gguf for this
  model, then Apply, then Use". For Gemma-4 QAT the main GGUF and a `mtp-*.gguf` drafter (both from
  the repo root of `unsloth/gemma-4-12B-it-qat-GGUF`) must sit in the same
  directory - the owner's install lives at
  `G:\llmmodels\gguf\gemma4-12b-qat-unsloth\`
  (`gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` + `mtp-gemma-4-12B-it-Q8_0.gguf`; the
  `mmproj-BF16.gguf` there is unused while the accel profile runs
  `--no-mmproj`). Co-located `mtp-*` / `mmproj*` files are never picked as the
  main model.

## Runtime behavior of the managed server

- **Ownership**: `services/main/llama-server-manager.js` is the single owner
  (states `stopped -> starting -> ready -> crashed | stopping`, one serialized
  operation chain, `getStatus()` -> `{state, pid, port, alias, modelPath,
  profileId, accelerationMode, reused, lastError, changedAt}`). It stops only
  the pid it spawned; a foreign server already on the port is reused, never
  killed, and reports `accelerationMode: 'unknown'` (the UI never claims MTP
  from a reused server).
- **Auth**: every launch gets a fresh 32-hex api key delivered through
  `--api-key-file` (`{userData}/llama-server-<8hex>.key`, written before spawn,
  deleted once readiness settles, stale files swept at boot and per launch),
  plus `--no-slots`. The sidecar receives the key as
  `openai_compatible_api_key` in its secrets only when the engine's `api_url`
  shares the managed server's local origin; profiles cannot override
  `--api-key*`/`--slots`.
- **Crash policy = surface + restart on next chat** (Ollama parity, no respawn
  loop): a child exit while ready -> `crashed` (WARN
  `llama.server.crashed_pending_recovery`), the health pill shows the server row
  with a **Restart llama-server** action, and the next chat on the managed
  model relaunches it before streaming (`ensureManagedLlamaServerReadyForChat`
  in `services/backend/managed-sidecar-chat-reconnect.js`; a launch that stays
  down surfaces the Ollama-preflight error shape).
- **Boot**: autostart runs when `managed.enabled && preferredEngineType ===
  'openai-compatible' && lastUsedTag` (env autostart still overrides). The
  Diagnostics runtime facet carries `runtime.llama_server`.
- IPC: `llamaServer.{getStatus,start,stop,restart,listLocalGgufs,chooseGguf,chooseLibraryFolder}`
  (`services/main/llama-server-ipc-handlers.js`, fail-soft `{ok:false,
  reason}`; `start`/`restart` report `ok:false` when the launch resolves short
  of ready).

## Binary refresh procedure (owner-run; MTP needs it, ngram does not)

The binary under `llama_server_extract/` is gitignored, local-only, and never
shipped in releases (`electron-builder.yml` has no entry for it — do not add
one; it is ~700 MB). Validated baseline (refreshed 2026-09-01): build 10749
(`dfc29b64e`, `version: 0.3.0-dev`), CUDA 13.3, from the
`llama-b10749-bin-win-cuda-13.3-x64.zip` + `cudart-llama-bin-win-cuda-13.3-x64.zip`
release pair — `--spec-type` lists `draft-mtp`. The previous baseline, build 8846
(`bcdcc1044`), had no `draft-mtp`; its files are kept locally in a sibling
`llama_server_extract-b8846-backup\` folder (also gitignored).

**Probe format drift (bug class):** between 8846 and 10749 both probed outputs
changed shape — `--help` went from a bracketed pipe list
(`--spec-type [none|ngram-cache|...]`) to a bare comma list
(`--spec-type none,draft-simple,draft-mtp,...`), and `--version` went from
`version: 8846 (bcdcc1044)` to `version: 0.3.0-dev (build 10749, commit dfc29b64e)`.
The probe parsers accept both layouts; after any refresh, run the probe against
the real binary (`node -e` with `probeCapabilities({ binaryPath })`) and check
`supportsMtp:true` plus a non-zero `build` BEFORE trusting a `mode:"ngram"`
degrade — an unparsed help text reads as `mtp_ineligible:binary`, which is
indistinguishable from a genuinely old binary.

1. Back up `llama_server_extract\` (unrecoverable from git).
2. Download a newer llama.cpp Windows CUDA release; replace the directory
   wholesale — the `ggml-*.dll`/`cublas*`/`cudart*` set must match the new
   `llama-server.exe` (mixed DLL generations are the classic failure).
3. Verify: `llama-server.exe --version`, and `--help` lists `draft-mtp` under
   `--spec-type`.
4. Compatibility smoke: relaunch with the existing
   `qwen3.8-27b-ud-iq3-s-128k` profile — every profile arg must still be
   accepted (`--fit` and `--flash-attn on` are the likely churn points; a
   rejected arg surfaces as `llama.server.readiness_failed`).
5. Manual flag-combination sanity outside Jenny:
   `llama-server -m <main.gguf> --model-draft <mtp-*.gguf> --spec-type draft-mtp --spec-draft-n-max 4`
   starts and generates.
6. Update `config/llama-server-runtime.json` build/commit.

## A/B benchmark recipe (owner-run)

GPU idle first (`nvidia-smi` ≈ 0 MB used). Arm A = flag unset; Arm B:

```powershell
$env:JENNY_LLAMA_SERVER_AUTOSTART = 'true'
$env:JENNY_LLAMA_SERVER_PROFILE   = 'gemma4-12b-qat-accel'
$env:JENNY_LLAMA_SERVER_MODEL_PATH = 'G:\llmmodels\gguf\gemma4-12b-qat-unsloth\gemma-4-12B-it-qat-UD-Q4_K_XL.gguf'
$env:JENNY_ENABLE_LLAMA_SERVER_ACCELERATION = '1'
npm run dev
```

On a binary without `draft-mtp` (e.g. the retired build 8846), Arm B degrades
automatically: `acceleration_resolved` logs `mode:"ngram",
reason:"mtp_ineligible:binary"` — that run is a valid ngram arm and a full-path
smoke; the `mode:"mtp"` arm requires a `draft-mtp`-capable binary.

### Raw (outside-Jenny) A/B, 2026-09-01, build 10749, RTX 5070 Ti 16 GB

Same launch args as the `gemma4-12b-qat-accel` profile (`-c 8192`), greedy
(`temperature 0, top_k 1`), one ~400-token codegen prompt via `/apply-template`
+ `/completion`, five runs per arm. Figures are the **median of the five**
(range in parentheses); the sampled output prefix (first 200 chars) was
identical across arms, as greedy decoding predicts:

| arm | decode tok/s, median (range) | drafted tokens accepted / drafted | VRAM used (nvidia-smi, incl. ~0.8 GB desktop) |
| --- | --- | --- | --- |
| plain | 75.2 (74.7–75.3) | — | 8,253 MiB |
| `--spec-type draft-mtp --spec-draft-n-max 4` | 175.4 (175.4–177.1) | 289 / 434 | 8,759 MiB (+506) |
| `--spec-type ngram-cache` | 75.2 (74.9–75.6) | 17 / 111 | not measured |

MTP is a ~2.3× decode speedup on this prompt for ~0.5 GB. ngram-cache showed
no measurable gain here (medians equal within run-to-run spread; 17 of 111
drafted tokens accepted) — self-speculation only pays when the output repeats
the prompt. Ollama has no speculative path on Windows/CUDA. As of 2026-09-01
the owner's machine carries no record of the managed llama-server ever having
served a Jenny turn (0 of 200 retained diagnostics stream records are
`openai-compatible`; the six retained shell logs show only
`llama.server.autostart_disabled`), so treat the first in-app run as a
first-run smoke of the engine path, not just of acceleration.

Confirm Arm B logs `llama.server.acceleration_resolved` with `mode:"mtp"` and
the drafter basename, and NO `acceleration_fallback`; the
`llama-server-ready` startup-audit mark carries `accelerationMode`. Three
prompts (short factual / ~600-token codegen / tool-calling turn), two warmups
discarded, three measured runs each; tokens/s from
`{userData}/diagnostics/<date>/<streamId>.json`, peak VRAM from
`nvidia-smi --query-gpu=memory.used --format=csv -l 1`. Expect ≈ +0.5–1 GB for
the Gemma drafter (+~2 GB for native-head families), and expect output TEXT to
differ between arms under sampling — only greedy decoding is output-identical;
a quality regression is a bug, a text difference is not.

Fallback rehearsal: rename the drafter file → clean start with one
`drafter_missing` reason, no crash.

### In-app A/B (owner-run) - PENDING

Record the first in-app run here before treating the ~2.3x figure as a product
claim. Recipe: pick gemma4 12B QAT in the Model library, Tune > Engine >
llama-server, MTP on, Use; confirm `llama.server.acceleration_resolved`
`mode:"mtp"` + the drafter basename, no `acceleration_fallback`, ready mark
`reused:false`; run the three prompts above; then flip MTP off (Apply -> Use
again) for the plain arm.

| arm | prompt | decode tok/s (3 runs) | peak VRAM | notes |
| --- | --- | --- | --- | --- |
| llama-server plain | short factual / codegen / tool turn | _pending_ | _pending_ | |
| llama-server + MTP | short factual / codegen / tool turn | _pending_ | _pending_ | |
| Ollama (reference) | short factual / codegen / tool turn | _pending_ | _pending_ | |

Crash rehearsal: end `llama-server.exe` from Task Manager mid-session -> health
pill turns danger with **Restart llama-server**; the next chat relaunches the
same model; record the recovery time.

## Known interactions / limitations

- **FIM / inline suggest**: the same llama-server instance serves chat and
  inline completion; there is no per-request speculation switch. If ghost-text
  latency regresses with acceleration on, the honest outcome is acceleration
  stays off — record it, don't special-case.
- **Exclusive GPU coordinator**: `services/backend/exclusive-gpu-coordinator.js`
  has no VRAM accounting; the drafter's extra residency raises the OOM odds for
  a privileged plugin workload after a lease handoff. The coordinator is
  deliberately NOT modified by this feature; a VRAM-aware lease is a separate
  program.
- **Vision**: the accel profiles run gemma4 text-only (`--no-mmproj`); serving
  vision through the accelerated server is unscoped.
- **MTP × quantized KV**: unverified upstream; the shipped accel profiles omit
  KV-quant flags. If a combined profile fails, the spawn fallback catches it
  but the reason will be opaque — the fallback WARN carries only the failure
  message (e.g. `llama_server_exited:<code>`); the server's own error output
  is piped into shell.log as `llama.server.*` child-log lines just before it.
