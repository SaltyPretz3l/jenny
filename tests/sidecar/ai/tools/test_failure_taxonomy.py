"""Red-first contract for the W0 failure taxonomy (tool-contract program).

Pins the closed 10-class failure vocabulary, the per-class retry dispositions,
the total ``FailureClass -> recovery_class`` projection consumed by the JS
``classifyAssistantError`` seam, taxonomy completeness over every constant in
``sidecar/ai/error_codes.py``, and ``classify()`` precedence rules.
"""

from __future__ import annotations

import pytest

from sidecar.ai import error_codes as error_codes_module
from sidecar.ai.error_codes import (
    CMP_AI_ENGINE_CONNECTION,
    CMP_APPROVAL_REJECTED,
    CMP_CFG_WORKSPACE_MISSING,
    CMP_LOOP_TOOL_INPUT_VALIDATION,
    CMP_LOOP_TOOL_INTERRUPTED,
    CMP_MCP_TOOL_NOT_FOUND,
    CMP_MODE_TOOL_BLOCKED,
    CMP_ROUTE_TOOL_DISABLED,
    CMP_TOOL_APPLY_PATCH_PREIMAGE_MISMATCH,
    CMP_TOOL_APPLY_PATCH_TARGET_EXISTS,
    CMP_TOOL_APPLY_PATCH_TARGET_MISSING,
    CMP_TOOL_APPROVAL_DENIED,
    CMP_TOOL_APPROVAL_WINDOW_DROPPED,
    CMP_TOOL_BACKGROUND_NOT_FOUND,
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_COERCED_ARGS_REJECTED,
    CMP_TOOL_COMMAND_ABORTED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_MERMAID_VALIDATION,
    CMP_TOOL_OUTSIDE_WORKSPACE,
    CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED,
    CMP_TOOL_POLICY_DENIED,
    CMP_TOOL_PYTHON_EXECUTION_FAILED,
    CMP_TOOL_PYTHON_NOT_AVAILABLE,
    CMP_TOOL_READ_SNAPSHOT_REQUIRED,
    CMP_TOOL_STALE_READ_SNAPSHOT,
    CMP_TOOL_UNKNOWN,
    CMP_WEB_CONTENT_TOO_LARGE,
    CMP_WEB_FETCH_FAILED,
    CMP_WEB_RATE_LIMITED,
    CMP_WEB_SSRF_BLOCKED,
)
from sidecar.ai.tools.failure_taxonomy import (
    FAILURE_CLASSES,
    RECOVERY_CLASS_PROJECTION,
    RETRY_DISPOSITIONS,
    TAXONOMY,
    classify,
)

EXPECTED_CLASSES = {
    "bad_arguments",
    "precondition_unmet",
    "not_found",
    "conflict",
    "denied",
    "cancelled",
    "unavailable",
    "limit_exceeded",
    "transient",
    "internal_error",
}

# Every recovery token the JS classifyAssistantError seam understands as a
# ``category`` (services/backend/chat-error-recovery.js). The projection must
# never emit a token outside this set.
JS_RECOGNIZED_CATEGORIES = {
    "cancelled",
    "denied",
    "process_exit",
    "timeout",
    "transport",
    "provider",
    "tool",
    "setup",
    "context",
    "loop",
}


def test_failure_classes_are_the_closed_ten() -> None:
    assert set(FAILURE_CLASSES) == EXPECTED_CLASSES
    assert len(FAILURE_CLASSES) == 10


def test_retry_dispositions_match_the_spec_table() -> None:
    assert dict(RETRY_DISPOSITIONS) == {
        "bad_arguments": "changed_args",
        "precondition_unmet": "after_fix",
        "not_found": "changed_args",
        "conflict": "after_fix",
        "denied": "never",
        "cancelled": "not_yet",
        "unavailable": "never",
        "limit_exceeded": "changed_args",
        "transient": "same_args",
        "internal_error": "never",
    }


def test_recovery_projection_is_total_and_pinned() -> None:
    assert set(RECOVERY_CLASS_PROJECTION) == EXPECTED_CLASSES
    assert set(RECOVERY_CLASS_PROJECTION.values()) <= JS_RECOGNIZED_CATEGORIES
    assert RECOVERY_CLASS_PROJECTION == {
        "bad_arguments": "tool",
        "precondition_unmet": "tool",
        "not_found": "tool",
        "conflict": "tool",
        "denied": "denied",
        "cancelled": "cancelled",
        "unavailable": "tool",
        "limit_exceeded": "tool",
        "transient": "tool",
        "internal_error": "tool",
    }


def _all_error_code_constants() -> dict[str, str]:
    return {
        name: value
        for name, value in vars(error_codes_module).items()
        if name.startswith("CMP_") and isinstance(value, str)
    }


