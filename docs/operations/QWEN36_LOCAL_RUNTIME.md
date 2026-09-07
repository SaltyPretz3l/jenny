---
kind: operations-doc
last_reviewed: 2026-09-07
status: active
---

# Qwen3.6-35B-A3B Local Runtime (llama-server + Jenny)

Hand-run recipe for hosting the **Qwen3.6-35B-A3B** GGUF quant locally via
`llama-server` and talking to it from Jenny through the unmanaged
OpenAI-compatible engine. The original integration-plan document
(`QWEN36_JENNY_INTEGRATION_PLAN.md`) has been retired; the plan's outcome
is reflected in the active runtime code at
`sidecar/ai/engines/openai_compatible.py` and the wiring documented below.

"OpenAI-compatible" here refers to the HTTP request/response shape only
(`/v1/chat/completions`, `/v1/models`). No cloud accounts, credentials,
or outbound calls are involved — everything stays on `127.0.0.1`.

---

## What you need

1. **GGUF weights.** Download one quant from
   [unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF)
   that fits in your VRAM+RAM budget. On a 24 GB consumer GPU the
   `UD-Q4_K_XL` quant (~20 GB) is a reasonable starting point.
2. **`llama-server.exe`** from a recent llama.cpp build. Pre-built
   binaries are published on the
   [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases);
   pick the `win-cuda` (or `win-avx2`) archive that matches your GPU.
3. **Jenny**, built from this repository. Nothing else is required —
   the OpenAI-compatible engine is bundled in `sidecar/ai/engines/openai_compatible.py`.

---

## Launch `llama-server`

From a terminal, start the server pointing at your downloaded GGUF:

```powershell
.\llama-server.exe ^
  -m C:\path\to\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf ^
  --host 127.0.0.1 ^
  --port 8033 ^
  --ctx-size 131072 ^
  --n-gpu-layers 99 ^
  --jinja ^
  --reasoning-format deepseek
```

Notes:

- `--port 8033` matches Jenny's default for the openai-compatible engine
  (`_OPENAI_COMPAT_DEFAULT_BASE_URL = "http://127.0.0.1:8033/v1"`). Pick
  any free port — just mirror it in Jenny's settings if you deviate.
- `--ctx-size 131072` = 128K, which the Qwen3.6 model card recommends as
  the minimum for preserving thinking capabilities. Raise to 262144 if
  your VRAM allows the KV cache.
- `--n-gpu-layers 99` pushes as many layers as fit to GPU. Lower the
  number if you OOM; the remainder spills to CPU.
- `--jinja` uses the chat template embedded in the GGUF (required for
  the model-card tool-call/thinking shape).
- `--reasoning-format deepseek` tells llama.cpp to emit Qwen3's
  ``<think>…</think>`` blocks as `reasoning_content` in the OpenAI
  response shape. Jenny's engine surfaces those deltas as
  `StreamingEvent(kind="thinking", …)` automatically.

Verify the server is up:

```powershell
curl http://127.0.0.1:8033/v1/models
```

You should see a JSON payload with one entry whose `id` resembles the
GGUF filename or the `general.name` metadata from the file.

Jenny does not auto-start this unmanaged `llama-server` path by default.
The legacy launcher remains available only when
`JENNY_LLAMA_SERVER_AUTOSTART=true` is set. Leaving that variable unset
or setting it to `false` / `0` keeps startup quiet and avoids
`llama.server.start_failed` warnings when the active chat model routes
through Ollama instead of a local OpenAI-compatible GGUF endpoint.

---

## Point Jenny at the server

Jenny picks up the OpenAI-compatible engine whenever
`engine_type === 'openai-compatible'` in the runtime config. The
wiring lives in:

- `sidecar/ai/engines/openai_compatible.py` — the engine class.
- `services/backend/managed-sidecar-lifecycle.js` — forwards
  `config.api_url` for `openai-compatible` from persisted settings.
- `services/shell-config-state.js` — persists `localEngines.openaiCompatible`.
- `services/shell-config-service.js` — exposes
  `getLocalEngines()` / `updateLocalEngineOpenAICompatible(patch)`.

### Option 1 — default port

If you launched `llama-server` on port **8033**, no extra configuration
is needed beyond priming Jenny to boot on the openai-compatible engine.
The model picker only queries the currently-active engine's endpoint, so
a bootstrap override is required once before the llama-server's GGUF
shows up in the dropdown.

Close Jenny, edit `%APPDATA%\jenny\shell-config.json`, and set:

```json
"preferredEngineType": "openai-compatible"
```

at the top level (alongside `toolsWorkspaceRoot` etc.). Relaunch Jenny
— the picker will now list whatever `llama-server` reports at
`/v1/models`. Pick the GGUF filename (e.g. `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`)
and chat. Empty string (the default) falls back to inferring the engine
from the active model name.

Why the override exists: GGUF tokens auto-infer to `openai-compatible`
(Ollama uses `model:tag` names, vLLM serves HF IDs, so `.gguf` can only
mean the llama-server path), but inference doesn't run until a model is
already loaded. Setting `preferredEngineType` breaks the
chicken-and-egg so the picker sees llama-server on first launch.
Jenny synthesizes `http://127.0.0.1:8033/v1` from the default
`localEngines.openaiCompatible.port` at startup.

