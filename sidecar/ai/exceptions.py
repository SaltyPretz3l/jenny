# ruff: noqa: PLR0913
"""
Custom exception hierarchy for sidecar AI engines.

Provides structured error types so callers can handle engine-specific
failures (connection errors, model-not-loaded, timeout, etc.) without
catching bare ``Exception`` or inspecting error message strings.

All AI engine exceptions inherit from ``CompanionError`` so they carry
a stable ``code`` attribute for machine-readable error identification.

Usage::

    from sidecar.ai.exceptions import ModelNotLoadedError, EngineConnectionError

    try:
        response = engine.generate(prompt)
    except ModelNotLoadedError:
        print("Load a model first.")
    except EngineConnectionError:
        print("Cannot reach the inference server.")
"""

from sidecar.ai.error_codes import (
    CMP_AI_ENGINE_CONNECTION,
    CMP_AI_GENERATION,
    CMP_AI_MODEL_NOT_LOADED,
    CMP_AI_UNSUPPORTED_MODAL,
)
from sidecar.exceptions import CompanionError


class EngineError(CompanionError):
    """Base class for all AI engine errors."""

    _default_code: str = CMP_AI_GENERATION

    def __init__(
        self,
        message: str = "Engine error.",
        *,
        code: str = "",
        retryable: bool = False,
    ):
        super().__init__(code or self._default_code, message, retryable=retryable)


class ModelNotLoadedError(EngineError):
    """Raised when an operation requires a loaded model but none is loaded."""

    _default_code = CMP_AI_MODEL_NOT_LOADED

    def __init__(self, message: str = "No model is currently loaded."):
        super().__init__(message)


class EngineConnectionError(EngineError):
    """Raised when the engine cannot reach its backend (e.g. Ollama server)."""

    _default_code = CMP_AI_ENGINE_CONNECTION

    def __init__(
        self,
        message: str = "Could not connect to inference server.",
        *,
        code: str = "",
        retryable: bool = False,
    ):
        super().__init__(message, code=code, retryable=retryable)


class GenerationError(EngineError):
    """Raised when text/multimodal generation fails at runtime."""

    _default_code = CMP_AI_GENERATION

    def __init__(self, message: str = "Generation failed.", *, retryable: bool = False):
        super().__init__(message, retryable=retryable)


class UnsupportedModalityError(EngineError):
    """Raised when the current model doesn't support the requested modality."""

    _default_code = CMP_AI_UNSUPPORTED_MODAL

    def __init__(self, modality: str, model: str = ""):
        model_info = f" (model: {model})" if model else ""
        super().__init__(f"Modality '{modality}' is not supported{model_info}.")
        self.modality = modality
