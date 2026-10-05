"""Contract tests for the POSIX owned-process supervisor.

The supervisor's normal exit is the owner's only proof that a command left no
descendant behind, so these tests pin both halves: it sweeps a descendant that
escaped the process group, and it never exits normally without that sweep.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from sidecar import _owned_process_supervisor as supervisor
from sidecar._owned_process_bootstrap import encode_windows_bootstrap_payload

posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX supervisor")

_ESCAPING_PARENT = (
    "import pathlib, subprocess, sys\n"
    "child = subprocess.Popen(\n"
    "    [sys.executable, '-c', 'import time; time.sleep(60)'],\n"
    "    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,\n"
    "    stderr=subprocess.DEVNULL, start_new_session=True,\n"
    ")\n"
    "pathlib.Path(sys.argv[1]).write_text(str(child.pid), encoding='ascii')\n"
)


def _run_supervisor(
    argv: list[str],
    tmp_path: Path,
    *,
    force_lineage: bool = False,
    input_data: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    payload = encode_windows_bootstrap_payload(
        argv, cwd=tmp_path, env=dict(os.environ), input_data=input_data
    )
    entry = (
        "import sys\n"
        "from sidecar._owned_process_supervisor import run_owned_process_supervisor\n"
        f"sys.exit(run_owned_process_supervisor(force_lineage={force_lineage!r}))\n"
    )
    return subprocess.run(
        [sys.executable, "-c", entry],
        input=payload,
        capture_output=True,
        timeout=30,
        check=False,
    )


def _pid_is_gone(pid: int) -> bool:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        # A killed orphan can linger as a zombie until init reaps it.
        try:
            stat = Path(f"/proc/{pid}/stat").read_text(encoding="ascii", errors="replace")
        except OSError:
            stat = ""
        if stat and stat[stat.rfind(")") + 1 :].split()[:1] == ["Z"]:
            return True
        time.sleep(0.05)
    return False


def test_supervisor_module_imports_only_the_bootstrap_from_sidecar() -> None:
    code = (
        "import sidecar._owned_process_supervisor\n"
        "import sys, json\n"
        "print(json.dumps(sorted("
        "n for n in sys.modules if n == 'sidecar' or n.startswith('sidecar.'))))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )

    # Every POSIX owned-process spawn pays this import in a fresh interpreter.
    assert set(json.loads(completed.stdout)) == {
        "sidecar",
        "sidecar._owned_process_bootstrap",
        "sidecar._owned_process_supervisor",
    }
    assert "ctypes" not in completed.stdout


def test_supervisor_command_and_containment_name_the_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert supervisor.supervisor_command()[-1] == supervisor.SUPERVISOR_FLAG
    monkeypatch.setattr(supervisor.sys, "platform", "linux")
    assert supervisor.supervisor_containment() == "posix_subreaper_supervisor"
    monkeypatch.setattr(supervisor.sys, "platform", "darwin")
    assert supervisor.supervisor_containment() == "posix_lineage_supervisor"


def test_entrypoint_flag_matches_the_supervisor_module() -> None:
    from sidecar import __main__ as entry

    assert entry._OWNED_PROCESS_SUPERVISOR_FLAG == supervisor.SUPERVISOR_FLAG


@posix_only
@pytest.mark.parametrize("force_lineage", [False, True])
def test_supervisor_mirrors_exit_code_and_delivers_input(
    tmp_path: Path, force_lineage: bool
) -> None:
    completed = _run_supervisor(
        [
            sys.executable,
            "-c",
            "import sys; data = sys.stdin.buffer.read(); print(len(data)); sys.exit(7)",
        ],
        tmp_path,
        force_lineage=force_lineage,
        input_data=b"x" * 70_000,
    )

    assert completed.returncode == 7
    assert completed.stdout.strip() == b"70000"


@posix_only
def test_supervisor_reports_a_signalled_target_as_128_plus_signal(tmp_path: Path) -> None:
    completed = _run_supervisor(
        [sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGKILL)"],
        tmp_path,
    )

    # A normal exit: the target died by signal, the supervisor did not.
    assert completed.returncode == 128 + int(signal.SIGKILL)


@posix_only
@pytest.mark.parametrize("force_lineage", [False, True])
def test_supervisor_sweeps_a_descendant_that_left_the_session(
    tmp_path: Path, force_lineage: bool
) -> None:
    pid_file = tmp_path / "escaped.pid"
    parent = tmp_path / "escape.py"
    parent.write_text(
        _ESCAPING_PARENT
        # Stay alive across one lineage sample so the sampled mode can see it.
        + ("import time; time.sleep(0.6)\n" if force_lineage else ""),
        encoding="utf-8",
    )
    child_pid = 0
    try:
        completed = _run_supervisor(
            [sys.executable, str(parent), str(pid_file)],
            tmp_path,
            force_lineage=force_lineage,
        )
        child_pid = int(pid_file.read_text(encoding="ascii"))

        assert completed.returncode == 0
        assert _pid_is_gone(child_pid)
    finally:
        if child_pid > 0:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@posix_only
def test_supervisor_does_not_leak_its_ready_descriptor_to_the_target(
    tmp_path: Path,
) -> None:
    from sidecar.ai.tools.builtins.owned_process import OwnedProcessService

    result = OwnedProcessService(max_active=1, max_queued=0).run(
        [
            sys.executable,
            "-c",
            "import os; print(os.environ.get("
            f"{supervisor.READY_FD_ENVIRONMENT_VARIABLE!r}, 'absent'))",
        ],
        cwd=tmp_path,
        timeout_seconds=10,
    )

    assert result.stdout.strip() == "absent"


@posix_only
def test_terminating_a_supervisor_sweeps_the_tree_and_still_proves_cleanup(
    tmp_path: Path,
) -> None:
    from sidecar.ai.tools.builtins.owned_process import OwnedProcessService

    pid_file = tmp_path / "escaped.pid"
    parent = tmp_path / "escape_and_wait.py"
    parent.write_text(_ESCAPING_PARENT + "import time; time.sleep(60)\n", encoding="utf-8")
    service = OwnedProcessService(max_active=1, max_queued=0)
    child_pid = 0
    try:
        result = service.run(
            [sys.executable, str(parent), str(pid_file)],
            cwd=tmp_path,
            timeout_seconds=1.5,
        )
        child_pid = int(pid_file.read_text(encoding="ascii"))

        assert result.timed_out is True
        assert result.cleanup_verdict.cleanup == "confirmed"
        assert service.snapshot().active == 0
        assert _pid_is_gone(child_pid)
    finally:
        if child_pid > 0:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def _start_reporting_supervisor(
    argv: list[str], tmp_path: Path, *, force_lineage: bool
) -> tuple[subprocess.Popen[bytes], int]:
    read_fd, write_fd = os.pipe()
    entry = (
        "import sys\n"
        "from sidecar._owned_process_supervisor import run_owned_process_supervisor\n"
        f"sys.exit(run_owned_process_supervisor(force_lineage={force_lineage!r}))\n"
    )
    try:
        process = subprocess.Popen(
            [sys.executable, "-c", entry],
            env={**os.environ, supervisor.READY_FD_ENVIRONMENT_VARIABLE: str(write_fd)},
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            pass_fds=(write_fd,),
        )
    finally:
        os.close(write_fd)
    assert process.stdin is not None
    process.stdin.write(
        encode_windows_bootstrap_payload(argv, cwd=tmp_path, env=dict(os.environ))
    )
    process.stdin.close()
    return process, read_fd


def _read_report(read_fd: int) -> bytes:
    try:
        with os.fdopen(read_fd, "rb") as report:
            return report.read()
    except OSError:
        return b""


@posix_only
@pytest.mark.parametrize("force_lineage", [False, True])
def test_repeated_termination_signals_still_end_in_a_proven_sweep(
    tmp_path: Path, force_lineage: bool
) -> None:
    # A target that ignores SIGTERM, torn down by two signals in a row: the
    # supervisor must neither exit on the second one nor leave the target.
    pid_file = tmp_path / "stubborn.pid"
    stubborn = tmp_path / "stubborn.py"
    stubborn.write_text(
        "import os, pathlib, signal, sys, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='ascii')\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    process, read_fd = _start_reporting_supervisor(
        [sys.executable, str(stubborn), str(pid_file)], tmp_path, force_lineage=force_lineage
    )
    try:
        assert os.read(read_fd, 1) == supervisor.READY_BYTE
        deadline = time.monotonic() + 10
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        target_pid = int(pid_file.read_text(encoding="ascii"))

        os.killpg(process.pid, signal.SIGTERM)
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)

        assert process.returncode == 128 + int(signal.SIGTERM)
        assert _read_report(read_fd) == (
            supervisor.SAMPLED_PROOF_BYTE if force_lineage else supervisor.PROOF_BYTE
        )
        assert _pid_is_gone(target_pid)
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


@posix_only
def test_supervisor_that_dies_unexpectedly_reports_no_proof(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai.tools.builtins.owned_process import OwnedProcessService

    service = OwnedProcessService(max_active=1, max_queued=0)
    owned = service.spawn(
        [sys.executable, "-c", "import time; time.sleep(60)"], cwd=tmp_path, allow_queue=False
    )
    try:
        # Whatever status the dead supervisor is later reported with, only the
        # proof byte counts: a packaging bootloader can turn a signal death
        # into an ordinary exit status.
        os.kill(owned.process.pid, signal.SIGKILL)
        owned.process.wait(timeout=5)
        monkeypatch.setattr(owned.process, "returncode", 0)

        verdict = service.release(owned)

        assert verdict.cleanup == "uncertain"
        assert service.snapshot().active == 1
    finally:
        try:
            os.killpg(owned.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


@posix_only
def test_missing_program_and_directory_still_raise_from_spawn(tmp_path: Path) -> None:
    from sidecar.ai.tools.builtins.owned_process import OwnedProcessService

    service = OwnedProcessService(max_active=1, max_queued=0)

    with pytest.raises(FileNotFoundError):
        service.spawn(["jenny-no-such-program"], cwd=tmp_path, allow_queue=False)
    with pytest.raises(FileNotFoundError):
        service.spawn([sys.executable, "-c", "pass"], cwd=tmp_path / "absent", allow_queue=False)
    assert service.snapshot().active == 0


@posix_only
def test_lineage_mode_finds_a_descendant_orphaned_between_two_samples(
    tmp_path: Path,
) -> None:
    # Dot's reproduction from the packaged retest: the target waits past the
    # first sample, detaches a child and exits before the next one, so sampling
    # never sees the child. The inherited token still does.
    pid_file = tmp_path / "bounded-child.pid"
    parent = tmp_path / "late_escape.py"
    parent.write_text("import time; time.sleep(0.065)\n" + _ESCAPING_PARENT, encoding="utf-8")
    process, read_fd = _start_reporting_supervisor(
        [sys.executable, str(parent), str(pid_file)], tmp_path, force_lineage=True
    )
    child_pid = 0
    try:
        process.wait(timeout=15)
        child_pid = int(pid_file.read_text(encoding="ascii"))

        # Best effort is reported as such, never as the kernel-backed proof.
        assert _read_report(read_fd) == supervisor.READY_BYTE + supervisor.SAMPLED_PROOF_BYTE
        assert _pid_is_gone(child_pid)
    finally:
        if child_pid > 0:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@posix_only
def test_owner_names_the_sampled_mechanism_on_a_confirmed_verdict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai.tools.builtins import owned_process

    # Stands in for macOS, and for Linux when the subreaper call is refused.
    monkeypatch.setattr(
        owned_process,
        "supervisor_command",
        lambda: [
            sys.executable,
            "-c",
            "import sys\n"
            "from sidecar._owned_process_supervisor import run_owned_process_supervisor\n"
            "sys.exit(run_owned_process_supervisor(force_lineage=True))\n",
        ],
    )
    service = owned_process.OwnedProcessService(max_active=1, max_queued=0)

    result = service.run([sys.executable, "-c", "print('ok')"], cwd=tmp_path, timeout_seconds=10)

    assert result.stdout.strip() == "ok"
    assert result.containment == supervisor.LINEAGE_CONTAINMENT
    assert result.cleanup_verdict.cleanup == "confirmed"
    assert result.cleanup_verdict.reason == owned_process.SAMPLED_LINEAGE_REASON
    assert service.snapshot().active == 0


@posix_only
def test_owner_reports_no_reason_for_the_kernel_backed_proof(tmp_path: Path) -> None:
    from sidecar.ai.tools.builtins.owned_process import OwnedProcessService

    result = OwnedProcessService(max_active=1, max_queued=0).run(
        [sys.executable, "-c", "pass"], cwd=tmp_path, timeout_seconds=10
    )

    if sys.platform.startswith("linux"):
        assert result.containment == supervisor.SUBREAPER_CONTAINMENT
        assert result.cleanup_verdict.reason is None

