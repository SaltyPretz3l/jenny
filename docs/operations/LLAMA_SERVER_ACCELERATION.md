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

- Settings > Models > a model's **Tune** drawer > **Engine** section
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
  `gemma4:12b -> gemma4-12b`). When llama-server is serving that model and
  the saved engine settings changed (build, MTP or GGUF file) while it stays on
  llama-server, Apply restarts the server once, after any tuning change, so
  the new settings are live; it asks first only while a chat is streaming. If
  the tuning change fails, the restart is owed and happens on the next
  successful Apply for that model while it is served. Otherwise the choice
  takes effect on the next **Use**.
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
  plus every folder added under Settings > Models > **GGUF folders**
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
  `--no-mmproj`). Co-located drafters and projectors are never picked as the
  main model (`services/llama-server-gguf-files.js`). A drafter is
  `mtp-*.gguf`. A projector either starts with `mmproj` (`mmproj-F16.gguf`,
  `mmproj-<model>-<quant>.gguf`) or carries `mmproj` as a whole name token
  (`<model>-mmproj-<quant>.gguf`, as in Bonsai 2's
  `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf`; `x-mmprojector.gguf` is still a
  model). A projector pairs with the model its name names. When none does, a
  lone model owns a generic one, and so does a folder holding only quants or
  shards of one model (an unsloth or bartowski snapshot). A projector naming
  another model is never used: a mismatched projector fails the whole launch,
  where none only loses vision. When several projectors name the model, the
  one naming the most of its name wins, so a fine-tune or a `-Flash` sibling
  beside its base pairs its own projector; then the smallest precision (Q8_0
  before F16/BF16, before F32). Keep each model's files in a folder of its
  own: in a shared folder, a model with no projector of its own can pair one
  named for a model its name extends. For a fine-tune beside its base that is
  usually right, but `GLM-4.6V-Flash` beside `GLM-4.6V` would pair the
  larger model's projector and describe images wrongly. And a projector that
  names more of the model's name beats the model's own when that one carries
  only the base's name: `gemma-4-31B-it-uncensored-heretic` would pair another
  fine-tune's `mmproj-gemma-4-31B-it-uncensored-F16.gguf` over its own
  `gemma-4-31B-it-mmproj-BF16.gguf`.
