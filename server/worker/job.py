"""Execution of one disposable foreground shell command."""

from __future__ import annotations

import ctypes
import os

try:
    import resource
except ImportError:  # pragma: no cover - resource is POSIX-only
    resource = None
import selectors
import subprocess
import time
from dataclasses import dataclass
from threading import Event
from typing import Callable

from .snapshot import snapshot_inputs

OUTPUT_LIMIT = 256 * 1024
FILE_LIMIT = 64 * 1024 * 1024
FD_LIMIT = 256
DEFAULT_UID = 10001
DEFAULT_GID = 10001
JOB_ARG_COUNT = 5
DRAIN_SECONDS = 0.1
READY_MARKER_LIMIT = 16


@dataclass(frozen=True)
class JobResult:
    status: str
    exit_code: int | None
    stdout: str
    stderr: str
    output_truncated: bool
    reason: str | None = None

    def record(self, incarnation: str, job_id: str) -> dict[str, object]:
        return {
            "schema_version": 1,
            "incarnation": incarnation,
            "job_id": job_id,
            "status": self.status,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "output_truncated": self.output_truncated,
            "reason": self.reason,
        }


def _set_no_new_privs() -> None:
    """Set Linux PR_SET_NO_NEW_PRIVS when available; harmless elsewhere."""
    if os.name != "posix" or not hasattr(ctypes, "CDLL"):
        return
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
            raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS")
    except AttributeError:
        return


def _capability_sets_empty() -> bool:
    if os.name != "posix":
        return True
    try:
        with open("/proc/self/status", encoding="ascii") as stream:
            fields = dict(line.rstrip().split(":", 1) for line in stream if ":" in line)
        return all(
            int(fields.get(name, "0").strip(), 16) == 0
            for name in ("CapInh", "CapPrm", "CapEff", "CapAmb")
        )
    except (OSError, ValueError):
        return False


def _job_environment() -> dict[str, str]:
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }


def _decode_output(value: bytearray, limit: int) -> tuple[str, bool]:
    decoded = bytes(value).decode("utf-8", "replace")
    encoded = decoded.encode("utf-8")
    if len(encoded) <= limit:
        return decoded, False
    bounded = encoded[:limit].decode("utf-8", "ignore")
    return bounded, True


def _job_entry_code() -> str:
    package_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    return (
        "import sys,os;sys.path.insert(0," + repr(package_root) + ");\n"
        "try: from server.worker.job import job_entry;job_entry()"
        "\nexcept BaseException: os._exit(126)"
    )


def _verify_job_identity(uid: int, gid: int) -> bool:
    if os.name != "posix" or resource is None:
        return True
    if (
        os.getresuid() != (uid, uid, uid)
        or os.getresgid() != (gid, gid, gid)
        or os.getgroups() != []
        or not _capability_sets_empty()
    ):
        return False
    try:
        with open("/proc/self/status", encoding="ascii") as stream:
            fields = dict(line.rstrip().split(":", 1) for line in stream if ":" in line)
        return fields.get("NoNewPrivs", "0").strip() == "1"
    except (OSError, ValueError):
        return False


def job_entry() -> None:
    """Run as the fixed job UID, snapshot inputs, then exec the shell."""
    if len(os.sys.argv) != JOB_ARG_COUNT:
        os._exit(126)
    command, cwd, workspace, ready_fd_text = os.sys.argv[1:]
    try:
        ready_fd = int(ready_fd_text)
    except ValueError:
        os._exit(126)
    if len(command.encode("utf-8")) > 16 * 1024 or "\x00" in command:
        os._exit(126)
    if not _verify_job_identity(DEFAULT_UID, DEFAULT_GID):
        os._exit(126)
    try:
        if resource is None:
            raise OSError
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_LIMIT, FILE_LIMIT))
        resource.setrlimit(resource.RLIMIT_NOFILE, (FD_LIMIT, FD_LIMIT))
        snapshot_inputs("/inputs", workspace)
        base = os.path.abspath(workspace)
        requested = os.path.abspath(os.path.join(base, cwd))
        if os.path.commonpath((base, requested)) != base:
            raise OSError
        os.chdir(requested)
        os.set_inheritable(ready_fd, False)
        os.write(ready_fd, b"ready")
        os.close(0)
        os.open(os.devnull, os.O_RDONLY)
        os.execve("/bin/sh", ["/bin/sh", "-c", command], _job_environment())
    except (OSError, ValueError, RuntimeError):
        try:
            os.write(ready_fd, b"failed")
        except OSError:
            pass
        os._exit(126)


