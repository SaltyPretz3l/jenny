"""Process containment helpers for stdio MCP servers."""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path, PureWindowsPath
from typing import Any, Callable

try:  # pragma: no cover - platform dependent.
    import resource as _resource
except ImportError:  # pragma: no cover - Windows.
    _resource = None  # type: ignore[assignment]

from sidecar.ai.config import MCPServerConfig, read_environment_value
from sidecar.ai.tools.builtins.python_runtime.job_object import JobObject
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
from sidecar.runtime.diagnostics import log_event

_CPU_SAMPLE_INTERVAL_SECONDS = 1.0
_CPU_SATURATION_RATIO = 0.9
_PROCESS_EXIT_TIMEOUT_SECONDS = 1.5
_ENV_PASSTHROUGH_KEYS = (
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
)
_POSIX_DEFAULT_PATH_SEGMENTS = ("/usr/local/bin", "/usr/bin", "/bin")
_BUILTIN_MCP_OPTIONAL_PATH_COMMANDS = ("git",)
_WINDOWS_GIT_RELATIVE_DIRS = (
    ("Git", "cmd"),
    ("Git", "bin"),
)
_WINDOWS_VS_GIT_GLOB = (
    "Microsoft Visual Studio/*/*/Common7/IDE/CommonExtensions/"
    "Microsoft/TeamFoundation/Team Explorer/Git/cmd/git.exe"
)


def _is_windows() -> bool:
    return os.name == "nt"


def _is_posix() -> bool:
    return os.name == "posix"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _resolve_command_path(command: str) -> Path | None:
    token = str(command or "").strip()
    if not token:
        return None
    path = Path(token).expanduser()
    if not path.is_absolute():
        return None
    try:
        return path.resolve(strict=False)
    except OSError:
        return path.absolute()


def _resolve_command_for_env(command: str) -> Path | None:
    resolved = _resolve_command_path(command)
    if resolved is not None:
        return resolved
    token = str(command or "").strip()
    if not token or _command_has_path_separator(token):
        return None
    search_paths = [
        item
        for item in (
            read_environment_value("PATH"),
            os.pathsep.join(_default_path_segments()),
        )
        if item
    ]
    for search_path in dict.fromkeys(search_paths):
        discovered = shutil.which(token, path=search_path)
        if discovered is not None:
            return _resolve_command_path(discovered)
    return None


def _command_has_path_separator(command: str) -> bool:
    return "/" in command or "\\" in command


def _base_working_directory(
    config: MCPServerConfig,
    *,
    command_path: Path | None,
) -> Path:
    if config.name == BUILTIN_MCP_SERVER_NAME and not getattr(sys, "frozen", False):
        return _repo_root()
    if command_path is not None:
        return command_path.parent
    return Path.cwd()


def _default_path_segments() -> tuple[str, ...]:
    if _is_windows():
        system_root = read_environment_value("SYSTEMROOT")
        if system_root:
            return (os.path.join(system_root, "System32"), system_root)
        return ()
    return _POSIX_DEFAULT_PATH_SEGMENTS


def _windows_program_roots() -> list[str]:
    roots = [
        read_environment_value("ProgramFiles"),
        read_environment_value("ProgramFiles(x86)"),
        read_environment_value("LOCALAPPDATA"),
    ]
    system_root = read_environment_value("SYSTEMROOT")
    system_drive = read_environment_value("SystemDrive")
    drive = system_drive or (PureWindowsPath(system_root).drive if system_root else "")
    if drive:
        drive_root = PureWindowsPath(f"{drive}\\")
        roots.extend((str(drive_root / "Program Files"), str(drive_root / "Program Files (x86)")))
    return list(dict.fromkeys(root for root in roots if root))


def _windows_git_install_candidates() -> list[Path]:
    candidates: list[Path] = []
    for raw_root in _windows_program_roots():
        root = Path(raw_root)
        for relative_dir in _WINDOWS_GIT_RELATIVE_DIRS:
            candidates.append(root.joinpath(*relative_dir, "git.exe"))
        try:
            candidates.extend(sorted(root.glob(_WINDOWS_VS_GIT_GLOB)))
        except OSError:
            continue
    return candidates


