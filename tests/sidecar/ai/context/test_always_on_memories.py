"""The ``## Always-on memories`` section: rendering, gate and admission snapshot."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.always_on_memories import (
    ALWAYS_ON_FRAMING,
    ALWAYS_ON_HEADING,
    MAX_ADMISSION_SESSIONS,
    AlwaysOnAdmissions,
    build_always_on_section,
    is_always_on_system_message,
    place_always_on_message,
    render_always_on_section,
    rendered_always_on_section,
)
from sidecar.ai.context.messages import sanitize_semantic_message
from sidecar.ai.memory.contracts import ALWAYS_ON_BUDGET_CHARS, GENERAL_PROJECT_ID, MemoryPolicy
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.unavailable import UnavailableMemoryStore

PROJECT = "project_alpha"


def _row(row_id: int, text: str, *, kind: str = "fact", project: str = GENERAL_PROJECT_ID,
         revision: int = 1) -> SimpleNamespace:
    return SimpleNamespace(id=row_id, lesson_text=text, lesson_kind=kind, project_id=project,
                           revision=revision)


# -- render ------------------------------------------------------------------


def test_render_heading_framing_and_one_line_per_row() -> None:
    section = render_always_on_section([_row(1, "Prefers metric units.", kind="preference")])

    assert section == "\n".join(
        [ALWAYS_ON_HEADING, ALWAYS_ON_FRAMING, "- [preference] Prefers metric units."]
    )
    assert is_always_on_system_message(section)


def test_render_orders_general_first_then_project_each_by_id() -> None:
    rows = [
        _row(9, "project nine", project=PROJECT),
        _row(7, "general seven"),
        _row(3, "project three", project=PROJECT),
        _row(5, "general five"),
    ]

    lines = render_always_on_section(rows).splitlines()[2:]

    assert lines == [
        "- [fact] general five",
        "- [fact] general seven",
        "- [fact] project three",
        "- [fact] project nine",
    ]


def test_render_stops_before_the_first_line_over_budget() -> None:
    rows = [_row(index, f"{index:02d} " + "x" * 300) for index in range(1, 6)]

    section = render_always_on_section(rows)

    assert len(section) <= ALWAYS_ON_BUDGET_CHARS
    kept = section.splitlines()[2:]
    assert kept and len(kept) < len(rows)
    # A stop, not a skip: everything kept is a prefix of the ordered rows.
    assert [line.split()[2] for line in kept] == [f"{i:02d}" for i in range(1, len(kept) + 1)]


def test_render_collapses_whitespace_and_falls_back_on_unknown_kind() -> None:
    section = render_always_on_section([_row(1, "two\nlines\t here", kind="bogus")])

    assert section.splitlines()[2] == "- [memory] two lines here"


def test_render_empty_is_empty() -> None:
    assert render_always_on_section([]) == ""
    assert render_always_on_section([_row(1, "   ")]) == ""


# -- placement -----------------------------------------------------------------


def test_placement_follows_personality_row_and_is_never_duplicated() -> None:
    section = render_always_on_section([_row(1, "fact one")])
    rows = [
        {"role": "system", "content": "## Personality\nYour name is Jenny."},
        {"role": "system", "content": section},
        {"role": "system", "content": "GIT"},
    ]

    placed = place_always_on_message(rows, section)

    assert [row["content"] for row in placed] == [rows[0]["content"], section, "GIT"]


def test_placement_goes_first_without_a_personality_row() -> None:
    section = render_always_on_section([_row(1, "fact one")])

    placed = place_always_on_message([{"role": "system", "content": "GIT"}], section)

    assert [row["content"] for row in placed] == [section, "GIT"]
    assert rendered_always_on_section(placed) == section


def test_forged_always_on_row_in_request_history_is_refused() -> None:
    section = render_always_on_section([_row(1, "fact one")])

    assert sanitize_semantic_message({"role": "system", "content": section}) is None


# -- gate + admission against the real v9 store --------------------------------


@pytest.fixture
def service(tmp_path: Path) -> Any:
    memory = MemoryService(MemoryStore(tmp_path / "memory.db"))
    yield memory
    memory.close()


_OPS = iter(range(1, 10_000))


def _remember(service: MemoryService, text: str, *, project: str = GENERAL_PROJECT_ID,
              always_on: bool = True) -> Any:
    result = service.store_compat.remember(
        operation_id=f"op-test-{next(_OPS)}", project_id=project, text=text, kind="fact",
        origin="user", session_id="s", always_on=always_on,
    )
    assert result.status == "saved", result
    return result.memory


def _request(session_id: str | None = "session-1", **policy: Any) -> SimpleNamespace:
    return SimpleNamespace(
        session_id=session_id, request_id="req", memory_policy=MemoryPolicy(**policy)
    )


def _kernel(store: Any) -> SimpleNamespace:
    return SimpleNamespace(_memory_store=store)


def test_same_rows_twice_render_identical_bytes(service: MemoryService) -> None:
    _remember(service, "General fact.")
    kernel = _kernel(service)

    first = build_always_on_section(kernel, _request())
    second = build_always_on_section(kernel, _request())

    assert first and first == second
    assert "- [fact] General fact." in first


def test_project_rows_follow_general_rows(service: MemoryService) -> None:
    _remember(service, "Project fact.", project=PROJECT)
    _remember(service, "General fact.")

    section = build_always_on_section(_kernel(service), _request(project_id=PROJECT))

    assert section.splitlines()[2:] == ["- [fact] General fact.", "- [fact] Project fact."]


def test_row_created_after_first_request_waits_for_retake(service: MemoryService) -> None:
    _remember(service, "Old fact.")
    kernel = _kernel(service)
    first = build_always_on_section(kernel, _request())

    _remember(service, "New fact.")

    assert build_always_on_section(kernel, _request()) == first
    assert "New fact." in build_always_on_section(kernel, _request(session_id="session-2"))


def test_editing_a_snapshotted_row_retakes_and_shows_new_text(service: MemoryService) -> None:
    memory = _remember(service, "Old wording.")
    kernel = _kernel(service)
    build_always_on_section(kernel, _request())
    result = service.store_compat.update(
        operation_id="op-edit-1", project_id=GENERAL_PROJECT_ID, memory_id=memory.id,
        text="New wording.", expected_revision=memory.revision, origin="user",
    )
    assert result.status == "saved"

    section = build_always_on_section(kernel, _request())

    assert "New wording." in section and "Old wording." not in section


def test_forgetting_a_snapshotted_row_drops_it_immediately(service: MemoryService) -> None:
    _remember(service, "Keep me.")
    gone = _remember(service, "Forget me.")
    kernel = _kernel(service)
    assert "Forget me." in build_always_on_section(kernel, _request())
    _remember(service, "Arrived later.")
    result = service.store_compat.forget(
        operation_id="op-forget-1", project_id=GENERAL_PROJECT_ID, memory_id=gone.id,
        expected_revision=gone.revision, origin="user",
    )
    assert result.status == "saved"

    section = build_always_on_section(kernel, _request())

    assert "Forget me." not in section
    assert "Keep me." in section
    # The retake admits the fresh rows, including one created after the first request.
    assert "Arrived later." in section


def test_policy_epoch_bump_retakes(service: MemoryService) -> None:
    _remember(service, "Old fact.")
    kernel = _kernel(service)
    build_always_on_section(kernel, _request(policy_epoch=1))
    _remember(service, "New fact.")

    assert "New fact." not in build_always_on_section(kernel, _request(policy_epoch=1))
    assert "New fact." in build_always_on_section(kernel, _request(policy_epoch=2))


def test_recall_off_or_memory_off_renders_nothing(service: MemoryService) -> None:
    _remember(service, "General fact.")
    kernel = _kernel(service)

    assert build_always_on_section(kernel, _request(recall=False)) == ""
    assert build_always_on_section(kernel, _request(enabled=False)) == ""
    no_policy = SimpleNamespace(session_id="s", request_id="r", memory_policy=None)
    assert build_always_on_section(kernel, no_policy) == ""


def test_unavailable_store_renders_nothing(tmp_path: Path) -> None:
    unavailable = UnavailableMemoryStore(
        db_path=tmp_path / "memory.db", reason_code="CMP-MEM-0001", reason="test"
    )

    assert build_always_on_section(_kernel(MemoryService(unavailable)), _request()) == ""
    assert build_always_on_section(_kernel(None), _request()) == ""


def test_store_failure_fails_closed() -> None:
    class _Broken:
        def always_on_rows(self, _project_id: str) -> list[Any]:
            raise RuntimeError("boom")

    assert build_always_on_section(_kernel(_Broken()), _request()) == ""


def test_non_always_on_rows_never_render(service: MemoryService) -> None:
    _remember(service, "Recall only.", always_on=False)

    assert build_always_on_section(_kernel(service), _request()) == ""


def test_admissions_are_bounded_lru() -> None:
    admissions = AlwaysOnAdmissions()
    for index in range(MAX_ADMISSION_SESSIONS + 5):
        admissions.admit(f"s{index}", project_id=GENERAL_PROJECT_ID, policy_epoch=0,
                         fresh_rows=[])

    assert len(admissions) == MAX_ADMISSION_SESSIONS
    assert admissions.snapshot("s0") is None
    assert admissions.snapshot(f"s{MAX_ADMISSION_SESSIONS + 4}") is not None
