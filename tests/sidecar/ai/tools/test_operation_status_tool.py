"""Red-first: the `operation_status` enumeration tool (W5, spec §3.6).

The missing enumeration surface: every non-terminal operation, every active
background job, every active monitor, each with its current cursor. Governing
rule taken verbatim from the reference ledger: a status query may reference
only an existing id and never authorizes re-execution.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.catalog import manifest_descriptors
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.operation_ledger import OperationLedger


@pytest.fixture()
def ledger_root(tmp_path: Path):
    root = tmp_path / "ledger-root"
    builtin_server.configure_operation_ledger(root)
    yield root
    builtin_server.configure_operation_ledger(None)


def _descriptor():
    for descriptor in manifest_descriptors():
        if descriptor.name == "operation_status":
            return descriptor
    raise AssertionError("operation_status missing from the canonical catalog")


def test_manifest_declares_a_no_arg_read_only_tool() -> None:
    descriptor = _descriptor()
    assert descriptor.side_effecting is False
    assert descriptor.read_only is True
    assert descriptor.input_schema.get("required", []) == []


def test_enumerates_pending_operations_with_key_and_status(ledger_root, tmp_path) -> None:
    OperationLedger(ledger_root).create_pending(
        operation_id="idem_cccccccccccccccccccccccc",
        request_fingerprint="fp_1",
        generation_id="gen_dead",
        now_iso="2026-08-28T12:00:00Z",
    )
    tools = builtin_server._default_tools()  # noqa: SLF001
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "opstatus-call",
        tools,
        WorkspaceGuard(str(tmp_path)),
        {"name": "operation_status", "arguments": {}},
    )
    assert "result" in response
    text = str(response["result"]["content"][0]["text"])
    assert "idem_cccccccccc" in text  # key prefix present, model can reference it
    assert "pending" in text


def test_empty_state_reports_no_active_operations(ledger_root, tmp_path) -> None:
    tools = builtin_server._default_tools()  # noqa: SLF001
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "opstatus-empty",
        tools,
        WorkspaceGuard(str(tmp_path)),
        {"name": "operation_status", "arguments": {}},
    )
    assert "result" in response
    text = str(response["result"]["content"][0]["text"]).lower()
    assert "no active operations" in text


def test_status_output_never_authorizes_re_execution(ledger_root, tmp_path) -> None:
    OperationLedger(ledger_root).create_pending(
        operation_id="idem_dddddddddddddddddddddddd",
        request_fingerprint="fp_1",
        generation_id="gen_dead",
        now_iso="2026-08-28T12:00:00Z",
    )
    tools = builtin_server._default_tools()  # noqa: SLF001
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "opstatus-doctrine",
        tools,
        WorkspaceGuard(str(tmp_path)),
        {"name": "operation_status", "arguments": {}},
    )
    text = str(response["result"]["content"][0]["text"]).lower()
    # The enumeration must instruct verification, not retry: an interrupted
    # pending operation renders with a "do not re-run automatically" posture.
    assert "verify" in text
    assert "safe to retry" not in text
