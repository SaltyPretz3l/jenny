"""Red-first contract for the widened TOOL_FAILURE_ERROR_DETAIL_KEYS (W0).

The whitelist is the only channel a handler has for carrying structured
failure fields (failure class, effects, phase, trace identity) into
``failure_metadata`` and, from W1 on, into the model-facing envelope.
``to_error_data`` stringifies every value, so timings travel as
pre-serialized JSON text under ``phase_timings_json``.
"""

from __future__ import annotations

import json

from sidecar.ai.error_codes import CMP_TOOL_PYTHON_EXECUTION_FAILED
from sidecar.ai.tools.contracts import TOOL_FAILURE_ERROR_DETAIL_KEYS, ToolExecutionFailure

WIDENED_KEYS = (
    "failure_class",
    "effects",
    "precondition_id",
    "remediation",
    "failed_phase",
    "phase_timings_json",
    "trace_id",
    "idempotency_key",
)


def test_widened_keys_are_whitelisted() -> None:
    missing = [key for key in WIDENED_KEYS if key not in TOOL_FAILURE_ERROR_DETAIL_KEYS]
    assert not missing, f"whitelist is missing: {missing}"


def test_existing_keys_survive_the_widening() -> None:
    for key in ("category", "operation_id", "generation_id", "offending_hunk"):
        assert key in TOOL_FAILURE_ERROR_DETAIL_KEYS


def test_widened_keys_round_trip_through_to_error_data() -> None:
    timings = json.dumps({"bootstrap": {"elapsed_ms": 242113.0}})
    failure = ToolExecutionFailure(
        code=CMP_TOOL_PYTHON_EXECUTION_FAILED,
        message="install step exceeded 120s",
        retryable=False,
        error_details={
            "failure_class": "unavailable",
            "effects": "none",
            "precondition_id": "",
            "remediation": "Use run_command with a system python.",
            "failed_phase": "bootstrap",
            "phase_timings_json": timings,
            "trace_id": "t_4b19c8.call_9f2a",
            "idempotency_key": "idem_0123456789abcdef01234567",
        },
    )
    data = failure.to_error_data()
    assert data["failure_class"] == "unavailable"
    assert data["effects"] == "none"
    assert data["remediation"] == "Use run_command with a system python."
    assert data["failed_phase"] == "bootstrap"
    assert data["trace_id"] == "t_4b19c8.call_9f2a"
    assert data["idempotency_key"] == "idem_0123456789abcdef01234567"
    # Empty values stay omitted (existing to_error_data contract).
    assert "precondition_id" not in data
    # Pre-serialized JSON text survives the stringify round-trip intact.
    assert json.loads(data["phase_timings_json"]) == {"bootstrap": {"elapsed_ms": 242113.0}}