def run_command(  # noqa: C901, PLR0912, PLR0913, PLR0915 - bounded selector state machine
    command: str,
    cwd: str,
    *,
    timeout_seconds: float,
    workspace_root: str = "/workspace",
    cancel_event: Event | None = None,
    uid: int = DEFAULT_UID,
    gid: int = DEFAULT_GID,
    output_limit: int = OUTPUT_LIMIT,
    popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
) -> JobResult:
    """Capture one foreground command; PID1 exit owns all descendant cleanup."""
    if os.name != "posix":
        return JobResult("failed", None, "", "", False, "linux_required")
    ready_r, ready_w = os.pipe()
    started = time.monotonic()
    try:
        process = popen(
            [
                os.sys.executable,
                "-I",
                "-c",
                _job_entry_code(),
                command,
                cwd,
                workspace_root,
                str(ready_w),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
            user=uid,
            group=gid,
            extra_groups=[],
            env=_job_environment(),
            pass_fds=(ready_w,),
        )
    except (OSError, ValueError):
        os.close(ready_r)
        return JobResult("failed", None, "", "", False, "start_failed")
    finally:
        os.close(ready_w)
    selector = selectors.DefaultSelector()
    output = {"stdout": bytearray(), "stderr": bytearray()}
    preparation = bytearray()
    ready_ok = False
    exit_code = None
    terminal = None
    truncated = False
    total = 0
    streams = [process.stdout, process.stderr]
    try:
        os.set_blocking(ready_r, False)
        selector.register(ready_r, selectors.EVENT_READ, "ready")
        for name, stream in zip(output, streams, strict=True):
            assert stream is not None
            os.set_blocking(stream.fileno(), False)
            selector.register(stream.fileno(), selectors.EVENT_READ, name)
        finished_at = None
        while terminal is None:
            now = time.monotonic()
            if cancel_event is not None and cancel_event.is_set():
                terminal = "cancelled"
                break
            exit_code = process.poll()
            if exit_code is not None and finished_at is None:
                finished_at = now
            if finished_at is None and now - started >= timeout_seconds:
                terminal = "timed_out"
                break
            # Drain at most 100 ms after the foreground process exits. A
            # detached descendant may keep output pipes open indefinitely.
            if finished_at is not None and now - finished_at >= DRAIN_SECONDS:
                terminal = "completed" if ready_ok else "failed"
                break
            for key, _ in selector.select(0.05):
                try:
                    chunk = os.read(key.fd, 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fd)
                    if key.data == "ready":
                        ready_ok = preparation == b"ready"
                    continue
                if key.data == "ready":
                    preparation.extend(chunk[:READY_MARKER_LIMIT])
                    if len(preparation) > READY_MARKER_LIMIT:
                        terminal = "failed"
                    continue
                room = output_limit - total
                output[key.data].extend(chunk[:room])
                total += min(room, len(chunk))
                if len(chunk) > room:
                    terminal, truncated = "output_limit", True
                    break
            # Closing stdout/stderr is not process completion; keep enforcing
            # the timeout until waitpid confirms the foreground process exit.
    finally:
        selector.close()
        os.close(ready_r)
        for stream in streams:
            if stream is not None:
                stream.close()
    exit_code = process.poll()
    stdout, stdout_cut = _decode_output(output["stdout"], output_limit)
    stderr, stderr_cut = _decode_output(
        output["stderr"], output_limit - len(stdout.encode("utf-8"))
    )
    truncated = truncated or stdout_cut or stderr_cut
    if truncated and terminal == "completed":
        terminal = "output_limit"
    reason = {
        "cancelled": "cancelled",
        "timed_out": "wall_time_exceeded",
        "output_limit": "output_limit_exceeded",
        "failed": "job_preparation_failed",
    }.get(terminal)
    return JobResult(terminal or "failed", exit_code, stdout, stderr, truncated, reason)


execute = run_command
