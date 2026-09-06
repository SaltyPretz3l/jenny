from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sidecar.runtime.monitor_status import (
    MAX_MONITOR_STATUS_BYTES,
    MonitorStatusError,
    MonitorStatusStore,
    decode_monitor_status,
    encode_monitor_status,
)

MONITOR_ID = "mon_abcdef012345"


def _status_payload(
    *,
    monitor_id: str = MONITOR_ID,
    state: str = "running",
    persistent: bool = True,
) -> dict[str, object]:
    terminal = state != "running"
    return {
        "version": 1,
        "monitor_id": monitor_id,
        "description": "test monitor",
        "state": state,
        "persistent": persistent,
        "timeout_ms": 5_000,
        "event_count": 0,
        "dropped_event_count": 0,
        "suppressed_event_count": 0,
        "events": [],
        "terminal_reason": "exit" if terminal else None,
        "exit_code": 0 if terminal else None,
        "success": True if terminal else None,
        "started_at": "2026-07-12T12:00:00.000Z",
        "updated_at": "2026-07-12T12:00:01.000Z",
        "terminal": terminal,
    }


def test_monitor_status_codec_round_trips_strict_versioned_object() -> None:
    payload = _status_payload(state="completed")

    # The salience-gate keys are additive-optional on read and ALWAYS written, so a
    # record that omits them is upgraded (to gate-enabled) as it round-trips.
    assert decode_monitor_status(
        encode_monitor_status(payload, expected_monitor_id=MONITOR_ID),
        expected_monitor_id=MONITOR_ID,
    ) == {
        **payload,
        "salience_gate_disabled": False,
        "salience_gate_disabled_reason": None,
    }


@pytest.mark.parametrize(
    "raw",
    [
        b"[]",
        b'"scalar"',
        b"{not-json",
        b'{"version":1,"version":1}',
        b'{"version":NaN}',
    ],
)
def test_monitor_status_codec_rejects_non_object_or_non_strict_json(raw: bytes) -> None:
    with pytest.raises(MonitorStatusError):
        decode_monitor_status(raw)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("version", 2),
        ("event_count", "many"),
        ("event_count", -1),
        ("suppressed_event_count", 1),
        ("timeout_ms", 1),
        ("terminal", "false"),
        ("events", {}),
    ],
)
def test_monitor_status_codec_rejects_future_or_malformed_fields(
    field: str,
    value: object,
) -> None:
    payload = _status_payload()
    payload[field] = value

    with pytest.raises(MonitorStatusError):
        encode_monitor_status(payload, expected_monitor_id=MONITOR_ID)


@pytest.mark.parametrize(
    ("event_count", "dropped_event_count", "suppressed_event_count"),
    [(3, 1, 1), (1, 1, 1)],
    ids=["over_counted", "under_counted"],
)
def test_monitor_status_codec_rejects_impossible_counter_totals(
    event_count: int,
    dropped_event_count: int,
    suppressed_event_count: int,
) -> None:
    payload = _status_payload()
    payload.update(
        event_count=event_count,
        dropped_event_count=dropped_event_count,
        suppressed_event_count=suppressed_event_count,
    )

    with pytest.raises(MonitorStatusError, match="counters are inconsistent"):
        encode_monitor_status(payload, expected_monitor_id=MONITOR_ID)


def test_monitor_status_store_round_trips_and_lists_valid_record(tmp_path: Path) -> None:
    store = MonitorStatusStore(tmp_path / "runtime")
    payload = _status_payload()

    store.write(MONITOR_ID, payload)

    assert store.read(MONITOR_ID) == {
        **payload,
        "salience_gate_disabled": False,
        "salience_gate_disabled_reason": None,
    }
    assert store.list_record_ids() == [MONITOR_ID]
    stored = store.read_with_mtime(MONITOR_ID)
    assert stored is not None and stored[1] > 0


def test_monitor_status_store_rejects_oversized_status_file(tmp_path: Path) -> None:
    store = MonitorStatusStore(tmp_path / "runtime")
    record_dir = store.record_path(MONITOR_ID)
    record_dir.mkdir()
    (record_dir / "status.json").write_bytes(b"x" * (MAX_MONITOR_STATUS_BYTES + 1))

    with pytest.raises(MonitorStatusError, match="read safely"):
        store.read(MONITOR_ID)


def test_monitor_status_store_rejects_identity_mismatch(tmp_path: Path) -> None:
    store = MonitorStatusStore(tmp_path / "runtime")
    payload = _status_payload(monitor_id="mon_111111111111")

    with pytest.raises(MonitorStatusError, match="identity"):
        store.write(MONITOR_ID, payload)


def test_monitor_status_store_rejects_linked_status_leaf_without_touching_target(
    tmp_path: Path,
) -> None:
    store = MonitorStatusStore(tmp_path / "runtime")
    record_dir = store.record_path(MONITOR_ID)
    record_dir.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text("sentinel", encoding="utf-8")
    try:
        os.symlink(outside, record_dir / "status.json")
    except (NotImplementedError, OSError) as error:
        pytest.skip(f"file symlinks unavailable: {error}")

    with pytest.raises(MonitorStatusError):
        store.read(MONITOR_ID)
    with pytest.raises(MonitorStatusError):
        store.write(MONITOR_ID, _status_payload())

    assert outside.read_text(encoding="utf-8") == "sentinel"


def test_monitor_status_store_rejects_linked_record_directory(tmp_path: Path) -> None:
    store = MonitorStatusStore(tmp_path / "runtime")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "status.json").write_text(
        json.dumps(_status_payload()),
        encoding="utf-8",
    )
    try:
        os.symlink(outside, store.record_path(MONITOR_ID), target_is_directory=True)
    except (NotImplementedError, OSError) as error:
        pytest.skip(f"directory symlinks unavailable: {error}")

    with pytest.raises(MonitorStatusError, match="unsafe"):
        store.read(MONITOR_ID)

    assert store.list_record_ids() == []
    assert json.loads((outside / "status.json").read_text(encoding="utf-8")) == _status_payload()


def test_monitor_status_store_delete_renames_before_recursive_cleanup(tmp_path: Path) -> None:
    store = MonitorStatusStore(tmp_path / "runtime")
    store.write(MONITOR_ID, _status_payload(state="completed"))

    assert store.delete_record(MONITOR_ID) is True
    assert store.read(MONITOR_ID) is None
    assert store.delete_record(MONITOR_ID) is False