When switching back to the Ollama tag form, for example
`qwen3.6:35b-a3b-ud-q4_k_xl`, clear this bootstrap override by setting
`preferredEngineType` back to an empty string (or selecting Ollama through the
app flow). Leave `preferredEngineType: "openai-compatible"` only while the
configured `llama-server` endpoint is running and `/v1/models` reports the GGUF
model you intend to use. Otherwise Jenny will correctly warn at startup that
the OpenAI-compatible default model load failed, even though an Ollama chat turn
can still route through Ollama by model name.

### Option 2 — custom port or remote host

Persist an explicit URL via the shell-config service:

```js
// In an electron console or a one-off node script:
service.updateLocalEngineOpenAICompatible({
  port: 9100,
  apiUrl: 'http://127.0.0.1:9100/v1',
});
```

`apiUrl` wins over `port` when both are set. Only `http://` and
`https://` URLs are accepted — `file://`, `javascript:`, and bare
paths are rejected by the normalizer.

### Model name

Set Jenny's active model to the ID that `/v1/models` reports. For
Unsloth quants from llama.cpp's `llama-server` that is usually the
full filename (e.g. `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`) — passing the
filename-with-extension is also what triggers auto-inference to the
openai-compatible engine. The engine also matches on the tail after
`/`, so `Qwen/Qwen3.6-35B-A3B` works if llama-server advertises that
form.

---

## What Jenny does with it

Once active, the OpenAI-compatible engine:

- Queries `/v1/models` and matches your requested model by exact ID,
  post-slash tail, or filename tail.
- Sends `/v1/chat/completions` requests using the same payload shape
  as the vLLM engine (inherits `VLLMEngine._build_payload`), including
  the Qwen3 sampler preset from the `qwen36` app profile
  (`temperature=0.6`, `top_p=0.95`, `top_k=20`, `min_p=0.0`,
  `presence_penalty=0.0`, `repeat_penalty=1.0`).
- Streams SSE, surfacing:
  - `reasoning_content` deltas as `StreamingEvent(kind="thinking")`,
  - `content` deltas as `StreamingEvent(kind="content")`,
  - a terminal `StreamingEvent(kind="done")`.
- Parses `tool_calls` blocks the same way as the vLLM engine — so long
  as llama-server's chat template emits them in the OpenAI shape
  (`--jinja` with the Qwen3 template does).

No credentials, feature flags, or environment variables are required
for the engine to operate. Diagnostics label the provider as
`openai-compatible`, not `vllm`, so logs and usage records stay
distinct.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `OpenAI-compatible server is not reachable at http://127.0.0.1:8033/v1` | `llama-server` not running or wrong port. Verify with `curl /v1/models`. |
| `is not serving model 'Qwen/Qwen3.6-35B-A3B'. Available models: …` | Jenny's model string doesn't match what `llama-server` advertises. Copy the exact `id` from `/v1/models` into Jenny's model setting. |
| No thinking output | llama-server was launched without `--reasoning-format deepseek`, or the quant's chat template doesn't emit `<think>` blocks. Upgrade llama.cpp or switch quants. |
| Tool calls ignored | Launched without `--jinja` (falls back to a legacy template that doesn't render `tool_calls`). Relaunch with `--jinja`. |
| Out of memory on load | Reduce `--n-gpu-layers` or drop to a smaller quant (`UD-Q4_K_M`, `UD-Q3_K_XL`). |

If the server works with `curl` but Jenny reports a connection error,
confirm the port matches `_OPENAI_COMPAT_DEFAULT_BASE_URL` (8033) or
that `localEngines.openaiCompatible.apiUrl` is set to the right URL.

---

## Operational caveats (tuning)

These knobs surface in community-tested launch commands
(see the Reddit GGUF tuning post referenced by the integration plan).
They are *not* Jenny acceptance criteria — they are pointers for
manual tuning on your own hardware:

- **`--fit-target 256` vs `512`.** Aggressive fit targets squeeze a
  few more generated tokens out of the KV budget but make the loader
  more likely to trip OOM mid-session. When stability matters more
  than peak output tokens, use `--fit-target 512`.
- **`-b 2048 -ub 2048` (logical / physical batch).** The right value
  is GPU- and context-shape-dependent; A/B test with your typical
  prompt sizes. `1024` is a safer default on 16–20 GB GPUs.
- **`--no-mmap --mlock`.** Forces weights fully-resident in RAM.
  OS- and workload-dependent — can *worsen* memory pressure on
  systems already near their page-cache ceiling. Drop both flags if
  you see thrashing.
- **Reddit throughput numbers are not Jenny benchmarks.** Community
  posts report tok/s on specific rigs. Do not use those figures as
  acceptance targets for Jenny — measure on your own hardware, and
  if you need a Jenny-internal benchmark, use the framework from
  Task 9 of the integration plan.

---

## Why unmanaged

Jenny does not launch or supervise `llama-server` in Slice B —
managed llama.cpp lifecycle is Task 7. The app's default startup posture
therefore treats `llama-server` autostart as opt-in through
`JENNY_LLAMA_SERVER_AUTOSTART=true`, and the normal recipe is to launch
and supervise the process yourself. Keeping the runtime "unmanaged"
means:

- The user controls memory budget, quant selection, GPU layers, and
  restart policy.
- Jenny stays a client, not a process supervisor, for this path.
- Nothing in Jenny's process tree owns the model — killing Jenny does
  not unload the weights, and crashing `llama-server` does not kill
  Jenny.

When Task 7 lands, a managed runtime will sit alongside this path; the
unmanaged engine stays available for users who want direct control.
