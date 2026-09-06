from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from sidecar.runtime import system_pressure
from sidecar.runtime.system_pressure import build_system_pressure_snapshot

GIB = 1024**3


def _set_pressure_probes(monkeypatch, *, total_bytes: int, free_bytes: int) -> None:
    monkeypatch.setattr(
        system_pressure.shutil,
        "disk_usage",
        lambda _target: SimpleNamespace(
            total=total_bytes,
            used=total_bytes - free_bytes,
            free=free_bytes,
        ),
    )
    monkeypatch.setattr(
        system_pressure,
        "psutil",
        SimpleNamespace(
            cpu_percent=lambda interval=None: 10.0,
            virtual_memory=lambda: SimpleNamespace(
                total=100 * GIB,
                available=50 * GIB,
                used=50 * GIB,
                percent=50.0,
            ),
        ),
    )


def test_system_pressure_snapshot_reports_ratio_only_disk_pressure_as_mild(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _set_pressure_probes(monkeypatch, total_bytes=999 * GIB, free_bytes=48 * GIB)

    payload = build_system_pressure_snapshot(root=tmp_path).to_payload()

    assert payload["status"] == "pressured"
    assert payload["disk"]["pressured"] is True
    assert payload["disk"]["reason"] == "disk_free_ratio_low"
    assert payload["warnings"] == ["disk_free_ratio_low"]


def test_system_pressure_snapshot_reports_low_disk_bytes_as_severe(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _set_pressure_probes(
        monkeypatch,
        total_bytes=999 * GIB,
        free_bytes=int(1.5 * GIB),
    )

    payload = build_system_pressure_snapshot(root=tmp_path).to_payload()

    assert payload["disk"]["reason"] == "disk_free_bytes_low"
    assert payload["warnings"] == ["disk_free_bytes_low"]


def test_system_pressure_snapshot_severe_floor_does_not_widen_pressure(
    monkeypatch,
    tmp_path: Path,
) -> None:
    # 5 GiB free of 20 GiB (25 %) is under the 10 GiB severity floor but was
    # never pressured (>= 2 GiB and >= 8 %); the floor must not change that.
    _set_pressure_probes(monkeypatch, total_bytes=20 * GIB, free_bytes=5 * GIB)

    payload = build_system_pressure_snapshot(root=tmp_path).to_payload()

    assert payload["disk"]["pressured"] is False
    assert payload["disk"]["reason"] == ""
    assert payload["warnings"] == []


def test_system_pressure_snapshot_small_disk_low_bytes_is_severe(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _set_pressure_probes(monkeypatch, total_bytes=20 * GIB, free_bytes=int(1.5 * GIB))

    payload = build_system_pressure_snapshot(root=tmp_path).to_payload()

    assert payload["disk"]["reason"] == "disk_free_bytes_low"
    assert payload["warnings"] == ["disk_free_bytes_low"]


def test_system_pressure_snapshot_reports_disk_pressure(tmp_path: Path) -> None:
    snapshot = build_system_pressure_snapshot(
        root=tmp_path,
        min_free_bytes=10**18,
        min_free_ratio=0.99,
    )

    payload = snapshot.to_payload()

    assert payload["status"] == "pressured"
    assert payload["disk"]["pressured"] is True
    assert payload["disk"]["free_bytes"] >= 0
    assert payload["warnings"]


def test_system_pressure_snapshot_handles_missing_root(tmp_path: Path) -> None:
    missing = tmp_path / "missing" / "child"

    snapshot = build_system_pressure_snapshot(root=missing)

    assert snapshot.disk.path == str(tmp_path)
    assert snapshot.to_payload()["status"] in {"ok", "pressured", "unknown"}


def test_system_pressure_snapshot_includes_psutil_cpu_and_memory(monkeypatch, tmp_path: Path) -> None:
    fake_psutil = SimpleNamespace(
        cpu_percent=lambda interval=None: 91.25,
        virtual_memory=lambda: SimpleNamespace(
            total=1000,
            available=75,
            used=925,
            percent=92.5,
        ),
    )
    monkeypatch.setattr(system_pressure, "psutil", fake_psutil, raising=False)

    snapshot = build_system_pressure_snapshot(root=tmp_path)
    payload = snapshot.to_payload()

    assert payload["status"] == "pressured"
    assert payload["cpu"]["percent"] == 91.25
    assert payload["cpu"]["pressured"] is True
    assert payload["memory"]["percent"] == 92.5
    assert payload["memory"]["available_ratio"] == 0.075
    assert payload["memory"]["pressured"] is True
    assert "cpu_saturation_high" in payload["warnings"]
    assert "memory_available_low" in payload["warnings"]
