"""Actual framed sidecar with a deterministic test-only child-aware replay model."""
from __future__ import annotations
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from sidecar.ai.engines.replay import ReplayEngine
from sidecar.__main__ import main

def resolve_call(self, messages):
    users = [str(row.get("content", "")) for row in messages or [] if row.get("role") == "user"]
    if any("RESOURCE_CHILD_TASK" in text for text in users):
        return {"text": "Child completed its bounded task."}
    results = [row for row in messages or [] if row.get("role") == "tool"]
    spawns = []
    for row in results:
        try:
            content = row.get("content", "")
            value, _end = json.JSONDecoder().raw_decode(content[content.index("{"):])
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and "root_run_id" in value and "child_work_id" in value:
            spawns.append(value["child_work_id"])
    count = len(results)
    if count in (0, 3):
        call = {"tool_id": "session_spawn", "arguments": {"task": "RESOURCE_CHILD_TASK " + str(count)}}
    elif count in (1, 4):
        call = {"tool_id": "session_wait", "arguments": {"child_work_id": spawns[-1]}}
    elif count == 2:
        call = {"tool_id": "read_file", "arguments": {"path": "blocked.txt"}}
    else:
        return {"text": "Mixed child and decision cycle completed."}
    return {"text": "Continuing bounded step " + str(count) + ".", "tool_calls": [call]}

ReplayEngine._call_index = staticmethod(lambda messages, _count: sum(
    row.get("role") == "tool" for row in messages or []))
ReplayEngine._resolve_call = resolve_call
raise SystemExit(main())
