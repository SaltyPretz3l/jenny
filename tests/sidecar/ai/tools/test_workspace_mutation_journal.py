from __future__ import annotations

import copy
import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any, cast

import pytest

from sidecar.ai.tools import workspace_mutation_journal_store as journal_store
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    EMPTY_SHA256,
    PathSignature,
    canonical_json_bytes,
    load_journal_schema,
    parse_record_bytes,
    seal_record,
    signature_for_path,
    validate_record,
    validate_relative_path,
    workspace_identity,
)
from sidecar.ai.tools.workspace_mutation_journal_store import (
    MAX_RECEIPT_BYTES,
    QuotaLimits,
    WorkspaceMutationJournalStore,
)


def _example() -> dict[str, Any]:
    return copy.deepcopy(cast(dict[str, Any], load_journal_schema()["examples"][0]))


def _uuid(index: int) -> str:
    return f"01990f9a-8c51-7ad2-a8be-{index:012x}"


def _timestamp(index: int) -> str:
    return f"2026-09-04T15:03:{index:02d}.120Z"


def _signature(path: Path) -> dict[str, object]:
    result = signature_for_path(path)
    assert result.ok is True
    assert result.signature is not None
    return result.signature.as_dict()


def _create_record(
    workspace: Path,
    index: int,
    *,
    state: str = "prepared",
    operation_status: str = "planned",
    relative_path: str = "nested/target.txt",
) -> dict[str, Any]:
    record = _example()
    identity = workspace_identity(workspace)
    missing = PathSignature("missing", 0, EMPTY_SHA256).as_dict()
    post = {
        "kind": "file",
        "byte_size": 5,
        "sha256": hashlib.sha256(b"after").hexdigest(),
    }
    record.update(
        {
            "change_set_id": _uuid(index),
            "state": state,
            "workspace": identity.as_dict(),
            "tool_call_ids": [f"call_{index}"],
            "operation_count": 1,
            "completed_sequences": [1] if operation_status == "applied" else [],
            "termination_reason": "turn_completed" if state == "committed" else None,
        }
    )
    record["wall_time"] = {
        "prepared_at": _timestamp(index),
        "mutation_started_at": _timestamp(index) if state == "in_progress" else None,
        "updated_at": _timestamp(index),
        "terminal_at": _timestamp(index) if state in {"committed", "rolled_back"} else None,
        "elapsed_ms": index,
    }
    record["retention"] = {
        "protected": True,
        "reserved_bytes": 0,
        "reserved_entries": 0,
        "referenced_object_ids": [],
        "created_active_use_seconds": 0,
        "last_accessed_active_use_seconds": 0,
        "active_age_seconds": 0,
        "wall_clock_review_due_at": "2027-09-04T15:03:11.120Z",
        "wall_clock_review_presented_at": None,
        "pinned_as_newest_committed": state == "committed",
    }
    record["operations"] = [
        {
            "sequence": 1,
            "status": operation_status,
            "kind": "create",
            "tool_name": "write_file",
            "tool_call_id": f"call_{index}",
            "observed_at": _timestamp(index),
            "source": None,
            "destination": {
                "relative_path": relative_path,
                "pre_signature": missing,
                "post_signature": post,
            },
            "created_parent_paths": ["nested"],
            "recovery_objects": [],
            "inverse_steps": [
                {
                    "step_id": "1.1",
                    "kind": "remove_created",
                    "from_relative_path": relative_path,
                    "to_relative_path": None,
                    "recovery_object_id": None,
                    "expected_current_signature": post,
                }
            ],
            "metadata_preservation": {
                "content_bytes": "preserved",
                "mtime": "not_preserved",
                "ctime": "not_preserved",
                "owner": "not_preserved",
                "mode": "best_effort",
                "acls": "not_preserved",
                "extended_attributes": "not_preserved",
                "alternate_data_streams": "not_preserved",
            },
            "restore_outcome": None,
            "diagnostic_code": None,
        }
    ]
    return record


def _with_recovery_bytes(record: dict[str, Any], size: int, object_id: str) -> dict[str, Any]:
    updated = copy.deepcopy(record)
    signature = {
        "kind": "file",
        "byte_size": size,
        "sha256": hashlib.sha256(object_id.encode("utf-8")).hexdigest(),
    }
    operation = updated["operations"][0]
    operation["kind"] = "modify"
    operation["tool_name"] = "edit_file"
    operation["destination"]["pre_signature"] = signature
    operation["recovery_objects"] = [
        {
            "object_id": object_id,
            "store_kind": "backup",
            "workspace_relative_path": f".jenny/backups/{object_id}.bak",
            "role": "overwritten_destination",
            "signature": signature,
        }
    ]
    updated["retention"]["reserved_bytes"] = size
    updated["retention"]["reserved_entries"] = 1
    updated["retention"]["referenced_object_ids"] = [object_id]
    return updated


