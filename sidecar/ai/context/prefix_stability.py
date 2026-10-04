"""Client-side prefix-stability meter for local prompt caches.

llama-server and Ollama reuse only the longest byte-identical prefix of the
previous request. This module records, per cache source key, the ordered
layout of the last model request (tool schemas, system-prompt sections,
message rows) as hashes and character counts, and reports where the next
request first diverges from it. It never stores content and never changes a
request; the router pairs its verdict with the server's reused-token count.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from sidecar.ai.config import read_environment_value
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt

_MAX_SOURCES = 16
# A request longer than this folds its remaining rows into one tail segment,
# so the retained layout stays bounded however long a chat grows.
_MAX_SEGMENTS = 2048
_MAX_CHANGED_LABELS = 8

DIVERGENCE_FIRST = "first"
DIVERGENCE_IDENTICAL = "identical"
DIVERGENCE_APPEND = "append"
DIVERGENCE_BREAK = "break"


def prefix_meter_enabled() -> bool:
    """Default-on kill switch for the diagnostic-only prefix meter."""
    return read_environment_value("JENNY_ENABLE_PREFIX_METER", "1") != "0"


@dataclass(frozen=True)
class Segment:
    label: str
    digest: str
    chars: int


@dataclass(frozen=True)
class PrefixObservation:
    """Where this request's layout first differs from the previous one."""

    divergence: str
    segment_count: int
    common_segments: int
    reusable_chars: int
    total_chars: int
    first_changed: str
    changed_system_sections: tuple[str, ...]
    tools_changed: bool

    @property
    def predicted_reuse_ratio(self) -> float:
        if self.total_chars <= 0:
            return 0.0
        return round(self.reusable_chars / self.total_chars, 4)

    def to_dict(self) -> dict[str, Any]:
        return {
            "divergence": self.divergence,
            "segment_count": self.segment_count,
            "common_segments": self.common_segments,
            "reusable_chars": self.reusable_chars,
            "total_chars": self.total_chars,
            "predicted_reuse_ratio": self.predicted_reuse_ratio,
            "first_changed": self.first_changed,
            "changed_system_sections": list(self.changed_system_sections),
            "tools_changed": self.tools_changed,
        }


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:24]


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def _message_segment(index: int, message: Mapping[str, Any]) -> Segment:
    role = str(message.get("role") or "").strip().lower() or "unknown"
    # Images are opaque objects; their count is the only stable projection.
    projected = {key: value for key, value in message.items() if key != "images"}
    images = message.get("images")
    if isinstance(images, list) and images:
        projected["images"] = len(images)
    text = _canonical(projected)
    content = message.get("content")
    chars = len(content) if isinstance(content, str) else len(text)
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        chars += len(_canonical(tool_calls))
    return Segment(label=f"msg[{index}]:{role}", digest=_digest(text), chars=chars)


def _system_segments(system_prompt: Any) -> list[Segment]:
    if isinstance(system_prompt, StructuredSystemPrompt):
        return [
            Segment(
                label=f"system:{section.name}",
                digest=_digest(section.content),
                chars=len(section.content),
            )
            for section in system_prompt.sections
            if section.content
        ]
    text = str(system_prompt or "")
    return [Segment(label="system", digest=_digest(text), chars=len(text))] if text else []


def request_layout(
    *,
    system_prompt: Any,
    tool_schemas: Sequence[Mapping[str, Any]] | None,
    messages: Sequence[Mapping[str, Any]],
) -> tuple[Segment, ...]:
    """Return the ordered segment layout of one model request.

    Tools lead because the common local chat templates (Qwen, Hermes) render
    the tool block inside the first system turn, so a tool-list change breaks
    the cache from the top whichever way a template orders the two.
    """
    segments: list[Segment] = []
    schemas = [dict(schema) for schema in (tool_schemas or []) if isinstance(schema, Mapping)]
    if schemas:
        text = _canonical(schemas)
        segments.append(Segment(label="tools", digest=_digest(text), chars=len(text)))
    segments.extend(_system_segments(system_prompt))
    for index, message in enumerate(messages):
        if isinstance(message, Mapping):
            segments.append(_message_segment(index, message))
    if len(segments) > _MAX_SEGMENTS:
        head = segments[: _MAX_SEGMENTS - 1]
        tail = segments[_MAX_SEGMENTS - 1 :]
        segments = [
            *head,
            Segment(
                label="msg[tail]",
                digest=_digest("".join(segment.digest for segment in tail)),
                chars=sum(segment.chars for segment in tail),
            ),
        ]
    return tuple(segments)


