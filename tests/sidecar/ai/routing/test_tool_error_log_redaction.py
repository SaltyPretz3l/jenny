"""HB-017: a tool error keeps its real path for the model while the router's
log copies stay path-redacted.

The builtin server used to redact every absolute path before the text left it,
so the router logs inherited that. Now the model keeps the paths it named or its
workspace holds, and the log sites must redact on their own.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_loop import (  # shared loop harness.
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

_MISSING = r"Z:\does\not\exist"
_MESSAGE = f"path does not exist: {_MISSING}. Check the exact path with list_dir or glob_files."


class _FailingMCPClient(_StubMCPClient):
    def execute_tool(self, tool_name, arguments, **_kwargs):
        self.executions.append((tool_name, dict(arguments)))
        raise MCPError(code="CMP-TOOL-0003", message=_MESSAGE, response_received=True)


def _run_failing_read(caplog) -> _ToolLoopEngine:
    caplog.set_level(logging.INFO)
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="probe_read",
                            arguments={"path": _MISSING},
                            call_id="call_probe_read",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="It is missing.", finish_reason="stop")),
        ]
    )
    _build_router(
        engine=engine,
        mcp_client=_FailingMCPClient(
            (
                MCPToolDescriptor(
                    name="probe_read",
                    description="Read a file",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            )
        ),
        extra_snapshot_tools=("probe_read",),
    ).build_chat_decision(
        request_id="req_hb017_log",
        messages=[{"role": "user", "content": "Read the file."}],
        latest_user_content="Read the file.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=lambda _event: None, request_id="req_hb017_log"),
    )
    return engine


def _records(caplog, event: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.__dict__.get("event") == event]


def test_model_keeps_the_path_but_router_logs_redact_it(caplog) -> None:
    engine = _run_failing_read(caplog)

    tool_messages = [
        str(message.get("content", ""))
        for message in engine.requests[-1]["messages"]
        if message.get("role") == "tool"
    ]
    assert any(_MISSING in text for text in tool_messages)

    failed = _records(caplog, "ai.router.tool_call_failed")
    recovered = _records(caplog, "ai.router.tool_execution_recovered")
    assert failed and recovered
    for record in (*failed, *recovered):
        logged = f"{record.getMessage()} {record.__dict__['data']}"
        assert _MISSING not in logged
        assert "does\\not" not in logged
    assert failed[0].__dict__["data"]["error_message"] == (
        "path does not exist: <path>. Check the exact path with list_dir or glob_files."
    )
    assert "<path>" in recovered[0].__dict__["data"]["error_message"]
    assert "<path>" in recovered[0].getMessage()


class _BadHeadingMCPClient(_StubMCPClient):
    def execute_tool(self, tool_name, arguments, **_kwargs):
        self.executions.append((tool_name, dict(arguments)))
        raise MCPError(
            code="CMP-TOOL-0004",
            message="none of the requested Markdown headings were found",
            response_received=True,
        )


# Owner run 2026-10-27: one missed Markdown heading wrote three WARN lines though the model got the
# reason and carried on. A failure the model caused with its arguments logs at INFO; a denial
# (the CMP-TOOL-0003 run above) stays a warning.
def test_a_model_argument_miss_logs_info_and_a_denial_stays_warning(caplog) -> None:
    _run_failing_read(caplog)
    denied = _records(caplog, "ai.router.tool_call_failed") + _records(
        caplog, "ai.router.tool_execution_recovered"
    )
    assert denied and all(record.levelno == logging.WARNING for record in denied)

    caplog.clear()
    caplog.set_level(logging.INFO)
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="probe_read",
                            arguments={"path": "README.md"},
                            call_id="call_probe_heading",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="No such heading.", finish_reason="stop")),
        ]
    )
    _build_router(
        engine=engine,
        mcp_client=_BadHeadingMCPClient(
            (
                MCPToolDescriptor(
                    name="probe_read",
                    description="Read a file",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            )
        ),
        extra_snapshot_tools=("probe_read",),
    ).build_chat_decision(
        request_id="req_heading_miss",
        messages=[{"role": "user", "content": "Read the Setup section."}],
        latest_user_content="Read the Setup section.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=lambda _event: None, request_id="req_heading_miss"),
    )
    missed = _records(caplog, "ai.router.tool_call_failed") + _records(
        caplog, "ai.router.tool_execution_recovered"
    )
    assert len(missed) == 2
    assert all(record.levelno == logging.INFO for record in missed)
