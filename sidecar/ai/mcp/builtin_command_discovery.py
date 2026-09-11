"""Bounded command installation discovery for first-party desktop tools only."""

from __future__ import annotations

import os
from pathlib import Path, PureWindowsPath
from typing import Callable

EnvironmentReader = Callable[[str], str]
COMMANDS = ("git", "python", "python3", "node", "npm", "npx", "powershell")
MAX_PATH_ENTRIES = 256
MAX_REGISTERED_PYTHONS = 32


def executable_path(candidate: Path, *, windows: bool) -> Path | None:
    if not candidate.is_absolute() or "windowsapps" in {p.lower() for p in candidate.parts}:
        return None
    try:
        if candidate.is_file() and (windows or os.access(candidate, os.X_OK)):
            return candidate.resolve(strict=True)
    except OSError:
        pass
    return None


def program_roots(read_env: EnvironmentReader) -> list[Path]:
    values = [read_env(key) for key in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")]
    drive = read_env("SystemDrive") or PureWindowsPath(read_env("SYSTEMROOT")).drive
    if drive:
        values.extend(
            str(PureWindowsPath(drive + "\\") / name)
            for name in ("Program Files", "Program Files (x86)")
        )
    return list(
        dict.fromkeys(Path(value) for value in values if value and Path(value).is_absolute())
    )


def registered_pythons() -> list[Path]:
    """Read PythonCore registration without launching interpreters or installers."""
    try:
        import winreg  # noqa: PLC0415 - Windows-only optional platform module.
    except ImportError:
        return []
    candidates = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(
                    hive, r"Software\Python\PythonCore", 0, winreg.KEY_READ | view
                ) as root:
                    versions = []
                    for index in range(MAX_REGISTERED_PYTHONS):
                        try:
                            version = winreg.EnumKey(root, index)
                        except OSError:
                            break
                        parts = version.split("-")[0].split(".")
                        if parts[0] == "3" and all(part.isdigit() for part in parts):
                            versions.append((tuple(map(int, parts)), version))
                    for _, version in sorted(versions, reverse=True):
                        try:
                            with winreg.OpenKey(root, version + r"\InstallPath") as install:
                                try:
                                    value = winreg.QueryValueEx(install, "ExecutablePath")[0]
                                except OSError:
                                    value = str(Path(winreg.QueryValue(install, "")) / "python.exe")
                                if isinstance(value, str):
                                    candidates.append(Path(value))
                        except OSError:
                            continue
            except OSError:
                continue
    return list(dict.fromkeys(candidates))


def windows_candidates(command: str, read_env: EnvironmentReader) -> list[Path]:
    roots = program_roots(read_env)
    if command in {"python", "python3"}:
        return registered_pythons()
    if command in {"node", "npm", "npx"}:
        filename = "node.exe" if command == "node" else command + ".cmd"
        return [root / "nodejs" / filename for root in roots]
    if command == "powershell":
        system_root = read_env("SYSTEMROOT")
        return (
            [Path(system_root) / "System32/WindowsPowerShell/v1.0/powershell.exe"]
            if system_root
            else []
        )
    if command != "git":
        return []
    candidates = [root / "Git" / folder / "git.exe" for root in roots for folder in ("cmd", "bin")]
    for root in roots:
        try:
            matches = root.glob(
                "Microsoft Visual Studio/*/*/Common7/IDE/CommonExtensions/"
                "Microsoft/TeamFoundation/Team Explorer/Git/cmd/git.exe"
            )
            for index, match in enumerate(matches):
                if index >= MAX_REGISTERED_PYTHONS:
                    break
                candidates.append(match)
        except OSError:
            continue
    return candidates


def discover_command_directories(
    *,
    parent_path: str,
    windows: bool,
    read_env: EnvironmentReader,
    commands: tuple[str, ...] = COMMANDS,
    excluded_directories: tuple[Path, ...] = (),
) -> list[str]:
    roots = [
        Path(raw.strip('"'))
        for raw in parent_path.split(os.pathsep)[:MAX_PATH_ENTRIES]
        if raw and Path(raw.strip('"')).is_absolute()
    ]
    excluded = {directory.resolve() for directory in excluded_directories}
    selected: list[tuple[int, str]] = []
    for command in commands:
        suffixes = (".exe", ".cmd", ".bat") if windows else ("",)
        candidates = [root / (command + suffix) for root in roots for suffix in suffixes]
        if windows:
            candidates.extend(windows_candidates(command, read_env))
        for candidate in candidates:
            resolved = executable_path(candidate, windows=windows)
            if resolved is not None and resolved.parent not in excluded:
                priority = (roots.index(candidate.parent) if candidate.parent in roots
                            else MAX_PATH_ENTRIES + len(selected))
                selected.append((priority, str(resolved.parent)))
                break
    return list(dict.fromkeys(directory for _, directory in sorted(selected)))