def _move_record(workspace: Path, index: int) -> dict[str, Any]:
    source = workspace / "source.txt"
    source.write_bytes(b"moved")
    record = _create_record(
        workspace, index, state="in_progress", operation_status="applying"
    )
    moved = _signature(source)
    missing = PathSignature("missing", 0, EMPTY_SHA256).as_dict()
    operation = record["operations"][0]
    operation.update(
        {
            "kind": "move",
            "tool_name": "move_file",
            "source": {
                "relative_path": "source.txt",
                "pre_signature": moved,
                "post_signature": missing,
            },
            "destination": {
                "relative_path": "destination.txt",
                "pre_signature": missing,
                "post_signature": moved,
            },
            "created_parent_paths": [],
            "inverse_steps": [
                {
                    "step_id": "1.1",
                    "kind": "move_back",
                    "from_relative_path": "destination.txt",
                    "to_relative_path": "source.txt",
                    "recovery_object_id": None,
                    "expected_current_signature": moved,
                }
            ],
        }
    )
    return record


def test_design_example_schema_and_canonical_round_trip() -> None:
    sealed = seal_record(_example())
    parsed = parse_record_bytes(canonical_json_bytes(sealed))
    assert validate_record(sealed).ok is True
    assert parsed.ok is True
    assert parsed.record == sealed
    assert canonical_json_bytes(sealed).endswith(b"\n")
    assert b"\r" not in canonical_json_bytes(sealed)
    wrong_version = _example()
    wrong_version["schema_version"] = True
    assert validate_record(wrong_version).ok is False
    unsafe_restore = _example()
    unsafe_restore["operations"][0]["inverse_steps"][0]["to_relative_path"] = "cafe\u0301.txt"
    assert validate_record(unsafe_restore).ok is False
    invalid_missing = _example()
    invalid_missing["operations"][0]["source"]["post_signature"]["byte_size"] = 1
    assert validate_record(invalid_missing).ok is False


@pytest.mark.parametrize(
    "path_value,reason",
    [
        ("../escape.txt", "journal_path_invalid"),
        ("/absolute.txt", "journal_path_not_relative"),
        ("C:/drive.txt", "journal_path_not_relative"),
        ("folder/C:/drive.txt", "journal_path_not_relative"),
        ("folder\\file.txt", "journal_path_not_relative"),
        ("cafe\u0301.txt", "journal_path_not_nfc"),
    ],
)
def test_relative_paths_are_strict(path_value: str, reason: str) -> None:
    result = validate_relative_path(path_value)
    assert result.ok is False
    assert result.failure is not None
    assert result.failure.reason == reason


def test_bounded_parser_refuses_oversize_without_raising() -> None:
    result = parse_record_bytes(b"{}" * 10, byte_cap=8)
    assert result.ok is False
    assert result.failure is not None
    assert result.failure.reason == "journal_oversized"
    entry_result = parse_record_bytes(canonical_json_bytes(seal_record(_example())), entry_cap=2)
    assert entry_result.failure is not None
    assert entry_result.failure.reason == "journal_entry_cap_exceeded"


@pytest.mark.parametrize("data", [b"[" * 1100 + b"]" * 1100, b"[" + b"9" * 5000 + b"]"])
def test_bounded_parser_contains_hostile_json_failures(data: bytes) -> None:
    result = parse_record_bytes(data)
    assert result.ok is False
    assert result.failure is not None
    assert result.failure.reason == "journal_parse_failed"


