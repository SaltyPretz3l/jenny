"""A skill named mid-message with /<command> is applied like an explicit invocation.

2026-10-31: "Please /po-review the tool selector on the composer" carried no
skill_invocation (only a leading slash command sets one), so the model grepped
the repo for "po-review" instead of loading the skill.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from sidecar.ai.context.builder import ContextBuilder, SkillScope
from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages
from sidecar.ai.context.skill_mentions import find_skill_mention, latest_user_text

_CANDIDATES = (("po-review", "po"), ("insight", "insight"), ("land", "land"))


@pytest.mark.parametrize(
    "text",
    [
        "/po-review the composer",
        "Please /po-review the tool selector on the composer",
        "Please /PO-Review the composer",
        "Can you (/po-review) it?",
        'Run "/po-review" now',
        "Use /po-review.",
        "Use /po-review, then stop",
        "Line one\n/po-review",
        "try /po-review: the selector",
    ],
)
def test_a_named_command_is_found(text: str) -> None:
    assert find_skill_mention(text, _CANDIDATES) == "po"


@pytest.mark.parametrize(
    "text",
    [
        "no command here",
        "see docs/po-review for details",
        "https://example.com/po-review",
        "Please /po-reviewer the composer",
        "Please /po-review-extra the composer",
        "Please /unknown the composer",
        "Run `/po-review` literally",
        "Run ``a /po-review b`` literally",
        "```\n/po-review\n```",
        "~~~text\nPlease /po-review\n~~~",
        "",
    ],
)
def test_paths_code_and_partial_names_are_not_mentions(text: str) -> None:
    assert find_skill_mention(text, _CANDIDATES) is None


def test_the_first_mention_in_the_text_wins() -> None:
    assert find_skill_mention("/insight first, then /land", _CANDIDATES) == "insight"
    assert find_skill_mention("/land first, then /insight", _CANDIDATES) == "land"


def test_code_before_a_real_mention_does_not_hide_it() -> None:
    text = "```\n/land\n```\nNow please /insight the harness"
    assert find_skill_mention(text, _CANDIDATES) == "insight"


def test_latest_user_text_reads_strings_and_text_parts() -> None:
    history = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": [{"type": "text", "text": "Please /land"}, {"type": "image"}]},
    ]
    assert latest_user_text(history) == "Please /land"
    assert latest_user_text([{"role": "assistant", "content": "x"}]) == ""
    assert latest_user_text(()) == ""


def _builder(tmp_path) -> ContextBuilder:
    root = tmp_path / "bundled"
    for directory, frontmatter in (
        ("po-review", "name: Product Owner Review\ncommand: po-review"),
        ("insight-dir", "name: Harness Insight"),
    ):
        (root / directory).mkdir(parents=True)
        (root / directory / "SKILL.md").write_text(
            f"---\n{frontmatter}\n---\nBody of {directory}.\n", encoding="utf-8"
        )
    return ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=root, enabled=True),),
        skills_system_enabled=True,
    )


def test_a_mentioned_skill_renders_the_invoked_section_with_mention_wording(
    tmp_path, caplog
) -> None:
    caplog.set_level(logging.INFO)
    builder = _builder(tmp_path)

    message = builder.build_mentioned_skill_system_message(
        "Please /po-review the tool selector on the composer"
    )

    assert message.startswith("## Invoked Skill: Product Owner Review\n")
    assert (
        "The user named this skill with /po-review in their message; apply it to this turn."
        in message
    )
    assert "Body of po-review." in message
    resolved = [
        record
        for record in caplog.records
        if record.__dict__.get("event") == "ai.context.skill_mention_resolved"
    ]
    assert len(resolved) == 1
    assert resolved[0].levelno == logging.INFO
    assert resolved[0].__dict__["data"] == {"id": "bundled/po-review"}


def test_the_id_slug_matches_when_the_skill_has_no_explicit_command(tmp_path) -> None:
    builder = _builder(tmp_path)

    message = builder.build_mentioned_skill_system_message("can you /insight-dir this")

    assert message.startswith("## Invoked Skill: Harness Insight\n")
    assert "/insight-dir in their message" in message


def test_no_mention_or_a_disabled_skill_renders_nothing(tmp_path) -> None:
    builder = _builder(tmp_path)
    assert builder.build_mentioned_skill_system_message("Please review the composer") == ""
    disabled = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=tmp_path / "bundled", enabled=True),),
        disabled_skill_ids=("bundled/po-review",),
        skills_system_enabled=True,
    )
    assert disabled.build_mentioned_skill_system_message("Please /po-review it") == ""


def _invoked_rows(messages: list[dict[str, object]]) -> list[str]:
    return [str(row["content"]) for row in messages if "## Invoked Skill:" in str(row["content"])]


def test_the_dynamic_overlay_applies_a_mention_only_without_an_explicit_invocation(
    tmp_path,
) -> None:
    builder = _builder(tmp_path)
    config = SimpleNamespace(engine_type="ollama", skills_auto_index="off")

    mentioned = build_dynamic_system_messages(
        context_builder=builder,
        config=config,
        latest_user_content="Please /po-review the composer",
    )
    explicit = build_dynamic_system_messages(
        context_builder=builder,
        config=config,
        skill_invocation={"id": "bundled/insight-dir"},
        latest_user_content="Please /po-review the composer",
    )

    assert len(_invoked_rows(mentioned)) == 1
    assert "named this skill with /po-review" in _invoked_rows(mentioned)[0]
    assert len(_invoked_rows(explicit)) == 1
    assert "Harness Insight" in _invoked_rows(explicit)[0]
    assert "invoked this skill with /insight-dir" in _invoked_rows(explicit)[0]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("open /build.gradle and fix it", None),
        ("see /build:target", None),
        ("please /build.", "B"),
        ("run /build: now", "B"),
        ("/x(/build)", "B"),
    ],
)
def test_a_period_or_colon_ends_a_mention_only_as_punctuation(text, expected):
    assert find_skill_mention(text, [("build", "B")]) == expected
