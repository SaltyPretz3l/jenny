# ruff: noqa: B027, PLC0415, PLR0913
"""
Abstract base class for AI inference engines.

Defines the interface that all AI engine implementations must follow,
enabling easy swapping between different model backends (Ollama, llama-cpp, Mock, etc.).

Supports text-only and multimodal (vision, audio) inference through
optional capability methods.

Chat-mode support:
    Engines may accept a ``messages`` parameter (list of dicts with
    ``role`` and ``content`` keys) for proper multi-turn conversation.
    When ``messages`` is provided, ``prompt`` and ``system`` are ignored.
"""

import time
from abc import ABC, abstractmethod
from enum import Enum, auto
from typing import TYPE_CHECKING, Any, Dict, Generator, List, Optional, Set, TypedDict

from sidecar.ai.context.messages import EMPTY_ASSISTANT_CONTENT_PLACEHOLDER  # noqa: F401
from sidecar.ai.engines.engine_events import (
    EngineEvent,
)

# EMPTY_ASSISTANT_CONTENT_PLACEHOLDER is part of the EngineMessage contract,
# re-exported for engine serializers: an assistant tool-call row whose content
# is exactly this placeholder holds no genuine text (see
# ensure_non_empty_assistant_content in sidecar/ai/context/messages.py).
# Import it from here rather than reaching into context — engine modules sit
# under the leaf import-fan-out cap (scripts/checks/check_import_fanout.py).

if TYPE_CHECKING:
    from ..tools.models import GenerationResult, StreamChunk
    from .response_format import ResponseFormat
    from .vision_input import VisionImage, VisionInput


class EngineToolCall(TypedDict, total=False):
    id: str
    call_id: str
    name: str
    tool_id: str
    arguments: dict[str, Any]


class EngineMessage(TypedDict, total=False):
    role: str
    content: Any
    images: list["VisionImage"]
    tool_calls: list[EngineToolCall]
    tool_call_id: str
    name: str


def clamp_timeout_to_deadline(
    timeout_seconds: float,
    wall_clock_deadline: float | None,
    *,
    minimum_seconds: float = 0.05,
) -> float:
    """Clamp a transport timeout to an absolute monotonic deadline.

    The small positive floor keeps provider libraries from interpreting zero
    as "no timeout" while still bounding a request whose deadline has already
    elapsed. The routing watchdog remains the owner of the terminal timeout
    status; this helper only prevents a transport acquisition from outliving
    that watchdog by its provider-wide default.
    """
    minimum = max(0.001, float(minimum_seconds))
    configured = max(minimum, float(timeout_seconds))
    if wall_clock_deadline is None:
        return configured
    remaining = float(wall_clock_deadline) - time.monotonic()
    return max(minimum, min(configured, remaining))


class ModelModality(Enum):
    """Supported model input/output modalities."""

    TEXT = auto()
    VISION = auto()


