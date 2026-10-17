"""Row 60 W2: micro-first compaction order (S6), touched-files carry (S8), instructions pin (S9)."""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.context.compaction import (
    _TOOL_PLACEHOLDER,
    COMPACTED_SUMMARY_HEADING,
    MICRO_FIRST_CODE,
    CompactionCircuitBreaker,
    CompactionPolicy,
    compact_context,
    compaction_policy,
)
from sidecar.ai.context.compaction_micro import (
    MAX_TOUCHED_FILES,
    TOUCHED_FILES_HEADING,
    collect_touched_files,
    tool_placeholder,
)
from sidecar.ai.context.token_budget import TokenBudget

_SUMMARY = (
    "<summary>\n"
    "## 1. Intent Summary\nFix the files.\n"
    "## 2. Key Technical Concepts\nnone\n"
    "## 3. Relevant Files & Code\nnone\n"
    "## 4. Errors & Debugging\nnone\n"
    "## 5. Problem-Solving Approaches\nnone\n"
    "## 6. User Messages\nnone\n"
    "## 7. Pending Tasks\nnone\n"
    "## 8. Current Work\nnone\n"
    "## 9. Next Step\nKeep going.\n"
    "</summary>"
)
_ALL_ON = CompactionPolicy(micro_first=True, recall_hint=True, touched_files=True)
_AGENTJ = "## Workspace Instructions (agentj.md)\nAlways run the tests with -q."


def _budget() -> TokenBudget:
    # auto threshold 1440 tokens, error threshold 1520 (see test_compaction._small_budget).
    return TokenBudget(context_window=1_800, max_output_tokens=200, reserved_for_summary=200)


def _call(call_id: str, name: str, **arguments: Any) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": call_id, "name": name, "arguments": dict(arguments)}],
    }


def _result(call_id: str, name: str, content: str, *, error: bool = False) -> dict[str, Any]:
    row: dict[str, Any] = {"role": "tool", "tool_call_id": call_id, "name": name, "content": content}
    if error:
        row["is_error"] = True
    return row


def _turn(task: str = "Fix the parser.", *, rounds: int = 10, size: int = 800, prefix: str = "c") -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = [{"role": "user", "content": task}]
    for index in range(rounds):
        call_id = f"{prefix}{index}"
        rows += [_call(call_id, "read_file", path=f"src/{prefix}{index}.py"), _result(call_id, "read_file", "x" * size)]
    return rows


class _Generator:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, _messages: list[dict[str, str]]) -> str:
        self.calls += 1
        return _SUMMARY


def _compact(messages: list[dict[str, Any]], policy: CompactionPolicy | None, **kwargs: Any):
    generate = _Generator()
    result = compact_context(
        messages,
        _budget(),
        generate_fn=generate,
        circuit_breaker=CompactionCircuitBreaker(),
        policy=policy,
        **kwargs,
    )
    return result, generate


# -- S6 micro-first ----------------------------------------------------------


def test_all_flags_off_builds_no_policy() -> None:
    off = {"compaction_micro_first": False, "compaction_recall_tool": False, "compaction_touched_files": False}
    assert compaction_policy(off) is None
    assert compaction_policy({}) == _ALL_ON
    assert compaction_policy(None) == _ALL_ON


def test_policy_off_keeps_the_summary_first_ladder_byte_for_byte() -> None:
    messages = [*_turn(), {"role": "user", "content": "Continue."}]
    off, off_generate = _compact(messages, None)
    pinned, _ = _compact(messages, compaction_policy({
        "compaction_micro_first": False, "compaction_recall_tool": False, "compaction_touched_files": False,
    }))

    assert off_generate.calls == 1
    assert off.strategy == "full"
    assert pinned == off
    assert TOUCHED_FILES_HEADING not in str(off.summary_message)


