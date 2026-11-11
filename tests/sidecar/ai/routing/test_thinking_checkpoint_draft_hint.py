"""Draft hint at a thinking-budget checkpoint outside an approved plan.

2026-11-03 Rust session: a direct "write this file" request in Auto drafted the
file inside its reasoning across four checkpoints under the generic nudge, because
the write-it-now nudge is reserved for approved-plan builds. A turn with write
tools now gets a conditional hint; a turn without them keeps the decisive nudge.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.routing import write_progress
from sidecar.ai.routing.thinking_checkpoint import build_checkpoint_messages

_RUST_DRAFT = "fn main() {\n    run();\n}\n\npub fn run() {}\n"


def _last(messages: list[dict[str, object]]) -> str:
    return str(messages[-1]["content"])


@pytest.mark.parametrize(
    "reasoning",
    [_RUST_DRAFT, "Plan:\n```rust\nfn main() {}\n```\nThen tests."],
)
def test_write_tools_without_a_plan_get_the_conditional_draft_hint(reasoning: str) -> None:
    nudge = _last(build_checkpoint_messages(reasoning, write_tools_available=True))

    assert nudge.startswith("If the user asked you to create or change files")
    assert "write it to disk now with write_file/edit_file" in nudge
    assert nudge.endswith("Otherwise give your answer now.")


def test_an_approved_plan_keeps_the_unconditional_draft_nudge() -> None:
    nudge = _last(build_checkpoint_messages(
        _RUST_DRAFT, allow_write_draft=True, write_tools_available=True,
    ))

    assert nudge.startswith("Your reasoning above already drafts code.")


def test_no_write_tools_or_no_draft_keeps_the_decisive_nudge() -> None:
    assert _last(build_checkpoint_messages(_RUST_DRAFT)).startswith("You hit a thinking-budget checkpoint.")
    assert _last(build_checkpoint_messages(
        "I should read the parser first.", write_tools_available=True,
    )).startswith("You hit a thinking-budget checkpoint.")


def _loop(*, plan_mode: bool = False, read_only: bool = False, names: tuple[str, ...] = ("write_file",)):
    return SimpleNamespace(
        plan_mode=plan_mode,
        read_only=read_only,
        tool_contract=SimpleNamespace(available_names=names),
        request_context=SimpleNamespace(approved_plan=None, plan_approved_in_turn=False),
    )


def test_write_tools_available_needs_write_tools_outside_plan_and_read_only() -> None:
    assert write_progress.write_tools_available(_loop()) is True
    assert write_progress.write_tools_available(_loop(plan_mode=True)) is False
    assert write_progress.write_tools_available(_loop(read_only=True)) is False
    assert write_progress.write_tools_available(_loop(names=("read_file",))) is False
    assert write_progress.nudge_applies(_loop()) is False, "the plan-only nudge still needs an approved plan"
