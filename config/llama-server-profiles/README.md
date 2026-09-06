# Managed llama-server profiles

Profiles are **optional overrides** for benchmarking and development. Since
2026-09-01 the normal way to run a model on Jenny's managed `llama-server` is
the Model library: a model's Tune drawer > Engine section picks
`Ollama | llama-server`, the GGUF file, and multi-token prediction per model,
and **Use** launches the server - no profile, no env var, no restart (see
`docs/operations/LLAMA_SERVER_ACCELERATION.md`). The per-model choice is
persisted at `localEngines.openaiCompatible.managed.perModel[<key>]`.

When a profile IS selected with `JENNY_LLAMA_SERVER_PROFILE`, its model tag,
context, and bounded extra arguments win over the persisted choice for that
launch (and `JENNY_LLAMA_SERVER_MODEL_PATH` wins over the persisted GGUF path).
Keep `JENNY_LLAMA_SERVER_AUTOSTART` explicit so a missing local model never
changes normal Ollama startup behavior. Profiles can never set the Jenny-owned
model/host/port/context/alias flags or the per-launch `--api-key*` /
`--slots` flags.

For the Qwen3.8 27B UD-IQ3_S 128K profile, place the downloaded GGUF at:

```text
.jenny/models/qwen3.8_27b-ud-iq3-s/Qwen3.8-27B-UD-IQ3_S.gguf
```

The filename itself may differ because Jenny selects the first `.gguf` in that
model directory. Alternatively, set `JENNY_LLAMA_SERVER_MODEL_PATH` to the
GGUF's absolute path.

Launch from PowerShell:

```powershell
$env:JENNY_LLAMA_SERVER_AUTOSTART = 'true'
$env:JENNY_LLAMA_SERVER_PROFILE = 'qwen3.8-27b-ud-iq3-s-128k'
npm run dev
```

The Qwen profile requests exactly 131,072 tokens, one server slot, no
multimodal projector, all weight layers on the single GPU, Flash Attention,
and Q8_0 K/V cache. `--fit off` is intentional: the server must report an
allocation failure instead of silently reducing the requested context or
changing placement. If it does not fit, tune the explicit profile rather than
assuming a smaller runtime was used.

## Schema v2: acceleration

Schema v2 profiles may add an `acceleration` object with `mode` (`off`, `mtp`,
or `ngram`), optional `draft_n_max` (1-6), and optional `allow_unverified`
(boolean). MTP flags are launch-scoped, so changing them requires a server
restart.

The llama-server engine resolves GGUF files from
`{userData}/models/<sanitized-tag>/` or `.jenny/models/<sanitized-tag>/`. For
`gemma4-12b-qat`, place both the main QAT GGUF and the `mtp-*.gguf` drafter
(e.g. `mtp-gemma-4-12B-it-Q8_0.gguf`) from the root of
`unsloth/gemma-4-12B-it-qat-GGUF` in that directory. The Ornith profile uses
the corresponding `ornith15_9b` directory. An `ollama pull` does not populate
these directories; Ollama blobs are not readable by llama-server. Co-located
`mtp-*.gguf` / `mmproj*.gguf` files are never picked as the main model.
