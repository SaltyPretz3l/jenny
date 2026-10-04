# Engines

Engine abstraction layer for local-first inference with explicit optional cloud
routes. `factory.py` selects the actual post-fallback engine and returns an
`EngineSelection`; routing budgets and capabilities follow that actual engine.

## Active engines

| Engine type | Implementation | Posture |
|---|---|---|
| `ollama` | `ollama.py` | Default local engine; discovers daemon models at runtime. |
| `vllm` | `vllm_engine.py` | Local OpenAI-style inference; factory default `Qwen/Qwen3.5-9B`. |
| `openai-compatible` | `openai_compatible.py` | Local-compatible HTTP endpoints, including managed or user-run llama-server. Factory enforces loopback/private/link-local hosts. |
| `chatgpt` | `responses_descriptor.py`, `chatgpt_subscription.py`, `chatgpt_provider_descriptor.py` | Core optional ChatGPT sign-in route. Jenny's own OAuth service supplies the access token; no external plugin is required. Factory fallback model is `gpt-5.5`; live discovery owns selection. |
| `codex-cli` | `codex_cli.py` | Explicit opt-in CLI subprocess transport; the CLI uses its own login. Jenny never reads or copies its credentials. |
| `mock` | `mock.py` | Deterministic test engine and fail-closed selection fallback. |
| `replay` | `replay.py` | Fixture-driven local engine for tests and authorized app automation. |

Unknown selections, invalid configuration and engine initialization failures fall
back to `MockEngine` with bounded fallback metadata. A fallback does not establish
that the requested provider or model is ready. The legacy API-key cloud engines
under `archive/cloud-engines/` remain historical source and are not active imports.

## Shared infrastructure

- `base.py` — `BaseEngine` and normalized generation/streaming contracts.
- `factory.py` / `provider_registry.py` — selection and lazy implementation imports.
- `catalog.py` / `chatgpt_model_catalog.py` — model discovery and capability metadata.
- `provider_http.py` / `http_utils.py` — bounded HTTP helpers.
- `provider_call_finalize.py` — exactly one terminal provider-call diagnostic row.
- `response_format.py` — response-format contract.

Model lifecycles and application authority remain with the host services; engines
hold no canonical conversation history. Request cancellation/deadlines arrive
through the request context. See Sidecar Runtime
and Concurrency Model.