def test_micro_first_stubs_old_output_without_calling_the_model() -> None:
    messages = [*_turn(), {"role": "user", "content": "Continue."}]
    result, generate = _compact(messages, _ALL_ON)

    assert generate.calls == 0
    assert result.strategy == "micro"
    assert result.summary_status == "not_applicable"
    assert result.summary_failure_code == MICRO_FIRST_CODE
    assert result.micro_fallback is False
    assert result.tokens_after <= int(_budget().auto_compact_threshold(0) * 2 / 3)
    stubs = [row["content"] for row in result.messages if row.get("role") == "tool" and row["content"] != "x" * 800]
    assert stubs[0] == tool_placeholder("c0", recall_hint=True)
    assert stubs[0] == '[tool output omitted for context space; recall_tool_output("c0")]'
    stubbed_call = result.messages[1]["tool_calls"][0]
    assert stubbed_call["arguments"] == {"compacted": True, "path": "src/c0.py"}


def test_micro_first_without_recall_or_touched_files_uses_todays_stub() -> None:
    messages = [*_turn(), {"role": "user", "content": "Continue."}]
    result, _ = _compact(messages, CompactionPolicy(micro_first=True))

    assert result.messages[2]["content"] == _TOOL_PLACEHOLDER
    assert result.messages[1]["tool_calls"][0]["arguments"] == {"compacted": True}


def test_summary_runs_when_stubbing_cannot_reach_the_target() -> None:
    # Large user prose and small tool results: stubbing frees too little.
    messages: list[dict[str, Any]] = []
    for index in range(8):
        messages += [{"role": "user", "content": f"Request {index}: " + "words " * 130}, {"role": "assistant", "content": "ok"}]
    messages.append({"role": "user", "content": "Continue."})
    result, generate = _compact(messages, _ALL_ON)

    assert generate.calls >= 1  # an over-limit source is folded in passes
    assert result.strategy == "full"


def test_summary_runs_once_the_request_used_its_micro_passes() -> None:
    messages = [*_turn(), {"role": "user", "content": "Continue."}]
    result, generate = _compact(messages, _ALL_ON, micro_passes_used=_ALL_ON.max_micro_passes)

    assert generate.calls == 1
    assert result.strategy == "full"


def test_micro_first_mid_turn_keeps_the_task_message_unchanged() -> None:
    task = "Inspect the workspace and finish the task."
    messages = _turn(task)
    result, generate = _compact(messages, _ALL_ON, mode="mid_turn", task_content=task)

    assert generate.calls == 0
    assert result.strategy == "micro"
    assert result.messages[0] == {"role": "user", "content": task}


def test_failed_summary_falls_back_to_the_same_hinted_micro_result() -> None:
    messages: list[dict[str, Any]] = []
    for index in range(8):
        messages += [{"role": "user", "content": f"Request {index}: " + "words " * 130}, {"role": "assistant", "content": "ok"}]
    messages += [*_turn(rounds=2), {"role": "user", "content": "Continue."}]

    result = compact_context(
        messages,
        _budget(),
        generate_fn=lambda _messages: "no summary here",
        circuit_breaker=CompactionCircuitBreaker(),
        policy=_ALL_ON,
    )

    assert result.strategy == "micro"
    assert result.micro_fallback is True
    assert result.summary_failure_code != MICRO_FIRST_CODE


# -- S8 touched files -----------------------------------------------------------


def _editing_turn(prefix: str) -> list[dict[str, Any]]:
    return [
        {"role": "user", "content": f"Edit round {prefix}."},
        _call(f"{prefix}e", "edit_file", file_path=f"src/{prefix}_edited.py", old_string="a", new_string="b"),
        _result(f"{prefix}e", "edit_file", "edited"),
        _call(f"{prefix}w", "write_file", path=f"docs/{prefix}_written.md", content="..."),
        _result(f"{prefix}w", "write_file", "written"),
        _call(f"{prefix}f", "edit_file", file_path=f"src/{prefix}_failed.py", old_string="a", new_string="b"),
        _result(f"{prefix}f", "edit_file", "Target string not found in file", error=True),
        _call(f"{prefix}m", "move_file", moves=[{"source": f"a/{prefix}.txt", "destination": f"b/{prefix}.txt"}]),
        _result(f"{prefix}m", "move_file", "moved"),
        *_turn(rounds=6, size=900, prefix=prefix)[1:],
    ]


