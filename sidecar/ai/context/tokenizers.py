"""Real tokenizer backend using optional tiktoken.

Satisfies the ``TokenizerBackend`` protocol from ``token_budget.py``.
When tiktoken is unavailable, falls back to ``CharEstimationBackend``.

Cross-family approximation note: tiktoken encodings are designed for
specific model families.  Using ``cl100k_base`` on a Llama or Gemma
model can be off by 10-15%.  A 10% budget headroom safety margin is
applied when a cross-family encoding is in use.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Encoding resolution
# ---------------------------------------------------------------------------

# Maps Ollama template families to tiktoken encoding names where a
# close match exists.  Families not listed here use the universal
# fallback (cl100k_base).
_FAMILY_ENCODING_MAP: dict[str, str] = {
    "qwen": "cl100k_base",  # Qwen uses a BPE similar to cl100k
    "chatml": "cl100k_base",
    "deepseek": "cl100k_base",
}
_APPROXIMATE_TIKTOKEN_FAMILIES = frozenset({"qwen", "deepseek"})

_UNIVERSAL_FALLBACK_ENCODING = "cl100k_base"
_LOCAL_TOKENIZER_FAMILIES = frozenset({"qwen", "gemma", "llama", "mistral", "phi", "deepseek"})
_LOCAL_TOKENIZER_IDS = {
    "qwen": "Qwen/Qwen3",
    "gemma": "google/gemma-3-4b-it",
    "llama": "meta-llama/Llama-3.1-8B-Instruct",
    "mistral": "mistralai/Mistral-7B-Instruct-v0.3",
    "phi": "microsoft/Phi-3-mini-4k-instruct",
    "deepseek": "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
}

# Safety margin for cross-family approximation (10%)
CROSS_FAMILY_HEADROOM = 0.10


def _resolve_encoding_name(model_family: str = "") -> tuple[str, bool]:
    """Return ``(encoding_name, is_exact_match)``.

    ``is_exact_match`` is True when the encoding is known to closely
    match the model family's native tokenizer.  When False, the caller
    should apply the cross-family headroom margin.
    """
    key = str(model_family).strip().lower()
    if key in _FAMILY_ENCODING_MAP:
        return _FAMILY_ENCODING_MAP[key], key not in _APPROXIMATE_TIKTOKEN_FAMILIES
    return _UNIVERSAL_FALLBACK_ENCODING, False


# ---------------------------------------------------------------------------
# LocalModelTokenizerBackend
# ---------------------------------------------------------------------------


class LocalModelTokenizerBackend:
    """Token counting backend using a locally available model-family tokenizer."""

    def __init__(self, *, model_family: str, tokenizer: Any) -> None:
        if tokenizer is None or not hasattr(tokenizer, "encode"):
            msg = "local tokenizer must expose encode(text)"
            raise TypeError(msg)
        self._model_family = model_family
        self._tokenizer = tokenizer

    @property
    def is_exact_match(self) -> bool:
        return True

    @property
    def headroom_factor(self) -> float:
        return 0.0

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        encoded = self._tokenizer.encode(text)
        return len(encoded)

    def encode(self, text: str) -> list[int]:
        if not text:
            return []
        encoded = self._tokenizer.encode(text)
        return list(encoded)

    def decode(self, token_ids: list[int]) -> str:
        if not token_ids:
            return ""
        decode = getattr(self._tokenizer, "decode", None)
        if callable(decode):
            return str(decode(token_ids))
        return ""

    def get_context_window(self, model: str) -> int:  # noqa: ARG002
        return 200_000

    def get_max_output_tokens(self, model: str) -> int:  # noqa: ARG002
        return 16_384


# ---------------------------------------------------------------------------
# TiktokenBackend
# ---------------------------------------------------------------------------


class TiktokenBackend:
    """Token counting backend using tiktoken.

    Instantiation fails with ``ImportError`` if tiktoken is not installed.
    Callers should catch this and fall back to ``CharEstimationBackend``.
    """

    def __init__(self, model_family: str = "") -> None:
        import tiktoken  # type: ignore[import-untyped,import-not-found]

        encoding_name, self._exact_match = _resolve_encoding_name(model_family)
        self._encoding = tiktoken.get_encoding(encoding_name)
        self._encoding_name = encoding_name
        self._model_family = model_family
        logger.info(
            "TiktokenBackend initialized: encoding=%s exact=%s family=%s",
            encoding_name,
            self._exact_match,
            model_family or "(none)",
        )

    @property
    def is_exact_match(self) -> bool:
        """True when the encoding closely matches the model's tokenizer."""
        return self._exact_match

    @property
    def headroom_factor(self) -> float:
        """Budget headroom factor: 0.0 for exact, CROSS_FAMILY_HEADROOM otherwise."""
        return 0.0 if self._exact_match else CROSS_FAMILY_HEADROOM

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        return len(self._encoding.encode(text))

    def encode(self, text: str) -> list[int]:
        """Encode text to token ids (used by chunking)."""
        if not text:
            return []
        return self._encoding.encode(text)

    def decode(self, token_ids: list[int]) -> str:
        """Decode token ids back to text."""
        if not token_ids:
            return ""
        return self._encoding.decode(token_ids)

    def get_context_window(self, model: str) -> int:  # noqa: ARG002
        return 200_000

    def get_max_output_tokens(self, model: str) -> int:  # noqa: ARG002
        return 16_384


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def _char_estimation_backend() -> Any:
    from sidecar.ai.context.token_budget import CharEstimationBackend

    return CharEstimationBackend()


def create_tokenizer_backend(
    model_family: str = "",
    *,
    local_tokenizer_loader: Callable[[str], Any] | None = None,
) -> Any:
    """Create the best available tokenizer backend.

    Prefers a locally available model-family tokenizer for known local model
    families, then tiktoken, then ``CharEstimationBackend``.
    """
    normalized_family = str(model_family or "").strip().lower()
    if normalized_family in _LOCAL_TOKENIZER_FAMILIES:
        loader = local_tokenizer_loader or _load_optional_local_tokenizer
        try:
            tokenizer = loader(normalized_family)
            if tokenizer is not None:
                return LocalModelTokenizerBackend(
                    model_family=normalized_family,
                    tokenizer=tokenizer,
                )
        except ImportError:
            logger.info(
                "Local tokenizer packages not available for family=%s; falling back.",
                normalized_family,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Local tokenizer initialization failed for family=%s: %s; falling back.",
                normalized_family,
                exc,
            )

    try:
        return TiktokenBackend(model_family=model_family)
    except ImportError:
        logger.info(
            "tiktoken not available; using CharEstimationBackend.",
        )
        return _char_estimation_backend()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "TiktokenBackend initialization failed: %s; using CharEstimationBackend.",
            exc,
        )
        return _char_estimation_backend()


def _load_optional_local_tokenizer(model_family: str) -> Any | None:
    """Load a cached tokenizer without network access when optional packages exist."""
    import transformers  # type: ignore[import-not-found]

    tokenizer_id = _LOCAL_TOKENIZER_IDS.get(model_family)
    if not tokenizer_id:
        return None
    return transformers.AutoTokenizer.from_pretrained(tokenizer_id, local_files_only=True)
