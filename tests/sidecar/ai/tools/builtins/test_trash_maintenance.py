"""WIDE-044 tests for ``.jenny/trash`` retention and maintenance primitives.

The trash previously had NO lifecycle at all. These pin: count/age/byte
quotas each tripped separately (injectable clock), the newest entry never
being evicted (a just-made delete stays reversible), list/purge primitives,
and delete_file applying retention automatically after every delete.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import delete_file as delete_module
from sidecar.ai.tools.builtins import trash_maintenance as trash_module
from sidecar.ai.tools.builtins.delete_file import delete_file_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, WorkspaceStoreKind

_NS_PER_DAY = 24 * 60 * 60 * 1_000_000_000


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _stamp(now: datetime, *, seconds_ago: int) -> str:
    return (now - timedelta(seconds=seconds_ago)).strftime("%Y%m%dT%H%M%S_%f")


def _seed_trash_entry(store: GuardedWorkspaceStore, stamp: str, payload: bytes) -> str:
    ref = store.resolve(WorkspaceStoreKind.TRASH, (stamp, "content.txt"))
    store.write_bytes_atomic(ref, payload)
    return stamp


class _EligibleAgeSource:
    def is_age_eligible(self, entry_name: str, created_at_ns: int) -> bool:
        del entry_name, created_at_ns
        return True


def test_list_trash_entries_is_newest_first_with_recursive_sizes(tmp_path: Path) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    older = _seed_trash_entry(store, _stamp(now, seconds_ago=300), b"a" * 10)
    newer = _seed_trash_entry(store, _stamp(now, seconds_ago=10), b"b" * 25)

    entries = trash_module.list_trash_entries(store)

    assert [entry.name for entry in entries] == [newer, older]
    by_name = {entry.name: entry for entry in entries}
    assert by_name[newer].size_bytes == 25
    assert by_name[older].size_bytes == 10
    assert all(entry.is_directory for entry in entries)


def test_count_quota_evicts_oldest_first(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(trash_module, "MAX_TRASH_ENTRIES", 2)
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    stamps = [_seed_trash_entry(store, _stamp(now, seconds_ago=age), b"x") for age in (400, 300, 200, 100)]

    outcome = trash_module.apply_trash_retention(
        store, active_use_age_source=_EligibleAgeSource()
    )

    remaining = [entry.name for entry in trash_module.list_trash_entries(store)]
    assert remaining == [stamps[3], stamps[2]], "two newest survive, oldest evicted first"
    assert sorted(outcome.evicted_names) == sorted(stamps[:2])
    assert outcome.remaining_entries == 2


def test_wall_clock_age_alone_never_evicts(tmp_path: Path) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    old = _seed_trash_entry(store, _stamp(now, seconds_ago=500), b"old")
    newer = _seed_trash_entry(store, _stamp(now, seconds_ago=100), b"new")

    injected_now = time.time_ns() + 60 * _NS_PER_DAY
    outcome = trash_module.apply_trash_retention(store, now_ns=injected_now)

    remaining = [entry.name for entry in trash_module.list_trash_entries(store)]
    assert remaining == [newer, old], "wall time alone never makes trash eligible"
    assert outcome.evicted_names == ()


def test_byte_quota_trips_separately(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(trash_module, "MAX_TRASH_TOTAL_BYTES", 60)
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    oldest = _seed_trash_entry(store, _stamp(now, seconds_ago=300), b"a" * 40)
    middle = _seed_trash_entry(store, _stamp(now, seconds_ago=200), b"b" * 30)
    newest = _seed_trash_entry(store, _stamp(now, seconds_ago=100), b"c" * 20)

    trash_module.apply_trash_retention(
        store, active_use_age_source=_EligibleAgeSource()
    )

    remaining = [entry.name for entry in trash_module.list_trash_entries(store)]
    assert remaining == [newest, middle], "oldest evicted until the aggregate fits"
    assert oldest not in remaining


def test_size_walk_cap_returns_over_quota_sentinel_and_logs_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    children = [
        SimpleNamespace(is_directory=False, size_bytes=1, ref=None)
        for _ in range(trash_module.MAX_SIZE_WALK_ENTRIES + 1)
    ]
    diagnostics: list[dict[str, object]] = []
    store = SimpleNamespace(
        list_entries=lambda _ref, *, quarantine_links: children,
    )

    def _log_event(*_args: object, **kwargs: object) -> None:
        diagnostics.append(kwargs)

    monkeypatch.setattr(trash_module, "log_event", _log_event)

    measured = trash_module._entry_total_bytes(  # noqa: SLF001
        store,
        None,
        is_directory=True,
        size_bytes=0,
    )

    assert measured == trash_module.MAX_TRASH_TOTAL_BYTES + 1
    assert diagnostics[-1]["event"] == "ai.tools.trash_maintenance.size_walk_bounded"
    assert diagnostics[-1]["data"] == {
        "max_entries": trash_module.MAX_SIZE_WALK_ENTRIES
    }


def test_newest_entry_is_never_evicted_even_when_all_quotas_are_violated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(trash_module, "MAX_TRASH_ENTRIES", 0)
    monkeypatch.setattr(trash_module, "MAX_TRASH_TOTAL_BYTES", 1)
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    only = _seed_trash_entry(store, _stamp(now, seconds_ago=5), b"x" * 100)

    injected_now = time.time_ns() + (trash_module.MAX_TRASH_AGE_DAYS + 10) * _NS_PER_DAY
    outcome = trash_module.apply_trash_retention(
        store, now_ns=injected_now, active_use_age_source=_EligibleAgeSource()
    )

    assert outcome.evicted_names == ()
    assert [entry.name for entry in trash_module.list_trash_entries(store)] == [only]


def test_purge_primitives(tmp_path: Path) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    first = _seed_trash_entry(store, _stamp(now, seconds_ago=100), b"one")
    second = _seed_trash_entry(store, _stamp(now, seconds_ago=50), b"two")

    assert trash_module.purge_trash_entry(store, first) is True
    assert trash_module.purge_trash_entry(store, first) is False, "already gone"
    assert trash_module.purge_trash_entry(store, "../escape") is False, "traversal refused"
    assert [entry.name for entry in trash_module.list_trash_entries(store)] == [second]

    _seed_trash_entry(store, _stamp(now, seconds_ago=25), b"three")
    assert trash_module.purge_trash(store) == 2
    assert trash_module.list_trash_entries(store) == ()


def test_delete_file_applies_trash_retention_automatically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        delete_module,
        "apply_trash_retention_best_effort",
        lambda _store, **_kwargs: calls.append("maintenance"),
    )
    guard = _guard(tmp_path)
    for index in range(3):
        target = tmp_path / f"doc-{index}.txt"
        target.write_text(f"body {index}\n", encoding="utf-8")
        result = delete_file_tool({"path": target.name}, guard)
        assert result.success is True

    assert calls == ["maintenance", "maintenance", "maintenance"]


class _FakeActiveUseAgeSource:
    """Minimal ``ActiveUseAgeSource`` double (WO-26): eligible iff named."""

    def __init__(self, eligible_names: frozenset[str]) -> None:
        self._eligible_names = eligible_names
        self.seen: list[str] = []

    def is_age_eligible(self, entry_name: str, created_at_ns: int) -> bool:
        del created_at_ns
        self.seen.append(entry_name)
        return entry_name in self._eligible_names


def test_active_use_age_source_wall_ancient_entry_survives_when_not_source_eligible(
    tmp_path: Path,
) -> None:
    """WO-26: age is driven entirely by the injected source, never ``now_ns``,
    whenever one is supplied -- an entry over a year old by WALL clock still
    survives if the active-use source reports it not (yet) eligible."""
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    wall_ancient = _seed_trash_entry(store, _stamp(now, seconds_ago=400 * 24 * 60 * 60), b"old")
    newest = _seed_trash_entry(store, _stamp(now, seconds_ago=1), b"new")
    source = _FakeActiveUseAgeSource(eligible_names=frozenset())  # nothing is source-eligible

    outcome = trash_module.apply_trash_retention(store, active_use_age_source=source)

    remaining = [entry.name for entry in trash_module.list_trash_entries(store)]
    assert remaining == [newest, wall_ancient]
    assert outcome.evicted_names == ()
    assert source.seen == [wall_ancient], "the newest entry is never even asked (structurally protected)"


def test_active_use_age_source_wall_fresh_non_newest_entry_is_still_evicted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mirror case: an entry created moments ago by WALL clock is still
    evicted once the active-use source reports it eligible, as long as it is
    not the single newest entry."""
    store = GuardedWorkspaceStore(tmp_path)
    now = datetime.now(UTC)
    oldest = _seed_trash_entry(store, _stamp(now, seconds_ago=10), b"oldest")
    wall_fresh_but_not_newest = _seed_trash_entry(store, _stamp(now, seconds_ago=5), b"fresh")
    newest = _seed_trash_entry(store, _stamp(now, seconds_ago=1), b"newest")
    source = _FakeActiveUseAgeSource(eligible_names=frozenset({wall_fresh_but_not_newest}))
    monkeypatch.setattr(trash_module, "MAX_TRASH_ENTRIES", 2)

    outcome = trash_module.apply_trash_retention(store, active_use_age_source=source)

    remaining = [entry.name for entry in trash_module.list_trash_entries(store)]
    assert remaining == [newest, oldest]
    assert outcome.evicted_names == (wall_fresh_but_not_newest,)


def test_retention_failure_never_fails_the_delete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(*_args: object, **_kwargs: object) -> object:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED, message="retention exploded", retryable=True
        )

    # The best-effort wrapper is delete_file's seam; break the INNER retention
    # to prove the wrapper contains it end-to-end through the real tool.
    monkeypatch.setattr(trash_module, "apply_trash_retention", _boom)
    assert delete_module.apply_trash_retention_best_effort is (
        trash_module.apply_trash_retention_best_effort
    )
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    result = delete_file_tool({"path": "notes.txt"}, _guard(tmp_path))

    assert result.success is True, "a retention failure must never undo a successful delete"
    assert not target.exists()