def test_full_summary_carries_successful_mutations_only() -> None:
    messages = [*_editing_turn("r1"), {"role": "user", "content": "Continue."}]
    result, _ = _compact(messages, CompactionPolicy(touched_files=True))

    assert result.strategy == "full"
    content = str(result.summary_message["content"])
    assert content.startswith(COMPACTED_SUMMARY_HEADING)
    block = content.rsplit(TOUCHED_FILES_HEADING, 1)[1]
    assert block.split() == ["-", "src/r1_edited.py", "-", "docs/r1_written.md", "-", "a/r1.txt", "-", "b/r1.txt"]


def test_touched_files_survive_three_successive_compactions() -> None:
    policy = CompactionPolicy(touched_files=True)
    history: list[dict[str, Any]] = []
    for prefix in ("r1", "r2", "r3"):
        history = [*history, *_editing_turn(prefix), {"role": "user", "content": "Continue."}]
        result, _ = _compact(history, policy)
        assert result.strategy == "full"
        history = result.messages[:-1]  # drop the trailing user row; the next round adds its own

    final = str(result.summary_message["content"])
    for prefix in ("r1", "r2", "r3"):
        assert f"- src/{prefix}_edited.py" in final
        assert f"- src/{prefix}_failed.py" not in final
    assert final.count(TOUCHED_FILES_HEADING) == 1


def test_touched_files_keep_the_latest_forty() -> None:
    rows: list[dict[str, Any]] = []
    for index in range(MAX_TOUCHED_FILES + 5):
        rows += [_call(f"w{index}", "write_file", path=f"f{index}.txt"), _result(f"w{index}", "write_file", "ok")]
    paths = collect_touched_files(rows)

    assert len(paths) == MAX_TOUCHED_FILES
    assert paths[0] == "f5.txt" and paths[-1] == f"f{MAX_TOUCHED_FILES + 4}.txt"


def test_touched_files_read_paths_kept_on_micro_stubbed_calls() -> None:
    rows = [_call("e1", "edit_file", compacted=True, file_path="src/a.py"), _result("e1", "edit_file", "ok")]
    assert collect_touched_files(rows) == ["src/a.py"]


def test_micro_stub_keeps_batch_move_paths_for_the_next_summary() -> None:
    from sidecar.ai.context.compaction_micro import microcompact

    messages = [*_editing_turn("r1"), {"role": "user", "content": "Continue."}]
    result = microcompact(
        messages, _budget(), target_fraction=0.0, keep_argument_keys=_ALL_ON.keep_argument_keys,
    )

    move = next(
        call for row in result.messages for call in row.get("tool_calls") or ()
        if call.get("name") == "move_file"
    )
    assert move["arguments"]["compacted"] is True
    assert move["arguments"]["moves"] == [{"source": "a/r1.txt", "destination": "b/r1.txt"}]
    assert {"a/r1.txt", "b/r1.txt"} <= set(collect_touched_files(result.messages))

# -- S9 instructions after compaction --------------------------------------------


@pytest.mark.parametrize("policy", [None, _ALL_ON], ids=["summary", "micro_first"])
def test_agentj_instructions_survive_a_mid_turn_compaction(policy: CompactionPolicy | None) -> None:
    system = {"role": "system", "content": f"You are Jenny.\n\n{_AGENTJ}"}
    task = "Inspect the workspace and finish the task."
    result, _ = _compact([system, *_turn(task)], policy, mode="mid_turn", task_content=task)

    assert result.strategy == ("full" if policy is None else "micro")
    assert result.messages[0] == system
    assert _AGENTJ in result.messages[0]["content"]
