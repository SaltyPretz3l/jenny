from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_budget_filter_probe_parity import (  # shared budget harness.
    _filter_input,
    _force_budget_pressure,
    _IncidentFilterKernel,
)

from sidecar.ai.context.token_budget import build_tool_schema_budget_plan
from sidecar.ai.routing.tool_budget_filter import apply_budget_aware_tool_filter
from sidecar.ai.routing.tool_budget_pairs import (
    pair_kept_partners,
    primary_directory_tool_names,
)
from sidecar.ai.tools.assembly import AssembledToolContract, AssembledToolEntry
from sidecar.ai.tools.catalog import CanonicalToolDescriptor

_SESSION_TOOLS = ("sessions_list", "session_status", "session_transcript", "session_stop", "session_message")
_OTHER_TOOLS = (
    "tool_search", "jenny_help", "conversations_search", "conversation_open", "propose_session",
    "task_board", "memory", "web_search", "web_fetch", "todo_write", "ask_user", "render_chart",
)
_PRIMARY_TOOLS = (*_OTHER_TOOLS, *_SESSION_TOOLS)


def _contract(hidden: frozenset[str] = frozenset()) -> AssembledToolContract:
    entries = []
    for name in _PRIMARY_TOOLS:
        descriptor = CanonicalToolDescriptor(
            name=name,
            description=f"Test descriptor for {name}",
            input_schema={"type": "object", "properties": {}},
            side_effecting=name in {"session_stop", "session_message"},
            read_only=name not in {"session_stop", "session_message"},
            tool_family=None,
        )
        schema = None if name in hidden else {
            "name": name, "description": descriptor.description,
            "parameters": descriptor.input_schema,
        }
        entries.append(AssembledToolEntry(descriptor=descriptor, available=True, prompt_schema=schema))
    return AssembledToolContract(tuple(entries))


class _PrimaryKernel(_IncidentFilterKernel):
    def _assemble_tool_contract(self, *, request_context, resolution_context):
        del request_context
        return _contract(resolution_context.budget_filtered_names)


def _kept(monkeypatch, *, session_role, history, level="auto_compact"):
    _force_budget_pressure(monkeypatch, level)
    kernel = _PrimaryKernel()
    base = _filter_input(kernel)
    context = replace(
        base,
        request_context=replace(base.request_context, session_role=session_role),
        semantic_history=list(history),
        latest_user_content="What is chat Beta parser doing right now?",
    )
    contract = kernel._assemble_tool_contract(
        request_context=context.request_context, resolution_context=context.tool_resolution_context,
    )
    result = apply_budget_aware_tool_filter(
        context, tool_contract=contract, tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )
    kept = context.tool_resolution_context.budget_filter_metadata["kept_names"]
    assert set(kept) == {schema["name"] for schema in result.tool_payload}
    return kept


_STOP_HISTORY = [{"role": "tool", "name": "session_stop", "content": "nothing_running"}]


def test_primary_chat_keeps_its_directory_read_tools_under_pressure(monkeypatch) -> None:
    kept = _kept(monkeypatch, session_role="primary", history=_STOP_HISTORY)
    assert {"sessions_list", "session_status", "session_transcript", "session_stop"} <= set(kept)
    assert len(kept) == 8


def test_recently_used_stop_brings_status_in_an_ordinary_chat(monkeypatch) -> None:
    # Row 69 gate run: only session_stop survived and the model used it to check a chat.
    kept = _kept(monkeypatch, session_role=None, history=_STOP_HISTORY)
    assert "session_stop" in kept
    assert "session_status" in kept
    assert len(kept) == 8


def test_no_stop_kept_means_no_forced_status(monkeypatch) -> None:
    kept = _kept(monkeypatch, session_role=None, history=[])
    assert "session_stop" not in kept
    assert len(kept) == 8


def test_primary_directory_names_only_for_the_primary_role() -> None:
    assert primary_directory_tool_names(type("R", (), {"session_role": "primary"})()) == (
        "sessions_list", "session_status", "session_transcript",
    )
    assert primary_directory_tool_names(type("R", (), {"session_role": None})()) == ()
    assert primary_directory_tool_names(object()) == ()


def test_pairing_keeps_the_plus_one_when_nothing_is_evictable() -> None:
    plan = build_tool_schema_budget_plan(
        ("session_stop", "read_file", "session_status"), level="error",
        mandatory_names=("session_stop", "read_file"),
    )
    plan = replace(plan, cap=2, kept_names=("session_stop", "read_file"),
                   filtered_names=frozenset({"session_status"}))
    paired = pair_kept_partners(plan, ("session_stop", "read_file", "session_status"), ())
    assert paired.kept_names == ("session_stop", "read_file", "session_status")
    assert "session_status" not in paired.filtered_names


def test_pairing_evicts_the_last_ordinary_tool_to_stay_in_the_cap() -> None:
    names = ("session_stop", "read_file", "grep_search", "session_status")
    plan = build_tool_schema_budget_plan(names, level="error", mandatory_names=("session_stop",))
    plan = replace(plan, cap=3, kept_names=names[:3], filtered_names=frozenset({"session_status"}))
    paired = pair_kept_partners(plan, names, ("read_file",))
    assert paired.kept_names == ("session_stop", "read_file", "session_status")
    assert paired.filtered_names == frozenset({"grep_search"})
