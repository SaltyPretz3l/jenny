# Strata fixtures (row 200): RECORDED, with two synthetic files

Recorded 2026-11-24 (S0b) from a live Strata server on an RTX 5090, headless, by a recorder that lives outside the
repository. Prompts are synthetic test prompts; no personal text. Local paths are replaced with `<STRATA_DATA>`.

Provenance:
- Strata release **v0.2.21**, commit `d46f5f268f8ed797e83a5c63a69bffbd7a581cf6` (github.com/Niko1221/Strata);
  Terminal 0.1.67; engine `strata-inkling-0.1.67` (`0.1.67-windows-x86_64-cuda-cuda13`).
- Packs (Hugging Face `strata-engine/Inkling-2-Mini-Strata` at revision `04996a1e2c45009b6a04f2af126cb6bdb2ba3587`),
  size and SHA-256 checked on disk: `Inkling-2-Mini-SQ-20.strata` 19,346,685,952 bytes,
  `0bbfd52344f0dd4779a7807b5f73554a812f24c035e6877b63cd0d499f7e1b97`; `Inkling-2-Mini-Vision.strata` 636,526,592
  bytes, `6589eff47f9c20bc3a032faa3d449f10bf4f04a84cc6b2ee8a44d51d2b6fc677`.
- Server: `python -m serve.server --engine strata --config <Setup's config, drafting off, --max-context 49152,
  vision on> --host 127.0.0.1 --port 8097 --no-api-key --offline --parallel 4 --lazy` (the queue-full 429 came from
  a `--parallel 1 --max-queue 1` run). Requests were sent by Jenny's own `OpenAICompatibleEngine` where Jenny has the
  shape, at temperature 0.

| File | Source |
|---|---|
| `v1_models.json`, `health.json`, `props.json` | Recorded once loaded. `props.json`'s `chat_template` is trimmed to the served template's `reasoning_effort` lines (it never names `enable_thinking`); `model_path` is redacted. |
| `v1_models_loading.json`, `health_loading.json` | Recorded during the first load of a `--lazy` server (`data: []`, `loaded: false`, `max_context: 0`). |
| `think_none.sse`, `think_medium.sse` | Recorded: Jenny at effort `none`, and at Automatic (sent as `medium` with a 4,096 budget). |
| `tool_call.sse` | Recorded: the first turn of a two-turn `read_file` loop at effort `low`. |
| `json_ok.sse` | Recorded: a JSON-mode stream (reasoning streams, the content arrives as one buffered chunk). |
| `after_stop_null_timings.sse` | Recorded: the request right after a client Stop; its `timings` clocks are null. |
| `errors.json` | Recorded: `model_not_found`, `context_overflow`, `logprobs`, `admission_full`, `props_not_running`. Synthetic (from the v0.2.21 source, marked `source: synthetic`): `structured_output_failed` (502) and `engine_starting`, which the run could not provoke. |
| `json_failed.sse` | **Synthetic**, `terminal/serve/server.py:8277-8279`, `:8296-8303`: a streamed JSON-mode validation failure is an in-band error object then `[DONE]` under HTTP 200. Every live JSON request validated. |
| `no_answer_length.sse` | **Synthetic**, `server.py:6547-6554`, string `server_parts/base.py:110-111`: Strata's injected no-answer note. Strata's answer reserve left room for visible text in every forced case tried. |
