"""Bounded UI-only projection of one child's loop events.

Snapshots replace prior snapshots; they never enter the parent model context.
The delegate coordinator owns transport and flushes before terminal settlement.
A frame carries the transcript only when it changed since the previous frame.
"""

from __future__ import annotations

import math
import threading
import time
from types import SimpleNamespace
from typing import Any, Callable

from sidecar.ai.routing import loop_events as events
from sidecar.ai.routing.delegate_child_steps import (
    MAX_CHILD_ANSWER_CHARS,
    MAX_CHILD_STEPS,
    _step_text,
    build_child_steps,
)
from sidecar.ai.routing.subagent_telemetry import usage_from_decision
from sidecar.ai.tools.catalog import tool_display_name
from sidecar.protocol import CHAT_THINKING_KIND_REASONING

_UPDATE_INTERVAL_SECONDS = 0.25

class SubagentLiveActivity:
    """Thread-safe bounded accumulator; no timers or background producers."""

    def __init__(self, publish: Callable[[dict[str, Any]], None], *, clock: Any = time.monotonic):
        self._publish = publish
        self._clock = clock
        self._lock = threading.RLock()
        self._last_sent = float('-inf')
        self._sequence = 0
        self._closed = False
        self._steps: dict[str, dict[str, Any]] = {}
        self._step_count = 0
        self._result_count = 0
        self._current = ''
        self._commentary = ''
        self._text_truncated = False
        self._commentary_truncated = False
        self._current_chars = 0
        self._estimate_pending = False
        self._usage: dict[str, Any] | None = None
        self._usage_incomplete = False
        self._summary = 'Starting research'
        # Loads with the first child run, not at sidecar startup.
        from sidecar.ai.routing.subagent_transcript import ChildTranscript

        self._transcript = ChildTranscript(clock=clock)
        self._published_version = 0

    def __call__(self, event: events.LoopEvent) -> None:
        with self._lock:
            if self._closed:
                return
            immediate = True
            if isinstance(event, events.ToolExecutingEvent):
                self._tool_started(event)
                self._transcript.tool_started(event.call_id, event.tool_name, event.arguments)
            elif isinstance(event, events.ToolResultEvent):
                self._tool_finished(event)
                self._transcript.tool_finished(
                    event.call_id, tool_name=event.tool_name, success=event.success,
                    content=event.content, tool_input=event.tool_input,
                    error_code=event.error_code, duration_ms=event.duration_ms,
                )
            elif isinstance(event, events.TokenDeltaEvent):
                self._transcript.text_delta(event.delta)
                self._current_chars += len(event.delta)
                self._estimate_pending = True
                remaining = MAX_CHILD_ANSWER_CHARS - len(self._commentary) - len(self._current)
                self._current += event.delta[:max(0, remaining)]
                self._text_truncated |= len(event.delta) > max(0, remaining)
                self._summary = 'Responding'
                immediate = False
            elif isinstance(event, events.StreamResetEvent):
                self._transcript.reset(keep_text=event.reason == 'tool_continuation')
                if event.reason == 'tool_continuation':
                    text = self._commentary + self._current + '\n\n'
                    self._commentary = text[:MAX_CHILD_ANSWER_CHARS]
                    self._commentary_truncated = self._text_truncated
                self._current = ''
                self._text_truncated = self._commentary_truncated
                self._current_chars = 0
                self._estimate_pending = False
            elif isinstance(event, events.GenerationUsageEvent):
                self._usage = usage_from_decision(SimpleNamespace(usage=event.usage))
                self._usage_incomplete |= not event.output_reported
                if self._usage is not None and self._usage_incomplete:
                    self._usage['partial'] = True
                # No provider accounting means the visible estimate stays a
                # separate estimate; it must never masquerade as reported usage.
                if self._usage is not None and event.output_reported:
                    self._estimate_pending = False
            elif isinstance(event, events.IterationStartEvent):
                self._summary = 'Working on it'
            elif not self._thought_opened(event):
                # Status thinking, raw output and other events stay private.
                return
            self._flush(immediate)

    def _thought_opened(self, event: events.LoopEvent) -> bool:
        # Reasoning feeds only the transcript. Its text lands when the thought
        # closes, so only opening a thought sends a frame.
        if not isinstance(event, events.ThinkingEvent):
            return False
        if event.kind != CHAT_THINKING_KIND_REASONING:
            return False
        version = self._transcript.version
        self._transcript.reasoning(event.thinking_id, event.delta)
        return self._transcript.version != version

    def _tool_started(self, event: events.ToolExecutingEvent) -> None:
        self._summary = _step_text(tool_display_name(event.tool_name), 64)
        if event.call_id not in self._steps:
            self._step_count += 1
            if len(self._steps) < MAX_CHILD_STEPS:
                self._steps[event.call_id] = {
                    'tool': _step_text(event.tool_name, 64),
                    'display': self._summary, 'status': 'running',
                }

    def _tool_finished(self, event: events.ToolResultEvent) -> None:
        self._result_count += 1
        outcome = SimpleNamespace(
            tool_name=event.tool_name, success=event.success,
            tool_input=event.tool_input, output=event.content,
            error_code=event.error_code, metadata=event.metadata,
        )
        steps = build_child_steps(SimpleNamespace(tool_results=(outcome,)))
        if event.call_id not in self._steps and len(self._steps) < MAX_CHILD_STEPS:
            self._step_count += 1
        if steps and (event.call_id in self._steps or len(self._steps) < MAX_CHILD_STEPS):
            self._steps[event.call_id] = {
                **steps[0], 'status': 'completed' if event.success else 'failed',
            }
        self._summary = 'Reading results' if event.success else 'Tool failed'

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot(transcript=True)

    def _snapshot(self, *, transcript: bool) -> dict[str, Any]:
        snapshot: dict[str, Any] = {
            'sequence': self._sequence,
            'steps': [dict(step) for step in self._steps.values()],
            'step_count': self._step_count,
            'result_count': self._result_count,
            'text': _step_text(self._commentary + self._current, MAX_CHILD_ANSWER_CHARS),
            'text_truncated': self._text_truncated,
            'visible_output_tokens_estimate': (
                min(2_147_483_647, math.ceil(self._current_chars / 4))
                if self._estimate_pending else None
            ),
            'usage': dict(self._usage) if self._usage else None,
            'summary': self._summary,
        }
        if transcript:
            snapshot['transcript'] = self._transcript.entries()
            snapshot['transcript_version'] = self._transcript.version
            if self._transcript.dropped:
                snapshot['transcript_dropped'] = self._transcript.dropped
        return snapshot

    def finish(self) -> dict[str, Any]:
        with self._lock:
            if not self._closed:
                if self._usage is not None and self._estimate_pending:
                    self._usage['partial'] = True
                for step in self._steps.values():
                    if step['status'] == 'running':
                        step['status'] = 'interrupted'
                self._transcript.finish()
                self._flush(True)
                self._closed = True
            return self.snapshot()

    def _flush(self, immediate: bool) -> None:
        now = self._clock()
        if not immediate and now - self._last_sent < _UPDATE_INTERVAL_SECONDS:
            return
        self._sequence += 1
        self._last_sent = now
        version = self._transcript.version
        changed, self._published_version = version != self._published_version, version
        # A closed/broken UI must not change a child's execution outcome.
        try:
            self._publish(self._snapshot(transcript=changed))
        except Exception:  # noqa: BLE001 - advisory, same boundary as agent.progress.
            pass
