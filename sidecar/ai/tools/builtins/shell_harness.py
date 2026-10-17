"""Shared shell environment and bounded output helpers; independent of shell owners."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from sidecar.ai.config import read_environment_value
from sidecar.ai.tools.builtins.shell_settings import default_on_feature_enabled

_NONINTERACTIVE_ENV = {
    "PAGER": "cat",
    "GIT_PAGER": "cat",
    "GIT_EDITOR": "false",
    "GIT_SEQUENCE_EDITOR": "false",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_EXTERNAL_DIFF": "",
    "GCM_INTERACTIVE": "never",
}
_MIDDLE_MARKER = "\n...[middle truncated]\n"


def noninteractive_env(base: Mapping[str, str]) -> dict[str, str]:
    """Copy inherited values and override settings that could require interaction."""
    env = dict(base)
    if os.name == "nt":
        env = {key: value for key, value in env.items() if key.upper() not in _NONINTERACTIVE_ENV}
    env.update(_NONINTERACTIVE_ENV)
    return env


def head_tail(text: str, *, head: int, tail: int, marker: str) -> str:
    """Keep both edges, inserting the caller's marker only when over budget."""
    if len(text) <= head + tail:
        return text
    return text[:head] + marker + (text[-tail:] if tail else "")


def powershell_directory() -> Path | None:
    """Canonical Windows PowerShell directory, when it exists on this host."""
    system_root = read_environment_value("SystemRoot") or read_environment_value("windir")
    if not system_root:
        return None
    candidate = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0"
    return candidate if (candidate / "powershell.exe").is_file() else None


def shell_environment(directory: Path | None) -> dict[str, str] | None:
    """Keep the legacy Windows PATH repair and optionally disable interaction."""
    inherited = dict(os.environ)
    env = None
    if os.name == "nt" and directory is not None:
        entries = [entry for entry in (inherited.get("PATH") or "").split(os.pathsep) if entry]
        if not any(os.path.normcase(os.path.normpath(entry)) ==
                   os.path.normcase(os.path.normpath(str(directory))) for entry in entries):
            env = {**inherited, "PATH": os.pathsep.join([*entries, str(directory)])}
    if default_on_feature_enabled("shell_noninteractive_env"):
        return noninteractive_env(env if env is not None else inherited)
    return env


def background_spawn_environment() -> dict[str, str] | None:
    """The background job's env; ``None`` (inherit, as before) when the flag is off."""
    if not default_on_feature_enabled("shell_noninteractive_env"):
        return None
    return shell_environment(powershell_directory())


def truncate_stream(value: str, *, failure: bool = False, display_path: str | None = None) -> str:
    """Preserve a root cause and final summary, pointing to persisted output if available."""
    marker = _middle_marker(display_path)
    head, tail = (6_000, 14_000) if failure else (14_000, 6_000)
    return head_tail(value, head=head, tail=tail, marker=marker)


def _middle_marker(display_path: str | None) -> str:
    if display_path:
        return f"\n...[middle truncated; full output: {display_path}]\n"
    return _MIDDLE_MARKER


def background_output(
    value: str, *, cap: int, failure: bool = False, display_path: str | None = None,
) -> tuple[str, bool]:
    """Fit both edges and the marker in the existing persisted status envelope."""
    if len(value) <= cap:
        return value, False
    if not default_on_feature_enabled("shell_head_tail_output"):
        return f"{value[:cap]}\n...[truncated]", True
    marker = _middle_marker(display_path)
    budget = cap + len("\n...[truncated]") - len(marker)
    head = int(budget * (0.3 if failure else 0.7))
    return head_tail(value, head=head, tail=budget - head, marker=marker), True
