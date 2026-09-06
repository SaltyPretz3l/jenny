"""Tests for the sidecar parent-death watchdog (ITEM 1).

Covers the deterministic logic (pid resolution, fire/no-fire, fail-open probe)
and a real-process integration test proving the production teardown force-exits
a sidecar whose parent dies while it is blocked (not reading stdin).
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from sidecar.runtime.parent_watchdog import (
    ParentDeathWatchdog,
    resolve_parent_pid,
)

# start_parent_death_watchdog is exercised by the integration test below, which
# imports it inside a subprocess worker (see worker_src), so it is intentionally
# not imported at module scope here.

REPO_ROOT = Path(__file__).resolve().parents[3]


# ---------------------------------------------------------------------------
# resolve_parent_pid
# ---------------------------------------------------------------------------


def test_resolve_parent_pid_prefers_env() -> None:
    assert resolve_parent_pid({"JENNY_PARENT_PID": "4242"}) == 4242


def test_resolve_parent_pid_falls_back_to_getppid() -> None:
    assert resolve_parent_pid({}) == os.getppid()


@pytest.mark.parametrize("bad", ["", "   ", "not-a-pid", "-5", "0"])
def test_resolve_parent_pid_ignores_invalid_env(bad: str) -> None:
    assert resolve_parent_pid({"JENNY_PARENT_PID": bad}) == os.getppid()


# ---------------------------------------------------------------------------
# ParentDeathWatchdog logic
# ---------------------------------------------------------------------------


def test_watchdog_fires_when_liveness_reports_dead() -> None:
    fired = threading.Event()
    watchdog = ParentDeathWatchdog(
        parent_pid=4242,
        on_parent_lost=fired.set,
        poll_interval_seconds=0.05,
        liveness_check=lambda _pid: False,
    )
    watchdog.start()
    try:
        assert fired.wait(timeout=5.0), "watchdog did not fire on a dead parent"
    finally:
        watchdog.stop()


def test_watchdog_does_not_fire_while_parent_alive() -> None:
    fired = threading.Event()
    watchdog = ParentDeathWatchdog(
        parent_pid=4242,
        on_parent_lost=fired.set,
        poll_interval_seconds=0.02,
        liveness_check=lambda _pid: True,
    )
    watchdog.start()
    try:
        assert not fired.wait(timeout=0.3)
    finally:
        watchdog.stop()


def test_watchdog_fails_open_on_probe_error() -> None:
    fired = threading.Event()

    def _boom(_pid: int) -> bool:
        raise OSError("probe blew up")

    watchdog = ParentDeathWatchdog(
        parent_pid=4242,
        on_parent_lost=fired.set,
        poll_interval_seconds=0.02,
        liveness_check=_boom,
    )
    watchdog.start()
    try:
        # A probe that raises must never tear the sidecar down.
        assert not fired.wait(timeout=0.3)
    finally:
        watchdog.stop()


def test_watchdog_disabled_for_invalid_pid() -> None:
    fired = threading.Event()
    watchdog = ParentDeathWatchdog(
        parent_pid=0,
        on_parent_lost=fired.set,
        poll_interval_seconds=0.02,
    )
    watchdog.start()
    try:
        assert not fired.wait(timeout=0.2)
        # No thread is started when there is no valid parent pid.
        assert watchdog._thread is None  # noqa: SLF001
    finally:
        watchdog.stop()


def test_watchdog_fires_on_real_parent_death() -> None:
    # Uses the real process_exists liveness check against a genuine child pid.
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    fired = threading.Event()
    watchdog = ParentDeathWatchdog(
        parent_pid=parent.pid,
        on_parent_lost=fired.set,
        poll_interval_seconds=0.05,
    )
    watchdog.start()
    try:
        assert not fired.wait(timeout=0.3), "fired while parent still alive"
        parent.kill()
        parent.wait(timeout=10)
        assert fired.wait(timeout=10.0), "watchdog did not detect real parent death"
    finally:
        watchdog.stop()
        if parent.poll() is None:
            parent.kill()


# ---------------------------------------------------------------------------
# Integration: production teardown force-exits the sidecar process
# ---------------------------------------------------------------------------


def test_start_watchdog_self_exits_process_when_parent_dies() -> None:
    """A real Python process running the watchdog must exit when its watched
    parent dies, even while blocked in a sleep (i.e. not reading stdin)."""
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    worker_src = (
        "import sys, time\n"
        "from sidecar.runtime.parent_watchdog import start_parent_death_watchdog\n"
        "start_parent_death_watchdog(\n"
        "    parent_pid=int(sys.argv[1]),\n"
        "    poll_interval_seconds=0.05,\n"
        "    establish_process_group=False,\n"
        ")\n"
        # Simulate being stuck inside a long child op, never reaching stdin EOF.
        "time.sleep(60)\n"
    )
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    child = subprocess.Popen(
        [sys.executable, "-c", worker_src, str(parent.pid)],
        cwd=str(REPO_ROOT),
        env=env,
    )
    try:
        # Give the child time to install its watchdog, then confirm it is blocked.
        time.sleep(0.6)
        assert child.poll() is None, "worker exited before the parent was killed"

        parent.kill()
        parent.wait(timeout=10)

        # The watchdog must force-exit the worker within a bounded time.
        child.wait(timeout=10)
        assert child.returncode is not None
    finally:
        for proc in (child, parent):
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
