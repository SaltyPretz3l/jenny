"""POSIX owned-process supervisor -- STDLIB-ONLY BY CONTRACT.

Child-side entry point for the POSIX owned-process transport
(`sidecar/ai/tools/builtins/owned_process.py`). It shares the launch wire
contract of `sidecar/_owned_process_bootstrap.py` and the same import-cost rule:
every POSIX owned-process spawn re-enters this module in a fresh interpreter, so
it imports nothing from `sidecar` except that bootstrap module.

WHY A SUPERVISOR:
    A process group is observable but is not a containment boundary: a
    descendant can call setsid() and outlive the group. The owner therefore
    cannot prove full-tree termination from an empty group. This supervisor sits
    between the owner and the target and supplies that proof.

PROOF CONTRACT (the owner relies on exactly this):
    The owner passes a pipe. The supervisor writes READY_BYTE to it once its
    termination handlers are installed, and PROOF_BYTE only after it has
    observed that no descendant of the target is alive, immediately before it
    exits. The proof byte is the proof; an exit status is not, because an
    unexpected error or a packaging bootloader can produce any status. When the
    supervisor cannot establish the proof inside its deadline, or ends in any
    state it did not plan for, it kills itself with SIGKILL and writes nothing,
    so the owner keeps the capacity slot quarantined.

    Linux (`subreaper`): the supervisor sets PR_SET_CHILD_SUBREAPER, so every
    orphaned descendant, including one that left the session, is reparented to
    it by the kernel. ECHILD from waitpid(-1) then means no descendant exists.
    This is exact.

    Other POSIX, such as macOS (`lineage`): no unprivileged kernel mechanism
    keeps an orphan attributable, so this mode is best effort and says so: it
    reports SAMPLED_PROOF_BYTE, never PROOF_BYTE. The supervisor finds
    descendants two ways. It samples the process table while the target runs
    and remembers every descendant it has seen (pid and start time). It also
    puts a random token in the target's environment and, at the end, looks for
    every process that inherited it; that finds a descendant orphaned between
    two samples (overnight Linux QA of 1.3.0 reproduced that miss with sampling
    alone). What still escapes: a descendant that is orphaned between two
    samples and also runs with a scrubbed environment. Linux falls back to
    this mode only when the subreaper call is refused.

    Neither mode defends against a same-user process that attacks the
    supervisor itself; killing the supervisor yields the uncertain verdict.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from typing import BinaryIO

from sidecar._owned_process_bootstrap import (
    _BOOTSTRAP_LAUNCH_FAILED_EXIT_CODE,
    _BOOTSTRAP_REJECTED_EXIT_CODE,
    _read_bootstrap_payload,
    _write_bootstrap_error,
)

SUPERVISOR_FLAG = "--owned-process-supervisor"
READY_FD_ENVIRONMENT_VARIABLE = "JENNY_OWNED_SUPERVISOR_READY_FD"
# Written to that descriptor: handlers installed, then how cleanup was
# established. PROOF_BYTE is the kernel-backed proof. SAMPLED_PROOF_BYTE says
# only that the best-effort lineage sweep found nothing left; the owner must
# report it as the weaker mechanism it is.
READY_BYTE = b"1"
PROOF_BYTE = b"P"
SAMPLED_PROOF_BYTE = b"S"
# Set in the target's environment in lineage mode so a descendant that was
# orphaned between two samples can still be found by what it inherited.
TREE_TOKEN_ENVIRONMENT_VARIABLE = "JENNY_OWNED_PROCESS_TREE"

# The owner waits this long, on top of its own termination grace, for the
# supervisor to finish a requested teardown before it kills the whole group.
SUPERVISOR_TEARDOWN_MARGIN_SECONDS = 1.5

_PR_SET_CHILD_SUBREAPER = 36
_TERMINATE_GRACE_SECONDS = 1.0
_EXITED_TARGET_GRACE_SECONDS = 0.05
_SWEEP_DEADLINE_SECONDS = 5.0
_SWEEP_POLL_SECONDS = 0.005
_LINEAGE_SAMPLE_SECONDS = 0.2
_LINEAGE_PS_TIMEOUT_SECONDS = 1.0
_SIGNAL_EXIT_BASE = 128
_PS_COLUMNS = 3
# Resolved by name so the module still type-checks and imports on Windows.
_SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)
_WNOHANG = int(getattr(os, "WNOHANG", 1))


class _TerminateRequested(BaseException):
    """Raised in the main thread by the termination signal handler."""


def supervisor_command() -> list[str]:
    """Return the trusted supervisor command for source and packaged runtimes."""
    if getattr(sys, "frozen", False):
        return [sys.executable, SUPERVISOR_FLAG]
    return [sys.executable, "-m", "sidecar", SUPERVISOR_FLAG]


SUBREAPER_CONTAINMENT = "posix_subreaper_supervisor"
LINEAGE_CONTAINMENT = "posix_lineage_supervisor"


def supervisor_containment() -> str:
    """Name the containment a supervised spawn is expected to get here.

    The owner replaces it with the mode the supervisor actually reports, since
    Linux falls back to lineage when the subreaper call is refused.
    """
    return SUBREAPER_CONTAINMENT if sys.platform.startswith("linux") else LINEAGE_CONTAINMENT


def run_owned_process_supervisor(
    control_stream: BinaryIO | None = None,
    *,
    force_lineage: bool = False,
) -> int:
    """Launch one validated target, then leave only with the cleanup proof."""
    stream = control_stream if control_stream is not None else sys.stdin.buffer
    report_fd = _take_report_fd()
    _install_termination_handlers()
    try:
        exit_code, proof = _supervise(stream, report_fd, force_lineage=force_lineage)
    except BaseException:  # noqa: BLE001 - an unknown state proves nothing.
        proof = None
        exit_code = 1
    if proof is None:
        _die_without_proof()
    else:
        _report(report_fd, proof)
    return exit_code


def _supervise(
    stream: BinaryIO,
    report_fd: int | None,
    *,
    force_lineage: bool,
) -> tuple[int, bytes | None]:
    """Run the target and return its exit code with the proof to report."""
    exit_code = _SIGNAL_EXIT_BASE + int(signal.SIGTERM)
    grace = _TERMINATE_GRACE_SECONDS
    subreaper = False
    lineage: _LineageTracker | None = None
    target: subprocess.Popen[bytes] | None = None
    try:
        # A termination signal that lands while the interpreter is still
        # starting kills the supervisor by default action, which loses the
        # proof. The owner holds its first signal until this byte arrives.
        _report(report_fd, READY_BYTE)
        try:
            argv, cwd, env, input_data = _read_bootstrap_payload(stream)
        except (OSError, TypeError, ValueError):
            _ignore_termination_signals()
            _write_bootstrap_error("owned process supervisor rejected control payload")
            return _BOOTSTRAP_REJECTED_EXIT_CODE, PROOF_BYTE
        subreaper = not force_lineage and _become_subreaper()
        if not subreaper:
            lineage = _LineageTracker(os.getpid())
            env = lineage.marked_environment(env)
        try:
            target = subprocess.Popen(
                argv,
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
            )
        except (OSError, ValueError):
            _ignore_termination_signals()
            _write_bootstrap_error("owned process supervisor target launch failed")
            return _BOOTSTRAP_LAUNCH_FAILED_EXIT_CODE, PROOF_BYTE
        if lineage is not None:
            lineage.start()
        if input_data is not None:
            _start_input_writer(target, input_data)
        status = (
            _wait_for_target_as_subreaper(target.pid)
            if subreaper
            else os.waitpid(target.pid, 0)[1]
        )
        exit_code = _exit_code_from_status(status)
        grace = _EXITED_TARGET_GRACE_SECONDS
    except _TerminateRequested:
        pass
    _ignore_termination_signals()
    if target is not None:
        # The supervisor reaps the target itself; keep Popen from waiting on it.
        target.returncode = exit_code

    # A teardown that arrives before either mode is set up has started no child.
    if lineage is not None:
        return exit_code, (SAMPLED_PROOF_BYTE if lineage.sweep(grace) else None)
    proven = _sweep_as_subreaper(grace) if subreaper else True
    return exit_code, (PROOF_BYTE if proven else None)


def _take_report_fd() -> int | None:
    raw_fd = os.environ.pop(READY_FD_ENVIRONMENT_VARIABLE, "")
    if not raw_fd.isdigit():
        return None
    try:
        os.set_inheritable(int(raw_fd), False)
    except OSError:
        return None
    return int(raw_fd)


def _report(report_fd: int | None, token: bytes) -> None:
    if report_fd is None:
        return
    try:
        os.write(report_fd, token)
    except OSError:
        pass


def _become_subreaper() -> bool:
    if not sys.platform.startswith("linux"):
        return False
    try:
        import ctypes  # Lazy: only the Linux supervisor pays for it.

        libc = ctypes.CDLL(None, use_errno=True)
        return int(libc.prctl(_PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) == 0
    except (AttributeError, OSError, TypeError, ValueError):
        return False


def _raise_terminate(_signum: int, _frame: object) -> None:
    # One-shot: a second signal that is already pending must not raise again
    # outside the teardown's own handling.
    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        signum = getattr(signal, name, None)
        if signum is not None:
            signal.signal(signum, signal.SIG_IGN)
    raise _TerminateRequested


def _install_termination_handlers() -> None:
    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        signum = getattr(signal, name, None)
        if signum is not None:
            signal.signal(signum, _raise_terminate)


def _ignore_termination_signals() -> None:
    while True:
        try:
            for name in ("SIGTERM", "SIGINT", "SIGHUP"):
                signum = getattr(signal, name, None)
                if signum is not None:
                    signal.signal(signum, signal.SIG_IGN)
            return
        except _TerminateRequested:
            continue


def _start_input_writer(target: subprocess.Popen[bytes], input_data: bytes) -> None:
    def _write() -> None:
        pipe = target.stdin
        if pipe is None:
            return
        try:
            pipe.write(input_data)
            pipe.flush()
        except (OSError, ValueError):
            pass
        finally:
            try:
                pipe.close()
            except (OSError, ValueError):
                pass

    threading.Thread(target=_write, name="owned-supervisor-stdin", daemon=True).start()


def _exit_code_from_status(status: int) -> int:
    code = os.waitstatus_to_exitcode(status)
    return _SIGNAL_EXIT_BASE - code if code < 0 else code


def _wait_for_target_as_subreaper(target_pid: int) -> int:
    """Reap adopted orphans until the target itself exits."""
    while True:
        pid, status = os.waitpid(-1, 0)
        if pid == target_pid:
            return status


def _direct_children() -> list[int]:
    """List this process's children from /proc; a miss is retried by the caller."""
    own_pid = os.getpid()
    children: list[int] = []
    try:
        entries = os.listdir("/proc")
    except OSError:
        return children
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "rb") as handle:
                stat = handle.read()
        except OSError:
            continue
        # The command name sits in parentheses and may itself contain them.
        fields = stat[stat.rfind(b")") + 1 :].split()
        if len(fields) > 1 and fields[1].isdigit() and int(fields[1]) == own_pid:
            children.append(int(entry))
    return children


