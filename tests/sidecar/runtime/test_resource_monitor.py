from __future__ import annotations

from sidecar.runtime import resource_monitor
from sidecar.runtime.resource_monitor import LongSessionResourceMonitor


def test_long_session_resource_monitor_warns_on_sustained_rss_growth() -> None:
    monitor = LongSessionResourceMonitor(sample_window=3, growth_bytes_threshold=100, growth_ratio=0.25)

    monitor.record_rss_sample(400)
    monitor.record_rss_sample(450)
    snapshot = monitor.record_rss_sample(650)

    assert snapshot["status"] == "warn"
    assert snapshot["warning"]["kind"] == "rss_growth"
    assert snapshot["warning"]["growth_bytes"] == 250
    assert snapshot["sample_count"] == 3


def test_long_session_resource_monitor_keeps_ok_for_small_growth() -> None:
    monitor = LongSessionResourceMonitor(sample_window=3, growth_bytes_threshold=100, growth_ratio=0.25)

    monitor.record_rss_sample(400)
    monitor.record_rss_sample(430)
    snapshot = monitor.record_rss_sample(470)

    assert snapshot["status"] == "ok"
    assert snapshot["warning"] is None


def test_long_session_resource_monitor_fails_open_when_psutil_unavailable(monkeypatch) -> None:
    monitor = LongSessionResourceMonitor(sample_window=3)
    monitor.record_rss_sample(400)
    monkeypatch.setattr(resource_monitor, "psutil", None)

    snapshot = monitor.sample_current_process()

    assert snapshot["status"] == "unknown"
    assert snapshot["sample_count"] == 1
    assert snapshot["warning"]["kind"] == "rss_probe_unavailable"
