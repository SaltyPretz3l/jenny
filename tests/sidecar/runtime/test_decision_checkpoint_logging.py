"""Session review 2026-11-17 (L1): ``decision_snapshot_unavailable`` names its reason.

The warning fired 18 times in one session with only an exception type. A designed
fallback (one of the module's fixed ``decision_*`` codes) is logged at INFO with its
code; anything unexpected stays a WARNING, by type and error code only.
"""

from __future__ import annotations

import logging

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.decision_checkpoint import log_snapshot_unavailable

LOGGER = "sidecar.runtime.decision_checkpoint"


def _records(caplog):
    return [r for r in caplog.records if r.name == LOGGER and r.getMessage() == "decision_snapshot_unavailable"]


def test_a_designed_fallback_is_info_with_its_code(caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    log_snapshot_unavailable(ValueError("decision_quota_state_unavailable"))
    [record] = _records(caplog)
    assert record.levelno == logging.INFO
    assert record.reason == "decision_quota_state_unavailable"
    assert record.designed is True


def test_an_unexpected_error_stays_a_warning_without_its_message(caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    log_snapshot_unavailable(TypeError("secret C:/Users/someone/file.txt"))
    [record] = _records(caplog)
    assert record.levelno == logging.WARNING
    assert record.reason == "TypeError"
    assert record.designed is False
    assert "someone" not in str(record.__dict__)


def test_a_free_text_value_error_is_not_mistaken_for_a_designed_code(caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    log_snapshot_unavailable(ValueError("bad value: decision_x"))
    [record] = _records(caplog)
    assert record.levelno == logging.WARNING
    assert record.reason == "ValueError"


def test_a_tool_failure_carries_its_error_code(caplog):
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    log_snapshot_unavailable(ToolExecutionFailure(code="CMP-TOOL-0008", message="x", retryable=False))
    [record] = _records(caplog)
    assert record.levelno == logging.WARNING
    assert record.code == "CMP-TOOL-0008"