def test_workspace_fingerprint_changes_when_directory_is_replaced(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    first = workspace_identity(workspace)
    workspace.rmdir()
    replacement_holder = tmp_path / "replacement"
    replacement_holder.mkdir()
    replacement_holder.replace(workspace)
    second = workspace_identity(workspace)
    assert second.real_path == first.real_path
    assert (second.device_id, second.file_id) != (first.device_id, first.file_id)
    assert second.fingerprint != first.fingerprint
    assert second.workspace_id != first.workspace_id


def test_file_directory_missing_symlink_and_other_signatures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    file_path = tmp_path / "data.bin"
    file_path.write_bytes(b"abc")
    directory = tmp_path / "tree"
    directory.mkdir()
    (directory / "child.txt").write_bytes(b"child")
    missing = signature_for_path(tmp_path / "missing")
    file_result = signature_for_path(file_path)
    directory_result = signature_for_path(directory)
    assert missing.signature == PathSignature("missing", 0, EMPTY_SHA256)
    assert file_result.signature == PathSignature(
        "file", 3, hashlib.sha256(b"abc").hexdigest()
    )
    assert directory_result.signature == PathSignature(
        "directory", 5, "e5010dff46ae04341295d418bcf792d60e1f7da28f40bbad00fd2b420558e7f8"
    )
    link = tmp_path / "synthetic-link"
    original_lstat = Path.lstat
    def _link_lstat(candidate: Path) -> os.stat_result:
        if candidate == link:
            values = list(original_lstat(file_path))
            values[0] = stat.S_IFLNK
            return os.stat_result(values)
        return original_lstat(candidate)
    monkeypatch.setattr(Path, "lstat", _link_lstat)
    monkeypatch.setattr(os, "readlink", lambda candidate: "target" if candidate == link else "")
    symlink_result = signature_for_path(link)
    assert symlink_result.signature == PathSignature(
        "symlink", 6, hashlib.sha256(b"target").hexdigest()
    )
    class _JunctionStat:
        st_mode = stat.S_IFDIR
        st_reparse_tag = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)
    monkeypatch.setattr(Path, "lstat", lambda candidate: _JunctionStat() if candidate == link else original_lstat(candidate))
    junction_result = signature_for_path(link)
    assert junction_result.signature == PathSignature(
        "junction", 6, hashlib.sha256(b"target").hexdigest()
    )
    assert journal_store._is_junction(link) is True
    def _fifo_lstat(candidate: Path) -> os.stat_result:
        if candidate == file_path:
            values = list(original_lstat(candidate))
            values[0] = stat.S_IFIFO
            return os.stat_result(values)
        return original_lstat(candidate)
    monkeypatch.setattr(Path, "lstat", _fifo_lstat)
    other_result = signature_for_path(file_path)
    assert other_result.signature == PathSignature(
        "other", 0, hashlib.sha256(b"jenny-other-v1\0").hexdigest()
    )