- Network paths: on Windows every path Jenny reads for llama-server is a
  drive path (`C:\...`). A UNC (`\\host\share\...`), device (`\\?\`, `\\.\`)
  or root-relative path is refused before any fs call, because a stat,
  readdir or open of one connects to that host with the user's Windows
  credentials. Settings drop such a `lastPickDir`, GGUF folder or `modelPath`
  when saved and when loaded; the IPC launch spec drops such a `modelPath`;
  the listing skips such a root, persisted model or Ollama blob; a saved
  `runtimePath` is shape-checked before its launch-time stat; and the three
  pickers answer `{ok:false,reason:'network_path'}` ("Jenny can't use network
  locations here. Map the share to a drive letter, then choose it from that
  drive."). The sidecar's Ollama blob lookup (`models.ollama_blob`) applies
  the same rule before its own stat, and reads only the `FROM` lines Ollama
  writes itself, never one inside a model's template, system prompt or
  license. A NAS keeps working through a mapped drive letter, which reaches
  only a host the user chose (File Explorer: This PC, then Map network drive;
  `isLocalAbsolutePath` in `services/shell-config-engines.js`). WSL folders
  (`\\wsl$\...`, `\\wsl.localhost\...`) are network paths too: map one to a
  drive letter first, for example `net use W: \\wsl$\Ubuntu`.

## Runtime behavior of the managed server

- **Ownership**: `services/main/llama-server-manager.js` is the single owner
  (states `stopped -> starting -> ready -> crashed | stopping`, one serialized
  operation chain, `getStatus()` -> `{state, pid, port, alias, modelPath,
  profileId, accelerationMode, runtimeLabel, reused, lastError, changedAt}`;
  `runtimeLabel` is below). It stops only
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
  'openai-compatible' && lastUsedTag` (env autostart still overrides).
  `lastUsedTag` survives only while it names a saved model set to
  llama-server: removing the model from the library, or moving it to Ollama in
  Tune (even while its Use is still launching), clears it, so an earlier model
  never starts in its place. The Diagnostics runtime facet carries
  `runtime.llama_server`.
- IPC: `llamaServer.{getStatus,start,stop,restart,listLocalGgufs,chooseGguf,chooseLibraryFolder,chooseRuntime}`
  (`services/main/llama-server-ipc-handlers.js`, fail-soft `{ok:false,
  reason}`; `start`/`restart` report `ok:false` when the launch resolves short
  of ready; `chooseRuntime` answers only a trusted sender, see below).

## Per-model llama-server builds

Each llama-server model can run on its own llama-server build; an unset build
means the bundled one (`llama_server_extract/`, b10749). The first user is
Bonsai 2, whose PQ2_0 quant type exists only in PrismML's fork; gemma4 stays on
the bundled build, where its MTP speedup was measured.

- **Saved shape**: `managed.perModel[key]` gains `runtimePath` and
  `runtimeBuild`. Only the main process writes them, and both are omitted when
  empty. A `runtimePath` must be an absolute, normalized drive path (no UNC, no
  `..`, at most 1024 characters, no control characters) whose file name is
  `llama-server.exe` (any case on Windows) or `llama-server`; `runtimeBuild` is
  a positive integer kept only with its path
  (`services/shell-config-engines.js`).
- **Trust rules** (a renderer can never make main spawn an executable of its
  choosing; `services/main/llama-server-runtime.js`):
  - Only `llamaServer.chooseRuntime` introduces a path. It answers only a
    trusted sender, opens a main-owned file dialog, checks the file name, then
    probes the file (`--version` and `--help`, which must report a build above
    0). A file that passes is recorded in the manager's in-memory pick list,
    which holds the 8 newest picks. The dialog opens in the folder the drawer
    suggests only when that is an existing local directory (on Windows, a drive
    path; a network or device path is never touched). Results: `{ok:true,picked:false,path:''}`
    on cancel, `{ok:true,picked:true,path,build,supportsMtp}` on a pick, or
    `{ok:false,reason}` (`manager_unavailable`, `network_path`, `not_llama_server`,
    `runtime_missing`, `runtime_probe_failed`, `runtime_pick_failed`).
  - `engines.updateSettings` reconciles each entry's `runtimePath`: absent
    keeps the saved one; `''` clears it; a path picked this session is
    accepted once, with the build number its probe read, and its pick is spent
    only when the build actually saved (so picking the saved build again after
    copying new files over it refreshes the saved number); the saved value sent
    back with no fresh pick keeps it and its saved number; anything else keeps
    the saved value and logs WARN `engines.managed_runtime_rejected {keys}`. A
    `runtimeBuild` sent by the renderer is always dropped; the build number
    comes from the probe. Logs carry model keys, never paths.
- **Launch precedence**: env `JENNY_LLAMA_SERVER_BINARY` > the model's saved
  build > bundled. When the env var hides a saved build, the launch logs WARN
  `llama.server.runtime_env_shadowed {model}`. The one resolved path feeds both
  the spawn and the acceleration probe, so MTP eligibility is judged on the
  build that actually runs.
- **A missing saved build fails the launch**: nothing is spawned, the status
  shows `lastError: llama_server_runtime_missing:<build>`, and the log shows
  WARN `llama.server.runtime_missing`. It never falls back to the bundled build
  silently. `<build>` is the llama.cpp build tag in the build's folder name
  (`b10683` for `llama-prism-b10683-cuda13.3`), lowercased, or `runtime` when
  the name carries none. The folder text itself never reaches the status or
  Diagnostics, since it can carry a person's or a project's name. A build
  deleted between planning and spawning gets the same error and is not retried.
- **A build that cannot read the model** exits while loading. The lifecycle
  checks the first 2,000 stderr lines for the loader's own error lines,
  `gguf_*: tensor '<name>' has invalid ggml type <N>` (a quant type newer than
  the build) or `llama_model_load: … unknown model architecture: '<arch>'`.
  A line matches only when it starts with that function, after llama.cpp's
  optional timestamp and level letter, so a path or a metadata value that
  merely contains the phrase never does. The launch fails with
  `llama_server_model_unsupported:bundled` or `:custom` (WARN
  `llama.server.model_unsupported {runtime}`). An accelerated launch that
  fails this way still gets the unaccelerated retry, because the file the build
  cannot read may be the MTP drafter; when it is the model itself, the retry
  fails the same way. A GGUF that is no language model at all (an image or
  video model's `flux` or `wan` architecture) fails the same way, although no
  llama-server build can serve it. Captured case: bundled b10749 on the Bonsai 2 PQ2_0 file
  exits with code 1 in about 0.3 s, logging
  `tensor 'output.weight' has invalid ggml type 142`.
- **Status and logs**: `getStatus().runtimeLabel` is `bundled`, `env`,
  `build <N>`, `custom` (no build number known), `unknown` (a reused server) or
  `''` (stopped). The executable path never leaves the main process. The
  Diagnostics runtime facet carries it as `runtime.llama_server.runtime_label`,
  and the `llama.server.spawn` log line as `runtime: <label>`; a spawn error
  logs only its code. The build's own output lines (`llama.server.output`,
  such as `load_backend: loaded CUDA backend from <folder>\ggml-cuda.dll`)
  are logged with `[llama-server folder]` in place of its folder.
- **Relaunch**: a Use relaunches the server when the model's resolved build
  differs from the running one. A restart with no model given (the health pill's
  **Restart llama-server**, crash recovery, boot autostart) rebuilds the model's
  saved settings (build, MTP, GGUF file) exactly as a Use does.
- **Tune's Apply**: a context-window or engine change (build, MTP, GGUF file)
  to the model being served, read from a fresh status at Apply, restarts
  llama-server right away, asking first only while a chat streams. Otherwise
  the change is saved and applies at the model's next start.
- **Probe cache**: probes are memoized on the file's mtime and size. Choosing a
  build re-probes a cached failure once (`retryFailed`), because a first run
  slowed by antivirus scanning should not stick.

## Bonsai 2 on PrismML's fork (owner recipe)

Ternary-Bonsai-2-27B (`prism-ml/bonsai-2`) is a 1.72-bit ternary Qwen3.8-27B
with vision. Jenny treats it as the `bonsai2` family: the Qwen3.8 chat
contract, effort `None` / `Medium` / `Extra High` (default `Medium`; `minimal`
and `low` run with thinking off), MTP off (`mtp: "no"` in the catalog).

Pinned inputs (sha256-verified 2026-09-18):

| File | Source | sha256 |
| --- | --- | --- |
| `llama-prism-b10683-d8f26ee-bin-win-cuda-13.3-x64.zip` | GitHub `PrismML-Eng/llama.cpp` release `prism-b10683-d8f26ee` | `31bbd608376473d42ac985069975134cc6638b8f51bdf065dac07e448399daa9` |
| `cudart-llama-bin-win-cuda-13.3-x64.zip` | same release | `1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e` |
| `Ternary-Bonsai-2-27B-PQ2_0.gguf` | HF `prism-ml/Ternary-Bonsai-2-27B-gguf` @ `6ed5e12b` | `3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1` |
| `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf` (vision projector) | same revision | `6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903` |

1. Extract both zips into one folder (the owner's is
   `G:\llmmodels\runtimes\llama-prism-b10683-cuda13.3\`); the DLLs must sit
   beside `llama-server.exe`. `llama-server.exe --version` reports build 10683.
2. Put both GGUFs in one folder (the owner's is
   `G:\llmmodels\gguf\ternary-bonsai-2-27b\`); the projector pairs by name.
3. Settings > Models > GGUF folders > **Add GGUF model…** > the PQ2_0
   file.
4. On its card, **Tune** > Engine: pick the fork's `llama-server.exe` under
   **llama-server build** > **Choose…**, then **Apply**.
5. **Use**.

Headless proof, 2026-09-18, RTX 5070 Ti 16 GB, with a game also holding VRAM:
at `-c 32768` with the projector on the GPU the server used about 10.0 GiB;
prefill 1,306 tok/s on a 4,752-token prompt, decode 53.8-58.8 tok/s. Thinking
on and off, streamed reasoning, a tool call and an image description all
worked. The 64K relaunch was not measured; at PrismML's 64 KiB of FP16 KV per
token, 64K should need about 12 GiB and fit, while 131K needs about 16 GiB and
does not fit without a quantized KV cache (not offered yet). Jenny launches at
32K unless Tune sets a context.

In-app checks (owner-run; PENDING):

1. **Add GGUF model…** on the PQ2_0 file gives one card reading "Local GGUF ·
   6.7 GB" (the library formats sizes in binary units).
2. Tune > Engine: Ollama is greyed out with the reason. **Choose…** the
   fork's `llama-server.exe`; the row reads
   `llama-prism-b10683-cuda13.3 · build 10683`; **Apply**.
3. **Use**, then a chat turn. The thinking row settles, and the effort options
   are None / Medium / Extra High. A tool call completes, and an attached image
   is described.
4. `shell.log`: `llama.server.spawn` shows `runtime: build 10683` and no path;
   `llama.server.acceleration_resolved` is off.
5. **Use** gemma4 on llama-server: it relaunches on the bundled b10749 with
   `mode:"mtp"`.
6. **Remove from library**: the card goes away and the file stays on disk.
7. Rename the fork's folder, then **Use**: the card says the build (b10683) is
   missing (`lastError: llama_server_runtime_missing:b10683`), and nothing
   falls back to the bundled build.

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
- **A build replaced in place**: the label comes from the probe cache, then
  from the saved `runtimeBuild`. If new files are copied over a chosen build's
  folder, the label can show the old build number until the same file is
  chosen again, which refreshes the saved number. If the copy lands while a
  launch is starting with MTP, that launch can
  fail and come up on the retry without MTP; the next restart applies MTP
  again.
- **A build is trusted by its path**: the probe runs when the build is chosen,
  and later launches run whatever file is at that path then. Keep builds in a
  folder only your account can write, such as one under your user profile. On
  Windows, a folder created at the root of the system drive (like `C:\llama\`)
  inherits write access for every signed-in account.
- **A restart and background turns**: before Tune restarts llama-server to
  apply a build, MTP or GGUF-file change, it asks only about chats this window
  is streaming. A background turn on the same model, such as a scheduled
  automation, is cut by the restart and has to run again.
- **Unconfirmed stop**: if stopping a server cannot be confirmed, a later
  launch may find it still on the port and reuse it (`runtimeLabel: unknown`)
  instead of starting the chosen build. This predates per-model builds.
