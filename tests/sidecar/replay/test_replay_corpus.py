"""Parametrized replay-fixture corpus runner.

For every JSON file under ``tests/fixtures/replays/`` this module exercises:

* **Engine-level**: ``ReplayEngine.stream_with_tools`` yields the events declared
  in ``expected_engine_events`` and returns the declared ``GenerationResult``.
* **Routing-level**: ``sidecar.ai.routing.generation_runtime.stream_generate_with_tools``
  emits the loop events declared in ``expected_loop_events`` when driven by the
  ``ReplayEngine``. Fixtures carrying an ``approval_resolution`` field are
  driven through ``sidecar.runtime.chat_helpers.emit_approval_rejection``
  instead, exercising the production approval-denied emit.
* **Protocol-level**: The captured loop events translate to the notification
  dicts declared in ``expected_notifications`` (subset comparison).

Phase 9 (2026-05-03): fixture #13 transitioned from xfail/skip to pass once
the approval-rejection emit (see
``sidecar.runtime.chat_helpers.emit_approval_rejection``) landed. The
``tool.executing`` emit is now owned by the post-approval dispatch layer rather
than this direct ``stream_generate_with_tools`` replay harness.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pytest

from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
from sidecar.ai.routing.loop_events import (
    LoopEvent,
    StopEvent,
    ThinkingEvent,
    TokenDeltaEvent,
    ToolExecutingEvent,
)
from sidecar.protocol import (
    CHAT_ERROR_METHOD,
    CHAT_THINKING_METHOD,
    CHAT_TOKEN_METHOD,
    TOOL_EXECUTING_METHOD,
)
from sidecar.runtime.chat_helpers import emit_approval_rejection
from tests.sidecar.replay.assertions import (
    assert_engine_events_match,
    assert_generation_result_matches,
    assert_loop_events_match,
    assert_notifications_match,
)
from tests.sidecar.replay.conftest import RecordingLoopRuntime
from tests.sidecar.replay.fixture_format import (
    Fixture,
    FixtureValidationError,
    discover_fixtures,
    load_fixture,
)
from tests.sidecar.replay.replay_engine import ReplayEngine, make_kernel


def _engine_marker(fixture: Fixture) -> list[Any]:
    """Engine-level marker policy: skip Phase 5+, otherwise unmarked.

    Engine-level assertions HERE are tautological for any well-formed fixture
    (ReplayEngine echoes the expectations by construction), so no xfail
    markers apply. The non-tautological half lives in
    ``test_replay_provider_parse.py`` (W4.6): provider fixtures with a real
    streaming tool parser replay their ``raw_chunks`` through the production
    parser and assert the same expectations.
    """
    if fixture.metadata.target_phase >= 5:
        return [
            pytest.mark.skip(
                reason=(
                    f"Phase {fixture.metadata.target_phase}: "
                    f"{fixture.metadata.description}"
                )
            )
        ]
    return []


def _phase_dependent_marker(fixture: Fixture) -> list[Any]:
    """Routing- and protocol-level marker policy.

    Fixtures targeting phases 3-5 run unconditionally. Phases 6+ are
    skipped because no production gating logic for them exists yet.
    """
    target = fixture.metadata.target_phase
    if target in (3, 4, 5):
        return []
    return [
        pytest.mark.skip(reason=f"Phase {target}: {fixture.metadata.description}")
    ]


def _build_corpus_params(marker_fn: Callable[[Fixture], list[Any]]) -> list[Any]:
    """Build a parametrize list from the discovered corpus, applying *marker_fn*.

    Each fixture is loaded once via :func:`_load_cached`; subsequent test
    invocations reuse the cached :class:`Fixture` rather than re-parsing JSON.
    """
    items: list[Any] = []
    for path in discover_fixtures():
        try:
            fixture = _load_cached(path)
        except FixtureValidationError as error:
            items.append(
                pytest.param(
                    path,
                    id=path.stem,
                    marks=pytest.mark.xfail(reason=f"fixture loader error: {error}"),
                )
            )
            continue
        items.append(pytest.param(path, id=path.stem, marks=marker_fn(fixture)))
    return items


_FIXTURE_CACHE: dict[Path, Fixture] = {}


def _load_cached(path: Path) -> Fixture:
    """Return the parsed fixture for *path*, loading it at most once per run."""
    cached = _FIXTURE_CACHE.get(path)
    if cached is not None:
        return cached
    fixture = load_fixture(path)
    _FIXTURE_CACHE[path] = fixture
    return fixture


_ENGINE_PARAMS = _build_corpus_params(_engine_marker)
_PHASE_DEPENDENT_PARAMS = _build_corpus_params(_phase_dependent_marker)


def _drive_engine(fixture: Fixture) -> tuple[list[Any], Any]:
    """Walk the ReplayEngine generator and return (yielded_events, generation_result)."""
    engine = ReplayEngine(fixture)
    stream = engine.stream_with_tools(prompt="", tools=[], max_tokens=128)
    yielded: list[Any] = []
    while True:
        try:
            yielded.append(next(stream))
        except StopIteration as stop:
            return yielded, stop.value


def _drive_routing(fixture: Fixture) -> tuple[RecordingLoopRuntime, list[dict[str, Any]]]:
    """Drive ``stream_generate_with_tools`` against a ReplayEngine; capture emitted events.

    The second return value is the list of synthesized notification dicts
    (empty for this driver — translation happens later in
    :func:`_translate_loop_event_to_notification`).
    """
    engine = ReplayEngine(fixture)
    kernel = make_kernel(engine)
    runtime = RecordingLoopRuntime(request_id="req_replay")
    stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="user request",
        prompt_messages=[{"role": "user", "content": "user request"}],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[
            {
                "type": "function",
                "function": {"name": "read_file", "parameters": {}},
            },
            {
                "type": "function",
                "function": {"name": "glob_files", "parameters": {}},
            },
        ],
    )
    return runtime, []


def _drive_approval_rejection(
    fixture: Fixture,
) -> tuple[RecordingLoopRuntime, list[dict[str, Any]]]:
    """Drive the production ``emit_approval_rejection`` helper for a fixture.

    Used for fixtures that declare ``approval_resolution: {approved: false,
    tool_name: ...}``. Captures the emitted ``StopEvent`` on
    :class:`RecordingLoopRuntime` and returns the chat.error notification
    dict that production would append to ``ProcessOutcome.notifications``
    at ``request_dispatch.py``'s approval-denied branch.
    """
    runtime = RecordingLoopRuntime(request_id="req_replay")
    resolution = fixture.approval_resolution or {}
    tool_name = str(resolution.get("tool_name") or "tool").strip() or "tool"
    chat_error = emit_approval_rejection(
        runtime=runtime,
        request_id="req_replay",
        trace_id=None,
        session_id=None,
        tool_name=tool_name,
    )
    return runtime, [chat_error]


def _select_routing_driver(
    fixture: Fixture,
) -> Callable[[Fixture], tuple[RecordingLoopRuntime, list[dict[str, Any]]]]:
    """Pick the driver whose production code path the fixture is exercising."""
    if fixture.approval_resolution is not None:
        return _drive_approval_rejection
    return _drive_routing


_REASONING_ONLY_CODE = "CMP-STREAM-REASONING-ONLY"


def _translate_loop_event_to_notification(event: LoopEvent) -> dict[str, Any] | None:
    """Translate a routing-layer loop event to its wire-format notification dict.

    Mirrors the relevant emit points in ``sidecar/runtime/chat_streaming.py``
    for the events emitted by ``stream_generate_with_tools``:

    * ``ThinkingEvent`` → ``chat.thinking``
    * ``TokenDeltaEvent`` → ``chat.token``
    * ``StopEvent(code=CMP-STREAM-REASONING-ONLY)`` → ``chat.error``
    * ``ToolExecutingEvent`` → ``tool.executing``

    ``StopEvent(code=CMP-APPROVAL-REJECTED)`` is intentionally not
    translated here — the production helper
    :func:`sidecar.runtime.chat_helpers.emit_approval_rejection` builds
    the matching ``chat.error`` notification dict directly and the
    driver appends it to ``direct_notifications``.
    Other events return ``None`` and are filtered out before comparison.
    """
    if isinstance(event, ThinkingEvent):
        return {
            "method": CHAT_THINKING_METHOD,
            "params": {
                "delta": event.delta,
                "thinking_id": event.thinking_id,
                "kind": event.kind,
                "persist": event.persist,
            },
        }
    if isinstance(event, TokenDeltaEvent):
        return {
            "method": CHAT_TOKEN_METHOD,
            "params": {
                "delta": event.delta,
                "role": "assistant",
                "sequence": event.token_index,
            },
        }
    if isinstance(event, StopEvent) and event.code == _REASONING_ONLY_CODE:
        return {
            "method": CHAT_ERROR_METHOD,
            "params": {
                "code": event.code,
                "message": event.reason,
                "retryable": False,
            },
        }
    if isinstance(event, ToolExecutingEvent):
        return {
            "method": TOOL_EXECUTING_METHOD,
            "params": {
                "call_id": event.call_id,
                "tool_name": event.tool_name,
                "arguments": dict(event.arguments),
            },
        }
    return None


@pytest.mark.parametrize("fixture_path", _ENGINE_PARAMS)
def test_replay_engine_yields_expected_events(fixture_path: Path) -> None:
    fixture = _load_cached(fixture_path)
    yielded, generation_result = _drive_engine(fixture)
    assert_engine_events_match(
        yielded,
        list(fixture.expected_engine_events),
        fixture_label=fixture.path.name,
    )
    assert_generation_result_matches(
        generation_result,
        fixture.expected_generation_result,
        fixture_label=fixture.path.name,
    )


@pytest.mark.parametrize("fixture_path", _PHASE_DEPENDENT_PARAMS)
def test_replay_routing_emits_expected_loop_events(fixture_path: Path) -> None:
    fixture = _load_cached(fixture_path)
    driver = _select_routing_driver(fixture)
    runtime, _direct_notifications = driver(fixture)
    assert_loop_events_match(
        runtime.emitted,
        list(fixture.expected_loop_events),
        fixture_label=fixture.path.name,
    )


@pytest.mark.parametrize("fixture_path", _PHASE_DEPENDENT_PARAMS)
def test_replay_protocol_notifications_match(fixture_path: Path) -> None:
    fixture = _load_cached(fixture_path)
    driver = _select_routing_driver(fixture)
    runtime, direct_notifications = driver(fixture)
    translated: list[dict[str, Any]] = [
        notification
        for notification in (
            _translate_loop_event_to_notification(event) for event in runtime.emitted
        )
        if notification is not None
    ]
    translated.extend(direct_notifications)
    assert_notifications_match(
        translated,
        list(fixture.expected_notifications),
        fixture_label=fixture.path.name,
    )
