from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from sidecar.ai.routing import resource_pressure
from sidecar.ai.routing.resource_pressure import (
    PressureBackoffDecision,
    apply_tool_pressure_backoff,
    build_resource_pressure_decision,
    build_tool_pressure_backoff_decision,
)
from sidecar.runtime import system_pressure

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


def test_apply_tool_pressure_backoff_sleeps_and_audits_when_pressured() -> None:
    sleeps: list[float] = []
    audits: list[tuple[str, dict[str, object]]] = []
    runtime = SimpleNamespace(
        raise_if_cancelled=lambda: None,
        audit=lambda kind, **payload: audits.append((kind, payload)),
    )
    decision = PressureBackoffDecision(
        should_backoff=True,
        delay_seconds=0.1,
        severity="warning",
        warnings=("cpu_saturation_high",),
        snapshot={"status": "pressured"},
    )

    apply_tool_pressure_backoff(
        tool_name="read_file",
        request_id="req-pressure",
        session_id="session-pressure",
        runtime=runtime,
        decision=decision,
        sleep=sleeps.append,
    )

    assert sleeps == [0.1]
    assert audits
    assert audits[0][0] == "tool_pressure_backoff"
    assert audits[0][1]["tool_name"] == "read_file"


def test_resource_pressure_decision_disables_only_on_explicit_flag_false(tmp_path) -> None:
    enabled = SimpleNamespace(feature_flags={})
    disabled = SimpleNamespace(feature_flags={"resource_discipline": False})

    assert build_resource_pressure_decision(config=enabled, root=tmp_path).status != "disabled"
    assert build_resource_pressure_decision(config=disabled, root=tmp_path).status == "disabled"


def test_ratio_only_disk_pressure_is_mild_without_backoff_or_warning(
    monkeypatch,
    tmp_path,
    caplog,
) -> None:
    _set_pressure_probes(monkeypatch, total_bytes=999 * GIB, free_bytes=48 * GIB)
    runtime = SimpleNamespace(
        raise_if_cancelled=lambda: None,
        audit=lambda *_args, **_kwargs: None,
    )
    sleeps: list[float] = []
    decision = build_tool_pressure_backoff_decision(
        config=SimpleNamespace(feature_flags={}),
        root=tmp_path,
    )
    caplog.set_level(logging.INFO, logger=resource_pressure.__name__)

    for tool_name in ("read_file", "search_files"):
        apply_tool_pressure_backoff(
            tool_name=tool_name,
            request_id="req-ratio-only",
            session_id="session-pressure",
            runtime=runtime,
            decision=decision,
            sleep=sleeps.append,
        )

    records = [record for record in caplog.records if record.name == resource_pressure.__name__]
    assert decision.severity == "mild"
    assert decision.should_backoff is False
    assert decision.delay_seconds == 0.0
    assert sleeps == []
    assert [record.levelno for record in records] == [logging.INFO]


@pytest.mark.parametrize(
    ("total_bytes", "free_bytes"),
    [
        (999 * GIB, int(1.5 * GIB)),
        (20 * GIB, int(1.5 * GIB)),
    ],
)
def test_low_disk_bytes_keep_severe_backoff_and_warning(
    monkeypatch,
    tmp_path,
    caplog,
    total_bytes: int,
    free_bytes: int,
) -> None:
    _set_pressure_probes(
        monkeypatch,
        total_bytes=total_bytes,
        free_bytes=free_bytes,
    )
    sleeps: list[float] = []
    decision = build_tool_pressure_backoff_decision(
        config=SimpleNamespace(feature_flags={}),
        root=tmp_path,
    )
    caplog.set_level(logging.WARNING, logger=resource_pressure.__name__)

    apply_tool_pressure_backoff(
        tool_name="read_file",
        request_id="req-low-bytes",
        session_id="session-pressure",
        runtime=None,
        decision=decision,
        sleep=sleeps.append,
    )

    records = [record for record in caplog.records if record.name == resource_pressure.__name__]
    assert decision.severity == "severe"
    assert decision.should_backoff is True
    assert decision.delay_seconds == 0.25
    assert sleeps == [0.25]
    assert [record.levelno for record in records] == [logging.WARNING]
