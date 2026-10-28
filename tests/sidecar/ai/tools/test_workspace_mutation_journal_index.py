"""Batch 3 / C7 journal review: the per-workspace usage index, the cached
schema, and journals whose ids differ from their directory."""

from __future__ import annotations

import copy
import shutil
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.tools import workspace_mutation_journal_contract as contract
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    load_journal_schema,
    validate_record,
    workspace_identity,
)
from sidecar.ai.tools.workspace_mutation_journal_store import (
    MAX_INDEXED_WORKSPACES,
    QuotaLimits,
    WorkspaceMutationJournalStore,
)
from tests.sidecar.ai.tools.test_workspace_mutation_journal import _create_record, _example

_ELIGIBLE_AGE = 2_592_000


def _store_with_sets(tmp_path: Path, count: int) -> tuple[Path, WorkspaceMutationJournalStore, list[dict[str, Any]]]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    records = [_create_record(workspace, index, state="rolled_back") for index in range(1, count + 1)]
    for record in records:
        assert store.write_transition(record).ok is True
    return workspace, store, records


def _count_loads(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    loads: list[str] = []
    original = WorkspaceMutationJournalStore.load

    def counting(self: WorkspaceMutationJournalStore, workspace_id: str, change_set_id: str) -> Any:
        loads.append(change_set_id)
        return original(self, workspace_id, change_set_id)

    monkeypatch.setattr(WorkspaceMutationJournalStore, "load", counting)
    return loads


def test_a_transition_after_a_warm_scan_reads_only_its_own_journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace, store, records = _store_with_sets(tmp_path, 8)
    assert len(store._scan_workspace(workspace_identity(workspace).workspace_id)) == 8  # warm
    loads = _count_loads(monkeypatch)

    target = copy.deepcopy(records[3])
    target["retention"]["active_age_seconds"] = 60
    assert store.write_transition(target).ok is True

    # The previous-state read and the post-write verification, never the other 7.
    assert set(loads) == {target["change_set_id"]}
    assert len(loads) <= 3


def test_the_usage_index_keeps_only_the_newest_workspaces(tmp_path: Path) -> None:
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    ids = [f"ws_{index:032x}" for index in range(MAX_INDEXED_WORKSPACES + 5)]
    for workspace_id in ids:
        (store.version_root / workspace_id).mkdir(parents=True)
        store._scan_workspace(workspace_id)

    assert list(store._scan_cache) == ids[5:]

    store._scan_workspace(ids[5])  # a re-scan moves the workspace to the newest slot
    assert list(store._scan_cache)[-1] == ids[5]
    assert len(store._scan_cache) == MAX_INDEXED_WORKSPACES


def test_the_index_follows_a_journal_rewritten_by_another_store(tmp_path: Path) -> None:
    workspace, warm, records = _store_with_sets(tmp_path, 3)
    workspace_id = workspace_identity(workspace).workspace_id
    assert [item.record["retention"]["active_age_seconds"] for item in warm._scan_workspace(workspace_id)] == [0, 0, 0]
    other = WorkspaceMutationJournalStore(tmp_path / "recovery")  # another process
    changed = copy.deepcopy(records[1])
    changed["retention"]["active_age_seconds"] = _ELIGIBLE_AGE
    assert other.write_transition(changed).ok is True

    ages = {item.change_set_id: item.record["retention"]["active_age_seconds"]
            for item in warm._scan_workspace(workspace_id)}

    assert ages[changed["change_set_id"]] == _ELIGIBLE_AGE
    shutil.rmtree(other.version_root / workspace_id / records[2]["change_set_id"])
    assert records[2]["change_set_id"] not in {item.change_set_id for item in warm._scan_workspace(workspace_id)}


def test_an_open_set_lookup_hands_out_a_copy_of_the_indexed_record(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    record = _create_record(workspace, 4)
    assert store.write_transition(record).ok is True
    found = store.find_open_change_set(workspace, session_id=record["session_id"], turn_id=record["turn_id"])
    assert found.record is not None
    found.record["state"] = "mutated by the caller"

    again = store.find_open_change_set(workspace, session_id=record["session_id"], turn_id=record["turn_id"])

    assert again.record is not None and again.record["state"] == "prepared"


def test_a_journal_copied_into_another_workspace_directory_is_ignored(tmp_path: Path) -> None:
    first, store, records = _store_with_sets(tmp_path, 1)
    second = tmp_path / "second"
    second.mkdir()
    eligible = copy.deepcopy(records[0])
    eligible["retention"]["active_age_seconds"] = _ELIGIBLE_AGE
    assert store.write_transition(eligible).ok is True
    second_id = workspace_identity(second).workspace_id
    source = store.version_root / workspace_identity(first).workspace_id / eligible["change_set_id"]
    shutil.copytree(source, store.version_root / second_id / eligible["change_set_id"])
    limited = WorkspaceMutationJournalStore(tmp_path / "recovery", quotas=QuotaLimits(max_change_sets=1))

    assert limited._scan_workspace(second_id) == []
    # Formerly the copy counted against the quota, eviction refused to remove it
    # (its record names another workspace) and every transition here failed.
    result = limited.write_transition(_create_record(second, 2))

    assert result.ok is True
    assert result.evicted_change_set_ids == ()


def test_a_journal_copied_under_another_set_name_is_ignored(tmp_path: Path) -> None:
    workspace, store, records = _store_with_sets(tmp_path, 1)
    workspace_dir = store.version_root / workspace_identity(workspace).workspace_id
    stray = "01990f9a-8c51-7ad2-a8be-0000000000ff"
    shutil.copytree(workspace_dir / records[0]["change_set_id"], workspace_dir / stray)

    scanned = [item.change_set_id for item in store._scan_workspace(workspace_dir.name)]

    assert scanned == [records[0]["change_set_id"]]
    assert store.write_transition(_create_record(workspace, 3)).ok is True


def test_the_schema_file_is_read_once_and_callers_get_private_copies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract._cached_journal_schema.cache_clear()
    reads: list[Path] = []
    original_read_text = Path.read_text

    def counting_read_text(self: Path, *args: Any, **kwargs: Any) -> str:
        if self.name == "workspace-mutation-journal-v1.schema.json":
            reads.append(self)
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counting_read_text)
    example = _example()
    first = load_journal_schema()
    first["$comment"] = "mutated by a caller"
    second = load_journal_schema()

    assert second.get("$comment") != "mutated by a caller"
    assert validate_record(example).ok == validate_record(copy.deepcopy(example)).ok
    assert len(reads) == 1
