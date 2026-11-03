"""Best-effort pytest test-file discovery for the progress grid.

Runs off the caller's thread. Anything unexpected (timeout, too many files, unreadable
config, a path outside the workspace) yields ``None`` so the tracker falls back to the
completion-order grid.
"""

from __future__ import annotations

import configparser
import fnmatch
import os
import re
import shlex
import time
import tomllib
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.tools.builtins.filesystem import SEARCH_IGNORE_DIRS
from sidecar.ai.tools.builtins.grep_search_file import is_link_path

MAX_FILES = 20_000
_DEFAULT_PATTERNS = ("test_*.py", "*_test.py")
_SKIP_DIRS = SEARCH_IGNORE_DIRS | {"build", "dist", ".tox", ".mypy_cache", ".pytest_cache"}
_OPTS_WITH_VALUE = {
    "-n", "-k", "-m", "-p", "-c", "-o", "-W", "-r", "--tb", "--maxfail", "--durations",
    "--rootdir", "--confcutdir", "--basetemp", "--deselect", "--ignore", "--ignore-glob",
    "--junitxml", "--junit-xml", "--log-level", "--dist", "--numprocesses", "--import-mode",
    "--capture", "--color", "--timeout", "--override-ini", "--durations-min",
    "--cov-report", "--cov-config", "--html", "--log-file", "--junit-prefix",
}  # fmt: skip
_COMMAND_BREAKS = {"&&", "||", ";", "|", "&"}
_PYTEST_NAMES = {"pytest", "pytest.exe", "py.test", "py.test.exe"}
# Shell redirections: `2>&1`, `>out`, `&>log`, `>>log`, `<in`; a bare operator takes the next token.
_REDIRECT_RE = re.compile(r"^(?:\d*|&)(?:>>?|<)(.*)$")


class _Budget(Exception):
    pass


def pytest_args(command: str) -> list[str]:
    """Tokens after the pytest executable, up to the next shell operator."""
    try:
        tokens = [t.strip("'\"") for t in shlex.split(command, posix=False)]
    except ValueError:
        return []
    for index, token in enumerate(tokens):
        name = token.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if name in _PYTEST_NAMES:
            args: list[str] = []
            for arg in tokens[index + 1 :]:
                if arg in _COMMAND_BREAKS:
                    break
                args.append(arg)
            return args
    return []


def positional_paths(args: list[str]) -> list[str]:
    paths: list[str] = []
    skip_next = False
    for arg in args:
        redirect = _REDIRECT_RE.match(arg)
        if skip_next:
            skip_next = False
        elif redirect:
            skip_next = not redirect.group(1)
        elif arg.startswith("-"):
            skip_next = arg in _OPTS_WITH_VALUE
        else:
            paths.append(arg.split("::", 1)[0])
    return paths