def test_taxonomy_is_complete_over_every_error_code_constant() -> None:
    constants = _all_error_code_constants()
    assert constants, "error code introspection returned nothing"
    missing = [name for name, code in constants.items() if code not in TAXONOMY]
    assert not missing, f"taxonomy rows missing for: {missing}"


def test_taxonomy_values_stay_inside_the_closed_vocabulary() -> None:
    stray = {code: cls for code, cls in TAXONOMY.items() if cls not in EXPECTED_CLASSES}
    assert not stray


PINNED_ROWS = {
    CMP_TOOL_COERCED_ARGS_REJECTED: "bad_arguments",
    CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED: "bad_arguments",
    CMP_LOOP_TOOL_INPUT_VALIDATION: "bad_arguments",
    CMP_TOOL_INVALID_PATH: "bad_arguments",
    CMP_TOOL_MERMAID_VALIDATION: "bad_arguments",
    CMP_TOOL_APPROVAL_DENIED: "denied",
    CMP_TOOL_POLICY_DENIED: "denied",
    CMP_APPROVAL_REJECTED: "denied",
    CMP_TOOL_COMMAND_BLOCKED: "denied",
    CMP_TOOL_OUTSIDE_WORKSPACE: "denied",
    CMP_MODE_TOOL_BLOCKED: "denied",
    CMP_WEB_SSRF_BLOCKED: "denied",
    CMP_TOOL_DISABLED: "unavailable",
    CMP_ROUTE_TOOL_DISABLED: "unavailable",
    CMP_TOOL_PYTHON_NOT_AVAILABLE: "unavailable",
    CMP_CFG_WORKSPACE_MISSING: "unavailable",
    CMP_TOOL_UNKNOWN: "not_found",
    CMP_MCP_TOOL_NOT_FOUND: "not_found",
    CMP_TOOL_BACKGROUND_NOT_FOUND: "not_found",
    CMP_TOOL_APPLY_PATCH_TARGET_MISSING: "not_found",
    CMP_TOOL_STALE_READ_SNAPSHOT: "conflict",
    CMP_TOOL_APPLY_PATCH_PREIMAGE_MISMATCH: "conflict",
    CMP_TOOL_APPLY_PATCH_TARGET_EXISTS: "conflict",
    CMP_TOOL_READ_SNAPSHOT_REQUIRED: "precondition_unmet",
    CMP_TOOL_CAP_EXCEEDED: "limit_exceeded",
    CMP_WEB_CONTENT_TOO_LARGE: "limit_exceeded",
    CMP_WEB_RATE_LIMITED: "limit_exceeded",
    CMP_TOOL_COMMAND_ABORTED: "cancelled",
    CMP_LOOP_TOOL_INTERRUPTED: "cancelled",
    CMP_TOOL_APPROVAL_WINDOW_DROPPED: "cancelled",
    CMP_TOOL_IO_FAILED: "transient",
    CMP_WEB_FETCH_FAILED: "transient",
    CMP_AI_ENGINE_CONNECTION: "transient",
    CMP_TOOL_EXECUTION_FAILED: "internal_error",
    CMP_TOOL_PYTHON_EXECUTION_FAILED: "internal_error",
}


@pytest.mark.parametrize(("code", "expected"), sorted(PINNED_ROWS.items()))
def test_pinned_taxonomy_rows(code: str, expected: str) -> None:
    assert TAXONOMY[code] == expected
    assert classify(code) == expected


def test_classify_handler_override_wins_when_valid() -> None:
    # Mirrors the spec §1.3 example: python bootstrap failure carries
    # CMP-TOOL-0012 but the handler asserts `unavailable`.
    assert (
        classify(
            CMP_TOOL_PYTHON_EXECUTION_FAILED,
            error_details={"failure_class": "unavailable"},
        )
        == "unavailable"
    )


def test_classify_ignores_invalid_override() -> None:
    assert (
        classify(
            CMP_TOOL_IO_FAILED,
            error_details={"failure_class": "definitely_not_a_class"},
        )
        == "transient"
    )


def test_classify_unknown_code_falls_back_on_retryable() -> None:
    assert classify("CMP-NOPE-9999", retryable=True) == "transient"
    assert classify("CMP-NOPE-9999", retryable=False) == "internal_error"


def test_classify_never_raises_on_junk_input() -> None:
    assert classify("") in EXPECTED_CLASSES
    assert classify(None) in EXPECTED_CLASSES  # type: ignore[arg-type]
    assert classify("   ", error_details={"failure_class": 42}) in EXPECTED_CLASSES  # type: ignore[dict-item]
