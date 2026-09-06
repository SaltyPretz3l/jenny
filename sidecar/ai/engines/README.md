# Engines

Engine abstraction layer for local-first LLM integration.

## Local-First Posture

Development and runtime selection target local inference engines. The retired
cloud provider engines are preserved under `archive/cloud-engines/` as historical
source, but they are not active imports or feature-flagged runtime options.

### Always-available Engines

| Engine | File | Notes |
|--------|------|-------|
| **Ollama** | `ollama.py` | Primary local engine; model discovered at runtime via `/api/tags` or local manifests. |
| **vLLM** | `vllm_engine.py` | OpenAI-compatible local inference; default model `Qwen/Qwen3.5-9B`. |
| **Mock** | `mock.py` | Deterministic stub for tests and fallback. |

## Shared Infrastructure

- `base.py` - abstract `BaseEngine` contract.
- `proxy.py` - transparent engine wrapper.
- `factory.py` - runtime engine selection with fallback.
- `catalog.py` - dynamic model discovery for Ollama and vLLM.
- `provider_registry.py` - active local engine class imports.
- `provider_http.py` / `http_utils.py` - shared HTTP helpers used by vLLM.
- `response_format.py` - normalized response envelope.

Retired `PORT_BUNDLES` salvage hooks are not active runtime code. Use the
reference-only docs and policy checks for historical salvage context.