def _signal_pids(pids: list[int], signum: int) -> None:
    for pid in pids:
        try:
            os.kill(pid, signum)
        except (ProcessLookupError, PermissionError):
            continue


def _reap_available() -> bool:
    """Reap every exited child; return False once no child exists at all."""
    while True:
        try:
            pid, _status = os.waitpid(-1, _WNOHANG)
        except ChildProcessError:
            return False
        if pid == 0:
            return True


def _sweep_as_subreaper(grace_seconds: float) -> bool:
    """Kill until waitpid reports ECHILD, which proves no descendant is left."""
    deadline = time.monotonic() + _SWEEP_DEADLINE_SECONDS
    grace_deadline = time.monotonic() + max(0.0, grace_seconds)
    if not _reap_available():
        return True
    _signal_pids(_direct_children(), signal.SIGTERM)
    while time.monotonic() < grace_deadline:
        if not _reap_available():
            return True
        time.sleep(_SWEEP_POLL_SECONDS)
    while time.monotonic() < deadline:
        if not _reap_available():
            return True
        # Killing a child hands its own children to this subreaper, so the
        # next pass sees them as direct children.
        _signal_pids(_direct_children(), _SIGKILL)
        time.sleep(_SWEEP_POLL_SECONDS)
    return not _reap_available()