def _discover_optional_command(command: str, *, parent_path: str) -> Path | None:
    discovered = shutil.which(command, path=parent_path) if parent_path else None
    resolved = _resolve_command_path(discovered or "")
    if resolved is not None:
        return resolved
    if _is_windows() and command.lower() == "git":
        for candidate in _windows_git_install_candidates():
            try:
                if candidate.is_file():
                    return candidate.resolve(strict=True)
            except OSError:
                continue
    return None


def _optional_builtin_tool_path_segments(config: MCPServerConfig) -> list[str]:
    if config.name != BUILTIN_MCP_SERVER_NAME:
        return []
    parent_path = read_environment_value("PATH")
    segments: list[str] = []
    for command in _BUILTIN_MCP_OPTIONAL_PATH_COMMANDS:
        resolved = _discover_optional_command(command, parent_path=parent_path)
        if resolved is not None:
            segments.append(str(resolved.parent))
    return segments


def _minimal_path(config: MCPServerConfig, command_path: Path | None) -> str:
    segments: list[str] = []
    if command_path is not None:
        segments.append(str(command_path.parent))
    segments.extend(_default_path_segments())
    segments.extend(_optional_builtin_tool_path_segments(config))
    return os.pathsep.join(dict.fromkeys(segments))


def _minimal_env(
    config: MCPServerConfig,
    *,
    command_path: Path | None,
) -> dict[str, str]:
    env = {
        "PATH": _minimal_path(config, command_path),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
    }
    for key in _ENV_PASSTHROUGH_KEYS:
        value = read_environment_value(key)
        if value:
            env[key] = value
    return env


def _set_resource_limit(resource_module: Any, resource_key: Any, value: int) -> None:
    if resource_key is None:
        return
    getrlimit = getattr(resource_module, "getrlimit", None)
    setrlimit = getattr(resource_module, "setrlimit", None)
    if not callable(getrlimit) or not callable(setrlimit):
        return
    soft, hard = getrlimit(resource_key)
    infinity = getattr(resource_module, "RLIM_INFINITY", -1)
    hard_limit = value if hard == infinity else min(int(hard), value)
    soft_limit = value if soft == infinity else min(int(soft), value)
    if value <= 0:
        limit = 0
        hard_limit = 0
    else:
        limit = max(1, min(soft_limit, hard_limit))
    setrlimit(resource_key, (limit, hard_limit))


def _posix_preexec_fn(
    *,
    memory_limit_mb: int,
    max_open_files: int,
) -> Callable[[], None]:
    memory_bytes = max(1, int(memory_limit_mb)) * 1024 * 1024
    open_files = max(1, int(max_open_files))

    def _apply_limits() -> None:  # pragma: no cover - runs in forked child
        if _resource is not None:
            _set_resource_limit(_resource, getattr(_resource, "RLIMIT_AS", None), memory_bytes)
            _set_resource_limit(_resource, getattr(_resource, "RLIMIT_NOFILE", None), open_files)
            _set_resource_limit(_resource, getattr(_resource, "RLIMIT_CORE", None), 0)
        setsid = getattr(os, "setsid", None)
        if callable(setsid):
            setsid()

    return _apply_limits


def _read_posix_process_cpu_seconds(pid: int) -> float | None:
    if not _is_posix():
        return None
    try:
        stat_text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        closing_paren = stat_text.rfind(")")
        if closing_paren < 0:
            return None
        stat_parts = stat_text[closing_paren + 2 :].split()
        sysconf = getattr(os, "sysconf", None)
        if not callable(sysconf):
            return None
        ticks = sysconf("SC_CLK_TCK")
        if not isinstance(ticks, int) or ticks <= 0:
            return None
        user_ticks = int(stat_parts[11])
        system_ticks = int(stat_parts[12])
    except (OSError, ValueError, IndexError):
        return None
    return (user_ticks + system_ticks) / ticks


