"""Framed Python quota fixture: real dispatch/consent, deterministic offline web results."""
from __future__ import annotations
import sys
import json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
mixed = "--quota-mixed" in sys.argv
if mixed:
    sys.argv.remove("--quota-mixed")
from dataclasses import replace
import sidecar.ai.config as config_module
parse = config_module.parse_runtime_config
config_module.parse_runtime_config = lambda raw: replace(parse(raw),
    max_web_tool_calls_per_turn=2, max_tool_calls_per_session=7 if mixed else 5,
    tools_web_enabled=True, tool_search_mode="off")
from sidecar.ai.engines.replay import ReplayEngine
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.mcp.models import MCPToolResult
from sidecar.__main__ import main

execute = MCPClient.execute_tool
def offline_execute(self, tool_name, arguments, **kwargs):
    if tool_name == "web_search":
        success = arguments["query"] != "failure"
        return MCPToolResult(tool_name=tool_name, output="Offline web " + arguments["query"], success=success)
    return execute(self, tool_name, arguments, **kwargs)
MCPClient.execute_tool = offline_execute

def resolve(self, messages):
    count = sum(row.get("role") == "tool" for row in messages or [])
    users = [str(row.get("content", "")) for row in messages or [] if row.get("role") == "user"]
    if any("QUOTA_CHILD_TASK" in text for text in users):
        return {"text": "Offline child completed."}
    if mixed and count == 3:
        return {"tool_calls": [{"tool_id": "session_spawn", "arguments": {"task": "QUOTA_CHILD_TASK"}}]}
    if mixed and count == 4:
        for row in messages:
            if row.get("role") != "tool":
                continue
            try:
                content = row.get("content", "")
                receipt, _ = json.JSONDecoder().raw_decode(content[content.index("{"):])
            except (TypeError, ValueError):
                continue
            if isinstance(receipt, dict) and "root_run_id" in receipt:
                return {"tool_calls": [{"tool_id": "session_wait", "arguments": {"child_work_id": receipt["child_work_id"]}}]}
        raise AssertionError("child receipt unavailable")
    if mixed and count >= 5:
        count -= 2
    web = lambda query: {"tool_id": "web_search", "arguments": {"query": query}}
    question = {"tool_id": "ask_user", "arguments": {"questions": [{"id": "choice", "prompt": "Continue?"}]}}
    if count == 0:
        calls = [web("success"), web("failure"), web("blocked-before")]
    elif count == 3:
        calls = [{"tool_id": "read_file", "arguments": {"path": "fixture.txt"}}] if any("QUOTA_APPROVAL" in text for text in users) else [question]
    elif count == 4:
        calls = [web("after"), web("blocked-after")]
    elif count == 6:
        calls = [question]
    elif count == 7:
        calls = [{"tool_id": "read_file", "arguments": {"path": "fixture.txt"}}]
    else:
        return {"text": "Quota cycle complete."}
    return {"tool_calls": calls}
ReplayEngine._call_index = staticmethod(lambda messages, _count: sum(row.get("role") == "tool" for row in messages or []))
ReplayEngine._resolve_call = resolve
raise SystemExit(main())