class _LineageTracker:
    """Sampled descendant tracking for POSIX systems without a subreaper."""

    def __init__(self, root_pid: int) -> None:
        self._root_pid = root_pid
        self._marker = f"{TREE_TOKEN_ENVIRONMENT_VARIABLE}={os.urandom(16).hex()}"
        self._known: dict[int, str] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._sample()
        self._thread = threading.Thread(
            target=self._run, name="owned-supervisor-lineage", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(_LINEAGE_SAMPLE_SECONDS):
            self._sample()

    def _snapshot(self) -> dict[int, tuple[int, str]] | None:
        """Return pid -> (ppid, start time) for the whole process table."""
        ps = "/bin/ps" if os.path.exists("/bin/ps") else "ps"
        try:
            process = subprocess.Popen(
                [ps, "-axo", "pid=,ppid=,lstart="],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, ValueError):
            return None
        try:
            output, _ = process.communicate(timeout=_LINEAGE_PS_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            return None
        if process.returncode != 0:
            return None
        table: dict[int, tuple[int, str]] = {}
        for line in output.decode("utf-8", "replace").splitlines():
            parts = line.split(None, 2)
            if len(parts) != _PS_COLUMNS or not parts[0].isdigit() or not parts[1].isdigit():
                continue
            table[int(parts[0])] = (int(parts[1]), parts[2].strip())
        # The sampler lists itself as a child of this process.
        table.pop(process.pid, None)
        return table

    def _sample(self) -> dict[int, str] | None:
        """Fold one snapshot into the known set; return the descendants alive now."""
        table = self._snapshot()
        if table is None:
            return None
        with self._lock:
            known = dict(self._known)
        # A recycled pid has a different start time and is not the descendant.
        alive = {
            pid: started
            for pid, started in known.items()
            if pid in table and table[pid][1] == started
        }
        changed = True
        while changed:
            changed = False
            for pid, (ppid, started) in table.items():
                if pid in alive or pid == self._root_pid:
                    continue
                if ppid == self._root_pid or ppid in alive:
                    alive[pid] = started
                    changed = True
        with self._lock:
            self._known.update(alive)
        return alive

    def marked_environment(self, env: dict[str, str] | None) -> dict[str, str]:
        """Return the target environment carrying this tree's token."""
        name, _, value = self._marker.partition("=")
        return {**(os.environ if env is None else env), name: value}

    def _token_holders(self) -> set[int]:
        """Pids whose launch environment carries the token; empty if unreadable."""
        marker = self._marker.encode("ascii")
        holders: set[int] = set()
        if sys.platform.startswith("linux"):
            try:
                entries = os.listdir("/proc")
            except OSError:
                return holders
            for entry in entries:
                if not entry.isdigit() or int(entry) == self._root_pid:
                    continue
                try:
                    with open(f"/proc/{entry}/environ", "rb") as handle:
                        if marker in handle.read():
                            holders.add(int(entry))
                except OSError:
                    continue
            return holders
        ps = "/bin/ps" if os.path.exists("/bin/ps") else "ps"
        try:
            listing = subprocess.run(
                [ps, "-axEww", "-o", "pid=,command="],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=_LINEAGE_PS_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, ValueError, subprocess.SubprocessError):
            return holders
        for line in listing.stdout.splitlines():
            pid, _, rest = line.strip().partition(b" ")
            if marker in rest and pid.isdigit() and int(pid) != self._root_pid:
                holders.add(int(pid))
        return holders

    def sweep(self, grace_seconds: float) -> bool:
        """Kill every descendant found; True once a pass finds none alive."""
        self._stop.set()
        deadline = time.monotonic() + _SWEEP_DEADLINE_SECONDS
        grace_deadline = time.monotonic() + max(0.0, grace_seconds)
        signum = signal.SIGTERM
        while time.monotonic() < deadline:
            # An unreaped child of this process stays in the table as a zombie
            # and would read as alive forever: the target after an interrupted
            # wait, or a sampler orphaned by the teardown signal.
            _reap_available()
            alive = self._sample()
            if alive is not None:
                pids = set(alive) | self._token_holders()
                if not pids:
                    return True
                _signal_pids(sorted(pids), signum)
            if time.monotonic() >= grace_deadline:
                signum = _SIGKILL
            time.sleep(_SWEEP_POLL_SECONDS * 4)
        return False


def _die_without_proof() -> None:
    """Leave by signal so the owner never reads this exit as a cleanup proof."""
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.kill(os.getpid(), _SIGKILL)
    time.sleep(1.0)
    os.abort()


__all__ = [
    "LINEAGE_CONTAINMENT",
    "PROOF_BYTE",
    "READY_BYTE",
    "READY_FD_ENVIRONMENT_VARIABLE",
    "SAMPLED_PROOF_BYTE",
    "SUBREAPER_CONTAINMENT",
    "SUPERVISOR_FLAG",
    "SUPERVISOR_TEARDOWN_MARGIN_SECONDS",
    "TREE_TOKEN_ENVIRONMENT_VARIABLE",
    "run_owned_process_supervisor",
    "supervisor_command",
    "supervisor_containment",
]
