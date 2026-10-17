"""The model-facing ``memory`` tool over a real schema v9 store (row 58 W1 S3b)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.memory.contracts import (
    ALWAYS_ON_BUDGET_CHARS,
    ALWAYS_ON_HEADING_RESERVE,
    ALWAYS_ON_ROW_OVERHEAD,
    GENERAL_PROJECT_ID,
    MAX_LESSON_TEXT_CHARS,
    MemoryPolicy,
)
from sidecar.ai.memory.service import MemoryService, PendingMemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.ai.routing import tool_execution as tool_execution_hub
from sidecar.ai.routing import tool_execution_memory as memory_tool
from sidecar.ai.routing.harness_helpers import MAX_RESPONSE_CHARS
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.routing.tool_execution_tool_handlers import SYNTHETIC_TOOL_HANDLERS
from sidecar.ai.tools.catalog import manifest_descriptors
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from tests.sidecar.ai.memory.memory_v9_helpers import pending_rows

PROJECT = "project_alpha"
SESSION = "session-1"


class _Contract:
    def __init__(self, descriptor: object) -> None:
        self._descriptor = descriptor

    def entry(self, tool_name: str) -> object | None:
        if tool_name != getattr(self._descriptor, "name", ""):
            return None
        return SimpleNamespace(available=True, descriptor=self._descriptor)


class _Harness:
    def __init__(self, tmp_path: Path) -> None:
        self.store = MemoryStore(tmp_path / "memory.db")
        self.service = MemoryService(self.store)
        self.descriptor = next(
            item for item in manifest_descriptors() if item.name == "memory"
        )
        self.kernel = SimpleNamespace(
            _config=RuntimeConfig(),
            _memory_store=self.service,
            _active_cancel_handle=None,
            _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: self.descriptor),
        )
        self.admitted: list[dict[str, Any]] = []
        self._calls = 0

    def close(self) -> None:
        self.store.close()

    def context(self, **overrides: Any) -> SimpleNamespace:
        values: dict[str, Any] = {
            "execution_context": SimpleNamespace(project_id=PROJECT, root_path=None),
            "memory_policy": MemoryPolicy(project_id=PROJECT),
            "agent_surface": "main",
            "agent_depth": 0,
            "session_offline_lockdown": False,
            "plan_mode": False,
            "read_only": False,
            "approved_plan": None,
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def run(
        self,
        arguments: dict[str, Any],
        *,
        call_id: str | None = None,
        session_id: str = SESSION,
        **context: Any,
    ) -> Any:
        self._calls += 1

        def admit(**kwargs: Any) -> dict[str, Any]:
            self.admitted.append(kwargs)
            return {"schema_version": 1}

        runtime = LoopRuntime(
            request_id="stream_1",
            trace_id="trace_1",
            session_id=session_id,
            logical_turn_id="turn-1",
            notification_writer=lambda _message: None,
            operation_admission=admit,
            request_context=self.context(**context),
        )
        return execute_tool(
            self.kernel,
            ToolCallRequest(
                tool_id="memory",
                call_id=call_id or f"call_{self._calls}",
                arguments=dict(arguments),
            ),
            request_id="stream_1",
            session_id=session_id,
            read_snapshot_cache={},
            tool_contract=_Contract(self.descriptor),
            runtime=runtime,
        )

    def active(self, project_id: str = PROJECT, **kwargs: Any) -> list[Any]:
        rows, _cursor = self.store.list_active(project_id=project_id, **kwargs)
        return rows


@pytest.fixture(autouse=True)
def _no_pressure_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tool_execution_hub, "apply_tool_pressure_backoff", lambda **_kw: None)


@pytest.fixture
def harness(tmp_path: Path) -> Any:
    instance = _Harness(tmp_path)
    try:
        yield instance
    finally:
        instance.close()


def _remember(harness: _Harness, text: str, **arguments: Any) -> Any:
    return harness.run({"action": "remember", "text": text, **arguments})


def test_remember_refuses_credential_shaped_text_and_scrubs_control_tokens(
    harness: _Harness,
) -> None:
    with pytest.raises(ToolExecutionFailure, match="memory remember failed"):
        harness.run({"action": "remember", "text": "The deploy key is sk-abcdefgh1234567890"})
    assert harness.active() == []
    ask = MemoryPolicy(project_id=PROJECT, capture="ask")
    with pytest.raises(ToolExecutionFailure, match="memory remember failed"):
        harness.run(
            {"action": "remember", "text": "password: hunter2"}, memory_policy=ask
        )
    assert pending_rows(harness.store, project_id=PROJECT, session_id=SESSION) == []

    scrubbed = _remember(harness, "Prefers\u200b tabs<|im_start|>")

    assert scrubbed.success is True
    [row] = harness.active()
    assert row.lesson_text == "Prefers tabs"


def test_an_observation_from_another_project_does_not_authorize_a_write(
    harness: _Harness,
) -> None:
    saved = _remember(harness, "Prefers tabs")
    memory_id = saved.metadata["memory_id"]
    assert harness.run({"action": "recall", "query": "tabs"}).success is True

    moved = harness.run(
        {"action": "update", "id": memory_id, "text": "Prefers spaces"},
        execution_context=SimpleNamespace(project_id="project_other", root_path=None),
        memory_policy=MemoryPolicy(project_id="project_other"),
    )

    assert moved.metadata["status"] == "refused"
    assert moved.metadata["reason"] == "unobserved"
    [row] = harness.active()
    assert row.lesson_text == "Prefers tabs"


def test_capture_ask_refuses_chat_scope_and_always_on_proposals(harness: _Harness) -> None:
    ask = MemoryPolicy(project_id=PROJECT, capture="ask")

    chat = harness.run({"action": "remember", "text": "Chat note", "scope": "chat"}, memory_policy=ask)
    pinned = harness.run({"action": "remember", "text": "Pin me", "always_on": True}, memory_policy=ask)

    for outcome in (chat, pinned):
        assert outcome.metadata["status"] == "refused"
        assert outcome.metadata["reason"] == "approval_required"
        # A remember gets its own sentence (gate F1: the update/forget wording
        # let a small model report the memory as saved).
        assert outcome.output.startswith("Not saved or queued")
        assert "project or global" in outcome.output
        assert "Changing or forgetting" not in outcome.output
    assert pending_rows(harness.store, project_id=PROJECT, session_id=SESSION) == []

    forget = harness.run({"action": "forget", "id": 1}, memory_policy=ask)
    assert forget.metadata["reason"] == "approval_required"
    assert forget.output.startswith("Changing or forgetting memories needs the user's approval")


def test_remember_after_forget_is_refused_as_deliberate_and_points_to_slash_remember(
    harness: _Harness,
) -> None:
    saved = _remember(harness, "Prefers tabs")
    assert harness.run({"action": "recall", "query": "tabs"}).success is True
    assert harness.run({"action": "forget", "id": saved.metadata["memory_id"]}).success is True

    again = _remember(harness, "Prefers tabs")

    assert again.metadata["status"] == "refused"
    assert again.metadata["reason"] == "suppressed"
    # Gate F2: say it is deliberate so the model neither retries nor blames the store.
    assert again.output.startswith("The user asked Jenny to forget that, so it was not saved.")
    assert "not an error" in again.output
    assert "/remember" in again.output
    assert harness.active() == []


def test_a_full_page_of_maximal_rows_fits_the_response_budget(harness: _Harness) -> None:
    for index in range(memory_tool.LIST_PAGE_SIZE + 1):
        _remember(harness, f"{index:03d} " + "x" * (MAX_LESSON_TEXT_CHARS - 4))

    page = harness.run({"action": "list"})

    lines = page.output.splitlines()
    assert len(lines) == memory_tool.LIST_PAGE_SIZE + 1
    assert lines[-1].startswith("(more: cursor=")
    assert len(page.output) <= MAX_RESPONSE_CHARS


def test_operation_ids_differ_across_turns_for_a_reused_call_id() -> None:
    first = memory_tool.memory_operation_id(SESSION, "call_1", "turn-1")
    second = memory_tool.memory_operation_id(SESSION, "call_1", "turn-2")

    assert first == f"tool:{SESSION}:turn-1:call_1"
    assert first != second
    assert memory_tool.memory_operation_id(SESSION, "call_1") == f"tool:{SESSION}:call_1"


def test_synthetic_dispatch_is_one_table_with_the_memory_handler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert set(SYNTHETIC_TOOL_HANDLERS) == {
        "monitor", "check_monitor", "delegate", "memory", "recall_tool_output",
    }
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(memory_tool, "_execute_memory_tool", lambda **kwargs: seen.append(kwargs))

    SYNTHETIC_TOOL_HANDLERS["memory"](call="c", session_id="s")

    assert seen == [{"call": "c", "session_id": "s"}]


def test_remember_uses_the_trusted_project_and_rejects_a_model_project_id(
    harness: _Harness,
) -> None:
    bogus = harness.run(
        {"action": "remember", "text": "Prefers tabs", "project_id": "project_evil"}
    )
    assert bogus.success is False
    assert harness.active() == []
    assert harness.active("project_evil") == []

    outcome = _remember(harness, "Prefers tabs", kind="preference")

    assert outcome.success is True
    [row] = harness.active()
    assert row.project_id == PROJECT
    assert row.origin == "jenny"
    assert row.session_id == SESSION
    assert row.scope_session_id == ""
    assert row.lesson_kind == "preference"
    assert row.source_message_ids == ("turn-1",)
    assert outcome.output == f"Remembered [id {row.id}, preference, project]: Prefers tabs"
    meta = outcome.metadata
    assert meta["result_kind"] == "memory"
    assert meta["action"] == "remember"
    assert meta["status"] == "saved"
    assert meta["memory_id"] == row.id
    assert meta["revision"] == 1
    assert meta["scope"] == "project"
    assert meta["kind"] == "preference"
    assert meta["duplicate"] is False
    assert meta["undoable"] is True
    assert meta["effects"] == "committed"
    assert meta["text_preview"] == "Prefers tabs"
    assert meta["operation_id"] == f"tool:{SESSION}:turn-1:call_2"
    assert harness.admitted and harness.admitted[-1]["tool_name"] == "memory"


def test_kind_defaults_to_fact_and_global_scope_lands_in_general(harness: _Harness) -> None:
    outcome = _remember(harness, "Lives in Lisbon", scope="global")

    assert outcome.success is True
    [row] = harness.active(GENERAL_PROJECT_ID)
    assert row.project_id == GENERAL_PROJECT_ID
    assert row.lesson_kind == "fact"
    assert outcome.metadata["scope"] == "global"
    assert ", fact, global]" in outcome.output


def test_chat_scope_lands_on_this_session_only(harness: _Harness) -> None:
    outcome = _remember(harness, "Call the draft v2", scope="chat")

    assert outcome.success is True
    assert outcome.metadata["scope"] == "chat"
    rows = harness.active(scope_session_id=SESSION)
    assert [row.scope_session_id for row in rows] == [SESSION]
    assert harness.active(scope_session_id="session-2") == []


def test_duplicate_reports_already_remembered_without_a_second_row(harness: _Harness) -> None:
    first = _remember(harness, "Prefers tabs")
    second = _remember(harness, "prefers   TABS")

    assert len(harness.active()) == 1
    memory_id = first.metadata["memory_id"]
    assert second.output == f"Already remembered [id {memory_id}]: Prefers tabs"
    assert second.metadata["duplicate"] is True
    assert second.metadata["undoable"] is False
    assert second.metadata["effects"] == "none"


def test_capture_off_refuses_writes_but_still_answers_reads(harness: _Harness) -> None:
    _remember(harness, "Prefers tabs")
    off = MemoryPolicy(project_id=PROJECT, capture="off", recall=False)

    refused = harness.run({"action": "remember", "text": "Uses vim"}, memory_policy=off)
    recalled = harness.run({"action": "recall", "query": "tabs"}, memory_policy=off)

    assert refused.success is True
    assert refused.metadata["status"] == "refused"
    assert refused.metadata["reason"] == "paused"
    assert "paused" in refused.output and "/remember" in refused.output
    assert [row.lesson_text for row in harness.active()] == ["Prefers tabs"]
    assert "Prefers tabs" in recalled.output


def test_capture_ask_queues_a_pending_candidate_and_writes_no_memory(
    harness: _Harness,
) -> None:
    ask = MemoryPolicy(project_id=PROJECT, capture="ask")

    outcome = harness.run(
        {"action": "remember", "text": "Prefers tabs", "kind": "preference"}, memory_policy=ask
    )

    assert outcome.success is True
    assert outcome.metadata["status"] == "pending_approval"
    assert outcome.metadata["effects"] == "none"
    assert outcome.metadata["operation_id"] == f"tool:{SESSION}:turn-1:call_1"
    assert harness.active() == []
    pending = pending_rows(harness.store, project_id=PROJECT, session_id=SESSION)
    assert [(row.lesson_text, row.lesson_kind, row.origin) for row in pending] == [
        ("Prefers tabs", "preference", "jenny")
    ]
    assert pending[0].source_request_id == f"tool:{SESSION}:turn-1:call_1"

    again = harness.run(
        {"action": "remember", "text": "Prefers tabs", "kind": "preference"}, memory_policy=ask
    )

    assert again.metadata["status"] == "refused"
    assert again.metadata["reason"] == "not_queued"
    assert len(pending_rows(harness.store, project_id=PROJECT, session_id=SESSION)) == 1


def test_capture_ask_queues_a_global_proposal_under_general(harness: _Harness) -> None:
    ask = MemoryPolicy(project_id=PROJECT, capture="ask")

    outcome = harness.run(
        {"action": "remember", "text": "Prefers tabs", "scope": "global"}, memory_policy=ask
    )

    assert outcome.metadata["status"] == "pending_approval"
    assert outcome.metadata["scope"] == "global"
    assert pending_rows(harness.store, project_id=PROJECT, session_id=SESSION) == []
    [row] = pending_rows(harness.store, project_id=GENERAL_PROJECT_ID, session_id=SESSION)
    assert (row.lesson_text, row.project_id) == ("Prefers tabs", GENERAL_PROJECT_ID)


def test_capture_ask_without_a_pending_queue_fails_closed(
    harness: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delattr(PendingMemoryService, "queue_candidate", raising=False)
    ask = MemoryPolicy(project_id=PROJECT, capture="ask")

    outcome = harness.run({"action": "remember", "text": "Prefers tabs"}, memory_policy=ask)

    assert outcome.metadata["status"] == "refused"
    assert outcome.metadata["reason"] == "approval_unavailable"
    assert harness.active() == []


def test_forget_of_an_unobserved_id_is_refused_and_archives_nothing(harness: _Harness) -> None:
    saved = harness.store.remember(
        operation_id="ui:1", project_id=PROJECT, text="Prefers tabs", kind="preference",
        origin="user", session_id="session-0",
    )
    assert saved.memory is not None

    outcome = harness.run({"action": "forget", "id": saved.memory.id})

    assert outcome.success is True
    assert outcome.metadata["status"] == "refused"
    assert outcome.metadata["reason"] == "unobserved"
    assert "recall or list first" in outcome.output
    assert [row.id for row in harness.active()] == [saved.memory.id]


def test_recall_then_forget_archives_the_row_and_is_undoable(harness: _Harness) -> None:
    saved = harness.store.remember(
        operation_id="ui:1", project_id=PROJECT, text="Prefers tabs", kind="preference",
        origin="reflection", session_id="session-0",
    )
    assert saved.memory is not None
    memory_id = saved.memory.id

    recalled = harness.run({"action": "recall", "query": "tabs"})
    forgot = harness.run({"action": "forget", "id": memory_id})

    assert recalled.output == f"[id {memory_id}] (preference, project) Prefers tabs"
    assert recalled.metadata["status"] == "ok"
    assert recalled.metadata["effects"] == "none"
    assert forgot.output == f"Forgot [id {memory_id}]."
    assert forgot.metadata["status"] == "saved"
    assert forgot.metadata["undoable"] is True
    assert forgot.metadata["effects"] == "committed"
    assert "text_preview" in forgot.metadata
    assert harness.active() == []


def test_update_with_a_stale_observed_revision_conflicts_then_refreshes(
    harness: _Harness,
) -> None:
    remembered = _remember(harness, "Prefers tabs")
    memory_id = remembered.metadata["memory_id"]
    elsewhere = harness.store.update(
        operation_id="ui:2", project_id=PROJECT, memory_id=memory_id, text="Prefers spaces",
        expected_revision=1, origin="reflection",
    )
    assert elsewhere.status == "saved"

    conflict = harness.run({"action": "update", "id": memory_id, "text": "Prefers 2 spaces"})
    retried = harness.run({"action": "update", "id": memory_id, "text": "Prefers 2 spaces"})

    assert conflict.success is True
    assert conflict.metadata["status"] == "conflict"
    assert conflict.metadata["revision"] == 2
    assert "Prefers spaces" in conflict.output
    assert retried.metadata["status"] == "saved"
    assert retried.output == f"Updated [id {memory_id}, revision 3]: Prefers 2 spaces"
    assert [row.lesson_text for row in harness.active()] == ["Prefers 2 spaces"]


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"agent_surface": "subagent"}, "subagent"),
        ({"agent_depth": 1}, "subagent"),
        ({"session_offline_lockdown": True}, "offline_lockdown"),
    ],
)
def test_sub_agents_and_lockdown_are_refused(
    harness: _Harness, overrides: dict[str, Any], reason: str
) -> None:
    outcome = harness.run({"action": "remember", "text": "Prefers tabs"}, **overrides)

    assert outcome.success is False
    assert outcome.error_code == CMP_TOOL_EXECUTION_FAILED
    assert outcome.metadata["status"] == "refused"
    assert outcome.metadata["reason"] == reason
    assert harness.active() == []


def test_unavailable_store_is_refused(harness: _Harness, tmp_path: Path) -> None:
    harness.kernel._memory_store = MemoryService(
        UnavailableMemoryStore(tmp_path / "missing.db", reason_code="CMP-MEM-0001", reason="test")
    )

    outcome = harness.run({"action": "recall", "query": "tabs"})

    assert outcome.success is False
    assert outcome.metadata["reason"] == "unavailable"


def test_always_on_over_budget_is_refused_with_the_current_lines(harness: _Harness) -> None:
    # Three rows that fill the always-on budget to within two characters.
    usable = ALWAYS_ON_BUDGET_CHARS - ALWAYS_ON_HEADING_RESERVE
    padding = usable // 3 - ALWAYS_ON_ROW_OVERHEAD - len("Rule 0 ")
    for index in range(3):
        result = harness.store.remember(
            operation_id=f"ui:{index}", project_id=PROJECT,
            text=f"Rule {index} " + "x" * padding, kind="convention", origin="user",
            session_id="session-0", always_on=True,
        )
        assert result.status == "saved"

    outcome = _remember(harness, "Always answer in English", always_on=True)

    assert outcome.success is True
    assert outcome.metadata["status"] == "refused"
    assert outcome.metadata["reason"] == "always_on_full"
    assert "Rule 0" in outcome.output and "Rule 2" in outcome.output
    assert len(harness.active()) == 3


def test_replaying_the_same_call_id_returns_the_same_result_and_one_row(
    harness: _Harness,
) -> None:
    first = harness.run({"action": "remember", "text": "Prefers tabs"}, call_id="call_same")
    second = harness.run({"action": "remember", "text": "Prefers tabs"}, call_id="call_same")

    assert len(harness.active()) == 1
    assert second.output == first.output
    assert second.metadata["memory_id"] == first.metadata["memory_id"]
    assert second.metadata["operation_id"] == first.metadata["operation_id"]
    assert second.metadata["status"] == first.metadata["status"] == "saved"


def test_list_pages_with_a_cursor_and_empty_recall_says_so(harness: _Harness) -> None:
    for index in range(memory_tool.LIST_PAGE_SIZE + 2):
        _remember(harness, f"Fact number {index}")

    first_page = harness.run({"action": "list"})
    lines = first_page.output.splitlines()
    cursor_line = lines[-1]
    assert len(lines) == memory_tool.LIST_PAGE_SIZE + 1
    assert cursor_line.startswith("(more: cursor=")
    cursor = cursor_line.removeprefix("(more: cursor=").removesuffix(")")
    second_page = harness.run({"action": "list", "cursor": cursor})
    empty = harness.run({"action": "recall", "query": "zebra"})

    assert len(second_page.output.splitlines()) == 2
    assert empty.output == "No memories match."


def test_project_falls_back_to_the_memory_policy_without_an_execution_context(
    harness: _Harness,
) -> None:
    outcome = harness.run(
        {"action": "remember", "text": "Prefers tabs"},
        execution_context=None,
        memory_policy=MemoryPolicy(project_id="project_beta"),
    )

    assert outcome.success is True
    assert [row.project_id for row in harness.active("project_beta")] == ["project_beta"]


def test_missing_request_context_is_refused(harness: _Harness) -> None:
    outcome = harness.run(
        {"action": "remember", "text": "Prefers tabs"},
        execution_context=None,
        memory_policy=None,
    )

    assert outcome.success is False
    assert outcome.metadata["reason"] == "scope_unavailable"


def test_observed_revisions_are_bounded_per_session_and_by_session_count() -> None:
    observed = memory_tool.ObservedRevisions()
    for memory_id in range(1, memory_tool.MAX_OBSERVED_IDS_PER_SESSION + 11):
        observed.record("s-0", memory_id, 1, PROJECT)
    assert observed.lookup("s-0", 1) is None
    assert observed.lookup("s-0", memory_tool.MAX_OBSERVED_IDS_PER_SESSION + 10) == (1, PROJECT)
    for index in range(1, memory_tool.MAX_OBSERVED_SESSIONS + 1):
        observed.record(f"s-{index}", 1, 1, PROJECT)
    assert observed.lookup("s-0", memory_tool.MAX_OBSERVED_IDS_PER_SESSION + 10) is None
    assert observed.lookup(f"s-{memory_tool.MAX_OBSERVED_SESSIONS}", 1) == (1, PROJECT)


def test_recall_and_list_never_show_a_reflection_recap(harness: _Harness) -> None:
    from sidecar.ai.memory.store_reflection import ReflectionCursor

    applied = harness.store.apply_reflection(
        session_id=SESSION, project_id=PROJECT, capture="auto", expected_fingerprint=None,
        cursor=ReflectionCursor(message_count=2, last_message_id="m-2",
                                window_fingerprint="sha256:" + "a" * 64,
                                session_incarnation="inc_1", turn_generation=1),
        proposals=(), recap="Recap about zebras and tabs.", is_policy_stale=lambda: False,
    )
    assert applied["status"] == "applied"

    recalled = harness.run({"action": "recall", "query": "zebras"})
    listed = harness.run({"action": "list"})

    assert recalled.output == "No memories match."
    assert "zebras" not in listed.output


def test_recall_goes_through_the_services_hybrid_helper(harness: _Harness) -> None:
    from tests.sidecar.ai.memory.fake_embedder import FakeEmbedder

    harness.service = MemoryService(
        harness.store, hybrid_recall_enabled=True, embedder_source=FakeEmbedder
    )
    harness.kernel._memory_store = harness.service
    for index in range(7):
        _remember(harness, f"Unrelated durable note {index} about invoices.")
    car = _remember(harness, "The user drives an old automobile.").metadata["memory_id"]
    assert harness.service.embed_step()["remaining"] == 0

    recalled = harness.run({"action": "recall", "query": "which car", "limit": 8})

    assert recalled.success is True
    lines = recalled.output.splitlines()
    assert lines[0] == f"[id {car}] (fact, project) The user drives an old automobile."
    assert len(lines) <= 5
    # The vector hit was observed, so the model may now act on it.
    forgot = harness.run({"action": "forget", "id": car})
    assert forgot.metadata["status"] == "saved"
