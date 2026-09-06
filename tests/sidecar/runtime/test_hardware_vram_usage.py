"""Tests for sidecar.runtime.hardware_vram_usage."""

from __future__ import annotations

import subprocess

from sidecar.runtime.hardware_vram_usage import get_vram_usage


def test_get_vram_usage_reports_nvidia_smi_totals(monkeypatch) -> None:
    def _fake_run(args: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        assert args == [
            "nvidia-smi",
            "--query-gpu=memory.used,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits",
        ]
        return subprocess.CompletedProcess(
            args=["nvidia-smi"],
            returncode=0,
            stdout="1024, 8192, 37\n512, 4096, 68\n",
            stderr="",
        )

    monkeypatch.setattr(
        "sidecar.runtime.hardware_vram_usage.subprocess.run",
        _fake_run,
    )

    payload = get_vram_usage()

    assert payload["available"] is True
    assert payload["used_mb"] == 1536
    assert payload["total_mb"] == 12288
    assert payload["util_available"] is True
    assert payload["util_percent"] == 68
    assert payload["gpu_type"] == "cuda"
    assert payload["source"] == "nvidia-smi"
    assert isinstance(payload["sampled_at"], str)


def test_get_vram_usage_keeps_memory_when_utilization_is_unavailable(monkeypatch) -> None:
    def _fake_run(*_args, **_kwargs) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["nvidia-smi"],
            returncode=0,
            stdout="1024, 8192, [N/A]\n",
            stderr="",
        )

    monkeypatch.setattr(
        "sidecar.runtime.hardware_vram_usage.subprocess.run",
        _fake_run,
    )

    payload = get_vram_usage()

    assert payload["available"] is True
    assert payload["used_mb"] == 1024
    assert payload["total_mb"] == 8192
    assert payload["util_available"] is False
    assert payload["util_percent"] == 0


def test_get_vram_usage_returns_unavailable_on_timeout(monkeypatch) -> None:
    def _fake_run(*_args, **_kwargs) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=1.0)

    monkeypatch.setattr(
        "sidecar.runtime.hardware_vram_usage.subprocess.run",
        _fake_run,
    )

    payload = get_vram_usage()

    assert payload["available"] is False
    assert payload["used_mb"] == 0
    assert payload["total_mb"] == 0
    assert payload["util_available"] is False
    assert payload["util_percent"] == 0
    assert payload["source"] == "nvidia-smi"


def test_get_vram_usage_returns_unavailable_on_invalid_output(monkeypatch) -> None:
    def _fake_run(*_args, **_kwargs) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["nvidia-smi"],
            returncode=0,
            stdout="not-a-number, ???\n",
            stderr="",
        )

    monkeypatch.setattr(
        "sidecar.runtime.hardware_vram_usage.subprocess.run",
        _fake_run,
    )

    payload = get_vram_usage()

    assert payload["available"] is False
    assert payload["used_mb"] == 0
    assert payload["total_mb"] == 0
    assert payload["util_available"] is False
    assert payload["util_percent"] == 0
    assert payload["source"] == "nvidia-smi"
