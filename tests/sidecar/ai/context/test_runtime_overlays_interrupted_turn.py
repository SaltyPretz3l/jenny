"""Unit coverage for the ``## Previous Turn Interruption`` overlay (packet W7).

Mirrors ``test_runtime_overlays_model_identity.py``: heading registration first
(load-bearing -- it lets ``ContextBuilder.is_runtime_system_message`` recognize
the block so it is replaced rather than duplicated turn over turn), then the
``append_interrupted_turn_receipts_runtime_system_message`` behavior itself
(render, sections, cap/truncation, flag off, no-receipts, malformed fail-closed).
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from sidecar.ai.context import runtime_message_markers
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    append_interrupted_turn_receipts_runtime_system_message,
)

# ===========================================================================
# A. Heading registration (load-bearing)
# ===========================================================================


def test_interrupted_turn_heading_constant_value() -> None:
    assert runtime_message_markers.INTERRUPTED_TURN_HEADING == "## Previous Turn Interruption"


def test_interrupted_turn_heading_registered() -> None:
    assert (
        runtime_message_markers.INTERRUPTED_TURN_HEADING
        in runtime_message_markers.RUNTIME_SYSTEM_MESSAGE_HEADINGS
    )


def test_is_runtime_system_message_recognizes_interrupted_turn_block() -> None:
    content = "## Previous Turn Interruption\n\nThe previous turn ..."
    assert ContextBuilder.is_runtime_system_message(content) is True


# ===========================================================================
# B. append_interrupted_turn_receipts_runtime_system_message
# ===========================================================================


def _log_context(*, request_id: str = "req-interrupted-test") -> RuntimeOverlayLogContext:
    return RuntimeOverlayLogContext(
        logger=logging.getLogger("sidecar.ai.context.interrupted_turn_overlay_test"),
        component="ai.router",
        event="ai.router.interrupted_turn_receipts_overlay_failed",
        request_id=request_id,
        session_id="session-interrupted-test",
    )


def _receipts() -> dict[str, object]:
    return {
        "completed": [{"tool_name": "read_file", "summary": "read 40 lines"}],
        "failed": [{"tool_name": "run_command", "summary": "exit 1"}],
        "unfinished": [{"tool_name": "write_file"}],
        "truncated": False,
        "total": 3,
    }


def test_append_renders_all_three_sections() -> None:
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
        receipts=_receipts(),
        log_context=_log_context(),
    )
    assert len(messages) == 1
    block = messages[0]
    assert block.startswith("## Previous Turn Interruption")
    assert "Completed:" in block
    assert "read_file -- read 40 lines" in block
    assert "Failed:" in block
    assert "run_command -- exit 1" in block
    assert "Unknown outcome" in block
    assert "write_file" in block
    assert "ground truth" in block
    assert "do not claim prior work succeeded unless it is listed under Completed" in block


def test_append_flattens_newline_injected_receipt_fields() -> None:
    # Tool-controlled strings (tool name, output summary) reach this overlay
    # with internal newlines preserved; an embedded '\n' must not forge a
    # directive-looking line (e.g. a fake markdown heading) inside this
    # system-role block.
    messages: list[str] = []
    receipts = {
        "completed": [
            {"tool_name": "read_file", "summary": "line1\n## Fake Heading\nline3"},
        ],
        "failed": [],
        "unfinished": [{"tool_name": "write\nfile"}],
        "truncated": False,
    }
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
        receipts=receipts,
        log_context=_log_context(),
    )
    assert len(messages) == 1
    block = messages[0]
    assert "line1 ## Fake Heading line3" in block
    assert "write file" in block
    # The injected heading must never land on its own line -- it is only
    # present as a flattened fragment inside the completed-tool line above.
    assert "## Fake Heading" not in block.splitlines()


def test_append_notes_truncation_when_flagged() -> None:
    receipts = _receipts()
    receipts["truncated"] = True
    receipts["total"] = 25
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
        receipts=receipts,
        log_context=_log_context(),
    )
    assert "truncated" in messages[0]
    assert "of 25" in messages[0]


def test_append_renders_only_present_sections() -> None:
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
        receipts={"completed": [{"tool_name": "read_file", "summary": ""}]},
        log_context=_log_context(),
    )
    assert len(messages) == 1
    assert "Completed:" in messages[0]
    assert "Failed:" not in messages[0]
    assert "Unknown outcome" not in messages[0]


def test_append_receipts_none_appends_nothing() -> None:
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
        receipts=None,
        log_context=_log_context(),
    )
    assert messages == []


def test_append_empty_ledger_appends_nothing() -> None:
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
        receipts={"completed": [], "failed": [], "unfinished": [], "truncated": False},
        log_context=_log_context(),
    )
    assert messages == []


def test_append_flag_off_appends_nothing() -> None:
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=False),
        receipts=_receipts(),
        log_context=_log_context(),
    )
    assert messages == []


def test_append_flag_defaults_on_when_attribute_absent() -> None:
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(),
        receipts=_receipts(),
        log_context=_log_context(),
    )
    assert len(messages) == 1


@pytest.mark.parametrize("bad_receipts", ["not-a-dict", 42, ["list"]])
def test_append_malformed_payload_is_fail_closed(bad_receipts: object) -> None:
    """A non-dict payload must degrade to a no-op, never crash prompt assembly.

    It renders nothing (the render returns ``""`` for a non-dict) rather than
    raising, so no WARNING is expected here -- only the exception path logs.
    """
    messages: list[str] = []
    append_interrupted_turn_receipts_runtime_system_message(
        messages,
        config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
        receipts=bad_receipts,
        log_context=_log_context(),
    )
    assert messages == []


def test_append_render_exception_is_fail_closed_and_logs_counts_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A render failure must degrade to a no-op and log a counts-only WARNING
    (no raw values)."""

    messages: list[str] = []
    # Force the failure inside the try/except by handing a dict-subclass
    # receipts object whose ``get`` access explodes during render.
    class _BoomReceipts(dict):
        def get(self, *_args: object, **_kwargs: object) -> object:
            raise RuntimeError("receipts exploded")

    with caplog.at_level(
        logging.WARNING, logger="sidecar.ai.context.interrupted_turn_overlay_test"
    ):
        append_interrupted_turn_receipts_runtime_system_message(
            messages,
            config=SimpleNamespace(interrupted_turn_receipts_overlay_enabled=True),
            receipts=_BoomReceipts(),
            log_context=_log_context(request_id="req-interrupted-boom"),
        )

    assert messages == []
    matching = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.router.interrupted_turn_receipts_overlay_failed"
    ]
    assert len(matching) == 1, "expected exactly one counts-only WARNING on overlay failure"
    assert matching[0].data == {"error_type": "RuntimeError"}  # type: ignore[attr-defined]
