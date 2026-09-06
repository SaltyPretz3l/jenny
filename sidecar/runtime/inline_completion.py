"""Fill-in-the-middle inline code completion (ghost text).

One-shot, off-transcript engine call: feeds the cursor prefix + suffix to the
selected local FIM model via the engine's inline-completion path and returns the
raw completion text. The edited file content never enters the chat transcript.
Never raises — every failure path returns an empty string so the renderer
degrades to "no suggestion this round".
"""

from __future__ import annotations

import logging

from sidecar.ai.container import BrainContainer
from sidecar.runtime.diagnostics import log_event

_DEFAULT_MAX_TOKENS = 96
# Backstop bounds on the context fed to the model (the renderer already bounds
# prefix/suffix; this guards a misbehaving or out-of-date caller).
_MAX_PREFIX_CHARS = 8_000
_MAX_SUFFIX_CHARS = 4_000
# Server-side cap kept just above the ~4s Electron client timeout (see
# services/backend/sidecar-request-timeouts.js). The sidecar processes requests
# serially, so a round the client has already abandoned must not hold the loop
# much past the point it gave up (head-of-line blocking other non-chat work).
# Ollama still begins loading the model on connect, so this keeps the warmup
# benefit while bounding the worst-case stall to ~5s instead of ~20s.
_ENGINE_TIMEOUT_SECONDS = 5

# Special / FIM control tokens some models leak into completions; truncate at the
# first one so ghost text never shows raw template scaffolding.
_STOP_MARKERS = (
    "<|file_separator|>",
    "<|endoftext|>",
    "<|fim_pad|>",
    "<|fim_prefix|>",
    "<|fim_suffix|>",
    "<|fim_middle|>",
    "<file_sep>",
    "<|im_end|>",
    "<|im_start|>",
    "<EOT>",
    "<｜end▁of▁sentence｜>",
)


def _clean_completion(text: str) -> str:
    """Cut the completion at the first leaked control token."""
    cleaned = str(text or "")
    for marker in _STOP_MARKERS:
        idx = cleaned.find(marker)
        if idx != -1:
            cleaned = cleaned[:idx]
    return cleaned


def _build_ollama_fallback_engine() -> object | None:
    """Construct a transient Ollama engine for inline completion.

    A FIM completion model is always a separate Ollama pull, unrelated to
    whichever engine serves chat, so when the active engine has no FIM path
    (e.g. openai-compatible / vLLM / mock) the completion is served from a
    throwaway Ollama engine pointed at the app-managed daemon. Construction does
    no network I/O — the model is loaded lazily by the daemon on the first
    ``/api/generate`` call and held hot via ``keep_alive`` — so a per-request
    instance is cheap and needs no caching or lifecycle management (which the
    BrainContainer request-boundary tripwire would otherwise flag). Returns
    None if the engine cannot be imported/constructed. Seam for tests.
    """
    try:
        from sidecar.ai.engines.ollama import OllamaEngine  # noqa: PLC0415

        return OllamaEngine()
    except Exception:  # noqa: BLE001
        return None


def list_loaded_inline_models(logger: logging.Logger) -> list[str]:
    """Return the names of models currently loaded in the Ollama daemon.

    Backs the IDE completion menu's live ●loaded / ○not-loaded indicator. Uses a
    transient Ollama engine against the app-managed daemon (independent of the
    chat engine). Never raises — returns [] on any failure so the menu degrades
    to "unknown / not loaded".
    """
    engine = _build_ollama_fallback_engine()
    lister = getattr(engine, "list_loaded_models", None)
    if not callable(lister):
        return []
    try:
        loaded = lister()
    except Exception:  # noqa: BLE001
        log_event(
            logger,
            logging.INFO,
            component="runtime.inline_completion",
            event="inline_completion.loaded_models_failed",
            message="Could not query loaded Ollama models",
        )
        return []
    names: list[str] = []
    for entry in loaded if isinstance(loaded, list) else []:
        if isinstance(entry, dict):
            name = str(entry.get("name") or "").strip()
        else:
            name = str(entry or "").strip()
        if name:
            names.append(name)
    return names


