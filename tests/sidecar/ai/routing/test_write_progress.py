from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.write_progress import (
    ESCALATION_FLAG,
    IGNORED_CALLS_BEFORE_ESCALATION,
    READS_WITHOUT_WRITE_LIMIT,
    TOOL_GATE_FLAG,
    WriteProgress,
    gated_generation_payload,
    repin_after_compaction,
)


def _outcome(tool_name: str, *, success: bool = True) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(tool_name=tool_name, output="ok", success=success)


def _reads(count: int, tool_name: str = "read_file") -> list[ToolExecutionOutcome]:
    return [_outcome(tool_name) for _ in range(count)]


def test_twelve_reads_without_a_write_produce_one_nudge() -> None:
    progress = WriteProgress()

    progress.observe(_reads(READS_WITHOUT_WRITE_LIMIT - 1))
    assert progress.nudge_text() is None

    progress.observe(_reads(1))
    text = progress.nudge_text()

    assert text is not None
    assert "write_file" in text
    assert progress.nudges_sent == 1
    assert progress.reads_since_write == 0
    assert progress.nudge_text() is None


def test_a_successful_edit_resets_the_read_count() -> None:
    progress = WriteProgress()

    progress.observe(_reads(8))
    progress.observe([_outcome("edit_file")])
    progress.observe(_reads(8))

    assert progress.reads_since_write == 8
    assert progress.nudge_text() is None
    assert progress.nudges_sent == 0


def test_a_failed_write_does_not_reset_the_count() -> None:
    progress = WriteProgress()

    progress.observe(_reads(8))
    progress.observe([_outcome("edit_file", success=False)])
    progress.observe(_reads(4))

    assert progress.reads_since_write == READS_WITHOUT_WRITE_LIMIT
    assert progress.nudge_text() is not None


def test_failed_reads_and_unclassified_tools_are_neutral() -> None:
    progress = WriteProgress()

    progress.observe([_outcome("read_file", success=False), _outcome("todo_write")])

    assert progress.reads_since_write == 0


def test_read_class_tools_outside_the_default_registry_count() -> None:
    progress = WriteProgress()

    progress.observe(
        [
            _outcome("lsp_definition"),
            _outcome("workspace_manifest_read"),
            _outcome("todo_read"),
            _outcome("tool_search"),
            _outcome("grep_search"),
        ]
    )

    assert progress.reads_since_write == 5


def test_at_most_two_nudges_per_turn() -> None:
    progress = WriteProgress()
    texts: list[str] = []

    for _ in range(4):
        progress.observe(_reads(READS_WITHOUT_WRITE_LIMIT))
        text = progress.nudge_text()
        if text is not None:
            texts.append(text)

    assert len(texts) == 2
    assert progress.nudges_sent == 2

    progress.observe([_outcome("write_file")])
    progress.observe(_reads(READS_WITHOUT_WRITE_LIMIT))
    assert progress.nudge_text() is None


def test_nudge_text_names_the_count() -> None:
    progress = WriteProgress()

    progress.observe(_reads(15))
    text = progress.nudge_text()

    assert text is not None
    assert "15 read-only tool calls" in text
    assert "approved plan" in text


# Astra B5 review: a shell command is a read in disguise unless it reports
# workspace_changed, so `git status` through run_command must not erase the
# streak, while a command that did change files does.
def test_run_command_resets_only_with_workspace_changed_evidence() -> None:
    progress = WriteProgress()

    progress.observe(_reads(10))
    progress.observe([_outcome("run_command")])
    assert progress.reads_since_write == 11, "a command that changed nothing is a read"

    progress.observe(_reads(1))
    assert progress.nudge_text() is not None

    progress.observe(_reads(5))
    changed = ToolExecutionOutcome(
        tool_name="run_command", output="ok", success=True, metadata={"workspace_changed": True}
    )
    progress.observe([changed])
    assert progress.reads_since_write == 0, "explicit workspace evidence counts as a save"


