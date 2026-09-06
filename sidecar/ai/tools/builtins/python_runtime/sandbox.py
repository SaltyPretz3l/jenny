"""Sandboxed subprocess execution for python runtime tool.

Windows enforcement is via the Job Object created in
``python_runtime.job_object.JobObject`` (process-count and memory cap,
kill-on-job-close).  On POSIX the equivalent is a ``preexec_fn`` that
calls ``resource.setrlimit`` to cap CPU time, address space, file
descriptors, and core-dump size, plus ``os.setsid()`` so cleanup can
signal the child's entire process group, including grandchildren.

See ``docs/SECURITY_MODEL.md`` for the full
threat model, accepted risks, and deferred hardening.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.config import read_environment_value
from sidecar.ai.tools.builtins.python_runtime.job_object import JobObject

PYTHON_RESULT_SCHEMA_VERSION = 1
MAX_RESULT_JSON_BYTES = 4 * 1024 * 1024
MAX_WRAPPER_PIPE_BYTES = 512 * 1024
_WRAPPER_PIPE_READ_CHUNK_BYTES = 64 * 1024


@dataclass(frozen=True)
class SandboxExecutionResult:
    work_dir: Path
    payload: dict[str, object]
    returncode: int

    def cleanup(self) -> None:
        _remove_tree(self.work_dir)


@dataclass
class _PipeCapture:
    max_bytes: int
    data: bytearray
    total_bytes: int = 0

    @property
    def exceeded(self) -> bool:
        return self.total_bytes > self.max_bytes

    def append(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        remaining = max(0, self.max_bytes - len(self.data))
        if remaining:
            self.data.extend(chunk[:remaining])


def _kill_sandbox_tree(proc: subprocess.Popen[Any]) -> None:
    """Kill the sandboxed child and, on POSIX, everything it started.

    ``setsid`` in the preexec_fn makes the child a group leader, so its PGID
    equals its PID and one ``killpg`` reaches the grandchildren too. When
    ``setsid`` was unavailable there is no such group, and ``killpg`` would
    raise rather than kill anything -- so fall back to the direct kill this
    replaced, instead of silently killing nothing.
    """
    if os.name == "nt":
        proc.kill()
        return
    # Looked up rather than referenced: neither name exists on Windows, and
    # this module is type-checked there too.
    killpg = getattr(os, "killpg", None)
    sigkill = getattr(signal, "SIGKILL", None)
    try:
        if killpg is None or sigkill is None:
            raise OSError("process groups are unavailable on this platform")
        killpg(proc.pid, sigkill)
    except OSError:
        with suppress(OSError):
            proc.kill()


def _wait_for_wrapper_process(
    proc: subprocess.Popen,
    captures: tuple[_PipeCapture, _PipeCapture],
    *,
    timeout_seconds: int,
) -> None:
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    while proc.poll() is None:
        if any(capture.exceeded for capture in captures):
            _kill_sandbox_tree(proc)
            proc.wait(timeout=1.0)
            raise RuntimeError("python runtime wrapper output exceeded the byte limit")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(proc.args, timeout_seconds)
        try:
            proc.wait(timeout=min(0.05, remaining))
        except subprocess.TimeoutExpired:
            continue


def _capture_wrapper_output(
    proc: subprocess.Popen,
    *,
    timeout_seconds: int,
) -> tuple[str, str]:
    stdout = getattr(proc, "stdout", None)
    stderr = getattr(proc, "stderr", None)
    if stdout is None or stderr is None:
        raise RuntimeError("python runtime wrapper pipes are unavailable")

    per_stream_limit = MAX_WRAPPER_PIPE_BYTES // 2
    captures = (
        _PipeCapture(per_stream_limit, bytearray()),
        _PipeCapture(MAX_WRAPPER_PIPE_BYTES - per_stream_limit, bytearray()),
    )

    def _reader(pipe, capture: _PipeCapture) -> None:
        try:
            while True:
                chunk = pipe.read(_WRAPPER_PIPE_READ_CHUNK_BYTES)
                if not chunk:
                    return
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8", errors="replace")
                capture.append(chunk)
        except (OSError, ValueError):
            return

    readers = [
        threading.Thread(target=_reader, args=(stdout, captures[0]), daemon=True),
        threading.Thread(target=_reader, args=(stderr, captures[1]), daemon=True),
    ]
    for reader in readers:
        reader.start()
    _wait_for_wrapper_process(
        proc,
        captures,
        timeout_seconds=timeout_seconds,
    )
    for reader in readers:
        reader.join(timeout=1.0)
    if any(capture.exceeded for capture in captures):
        raise RuntimeError("python runtime wrapper output exceeded the byte limit")
    decoded = tuple(
        bytes(capture.data).decode("utf-8", errors="replace")
        for capture in captures
    )
    return decoded[0], decoded[1]


def _force_remove_readonly(func, path, _excinfo) -> None:
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, onerror=_force_remove_readonly)


def _read_result_payload(result_path: Path) -> dict[str, object]:
    try:
        initial_stat = result_path.lstat()
    except OSError as error:
        raise RuntimeError("python runtime result file is unavailable") from error
    if not stat.S_ISREG(initial_stat.st_mode) or result_path.is_symlink():
        raise RuntimeError("python runtime result is not a regular file")
    if initial_stat.st_size > MAX_RESULT_JSON_BYTES:
        raise RuntimeError("python runtime result exceeds the parent byte limit")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(result_path), flags)
    except OSError as error:
        raise RuntimeError("python runtime result file could not be opened") from error
    try:
        opened_stat = os.fstat(fd)
        if (
            not stat.S_ISREG(opened_stat.st_mode)
            or (initial_stat.st_dev, initial_stat.st_ino)
            != (opened_stat.st_dev, opened_stat.st_ino)
        ):
            raise RuntimeError("python runtime result identity changed before read")
        chunks: list[bytes] = []
        total = 0
        while total <= MAX_RESULT_JSON_BYTES:
            chunk = os.read(fd, min(64 * 1024, MAX_RESULT_JSON_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > MAX_RESULT_JSON_BYTES:
            raise RuntimeError("python runtime result exceeds the parent byte limit")
    finally:
        os.close(fd)
    try:
        payload = json.loads(b"".join(chunks).decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise RuntimeError("python runtime wrapper returned malformed JSON") from error
    return _validate_result_payload(payload)


def _validate_result_payload(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise RuntimeError("python runtime wrapper returned an invalid payload")
    if payload.get("schema_version") != PYTHON_RESULT_SCHEMA_VERSION:
        raise RuntimeError("python runtime result schema is unsupported")
    expected_types = {
        "stdout": str,
        "stderr": str,
        "images": list,
        "tables": list,
    }
    if any(not isinstance(payload.get(key), expected) for key, expected in expected_types.items()):
        raise RuntimeError("python runtime wrapper returned an invalid payload")
    if not (payload.get("error") is None or isinstance(payload.get("error"), dict)):
        raise RuntimeError("python runtime wrapper returned an invalid error payload")
    if not (
        payload.get("last_expr_repr") is None
        or isinstance(payload.get("last_expr_repr"), str)
    ):
        raise RuntimeError("python runtime wrapper returned an invalid expression payload")
    return {str(key): value for key, value in payload.items()}


_POSIX_NOFILE_LIMIT = 256
_POSIX_CPU_GRACE_SECONDS = 5


def _posix_preexec_fn(
    *,
    memory_limit_mb: int,
    timeout_seconds: int,
) -> Callable[[], None]:
    """Build a ``preexec_fn`` that caps child resources on POSIX.

    Sets RLIMIT_CPU to ``timeout_seconds + grace``, RLIMIT_AS to the
    memory cap, RLIMIT_NOFILE to a small bound, and RLIMIT_CORE to 0
    to disable core dumps.  Then ``os.setsid()`` so the child owns a
    new session/process-group that parent cleanup can signal in full
    with ``killpg``.

    No-op on platforms that do not expose the ``resource`` module
    (Windows); callers should only wire this on POSIX in the first
    place.
    """
    cpu_limit = max(1, int(timeout_seconds) + _POSIX_CPU_GRACE_SECONDS)
    mem_bytes = max(1, int(memory_limit_mb)) * 1024 * 1024

    def _apply_limits() -> None:  # pragma: no cover — runs in forked child
        try:
            import resource  # POSIX-only module
        except ImportError:
            return
        setrlimit = getattr(resource, "setrlimit", None)
        if not callable(setrlimit):
            return
        limits = (
            (getattr(resource, "RLIMIT_CPU", None), (cpu_limit, cpu_limit)),
            (getattr(resource, "RLIMIT_AS", None), (mem_bytes, mem_bytes)),
            (
                getattr(resource, "RLIMIT_NOFILE", None),
                (_POSIX_NOFILE_LIMIT, _POSIX_NOFILE_LIMIT),
            ),
            (getattr(resource, "RLIMIT_CORE", None), (0, 0)),
        )
        for resource_key, resource_limits in limits:
            if resource_key is not None:
                setrlimit(resource_key, resource_limits)
        setsid = getattr(os, "setsid", None)
        if callable(setsid):
            setsid()

    return _apply_limits


def _minimal_path(venv_python: Path) -> str:
    python_dir = str(venv_python.parent)
    system_root = read_environment_value("SYSTEMROOT")
    segments = [python_dir]
    if system_root:
        segments.extend(
            [
                os.path.join(system_root, "System32"),
                system_root,
            ]
        )
    return os.pathsep.join(segment for segment in segments if segment)


def execute_sandboxed(
    *,
    code: str,
    venv_python: Path,
    timeout_seconds: int,
    memory_limit_mb: int,
    working_directory: Path | None = None,
) -> SandboxExecutionResult:
    work_dir = Path(tempfile.mkdtemp(prefix="jenny-pyexec-"))
    launch_directory = working_directory or work_dir
    script_path = work_dir / "_script.py"
    result_path = work_dir / "_result.json"
    wrapper_path = Path(__file__).with_name("_exec_wrapper.py")
    script_path.write_text(code, encoding="utf-8")
    system_root = read_environment_value("SYSTEMROOT")

    env = {
        "PATH": _minimal_path(venv_python),
        "SYSTEMROOT": system_root,
        # Matplotlib's Windows font discovery reads WINDIR directly. Windows
        # normally aliases it to SYSTEMROOT, but the scrubbed child environment
        # must carry the alias explicitly.
        "WINDIR": read_environment_value("WINDIR") or system_root,
        "COMSPEC": read_environment_value("COMSPEC"),
        "TEMP": str(work_dir),
        "TMP": str(work_dir),
        "JENNY_OUTPUT_DIR": str(work_dir),
        "MPLCONFIGDIR": str(work_dir),
        "VIRTUAL_ENV": str(venv_python.parent.parent),
        # Scientific runtimes otherwise size native worker pools from the host
        # CPU count before user code runs. Their thread stacks can exhaust the
        # intentionally small Job Object memory budget on a trivial command.
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
    }
    if working_directory is not None:
        # Tell user code where the configured workspace is without passing
        # through the parent's broader environment.
        env["JENNY_WORKSPACE_ROOT"] = str(working_directory)

    preexec_fn: Callable[[], None] | None = None
    if os.name != "nt":
        preexec_fn = _posix_preexec_fn(
            memory_limit_mb=memory_limit_mb,
            timeout_seconds=timeout_seconds,
        )
    creationflags = 0
    if os.name == "nt":
        creationflags = int(getattr(subprocess, "CREATE_SUSPENDED", 0x00000004))

    proc: subprocess.Popen[str] | None = None
    wrapper_stderr = ""
    try:
        with JobObject(memory_limit_mb=memory_limit_mb, max_processes=5) as job:
            proc = subprocess.Popen(
                [
                    str(venv_python),
                    str(wrapper_path),
                    str(script_path),
                    str(result_path),
                    str(work_dir),
                ],
                cwd=str(launch_directory),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                preexec_fn=preexec_fn,
                creationflags=creationflags,
            )
            job.assign(proc)
            job.resume(proc)
            _, wrapper_stderr = _capture_wrapper_output(
                proc,
                timeout_seconds=timeout_seconds,
            )
        if not result_path.exists():
            raise RuntimeError(
                "python runtime wrapper did not produce a result file"
                + (f": {wrapper_stderr.strip()}" if wrapper_stderr.strip() else "")
            )
        payload = _read_result_payload(result_path)
        return SandboxExecutionResult(
            work_dir=work_dir,
            payload=payload,
            returncode=int(proc.returncode if proc is not None else 1),
        )
    except Exception:
        if proc is not None and proc.poll() is None:
            _kill_sandbox_tree(proc)
            proc.wait(timeout=1.0)
        if proc is not None:
            for pipe in (getattr(proc, "stdout", None), getattr(proc, "stderr", None)):
                if pipe is not None:
                    try:
                        pipe.close()
                    except OSError:
                        pass
        _remove_tree(work_dir)
        raise