def _split_ini(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    return str(value or "").split()


def read_config(cwd: Path) -> tuple[list[str], list[str]]:
    """``(python_files, testpaths)`` from the first pytest config found in ``cwd``."""
    section: dict[str, object] | None = None
    ini = cwd / "pytest.ini"
    pyproject = cwd / "pyproject.toml"
    if ini.is_file():
        section = _ini_section(ini, "pytest")
        section = {} if section is None else section
    if section is None and pyproject.is_file():
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        table = data.get("tool", {}).get("pytest", {}).get("ini_options")
        section = table if isinstance(table, dict) else None
    for name, header in (("setup.cfg", "tool:pytest"), ("tox.ini", "pytest")):
        if section is None and (cwd / name).is_file():
            section = _ini_section(cwd / name, header)
    section = section or {}
    return _split_ini(section.get("python_files")), _split_ini(section.get("testpaths"))


def _ini_section(path: Path, header: str) -> dict[str, object] | None:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(path.read_text(encoding="utf-8"))
    return dict(parser[header]) if parser.has_section(header) else None


def _inside(path: Path, root: Path) -> bool:
    try:
        return path.resolve().is_relative_to(root)
    except (OSError, RuntimeError):
        return False


def _matches(relative: str, patterns: list[str]) -> bool:
    name = relative.rsplit("/", 1)[-1]
    return any(fnmatch.fnmatch(relative if "/" in pat else name, pat) for pat in patterns)


def _skip_dir(name: str) -> bool:
    return name in _SKIP_DIRS or fnmatch.fnmatch(name, "*.egg*")


def discover(
    *,
    command: str,
    cwd: Path,
    workspace_root: Path,
    budget_seconds: float = 1.0,
    clock: Callable[[], float] = time.monotonic,
) -> list[str] | None:
    """Sorted test-file labels (posix, relative to ``cwd``), or ``None`` on any failure."""
    try:
        return _discover(command, cwd, workspace_root, budget_seconds, clock)
    except (
        _Budget,
        OSError,
        ValueError,
        KeyError,
        NotImplementedError,
        tomllib.TOMLDecodeError,
        configparser.Error,
    ):
        return None


def _discover(
    command: str, cwd: Path, workspace_root: Path, budget: float, clock: Callable[[], float]
) -> list[str]:
    deadline = clock() + budget
    root = workspace_root.resolve()
    cwd = cwd.resolve()
    patterns, testpaths = read_config(cwd)
    patterns = patterns or list(_DEFAULT_PATTERNS)
    explicit = [p for p in positional_paths(pytest_args(command)) if _exists(cwd, p)]
    requested = explicit or testpaths or ["."]
    found: set[str] = set()

    def check_deadline() -> None:
        if clock() > deadline:
            raise _Budget

    for entry in requested:
        for candidate in _expand(cwd, entry, check_deadline):
            if not _inside(candidate, root) or is_link_path(candidate):
                continue
            if candidate.is_file():
                found.add(_label(candidate, cwd))
            elif candidate.is_dir():
                _walk(candidate, _Scan(cwd, root, patterns, found, deadline, clock))
            if len(found) > MAX_FILES:
                raise _Budget
    if not found:
        raise _Budget  # nothing to draw: the tracker falls back to the completion-order grid
    return sorted(found)


def _exists(cwd: Path, entry: str) -> bool:
    """Drop junk positionals (option values, redirection targets); globs always pass."""
    if any(ch in entry for ch in "*?["):
        return True
    try:
        return (cwd / entry).exists()
    except (OSError, ValueError):
        return False


def _expand(cwd: Path, entry: str, check_deadline: Callable[[], None]) -> Iterator[Path]:
    if not any(ch in entry for ch in "*?["):
        yield cwd / entry
        return
    for path in cwd.glob(entry):
        check_deadline()
        yield path


def _label(path: Path, cwd: Path) -> str:
    try:
        return path.resolve().relative_to(cwd).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _dir_prefix(dirpath: str, cwd: Path) -> str:
    try:
        rel = os.path.relpath(dirpath, cwd).replace("\\", "/")
    except ValueError:
        return Path(dirpath).as_posix() + "/"
    if rel == ".":
        return ""
    return (Path(dirpath).as_posix() if rel.startswith("..") else rel) + "/"


@dataclass
class _Scan:
    cwd: Path
    root: Path
    patterns: list[str]
    found: set[str]
    deadline: float
    clock: Callable[[], float]


def _walk(start: Path, scan: _Scan) -> None:
    cwd, root, patterns, found = scan.cwd, scan.root, scan.patterns, scan.found
    base = start.resolve()
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        if scan.clock() > scan.deadline:
            raise _Budget
        dirnames[:] = [
            d for d in dirnames if not _skip_dir(d) and not is_link_path(Path(dirpath, d))
        ]
        if not _inside(Path(dirpath), root):
            dirnames[:] = []
            continue
        prefix = _dir_prefix(dirpath, cwd)
        for filename in filenames:
            relative = prefix + filename
            if _matches(relative, patterns) and not os.path.islink(os.path.join(dirpath, filename)):
                found.add(relative)
        if len(found) > MAX_FILES:
            raise _Budget