def test_store_rejects_checksum_corruption_without_raising(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    record = _create_record(workspace, 1, state="committed", operation_status="applied")
    result = store.write_transition(record, workspace_root=workspace)
    assert result.ok is True
    path = store.journal_path(record["workspace"]["workspace_id"], record["change_set_id"])
    data = path.read_bytes().replace(b"turn_completed", b"turn_cancelled")
    path.write_bytes(data)
    loaded = store.load(record["workspace"]["workspace_id"], record["change_set_id"])
    assert loaded.ok is False
    assert loaded.failure is not None
    assert loaded.failure.reason == "journal_checksum_mismatch"


def test_startup_cleans_only_aged_orphan_temps(tmp_path: Path) -> None:
    recovery = tmp_path / "recovery"
    workspace_id = "ws_" + "1" * 32
    change_set_id = _uuid(2)
    set_path = recovery / "v1" / workspace_id / change_set_id
    set_path.mkdir(parents=True)
    temp_path = set_path / "journal.json.crash.tmp"
    temp_path.write_text("partial", encoding="utf-8")
    WorkspaceMutationJournalStore(recovery)
    assert temp_path.exists() is True
    old = temp_path.stat().st_mtime - 600
    os.utime(temp_path, (old, old))
    WorkspaceMutationJournalStore(recovery)
    assert temp_path.exists() is False


def test_first_write_fsyncs_new_store_hierarchy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    recovery = tmp_path / "recovery"
    synced: list[Path] = []
    monkeypatch.setattr(journal_store, "_fsync_directory", lambda path: synced.append(path.absolute()))
    result = WorkspaceMutationJournalStore(recovery).write_transition(_create_record(workspace, 2))
    assert result.ok is True
    assert (recovery / "v1").absolute() in synced
    assert (recovery / "v1" / workspace_identity(workspace).workspace_id).absolute() in synced


@pytest.mark.parametrize(
    "case",
    [
        ("prepared", "planned", None, "rolled_back", "planned"),
        ("prepared", "planned", b"changed", "interrupted", "planned"),
        ("in_progress", "planned", None, "interrupted", "planned"),
        ("in_progress", "applying", None, "interrupted", "planned"),
        ("in_progress", "applying", b"after", "interrupted", "applied"),
        ("in_progress", "applying", b"other", "interrupted", "unknown"),
        ("in_progress", "applied", b"after", "interrupted", "applied"),
    ],
)
def test_startup_reconciliation_table(
    tmp_path: Path,
    case: tuple[str, str, bytes | None, str, str],
) -> None:
    durable_state, operation_status, workspace_bytes, expected_state, expected_status = case
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    record = _create_record(
        workspace, 3, state=durable_state, operation_status=operation_status
    )
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    assert store.write_transition(record).ok is True
    target = workspace / "nested" / "target.txt"
    if workspace_bytes is not None:
        target.parent.mkdir(parents=True)
        target.write_bytes(workspace_bytes)

    reconciled = WorkspaceMutationJournalStore(tmp_path / "recovery").reconcile_workspace(workspace)

    assert len(reconciled) == 1
    assert reconciled[0].ok is True
    assert reconciled[0].record is not None
    assert reconciled[0].record["state"] == expected_state
    assert reconciled[0].record["operations"][0]["status"] == expected_status


@pytest.mark.parametrize("terminal_state", ["committed", "rolled_back", "interrupted"])
def test_reconciliation_leaves_terminal_states_unchanged(
    tmp_path: Path, terminal_state: str
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    status = "applied" if terminal_state == "committed" else "planned"
    record = _create_record(workspace, 4, state=terminal_state, operation_status=status)
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    assert store.write_transition(record).ok is True

    assert store.reconcile_workspace(workspace) == ()


def test_crash_hook_runs_after_durable_in_progress_flush(tmp_path: Path) -> None:
    class InjectedCrash(Exception):
        pass

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    record = _create_record(workspace, 5, state="in_progress", operation_status="applying")

    def _crash() -> None:
        raise InjectedCrash

    store = WorkspaceMutationJournalStore(
        tmp_path / "recovery",
        after_in_progress_flush_before_first_workspace_mutation=_crash,
    )
    with pytest.raises(InjectedCrash):
        store.write_transition(record, workspace_root=workspace)
    assert (workspace / "nested").exists() is False
    loaded = WorkspaceMutationJournalStore(tmp_path / "recovery").load(
        record["workspace"]["workspace_id"], record["change_set_id"]
    )
    assert loaded.ok is True
    reconciled = WorkspaceMutationJournalStore(tmp_path / "recovery").reconcile_workspace(workspace)
    assert reconciled[0].record is not None
    assert reconciled[0].record["state"] == "interrupted"
    assert reconciled[0].record["completed_sequences"] == []
    other_workspace = tmp_path / "other-workspace"
    other_workspace.mkdir()
    refused = store.complete_no_effect_rollback(
        record["workspace"]["workspace_id"], record["change_set_id"], workspace_root=other_workspace
    )
    assert refused.failure is not None and refused.failure.reason == "workspace_identity_changed"
    rolled_back = WorkspaceMutationJournalStore(
        tmp_path / "recovery"
    ).complete_no_effect_rollback(
        record["workspace"]["workspace_id"],
        record["change_set_id"],
        workspace_root=workspace,
    )
    assert rolled_back.ok is True
    assert rolled_back.record is not None
    assert rolled_back.record["state"] == "rolled_back"
    assert rolled_back.record["operations"][0]["status"] == "skipped"


def test_reconciliation_marks_mixed_move_endpoints_unknown(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    record = _move_record(workspace, 15)
    explorer = copy.deepcopy(record)
    explorer.update({"actor": "explorer", "session_id": None, "turn_id": None, "tool_call_ids": []})
    explorer["operations"][0]["tool_name"] = "explorer_rename"
    assert validate_record(explorer).ok is True
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    assert store.write_transition(record).ok is True
    (workspace / "source.txt").unlink()
    (workspace / "destination.txt").write_bytes(b"unexpected")
    reconciled = WorkspaceMutationJournalStore(tmp_path / "recovery").reconcile_workspace(workspace)
    assert reconciled[0].record is not None
    assert reconciled[0].record["state"] == "interrupted"
    assert reconciled[0].record["operations"][0]["status"] == "unknown"


def test_entry_quota_evicts_oldest_eligible_and_keeps_newest_committed(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    recovery = tmp_path / "recovery"
    setup = WorkspaceMutationJournalStore(recovery)
    committed = _create_record(workspace, 6, state="committed", operation_status="applied")
    rolled_one = _create_record(workspace, 7, state="rolled_back")
    rolled_two = _create_record(workspace, 8, state="rolled_back")
    rolled_one["retention"]["active_age_seconds"] = 2_592_000
    rolled_two["retention"]["active_age_seconds"] = 2_592_000
    for record in (committed, rolled_one, rolled_two):
        assert setup.write_transition(record).ok is True
    evicted: list[str] = []
    limited = WorkspaceMutationJournalStore(
        recovery,
        quotas=QuotaLimits(max_change_sets=2),
        on_evict=lambda _workspace_id, change_set_id: evicted.append(change_set_id),
    )
    incoming = _create_record(workspace, 9)
    result = limited.write_transition(incoming)
    assert result.ok is True
    assert evicted == [rolled_one["change_set_id"], rolled_two["change_set_id"]]
    assert limited.load(committed["workspace"]["workspace_id"], committed["change_set_id"]).ok
    assert limited.load(incoming["workspace"]["workspace_id"], incoming["change_set_id"]).ok


def test_failed_quota_reservation_does_not_evict_eligible_sets(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    recovery = tmp_path / "recovery"
    setup = WorkspaceMutationJournalStore(recovery)
    committed = _create_record(workspace, 16, state="committed", operation_status="applied")
    eligible = _create_record(workspace, 17, state="rolled_back")
    eligible["retention"]["active_age_seconds"] = 2_592_000
    assert setup.write_transition(committed).ok is True
    assert setup.write_transition(eligible).ok is True
    limited = WorkspaceMutationJournalStore(recovery, quotas=QuotaLimits(max_change_sets=1))
    result = limited.write_transition(_create_record(workspace, 18))
    assert result.ok is False
    assert limited.load(eligible["workspace"]["workspace_id"], eligible["change_set_id"]).ok
    eligible["retention"]["active_age_seconds"] = 0
    assert setup.write_transition(eligible).ok is True
    fresh_result = WorkspaceMutationJournalStore(
        recovery, quotas=QuotaLimits(max_change_sets=2)
    ).write_transition(_create_record(workspace, 19))
    assert fresh_result.ok is False


def test_recovery_byte_quota_counts_unique_objects_and_evicts_oldest(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    recovery = tmp_path / "recovery"
    setup = WorkspaceMutationJournalStore(recovery)
    committed = _with_recovery_bytes(
        _create_record(workspace, 10, state="committed", operation_status="applied"), 9, "shared"
    )
    eligible = _with_recovery_bytes(
        _create_record(workspace, 11, state="rolled_back"), 5, "eligible"
    )
    eligible["retention"]["active_age_seconds"] = 2_592_000
    assert setup.write_transition(committed).ok is True
    assert setup.write_transition(eligible).ok is True
    limited = WorkspaceMutationJournalStore(
        recovery,
        quotas=QuotaLimits(max_recovery_object_bytes=13),
    )
    incoming = _with_recovery_bytes(_create_record(workspace, 12), 9, "shared")
    result = limited.write_transition(incoming)
    assert result.ok is True
    assert result.evicted_change_set_ids == (eligible["change_set_id"],)
    assert limited.load(committed["workspace"]["workspace_id"], committed["change_set_id"]).ok


def test_pins_include_protected_references_and_restore_occupants(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    record = _with_recovery_bytes(_create_record(workspace, 13), 4, "backup:one")
    occupant = copy.deepcopy(record["operations"][0]["recovery_objects"][0])
    occupant["object_id"] = "backup:occupant"
    occupant["role"] = "protected_occupant"
    record["restore"]["status"] = "in_progress"
    record["restore"]["protected_occupants"] = [occupant]
    record["retention"]["reserved_bytes"] = 8
    record["retention"]["reserved_entries"] = 2
    record["retention"]["referenced_object_ids"].append("backup:occupant")
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    assert store.write_transition(record).ok is True
    pins = store.pinned_recovery_object_ids(record["workspace"]["workspace_id"])
    assert pins == frozenset({"backup:one", "backup:occupant"})
    assert store.is_recovery_object_pinned("backup:one") is True
    assert store.is_recovery_object_pinned("backup:missing") is False


def test_receipt_is_bounded_non_authoritative_and_has_no_absolute_store_path(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    record = _create_record(workspace, 14, state="committed", operation_status="applied")
    record["coverage"]["known_unjournaled_events"] = [f"call_{index:04d}" for index in range(1000)]
    record["coverage"]["partially_undoable"] = True
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    result = store.write_transition(record, workspace_root=workspace)
    receipt_path = workspace / ".jenny" / "workspace-recovery.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert result.ok is True
    assert receipt_path.stat().st_size <= MAX_RECEIPT_BYTES
    assert receipt["latest_change_set_id"] == record["change_set_id"]
    assert receipt["coverage"]["partially_undoable"] is True
    assert str(tmp_path / "recovery") not in receipt["authoritative_store"]