class BaseEngine(ABC):
    """
    Abstract Base Class for the AI Brain.

    Ensures different models (LFM, Llama, Mock, Ollama) can be swapped easily
    without changing the application code.

    All concrete implementations must provide:
    - load_model: Initialize and prepare the model
    - generate: Synchronous text generation
    - stream: Token-by-token streaming generation
    - unload_model: Cleanup (optional)

    Multimodal engines may additionally implement:
    - generate_with_vision: Generate from text + image(s)
    """

    @property
    def supported_modalities(self) -> Set[ModelModality]:
        """
        Return the set of modalities this engine currently supports.

        By default, only TEXT is supported. Subclasses should override
        this to advertise additional capabilities.

        Returns:
            Set of ModelModality values the engine can handle.
        """
        return {ModelModality.TEXT}

    @property
    def capabilities(self) -> Dict[str, bool]:
        """
        Return a user-friendly dict of engine capabilities.

        Returns:
            Dict mapping capability names to booleans.
        """
        mods = self.supported_modalities
        return {
            "text": ModelModality.TEXT in mods,
            "vision": ModelModality.VISION in mods,
        }

    @property
    def supports_tool_calling(self) -> bool:
        """
        Return whether this engine natively supports structured tool calls.

        Engines without native support can still participate in tool loops via
        the in-band adapter.
        """
        return False

    @property
    def supports_inband_tool_calling(self) -> bool:
        """Return whether plain text output can be parsed for tool calls."""
        return False

    @abstractmethod
    def load_model(self, model_path: str) -> None:
        """
        Load the model into memory.

        Args:
            model_path: Path or identifier for the model to load
                       (file path for local models, model name for APIs)

        Raises:
            FileNotFoundError: If model file doesn't exist (for local models)
            ConnectionError: If remote model service is unavailable
            RuntimeError: If model loading fails
        """
        pass

    @abstractmethod
    def generate(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: Optional[str] = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
    ) -> str:
        """
        Generate a complete text response synchronously.

        When *messages* is provided the engine should use its native
        chat/multi-turn API (e.g. Ollama ``/api/chat``) and ignore
        *prompt* and *system*.  Each message dict must have ``role``
        (``"system"``, ``"user"``, or ``"assistant"``) and ``content``.

        When *response_format* is provided and its ``is_json`` property
        is True, the engine should constrain output to valid JSON.

        Args:
            prompt: Input text prompt for the model (ignored if messages given)
            max_tokens: Maximum number of tokens to generate
            temperature: Sampling temperature (0.0 = deterministic, higher = more random)
            system: Optional system prompt (ignored if messages given)
            messages: Optional chat-mode message list for multi-turn conversation
            response_format: Optional format constraint (e.g. JSON mode)

        Returns:
            Generated text response

        Raises:
            RuntimeError: If model is not loaded or generation fails
        """
        ...

    @abstractmethod
    def stream(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: Optional[str] = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
        cancel_handle: Any = None,
    ) -> Generator["StreamChunk", None, None]:
        """
        Yield tokens for streaming response.

        When *messages* is provided the engine should use its native
        chat/multi-turn API and ignore *prompt* and *system*.

        When *response_format* is provided and its ``is_json`` property
        is True, the engine should constrain output to valid JSON.

        Args:
            prompt: Input text prompt for the model (ignored if messages given)
            max_tokens: Maximum number of tokens to generate
            temperature: Sampling temperature (0.0 = deterministic, higher = more random)
            system: Optional system prompt (ignored if messages given)
            messages: Optional chat-mode message list for multi-turn conversation
            response_format: Optional format constraint (e.g. JSON mode)

        Yields:
            Text chunks as they are generated

        Raises:
            RuntimeError: If model is not loaded or streaming fails
        """
        pass

    def generate_with_tools(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: Optional[str] = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
    ) -> "GenerationResult":
        """
        Generate with optional structured tool-calling support.

        Default behavior falls back to plain text generation and returns a
        non-tool-call result. Engines with native tool-calling should override.
        """
        from ..tools.models import GenerationResult

        content = self.generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        return GenerationResult(content=content, finish_reason="stop")

    def stream_with_tools(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: Optional[str] = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> Generator["StreamChunk", None, "GenerationResult"]:
        """Yield stream chunks, then return a terminal GenerationResult.

        Default implementation wraps ``generate_with_tools()`` as a single
        terminal yield.  Engines override for true token-level streaming.
        This unified path lets timeout enforcement (GAP 4) and streaming
        consumers share the same code path.
        """
        _ = (cancel_handle, wall_clock_deadline)
        result = self.generate_with_tools(
            prompt=prompt,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        yield result.content  # single chunk with full content
        return result

    def generate_with_vision(
        self,
        prompt: str,
        images: List["VisionInput"],
        max_tokens: int = 256,
        temperature: float = 0.7,
    ) -> "GenerationResult":
        """
        Generate a response from text prompt and one or more images.

        Args:
            prompt: Text prompt describing what to do with the image(s)
            images: List of image paths or base64-encoded image strings
            max_tokens: Maximum number of tokens to generate
            temperature: Sampling temperature

        Returns:
            GenerationResult whose ``content`` is the generated text and whose
            ``finish_reason`` is ``"length"`` when the provider stopped at the
            token budget (``"stop"`` otherwise)

        Raises:
            NotImplementedError: If engine does not support vision
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support vision input. "
            f"Supported modalities: {self.supported_modalities}"
        )

    def get_model_context_length(self) -> Optional[int]:
        """
        Return the native maximum context length of the loaded model.

        Subclasses should override this to query actual model metadata.
        Returns ``None`` if the information is not available.
        """
        return None

    def get_model_max_output_tokens(self) -> Optional[int]:
        """
        Return the recommended max output tokens for the loaded model.

        Subclasses should override this to query actual model metadata
        (e.g. Ollama's ``num_predict`` from the Modelfile, or a heuristic
        derived from the context length).
        Returns ``None`` if the information is not available.
        """
        return None

    def get_request_output_reservation(
        self,
        reasoning_effort: Optional[str] = None,  # noqa: ARG002
    ) -> Optional[int]:
        """Return total request output headroom, including hidden reasoning."""

        return self.get_model_max_output_tokens()

    def unload_model(self, name: str | None = None) -> None:
        """
        Unload the model to free resources.

        Engines backed by a shared daemon may use ``name`` to force an
        intentional eviction of that exact model. Other engines may ignore it.
        This method is optional but recommended for resource management,
        especially on memory-constrained devices.
        """
        pass

    def close(self) -> None:
        """
        Release engine resources (HTTP clients, subprocesses, file handles).

        Called by the container when the engine is being discarded. Default
        is a no-op; subclasses with managed transports should override.
        """
        pass