class MCPProcessContainment:
    """Build and manage OS-level containment for one MCP stdio process."""

    def __init__(self, config: MCPServerConfig) -> None:
        self._config = config
        self._job: JobObject | None = None
        self._cpu_stop = threading.Event()
        self._cpu_thread: threading.Thread | None = None

    def popen_kwargs(self) -> dict[str, Any]:
        command_path = _resolve_command_for_env(str(self._config.command or ""))
        kwargs: dict[str, Any] = {
            "cwd": str(_base_working_directory(self._config, command_path=command_path)),
            "env": _minimal_env(self._config, command_path=command_path),
        }
        if _is_windows():
            kwargs["creationflags"] = int(getattr(subprocess, "CREATE_SUSPENDED", 0x00000004))
        else:
            kwargs["preexec_fn"] = _posix_preexec_fn(
                memory_limit_mb=self._config.memory_limit_mb,
                max_open_files=self._config.max_open_files,
            )
        return kwargs

    def after_spawn(self, process: subprocess.Popen[str]) -> None:
        if not _is_windows():
            return
        job = JobObject(
            memory_limit_mb=self._config.memory_limit_mb,
            max_processes=self._config.max_processes,
        )
        job.__enter__()
        try:
            job.assign(process)
            job.resume(process)
        except Exception:
            job.close()
            raise
        self._job = job

    def start_cpu_watchdog(
        self,
        *,
        logger: logging.Logger,
        process: subprocess.Popen[str],
    ) -> None:
        if self._cpu_thread is not None:
            return
        if not _is_posix() or _read_posix_process_cpu_seconds(int(process.pid)) is None:
            return
        self._cpu_thread = threading.Thread(
            target=self._watch_cpu_usage,
            args=(logger, process),
            name=f"mcp-cpu-watch-{self._config.name}",
            daemon=True,
        )
        self._cpu_thread.start()

    def terminate(self, process: subprocess.Popen[str]) -> None:
        self._cpu_stop.set()
        if self._job is not None:
            self._job.close()
            self._job = None
        if process.poll() is not None:
            return
        if _is_posix():
            self._terminate_posix_group(process)
            return
        self._terminate_process(process)

    def close(self) -> None:
        self._cpu_stop.set()
        if self._job is not None:
            self._job.close()
            self._job = None

    def _terminate_posix_group(self, process: subprocess.Popen[str]) -> None:
        if self._signal_posix_group(process, signal.SIGTERM):
            return
        if self._signal_posix_group(process, getattr(signal, "SIGKILL", signal.SIGTERM)):
            return
        self._terminate_process(process)

    def _terminate_process(self, process: subprocess.Popen[str]) -> None:
        for stop_process in (process.terminate, process.kill):
            try:
                stop_process()
                process.wait(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)
                return
            except Exception:
                continue

    def _signal_posix_group(self, process: subprocess.Popen[str], sig: int) -> bool:
        killpg = getattr(os, "killpg", None)
        if not callable(killpg):
            return False
        try:
            killpg(int(process.pid), sig)
            process.wait(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)
        except Exception:
            return False
        return True

    def _watch_cpu_usage(
        self,
        logger: logging.Logger,
        process: subprocess.Popen[str],
    ) -> None:
        warning_seconds = max(1.0, float(self._config.cpu_warning_seconds))
        previous_wall = time.monotonic()
        previous_cpu = _read_posix_process_cpu_seconds(int(process.pid))
        saturated_seconds = 0.0
        warned = False
        while not self._cpu_stop.wait(_CPU_SAMPLE_INTERVAL_SECONDS):
            if process.poll() is not None:
                return
            current_cpu = _read_posix_process_cpu_seconds(int(process.pid))
            if previous_cpu is None or current_cpu is None:
                return
            current_wall = time.monotonic()
            wall_delta = max(0.0, current_wall - previous_wall)
            cpu_delta = max(0.0, current_cpu - previous_cpu)
            if wall_delta > 0 and cpu_delta / wall_delta >= _CPU_SATURATION_RATIO:
                saturated_seconds += wall_delta
            else:
                saturated_seconds = 0.0
            if saturated_seconds >= warning_seconds and not warned:
                warned = True
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.mcp.process_containment",
                    event="ai.mcp.cpu_saturated",
                    message=f"MCP server CPU saturation warning: {self._config.name}",
                    status="degraded",
                    data={"server": self._config.name},
                )
            previous_wall = current_wall
            previous_cpu = current_cpu
