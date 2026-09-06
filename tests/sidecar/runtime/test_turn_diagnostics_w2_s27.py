from __future__ import annotations

from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore


def _snapshot_for_visible_chunks(chunks: list[str]) -> dict[str, object]:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="visible", session_id=None, mode="chat")
    for chunk in chunks:
        store.record_visible_output(request_id="visible", text=chunk)
    snapshot = store.snapshot()
    assert snapshot is not None
    return snapshot


def _snapshot_for_buffered_chunks(chunks: list[str]) -> dict[str, object]:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="buffered", session_id=None, mode="chat")
    for chunk in chunks:
        store.record_buffered_visible_output(
            request_id="buffered",
            text=chunk,
            reason="tool_calls",
        )
    snapshot = store.snapshot()
    assert snapshot is not None
    return snapshot


def test_visible_token_estimate_is_chunk_invariant() -> None:
    single = _snapshot_for_visible_chunks(["hello"])
    streamed = _snapshot_for_visible_chunks(list("hello"))

    assert streamed["visible_output_tokens_estimate"] == single[
        "visible_output_tokens_estimate"
    ]


def test_buffered_token_estimate_is_chunk_invariant() -> None:
    single = _snapshot_for_buffered_chunks(["hello"])
    streamed = _snapshot_for_buffered_chunks(list("hello"))

    assert streamed["buffered_visible_output_tokens_estimate"] == single[
        "buffered_visible_output_tokens_estimate"
    ]