def compare_layouts(
    previous: Sequence[Segment] | None,
    current: Sequence[Segment],
) -> PrefixObservation:
    total_chars = sum(segment.chars for segment in current)
    if previous is None:
        return PrefixObservation(
            divergence=DIVERGENCE_FIRST,
            segment_count=len(current),
            common_segments=0,
            reusable_chars=0,
            total_chars=total_chars,
            first_changed="",
            changed_system_sections=(),
            tools_changed=False,
        )
    common = 0
    for before, after in zip(previous, current, strict=False):
        if before.label != after.label or before.digest != after.digest:
            break
        common += 1
    if common == len(previous) == len(current):
        divergence = DIVERGENCE_IDENTICAL
    elif common == len(previous):
        divergence = DIVERGENCE_APPEND
    else:
        divergence = DIVERGENCE_BREAK
    first_changed = current[common].label if common < len(current) else ""
    if divergence == DIVERGENCE_BREAK and common >= len(current):
        first_changed = "truncated"
    previous_by_occurrence = _digests_by_occurrence(previous)
    changed_sections = tuple(
        dict.fromkeys(
            label.removeprefix("system:")
            for (label, nth), digest in _digests_by_occurrence(current).items()
            if label.startswith("system") and previous_by_occurrence.get((label, nth)) != digest
        )
    )[:_MAX_CHANGED_LABELS]
    return PrefixObservation(
        divergence=divergence,
        segment_count=len(current),
        common_segments=common,
        reusable_chars=sum(segment.chars for segment in current[:common]),
        total_chars=total_chars,
        first_changed=first_changed if divergence == DIVERGENCE_BREAK else "",
        changed_system_sections=changed_sections,
        tools_changed=_label_digest(previous, "tools") != _label_digest(current, "tools"),
    )


def _digests_by_occurrence(segments: Sequence[Segment]) -> dict[tuple[str, int], str]:
    """Key each segment by label and occurrence; the builder repeats section names."""
    seen: dict[str, int] = {}
    keyed: dict[tuple[str, int], str] = {}
    for segment in segments:
        nth = seen.get(segment.label, 0)
        seen[segment.label] = nth + 1
        keyed[(segment.label, nth)] = segment.digest
    return keyed


def _label_digest(segments: Sequence[Segment], label: str) -> str | None:
    for segment in segments:
        if segment.label == label:
            return segment.digest
    return None


class PrefixStabilityMeter:
    """Bounded per-source memory of the last request layout (hashes only)."""

    def __init__(self, max_sources: int = _MAX_SOURCES) -> None:
        self._max_sources = max(1, int(max_sources))
        self._layouts: OrderedDict[str, tuple[Segment, ...]] = OrderedDict()
        self._lock = threading.Lock()

    def observe(
        self,
        source_key: str,
        *,
        system_prompt: Any,
        tool_schemas: Sequence[Mapping[str, Any]] | None,
        messages: Sequence[Mapping[str, Any]],
    ) -> PrefixObservation | None:
        key = str(source_key or "").strip()
        if not key:
            return None
        layout = request_layout(
            system_prompt=system_prompt,
            tool_schemas=tool_schemas,
            messages=messages,
        )
        with self._lock:
            previous = self._layouts.pop(key, None)
            self._layouts[key] = layout
            while len(self._layouts) > self._max_sources:
                self._layouts.popitem(last=False)
        return compare_layouts(previous, layout)

    def forget(self, source_key: str) -> None:
        with self._lock:
            self._layouts.pop(str(source_key or "").strip(), None)


# One meter per process: the routed tool loop and the live chat stream serve the
# same session from the same engine slot, so they compare against one layout.
_SHARED_METER = PrefixStabilityMeter()


def shared_prefix_meter() -> PrefixStabilityMeter:
    return _SHARED_METER