def test_nudge_wording_is_conditional_on_remaining_work() -> None:
    progress = WriteProgress()
    progress.observe(_reads(READS_WITHOUT_WRITE_LIMIT))
    text = progress.nudge_text()

    assert text is not None
    assert "saved yet" not in text
    assert "if code remains to be written" in text


# TR-015 reopen (G5, 2026-09-30): the model applied its edit with a Python
# run_temp_script and did its diagnosis through scripts and commands, so the
# tracker saw neither the write nor most of the stall.
def _changed(tool_name: str, **metadata: object) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(tool_name=tool_name, output="ok", success=True, metadata=metadata)


def _read(path: str) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name="read_file", output="ok", success=True, tool_input={"path": path}
    )


def test_a_script_that_changed_the_workspace_counts_as_a_write() -> None:
    progress = WriteProgress()

    progress.observe(_reads(9))
    progress.observe([_changed("run_temp_script", workspace_changed=True)])

    assert progress.reads_since_write == 0


def test_observed_worktree_changes_count_as_a_write() -> None:
    progress = WriteProgress()

    progress.observe(_reads(9))
    observation = {"changed_path_count": 1, "certainty": "observed_during_call"}
    progress.observe([_changed("run_command", worktree_observation=observation)])

    assert progress.reads_since_write == 0


def test_a_background_command_observation_is_not_a_write() -> None:
    progress = WriteProgress()

    observation = {"changed_path_count": 3, "certainty": "ambiguous_background"}
    progress.observe([_changed("run_command", worktree_observation=observation)])

    assert progress.reads_since_write == 1


def test_scripts_that_changed_nothing_count_toward_the_streak() -> None:
    progress = WriteProgress()

    progress.observe(_reads(6))
    progress.observe([_outcome("run_temp_script") for _ in range(6)])

    assert progress.nudge_text() is not None


def _nudged(paths: tuple[str, ...] = ()) -> WriteProgress:
    progress = WriteProgress()
    progress.observe([_read(path) for path in paths])
    progress.observe(_reads(READS_WITHOUT_WRITE_LIMIT - len(paths)))
    assert progress.next_text() is not None
    return progress


def test_an_ignored_nudge_escalates_to_a_directive_naming_the_most_read_file() -> None:
    progress = _nudged(("bank_recon/matching.py", "tests/test_match.py", "bank_recon/matching.py"))

    progress.observe([_outcome("run_temp_script")] * (IGNORED_CALLS_BEFORE_ESCALATION - 1))
    assert progress.next_text() is None

    progress.observe([_outcome("read_file")])
    text = progress.next_text()

    assert text is not None
    assert "must be edit_file" in text
    assert "bank_recon/matching.py" in text
    assert progress.gate_next_step is False


def test_a_write_after_the_nudge_cancels_the_escalation() -> None:
    progress = _nudged()

    progress.observe([_outcome("edit_file")])
    progress.observe(_reads(IGNORED_CALLS_BEFORE_ESCALATION))

    assert progress.next_text() is None


def test_an_ignored_directive_arms_one_write_only_step() -> None:
    progress = _nudged()
    progress.observe(_reads(IGNORED_CALLS_BEFORE_ESCALATION))
    assert progress.next_text() is not None

    progress.observe(_reads(IGNORED_CALLS_BEFORE_ESCALATION))
    text = progress.next_text()

    assert text is not None
    assert "only write_file and edit_file" in text
    assert progress.gate_next_step is True


def test_tool_gate_kill_switch_keeps_the_directive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TOOL_GATE_FLAG, "0")
    progress = WriteProgress.from_environment()
    progress.observe(_reads(READS_WITHOUT_WRITE_LIMIT))
    assert progress.next_text() is not None

    for _ in range(2):
        progress.observe(_reads(IGNORED_CALLS_BEFORE_ESCALATION))
        text = progress.next_text()
        assert text is not None
        assert "must be edit_file" in text

    assert progress.gate_next_step is False