def unload_inline_model(model: str, logger: logging.Logger) -> bool:
    """Evict a specific FIM model from the Ollama daemon (keep_alive:0).

    Independent of the chat engine. Returns True on success, False on any failure
    or when no model tag is given (degrade-never).
    """
    tag = str(model or "").strip()
    if not tag:
        return False
    engine = _build_ollama_fallback_engine()
    unloader = getattr(engine, "unload_model", None)
    if not callable(unloader):
        return False
    try:
        unloader(tag)
    except Exception:  # noqa: BLE001
        log_event(
            logger,
            logging.INFO,
            component="runtime.inline_completion",
            event="inline_completion.unload_failed",
            message="Could not unload Ollama completion model",
        )
        return False
    log_event(
        logger,
        logging.INFO,
        component="runtime.inline_completion",
        event="inline_completion.unloaded",
        message="Unloaded inline completion model from the Ollama daemon",
    )
    return True


def generate_inline_completion(  # noqa: PLR0913 -- explicit inline-completion request boundary
    brain_container: BrainContainer,
    *,
    prefix: str,
    suffix: str,
    model: str,
    max_tokens: int,
    logger: logging.Logger,
) -> str:
    """Produce a single inline completion for the cursor position.

    Returns the cleaned completion string, or an empty string on any failure
    (no model selected, no FIM path and no constructable Ollama fallback, or an
    engine error). Works even when no chat model is loaded — the completion runs
    on its own Ollama model, independent of the chat engine. Never raises.
    """
    selected = str(model or "").strip()
    if not selected:
        return ""

    # FIM autocomplete runs on its OWN Ollama model — a separate pull, unrelated
    # to whichever model/engine serves chat — so it must work even when NO chat
    # model is loaded (``brain_container.stack is None``), e.g. while editing in
    # the IDE before any chat has started. Use the active chat engine's FIM path
    # only when it genuinely has one; otherwise (no stack at all, or a chat engine
    # without an FIM path such as openai-compatible / vLLM / mock) serve the
    # completion from a transient Ollama engine pointed at the app-managed daemon.
    stack = brain_container.stack
    engine = getattr(stack, "engine", None) if stack is not None else None
    fim = getattr(engine, "generate_inline_completion", None)
    if not callable(fim):
        fallback = _build_ollama_fallback_engine()
        fim = getattr(fallback, "generate_inline_completion", None)
        if not callable(fim):
            log_event(
                logger,
                logging.INFO,
                component="runtime.inline_completion",
                event="inline_completion.unsupported_engine",
                message=(
                    "No inline-completion path available "
                    "(Ollama fallback unavailable); skipping"
                ),
            )
            return ""
        log_event(
            logger,
            logging.INFO,
            component="runtime.inline_completion",
            event="inline_completion.ollama_fallback",
            message=(
                "Serving inline completion via the Ollama daemon "
                "(no chat stack, or the active engine has no FIM path)"
            ),
        )

    bounded_prefix = str(prefix or "")[-_MAX_PREFIX_CHARS:]
    bounded_suffix = str(suffix or "")[:_MAX_SUFFIX_CHARS]
    try:
        tokens = int(max_tokens)
    except (TypeError, ValueError):
        tokens = _DEFAULT_MAX_TOKENS
    if tokens <= 0:
        tokens = _DEFAULT_MAX_TOKENS

    try:
        raw = fim(
            selected,
            bounded_prefix,
            bounded_suffix,
            # ``use_gpu`` remains in the Python call signature for one-release
            # compatibility, but placement is automatic now: True means the
            # Ollama adapter does not pin ``num_gpu=0`` and lets the daemon use
            # its current hardware/resource policy.
            use_gpu=True,
            max_tokens=tokens,
            timeout=_ENGINE_TIMEOUT_SECONDS,
        )
    except Exception:
        log_event(
            logger,
            logging.WARNING,
            component="runtime.inline_completion",
            event="inline_completion.failed",
            message="Engine call failed during inline completion",
        )
        return ""

    return _clean_completion(str(raw or ""))
