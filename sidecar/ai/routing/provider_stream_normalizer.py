"""Normalize provider chunks, accumulate bounded argument fragments by call ID,
and identify reasoning-only completion.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterator, Mapping

from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL
from sidecar.ai.routing.provider_tool_limits import (
    MAX_PROVIDER_TOOL_CALLS,
    MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES,
    MAX_TOOL_CALL_ARGUMENT_BYTES,
    safe_unique_tool_call_id,
    serialized_tool_arguments,
)
from sidecar.ai.tools.models import coerce_tool_arguments
from sidecar.runtime.local_engine.request_context import (
    current_diagnostics_store,
    current_request_context,
)
from sidecar.runtime.vllm_engine_support import extract_reasoning_delta

# ---------------------------------------------------------------------------
# Public data contracts
# ---------------------------------------------------------------------------

# The cross-layer signal an engine sets on itself when the normalizer detects a
# reasoning-only completion. Read by ``chat_streaming.build_live_streaming_chat_response``
# at end-of-stream to surface ``CHAT_ERROR_METHOD`` instead of ``CHAT_DONE_METHOD``.
FINISH_REASON_REASONING_ONLY = "reasoning_only"

# Terminal-evidence verdicts. ``incomplete`` is set by the ENGINE when a stream
# EOFs with no terminal evidence at all (no Ollama ``done`` chunk, no vLLM
# ``[DONE]`` sentinel and no ``finish_reason``); ``error`` is set HERE when the
# provider ships an in-band error frame mid-stream. Both previously fell through
# to a synthesized ``finish_reason="stop"``, which made a truncated answer
# indistinguishable from a complete one. See ``CMP_STREAM_INCOMPLETE``.
FINISH_REASON_INCOMPLETE = "incomplete"
FINISH_REASON_PROVIDER_ERROR = "error"
# Set by an engine when the thinking-repetition guard aborts generation after
# the thinking character budget is exhausted; a later engine slice emits it.
FINISH_REASON_THINKING_BUDGET = "thinking_budget"

# The eight spec-locked event kinds. Listed verbatim from the umbrella spec.
NORMALIZED_KIND_VISIBLE_TEXT_DELTA = "visible_text_delta"
NORMALIZED_KIND_REASONING_DELTA = "reasoning_delta"
NORMALIZED_KIND_TOOL_CALL_DELTA = "tool_call_delta"
NORMALIZED_KIND_TOOL_CALL_COMPLETED = "tool_call_completed"
NORMALIZED_KIND_EMPTY_CHUNK = "empty_chunk"
NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS = "malformed_tool_arguments"
NORMALIZED_KIND_DONE = "done"
NORMALIZED_KIND_FAILED = "failed"

# Source values; Phase 4 only uses provider_stream. Phase 5+ may add others
# (e.g. in_band_parser) without changing the eight kinds above.
NORMALIZED_SOURCE_PROVIDER_STREAM = "provider_stream"


@dataclass(frozen=True)
class NormalizedStreamEvent:
    """A single classified stream event.

    Field semantics:

    * ``kind`` — one of the eight spec values above.
    * ``text`` — visible-text or reasoning-text fragment; empty for non-text.
    * ``thinking_id`` — opaque correlation id for reasoning streams; the
      engine layer is the canonical owner of this id (Phase 4 leaves it as
      ``None`` and lets the routing layer assign it).
    * ``tool_call_id`` — the provider's call id for tool-related kinds.
    * ``tool_name`` — the resolved function name for tool-related kinds.
    * ``arguments_delta`` — raw fragment for ``tool_call_delta``, parsed dict
      for ``tool_call_completed``, raw bad string for
      ``malformed_tool_arguments``.
    * ``sequence`` — monotonic per-stream counter; starts at 0 and increments
      per emitted event.
    * ``source`` — constant ``"provider_stream"`` for Phase 4.
    """

    kind: str
    text: str = ""
    thinking_id: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    arguments_delta: Any = None
    sequence: int = 0
    source: str = NORMALIZED_SOURCE_PROVIDER_STREAM


@dataclass(frozen=True)
class StreamCounters:
    """Per-stream classifier counters.

    Surfaced via :py:meth:`TurnDiagnosticsStore.record_stream_counters` and
    flowed out automatically through ``runtime.latest_turn_diagnostics``.
    Provider-neutral; the ``provider`` field carries the engine_id verbatim
    (e.g., ``"ollama"``, ``"vllm"``).
    """

    visible_text_delta_count: int = 0
    reasoning_delta_count: int = 0
    tool_call_delta_count: int = 0
    tool_call_completed_count: int = 0
    empty_chunk_count: int = 0
    malformed_tool_arguments_count: int = 0
    failed_count: int = 0
    total_chunk_count: int = 0
    provider: str = ""

    def to_payload(self) -> dict[str, Any]:
        """Return a JSON-friendly dict view for diagnostics surfacing."""
        return {
            "visible_text_delta_count": self.visible_text_delta_count,
            "reasoning_delta_count": self.reasoning_delta_count,
            "tool_call_delta_count": self.tool_call_delta_count,
            "tool_call_completed_count": self.tool_call_completed_count,
            "empty_chunk_count": self.empty_chunk_count,
            "malformed_tool_arguments_count": self.malformed_tool_arguments_count,
            "failed_count": self.failed_count,
            "total_chunk_count": self.total_chunk_count,
            "provider": self.provider,
        }


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


# The canonical implementation lives beside ``ToolCallRequest`` in
# ``sidecar.ai.tools.models`` so the streaming path here and the non-streaming
# ``_parse_tool_calls`` cannot drift apart on what "malformed" means. Kept
# under the original private name for this module's existing call sites.
_coerce_tool_arguments = coerce_tool_arguments


def record_counters_to_diagnostics(engine: Any, normalizer: ProviderStreamNormalizer) -> None:
    """Emit per-stream counters to the engine's diagnostics store.

    Defensive: never raises. Pulls request_id from the engine's active
    request context (the same lookup ``request_context.request_id`` exposes,
    inlined here to avoid an extra import on the routing-side module).
    """
    try:
        store = current_diagnostics_store(engine)
        if store is None or not hasattr(store, "record_stream_counters"):
            return
        context = current_request_context(engine)
        if not isinstance(context, Mapping):
            return
        request_id = str(context.get("request_id") or "").strip()
        if not request_id:
            return
        store.record_stream_counters(
            request_id=request_id,
            counters=normalizer.counters.to_payload(),
        )
    except Exception:  # noqa: BLE001 — diagnostic-only.
        pass


# ---------------------------------------------------------------------------
# Internal accumulator state (per-stream, per-call_id)
# ---------------------------------------------------------------------------


@dataclass
class _ToolCallState:
    """Internal accumulator for one tool call's argument fragments.

    Tracks the latest seen ``tool_name`` (engines may not provide it on every
    delta) and bounded raw JSON fragments without quadratic string copying.
    ``finalized`` flips True once the call has been completed or marked
    malformed; subsequent fragments for the same call_id are ignored.
    """

    call_id: str
    tool_name: str | None = None
    argument_fragments: list[str] = field(default_factory=list)
    argument_bytes: int = 0
    finalized: bool = False


# ---------------------------------------------------------------------------
# Public class
# ---------------------------------------------------------------------------


class ProviderStreamNormalizer:
    """Per-stream chunk classifier.

    Construct one instance per :py:meth:`Engine.stream_with_tools` /
    :py:meth:`Engine.stream` invocation; discard at end-of-stream.

    Public surface:

    * :py:meth:`process_chunk` — classify one raw provider chunk and yield
      the resulting :class:`NormalizedStreamEvent` records.
    * :py:meth:`finalize` — emit the terminal ``done`` (and optional
      ``failed`` for reasoning-only) event.
    * :py:meth:`feed` / :py:meth:`finalize_for_counters` — non-yielding
      drives for engine-side hot paths that only need the counter and
      detection side effects.
    * :py:attr:`counters` — read-only view of the live counter dict.
    * :py:attr:`reasoning_only_detected` — True after :py:meth:`finalize`
      determined the stream produced reasoning but no visible text or tool.
    """

    def __init__(
        self,
        *,
        provider: str,
    ) -> None:
        self._provider = str(provider or "")
        self._sequence = 0
        self._finalized = False
        self._reasoning_only_detected = False
        # Terminal evidence observed IN the stream: the provider's own
        # ``done_reason`` (Ollama) / ``finish_reason`` (vLLM), or ``"error"``
        # for an in-band error frame. Empty string means "no terminal chunk was
        # ever seen", which is what an engine reads to distinguish a clean end
        # from a truncated one.
        self._terminal_finish_reason = ""
        # vLLM-only state: Ollama ships fully-formed tool calls per chunk
        # and never populates this dict; vLLM SSE accumulates fragments
        # here keyed by call_id.
        self._tool_calls: dict[str, _ToolCallState] = {}
        # vLLM-only: maps the per-stream ``index`` to the ``call_id`` we
        # registered for the *first* fragment carrying that index. Subsequent
        # fragments with the same ``index`` but no ``id`` route to the same
        # accumulator instead of forking a new one.
        self._tool_call_index_to_call_id: dict[int, str] = {}
        self._used_tool_call_ids: set[str] = set()
        self._tool_call_count = 0
        self._aggregate_argument_bytes = 0
        self._tool_input_rejected = False
        self._counts: Counter[str] = Counter()
        self._total_chunk_count = 0

    # ------------------------------------------------------------------ public

    @property
    def counters(self) -> StreamCounters:
        return StreamCounters(
            visible_text_delta_count=self._counts.get(
                NORMALIZED_KIND_VISIBLE_TEXT_DELTA, 0
            ),
            reasoning_delta_count=self._counts.get(NORMALIZED_KIND_REASONING_DELTA, 0),
            tool_call_delta_count=self._counts.get(NORMALIZED_KIND_TOOL_CALL_DELTA, 0),
            tool_call_completed_count=self._counts.get(
                NORMALIZED_KIND_TOOL_CALL_COMPLETED, 0
            ),
            empty_chunk_count=self._counts.get(NORMALIZED_KIND_EMPTY_CHUNK, 0),
            malformed_tool_arguments_count=self._counts.get(
                NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS, 0
            ),
            failed_count=self._counts.get(NORMALIZED_KIND_FAILED, 0),
            total_chunk_count=self._total_chunk_count,
            provider=self._provider,
        )

    @property
    def reasoning_only_detected(self) -> bool:
        return self._reasoning_only_detected

    @property
    def terminal_finish_reason(self) -> str:
        """The provider's own terminal verdict, or ``""`` when none was seen."""
        return self._terminal_finish_reason

    @property
    def saw_terminal_evidence(self) -> bool:
        """True when the stream carried an explicit terminal marker."""
        return bool(self._terminal_finish_reason)

    def feed(self, raw_chunk: Mapping[str, Any]) -> None:
        """Drive the normalizer for counter/detection state without yielding.

        Use this from engine wrappers where the existing parser pipeline is
        the canonical event producer and only the normalizer's classification
        side-effects are needed. Avoids per-event ``NormalizedStreamEvent``
        allocation in the per-chunk hot path.
        """
        for _ in self.process_chunk(raw_chunk):
            pass

    def finalize_for_counters(self) -> None:
        """Non-yielding variant of :py:meth:`finalize` for counter-only callers."""
        for _ in self.finalize():
            pass

    def process_chunk(
        self, raw_chunk: Mapping[str, Any]
    ) -> Iterator[NormalizedStreamEvent]:
        """Classify a single raw provider chunk; yield zero or more events."""
        if self._finalized:
            return
        self._total_chunk_count += 1
        if not isinstance(raw_chunk, Mapping):
            self._counts[NORMALIZED_KIND_EMPTY_CHUNK] += 1
            yield self._build(NORMALIZED_KIND_EMPTY_CHUNK)
            return

        if self._provider == "vllm":
            yield from self._process_vllm_chunk(raw_chunk)
        else:
            # Unknown providers fall through to the Ollama-shaped envelope;
            # empty fields produce ``empty_chunk`` rather than crashing.
            yield from self._process_ollama_chunk(raw_chunk)

    def finalize(self) -> Iterator[NormalizedStreamEvent]:
        """Emit terminal events (``done`` and optionally ``failed``).

        Idempotent: subsequent calls yield nothing.
        """
        if self._finalized:
            return
        self._finalized = True

        # Flush any tool calls that accumulated fragments but never received
        # an explicit completion signal. Each accumulator either parses to a
        # ``tool_call_completed`` or surfaces a ``malformed_tool_arguments``.
        for state in self._tool_calls.values():
            if state.finalized:
                continue
            yield from self._complete_or_mark_malformed(state)

        # Reasoning-only fail-closed: any reasoning, no visible text, no
        # completed tool call. Other shapes (reasoning + content, reasoning
        # + tool, no reasoning at all) are valid and pass through as ``done``.
        if (
            self._counts.get(NORMALIZED_KIND_REASONING_DELTA, 0) > 0
            and self._counts.get(NORMALIZED_KIND_VISIBLE_TEXT_DELTA, 0) == 0
            and self._counts.get(NORMALIZED_KIND_TOOL_CALL_COMPLETED, 0) == 0
            and self._counts.get(NORMALIZED_KIND_FAILED, 0) == 0
        ):
            self._reasoning_only_detected = True
            self._counts[NORMALIZED_KIND_FAILED] += 1
            yield self._build(
                NORMALIZED_KIND_FAILED,
                text="reasoning_only_completion",
            )

        yield self._build(NORMALIZED_KIND_DONE)

    # ----------------------------------------------------------------- helpers

    def _build(
        self,
        kind: str,
        *,
        text: str = "",
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        arguments_delta: Any = None,
    ) -> NormalizedStreamEvent:
        """Build the next NormalizedStreamEvent and bump the sequence counter."""
        seq = self._sequence
        self._sequence += 1
        return NormalizedStreamEvent(
            kind=kind,
            text=text,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            arguments_delta=arguments_delta,
            sequence=seq,
            source=NORMALIZED_SOURCE_PROVIDER_STREAM,
        )

    def _allocate_tool_call_id(
        self,
        provider_id: Any,
        *,
        index: int | None = None,
    ) -> str | None:
        if index is not None and index in self._tool_call_index_to_call_id:
            return self._tool_call_index_to_call_id[index]
        if self._tool_call_count >= MAX_PROVIDER_TOOL_CALLS:
            return None
        self._tool_call_count += 1
        call_id = safe_unique_tool_call_id(
            provider_id,
            ordinal=self._tool_call_count,
            used_ids=self._used_tool_call_ids,
        )
        if index is not None:
            self._tool_call_index_to_call_id[index] = call_id
        return call_id

    def _arguments_fit(self, *, call_bytes: int, added_bytes: int) -> bool:
        return (
            call_bytes + added_bytes <= MAX_TOOL_CALL_ARGUMENT_BYTES
            and self._aggregate_argument_bytes + added_bytes
            <= MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES
        )

    def _reject_tool_input(self, *, reason: str) -> Iterator[NormalizedStreamEvent]:
        if self._tool_input_rejected:
            return
        self._tool_input_rejected = True
        for state in self._tool_calls.values():
            state.argument_fragments.clear()
            state.finalized = True
        self._counts[NORMALIZED_KIND_FAILED] += 1
        yield self._build(
            NORMALIZED_KIND_FAILED,
            text=(
                f"{CMP_LOOP_INVALID_TOOL_CALL}: "
                f"provider tool-call input rejected ({reason})"
            ),
        )

    def _classify_inband_error(self, detail: str) -> Iterator[NormalizedStreamEvent]:
        """Classify a provider in-band error frame as a terminal failure.

        Both providers can interleave an error object into an otherwise
        well-formed stream. Neither was classified before, so the frame fell
        through as an ``empty_chunk`` and the stream still ended as ``stop``.
        """
        self._terminal_finish_reason = FINISH_REASON_PROVIDER_ERROR
        self._counts[NORMALIZED_KIND_FAILED] += 1
        yield self._build(
            NORMALIZED_KIND_FAILED,
            text=detail or "provider_stream_error",
        )

    # ------------------------------------------------------------- ollama path

    def _process_ollama_chunk(
        self, raw_chunk: Mapping[str, Any]
    ) -> Iterator[NormalizedStreamEvent]:
        """Classify an Ollama ``/api/chat`` JSON-line chunk."""
        inband_error = raw_chunk.get("error")
        if inband_error:
            yield from self._classify_inband_error(str(inband_error))
            return
        if raw_chunk.get("done"):
            # Record terminal evidence BEFORE the message-shape guard: a done
            # chunk may carry an empty or absent ``message`` envelope.
            self._terminal_finish_reason = str(raw_chunk.get("done_reason") or "stop")
        message = raw_chunk.get("message")
        if not isinstance(message, Mapping):
            self._counts[NORMALIZED_KIND_EMPTY_CHUNK] += 1
            yield self._build(NORMALIZED_KIND_EMPTY_CHUNK)
            return
        thinking_text = str(message.get("thinking") or "")
        content_text = str(message.get("content") or "")
        tool_calls = message.get("tool_calls") or []
        emitted_anything = False

        if thinking_text:
            self._counts[NORMALIZED_KIND_REASONING_DELTA] += 1
            emitted_anything = True
            yield self._build(NORMALIZED_KIND_REASONING_DELTA, text=thinking_text)

        if content_text:
            self._counts[NORMALIZED_KIND_VISIBLE_TEXT_DELTA] += 1
            emitted_anything = True
            yield self._build(NORMALIZED_KIND_VISIBLE_TEXT_DELTA, text=content_text)

        if isinstance(tool_calls, list) and tool_calls:
            rejection_reason = self._ollama_tool_batch_rejection_reason(tool_calls)
            if rejection_reason is not None:
                emitted_anything = True
                yield from self._reject_tool_input(reason=rejection_reason)
            else:
                for tool_call in tool_calls:
                    if not isinstance(tool_call, Mapping):
                        continue
                    emitted_anything = True
                    yield from self._classify_ollama_tool_call(tool_call)

        if not emitted_anything:
            self._counts[NORMALIZED_KIND_EMPTY_CHUNK] += 1
            yield self._build(NORMALIZED_KIND_EMPTY_CHUNK)

    def _ollama_tool_batch_rejection_reason(
        self,
        tool_calls: list[Any],
    ) -> str | None:
        batch_call_count = 0
        batch_argument_bytes = 0
        for tool_call in tool_calls:
            if not isinstance(tool_call, Mapping):
                continue
            function = tool_call.get("function") or {}
            if not isinstance(function, Mapping):
                continue
            batch_call_count += 1
            if self._tool_call_count + batch_call_count > MAX_PROVIDER_TOOL_CALLS:
                return "tool_call_count"
            raw_arguments = function.get("arguments")
            if isinstance(raw_arguments, str):
                argument_bytes = len(raw_arguments.encode("utf-8"))
            elif isinstance(raw_arguments, Mapping):
                argument_bytes = len(serialized_tool_arguments(raw_arguments))
            else:
                argument_bytes = 0
            if argument_bytes > MAX_TOOL_CALL_ARGUMENT_BYTES:
                return "argument_bytes"
            batch_argument_bytes += argument_bytes
            if (
                self._aggregate_argument_bytes + batch_argument_bytes
                > MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES
            ):
                return "argument_bytes"
        return None

    def _classify_ollama_tool_call(
        self, tool_call: Mapping[str, Any]
    ) -> Iterator[NormalizedStreamEvent]:
        """Classify a single Ollama tool_call entry.

        Ollama ships fully-formed tool_calls in a terminal chunk; arguments
        are typically already a dict. The string-arguments branch handles
        the rare case where the provider serialised them.
        """
        function = tool_call.get("function") or {}
        if not isinstance(function, Mapping):
            return
        tool_name = str(function.get("name") or "") or None
        if self._tool_input_rejected:
            return
        call_id = self._allocate_tool_call_id(tool_call.get("id"))
        if call_id is None:
            yield from self._reject_tool_input(reason="tool_call_count")
            return
        raw_arguments = function.get("arguments")
        if isinstance(raw_arguments, str):
            argument_bytes = len(raw_arguments.encode("utf-8"))
        elif isinstance(raw_arguments, Mapping):
            argument_bytes = len(serialized_tool_arguments(raw_arguments))
        else:
            argument_bytes = 0
        if not self._arguments_fit(call_bytes=0, added_bytes=argument_bytes):
            yield from self._reject_tool_input(reason="argument_bytes")
            return
        self._aggregate_argument_bytes += argument_bytes
        arguments_dict, malformed_raw = _coerce_tool_arguments(raw_arguments)
        if malformed_raw is not None:
            self._counts[NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS] += 1
            yield self._build(
                NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS,
                tool_call_id=call_id,
                tool_name=tool_name,
                arguments_delta=malformed_raw,
            )
            return
        self._counts[NORMALIZED_KIND_TOOL_CALL_COMPLETED] += 1
        yield self._build(
            NORMALIZED_KIND_TOOL_CALL_COMPLETED,
            tool_call_id=call_id,
            tool_name=tool_name,
            arguments_delta=arguments_dict,
        )

    # --------------------------------------------------------------- vllm path

    def _process_vllm_chunk(
        self, raw_chunk: Mapping[str, Any]
    ) -> Iterator[NormalizedStreamEvent]:
        """Classify a vLLM SSE chunk (already JSON-parsed).

        vLLM's chat-completions SSE payload looks like::

            {"choices": [{"delta": {"content": "...",
                                    "reasoning_content": "...",
                                    "tool_calls": [...]},
                          "finish_reason": "stop"|"tool_calls"|null}]}
        """
        if str(raw_chunk.get("object") or "") == FINISH_REASON_PROVIDER_ERROR:
            error_body = raw_chunk.get("error") or raw_chunk.get("message") or ""
            yield from self._classify_inband_error(str(error_body))
            return
        choices = raw_chunk.get("choices")
        if not isinstance(choices, list) or not choices:
            self._counts[NORMALIZED_KIND_EMPTY_CHUNK] += 1
            yield self._build(NORMALIZED_KIND_EMPTY_CHUNK)
            return
        first = choices[0]
        delta = first.get("delta") if isinstance(first, Mapping) else None
        finish_reason = (
            str(first.get("finish_reason") or "")
            if isinstance(first, Mapping)
            else ""
        )
        if finish_reason:
            self._terminal_finish_reason = finish_reason
        if not isinstance(delta, Mapping):
            yield from self._vllm_chunk_without_delta(finish_reason)
            return

        reasoning_content = extract_reasoning_delta(delta)
        content = delta.get("content")
        tool_calls = delta.get("tool_calls")
        emitted_anything = False

        if reasoning_content:
            self._counts[NORMALIZED_KIND_REASONING_DELTA] += 1
            emitted_anything = True
            yield self._build(NORMALIZED_KIND_REASONING_DELTA, text=reasoning_content)

        if isinstance(content, str) and content:
            self._counts[NORMALIZED_KIND_VISIBLE_TEXT_DELTA] += 1
            emitted_anything = True
            yield self._build(NORMALIZED_KIND_VISIBLE_TEXT_DELTA, text=content)

        if isinstance(tool_calls, list) and tool_calls:
            for tool_call in tool_calls:
                if not isinstance(tool_call, Mapping):
                    continue
                emitted_anything = True
                yield from self._accumulate_vllm_tool_call(tool_call)

        if finish_reason:
            yield from self._finalize_pending_tool_calls()

        if not emitted_anything and not finish_reason:
            self._counts[NORMALIZED_KIND_EMPTY_CHUNK] += 1
            yield self._build(NORMALIZED_KIND_EMPTY_CHUNK)

    def _vllm_chunk_without_delta(
        self, finish_reason: str
    ) -> Iterator[NormalizedStreamEvent]:
        """Handle a vLLM choice that carries no incremental ``delta``.

        Still flushes pending tool accumulators when ``finish_reason`` is
        present so well-formed streams emit ``tool_call_completed`` before the
        engine sees ``done``.
        """
        if finish_reason:
            yield from self._finalize_pending_tool_calls()
            return
        self._counts[NORMALIZED_KIND_EMPTY_CHUNK] += 1
        yield self._build(NORMALIZED_KIND_EMPTY_CHUNK)

    def _accumulate_vllm_tool_call(
        self, tool_call: Mapping[str, Any]
    ) -> Iterator[NormalizedStreamEvent]:
        """Append vLLM's argument-delta fragment to the per-call accumulator.

        vLLM SSE may ship arguments in fragments across multiple deltas;
        ``index`` correlates fragments to the same call. We use the
        provider's ``id`` when present, falling back to a synthetic id
        derived from the index. Each fragment yields a ``tool_call_delta``
        for routing-layer observability; the parsed ``tool_call_completed``
        is deferred to ``finish_reason`` or ``finalize()``.
        """
        if self._tool_input_rejected:
            return
        provider_id = tool_call.get("id")
        index = tool_call.get("index")
        index_int: int | None = index if isinstance(index, int) else None
        # Reuse the call_id registered for this index by an earlier fragment so
        # accumulation stays in one accumulator even when later fragments omit
        # ``id``.
        call_id = self._allocate_tool_call_id(provider_id, index=index_int)
        if call_id is None:
            yield from self._reject_tool_input(reason="tool_call_count")
            return
        function = tool_call.get("function") or {}
        if not isinstance(function, Mapping):
            function = {}
        tool_name_value = function.get("name")
        arguments_value = function.get("arguments")

        state = self._tool_calls.get(call_id)
        if state is None:
            state = _ToolCallState(call_id=call_id)
            self._tool_calls[call_id] = state
        if state.finalized:
            return
        if isinstance(tool_name_value, str) and tool_name_value:
            state.tool_name = tool_name_value
        fragment = ""
        if isinstance(arguments_value, str):
            fragment = arguments_value
        elif isinstance(arguments_value, Mapping):
            # Provider already sent a parsed dict — finalize immediately.
            argument_bytes = len(serialized_tool_arguments(arguments_value))
            if not self._arguments_fit(
                call_bytes=state.argument_bytes,
                added_bytes=argument_bytes,
            ):
                yield from self._reject_tool_input(reason="argument_bytes")
                return
            self._aggregate_argument_bytes += argument_bytes
            state.argument_fragments.clear()
            self._counts[NORMALIZED_KIND_TOOL_CALL_COMPLETED] += 1
            state.finalized = True
            tool_name_str = state.tool_name or (
                str(tool_name_value) if isinstance(tool_name_value, str) else ""
            )
            yield self._build(
                NORMALIZED_KIND_TOOL_CALL_COMPLETED,
                tool_call_id=call_id,
                tool_name=tool_name_str or None,
                arguments_delta=dict(arguments_value),
            )
            return
        if fragment:
            fragment_bytes = len(fragment.encode("utf-8"))
            if not self._arguments_fit(
                call_bytes=state.argument_bytes,
                added_bytes=fragment_bytes,
            ):
                yield from self._reject_tool_input(reason="argument_bytes")
                return
            state.argument_fragments.append(fragment)
            state.argument_bytes += fragment_bytes
            self._aggregate_argument_bytes += fragment_bytes
            self._counts[NORMALIZED_KIND_TOOL_CALL_DELTA] += 1
            yield self._build(
                NORMALIZED_KIND_TOOL_CALL_DELTA,
                tool_call_id=call_id,
                tool_name=state.tool_name,
                arguments_delta=fragment,
            )

    def _finalize_pending_tool_calls(self) -> Iterator[NormalizedStreamEvent]:
        """Attempt to parse every still-open tool_call accumulator.

        Called when the provider signals ``finish_reason`` mid-stream or
        when :py:meth:`finalize` runs. Each accumulator that parses to a
        dict yields ``tool_call_completed``; each that fails yields
        ``malformed_tool_arguments``.
        """
        for state in list(self._tool_calls.values()):
            if state.finalized:
                continue
            yield from self._complete_or_mark_malformed(state)

    def _complete_or_mark_malformed(
        self, state: _ToolCallState
    ) -> Iterator[NormalizedStreamEvent]:
        """Resolve one tool-call accumulator into completed/malformed.

        Marks the state ``finalized`` regardless of outcome so the same
        accumulator never re-emits.
        """
        state.finalized = True
        buffer = "".join(state.argument_fragments)
        state.argument_fragments.clear()
        if not buffer:
            # No fragments accumulated — treat as ``{}``.
            self._counts[NORMALIZED_KIND_TOOL_CALL_COMPLETED] += 1
            yield self._build(
                NORMALIZED_KIND_TOOL_CALL_COMPLETED,
                tool_call_id=state.call_id,
                tool_name=state.tool_name,
                arguments_delta={},
            )
            return
        parsed_dict, malformed_raw = _coerce_tool_arguments(buffer)
        if malformed_raw is not None:
            self._counts[NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS] += 1
            yield self._build(
                NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS,
                tool_call_id=state.call_id,
                tool_name=state.tool_name,
                arguments_delta=malformed_raw,
            )
            return
        self._counts[NORMALIZED_KIND_TOOL_CALL_COMPLETED] += 1
        yield self._build(
            NORMALIZED_KIND_TOOL_CALL_COMPLETED,
            tool_call_id=state.call_id,
            tool_name=state.tool_name,
            arguments_delta=parsed_dict,
        )


# ---------------------------------------------------------------------------
# Re-exports (consumers prefer importing from this module)
# ---------------------------------------------------------------------------

__all__ = [
    "FINISH_REASON_INCOMPLETE",
    "FINISH_REASON_PROVIDER_ERROR",
    "FINISH_REASON_REASONING_ONLY",
    "FINISH_REASON_THINKING_BUDGET",
    "NormalizedStreamEvent",
    "NORMALIZED_KIND_DONE",
    "NORMALIZED_KIND_EMPTY_CHUNK",
    "NORMALIZED_KIND_FAILED",
    "NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS",
    "NORMALIZED_KIND_REASONING_DELTA",
    "NORMALIZED_KIND_TOOL_CALL_COMPLETED",
    "NORMALIZED_KIND_TOOL_CALL_DELTA",
    "NORMALIZED_KIND_VISIBLE_TEXT_DELTA",
    "NORMALIZED_SOURCE_PROVIDER_STREAM",
    "ProviderStreamNormalizer",
    "StreamCounters",
    "record_counters_to_diagnostics",
]