def test_escalation_kill_switch_restores_the_b5_tracker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ESCALATION_FLAG, "0")
    progress = WriteProgress.from_environment()

    progress.observe([_outcome("run_temp_script")] * 5)
    assert progress.reads_since_write == 0, "commands are neutral without the escalation"

    progress.observe(_reads(READS_WITHOUT_WRITE_LIMIT))
    assert progress.next_text() is not None
    progress.observe(_reads(IGNORED_CALLS_BEFORE_ESCALATION * 3))
    assert progress.next_text() is None


def _schema(name: str) -> dict[str, object]:
    return {"type": "function", "function": {"name": name, "parameters": {}}}


def test_the_armed_gate_offers_only_write_tools_for_one_generation() -> None:
    loop = SimpleNamespace(_write_progress=WriteProgress(gate_next_step=True))
    payload = [_schema("read_file"), _schema("edit_file"), _schema("write_file")]

    gated = gated_generation_payload(loop, payload)

    assert [entry["function"]["name"] for entry in gated] == ["edit_file", "write_file"]
    assert gated_generation_payload(loop, payload) == payload


def test_the_gate_never_empties_the_payload() -> None:
    loop = SimpleNamespace(_write_progress=WriteProgress(gate_next_step=True))
    payload = [_schema("read_file")]

    assert gated_generation_payload(loop, payload) == payload


def test_an_unanswered_nudge_is_repinned_after_compaction() -> None:
    progress = _nudged()
    loop = SimpleNamespace(
        _write_progress=progress, working_messages=[{"role": "user", "content": "summary"}]
    )

    repin_after_compaction(loop)
    repin_after_compaction(loop)

    assert loop.working_messages[-1] == {"role": "system", "content": progress.outstanding}
    assert len(loop.working_messages) == 2


def test_nothing_is_repinned_once_the_model_wrote() -> None:
    progress = _nudged()
    progress.observe([_outcome("write_file")])
    loop = SimpleNamespace(_write_progress=progress, working_messages=[])

    repin_after_compaction(loop)

    assert loop.working_messages == []


# TR-015 / MQ-014: `git add`, a stray `cfile=none` and repo-root data folders
# changed the workspace without saving any source, yet reset the streak.
def test_command_with_source_changed_false_is_a_read_even_if_workspace_changed() -> None:
    progress = WriteProgress()

    progress.observe(_reads(9))
    progress.observe([_changed("run_command", workspace_changed=True, source_changed=False)])

    assert progress.reads_since_write == 10


def test_command_with_source_changed_true_is_a_write() -> None:
    progress = WriteProgress()

    progress.observe(_reads(9))
    progress.observe([_changed("run_temp_script", workspace_changed=True, source_changed=True)])

    assert progress.reads_since_write == 0


def test_command_without_source_changed_key_falls_back_to_workspace_changed() -> None:
    progress = WriteProgress()

    progress.observe(_reads(9))
    progress.observe([_changed("run_command", workspace_changed=True)])

    assert progress.reads_since_write == 0


def test_rehydration_never_arms_the_tool_gate() -> None:
    sent = _nudged()
    nudge = sent.outstanding
    sent.observe(_reads(IGNORED_CALLS_BEFORE_ESCALATION))
    directive = sent.next_text()
    sent.observe(_reads(IGNORED_CALLS_BEFORE_ESCALATION))
    gate = sent.next_text()
    assert sent.gate_next_step is True
    messages = [
        {"role": "system", "content": text} for text in (nudge, directive, gate)
    ]

    progress = WriteProgress()
    progress.rehydrate([], messages)

    assert progress.outstanding == gate
    assert (progress.nudges_sent, progress.directives_sent, progress.gates_sent) == (1, 1, 1)
    assert progress.gate_next_step is False
