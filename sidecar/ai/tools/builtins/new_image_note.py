"""One model-facing line naming image files a command or script just wrote (row 199 C1).

A model that renders a screenshot can read pixel colours with scripts and never
look at the picture. After ``run_command``, ``run_temp_script``,
``python_execute`` and a finished ``check_background_job``, this module names
up to five new image files inside the workspace and says how to open one
(``read_file`` when Image reads are on) or that the model cannot see them.

Candidates are image path tokens in the call's text (command line or script,
stdout, stderr); gitignored folders such as ``target/`` never show up in git
status, so the text is the source. A candidate counts only when it is a regular
file modified since the call began and its real path stays in the workspace.
Paths only, never file content. Any failure yields an empty note; the tool
result is primary.
"""

from __future__ import annotations

import json
import os
import re
import stat
import threading
from collections import OrderedDict
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path

from sidecar.ai.tools.builtins import filesystem_settings

MAX_SCAN_CHARS = 64 * 1024
MAX_CANDIDATES = 50
MAX_LISTED = 5
MAX_TOKEN_CHARS = 400
MAX_JOB_STARTS = 64
MAX_STORED_COMMAND_CHARS = 8 * 1024
# A file written a moment before the clock reading (coarse filesystem timestamps).
MTIME_SLACK_SECONDS = 2.0
# Longer names, or names with control characters, are left out of the note.
MAX_LISTED_CHARS = 200
NOTE_KEY = "new_images_note"

_ON_HINT = (
    "If you can see images, open one with read_file to look at it before you describe or judge it; "
    "otherwise tell the user where they are."
)
_OFF_HINT = (
    "Image reads are off in Jenny's settings, so you cannot see them; "
    "tell the user where they are."
)
_SUFFIX_PATTERN = re.compile(r"\.(?:png|jpe?g|gif|webp)(?![A-Za-z0-9_]|\.[A-Za-z0-9_])", re.I)
_TOKEN_STOPS = frozenset(" \t\r\n\x00\"'`<>|*?,;()[]{}=")
_QUOTES = "\"'`"
_DRIVE_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")
_BACKSLASH_RUN = re.compile(r"\\+")
# A JSON-escaped newline, return or tab that ran into the path that follows it.
_JSON_ESCAPE_PREFIX = re.compile(r"^\\[nrt](?=[^\\/:])")

_lock = threading.Lock()
_job_starts: OrderedDict[tuple[str, str], tuple[float, str, str | None]] = OrderedDict()


def image_reads() -> bool:
    """This process's Image reads setting."""
    return bool(filesystem_settings._FILESYSTEM_SETTINGS["image_read_enabled"])


def new_image_note(
    workspace_root: Path | str | None,
    *,
    texts: Iterable[str],
    started_at: float,
    image_reads_enabled: bool | None = None,
    base_dirs: Sequence[Path | str] = (),
) -> str:
    """The note for one finished call, or ``""`` when no new image qualifies.

    ``image_reads_enabled`` defaults to this process's Image reads setting.
    """
    if workspace_root is None:
        return ""
    try:
        candidates = _candidates(texts)
        if not candidates:
            return ""
        reads = image_reads() if image_reads_enabled is None else image_reads_enabled
        listed = _new_images(Path(workspace_root), candidates, started_at, base_dirs)
        return _format_note(listed, reads)
    except Exception:  # noqa: BLE001 - the note is optional; the tool result is primary.
        return ""


def remember_job_start(
    workspace_root: Path | str, job_id: str, started_at: float, command: str,
    cwd: Path | str | None = None,
) -> None:
    """Keep a background job's start time, command and cwd, in this process only."""
    entry = (started_at, command[:MAX_STORED_COMMAND_CHARS], None if cwd is None else str(cwd))
    with _lock:
        _job_starts[_job_key(workspace_root, job_id)] = entry
        _job_starts.move_to_end(_job_key(workspace_root, job_id))
        while len(_job_starts) > MAX_JOB_STARTS:
            _job_starts.popitem(last=False)


def job_start(workspace_root: Path | str, job_id: str) -> tuple[float, str, str | None] | None:
    """``(started_at, command, cwd)`` of a job this process started, else ``None``."""
    with _lock:
        return _job_starts.get(_job_key(workspace_root, job_id))


def note_for_job(workspace_root: Path | str, job_id: str, *, texts: Iterable[str]) -> str:
    """The note for a finished background job, measured from its own start time."""
    entry = job_start(workspace_root, job_id)
    if entry is None:
        return ""
    started_at, command, cwd = entry
    return new_image_note(
        workspace_root, texts=(command, *texts), started_at=started_at,
        base_dirs=() if cwd is None else (cwd,),
    )


def _job_key(workspace_root: Path | str, job_id: str) -> tuple[str, str]:
    return (os.path.normcase(os.path.realpath(workspace_root)), job_id)


def _format_note(listed: list[str], reads_enabled: bool) -> str:
    # Each name is JSON-quoted so a file name reads as data, never as an instruction.
    listed = [path for path in listed if len(path) <= MAX_LISTED_CHARS and path.isprintable()]
    if not listed:
        return ""
    hidden = len(listed) - MAX_LISTED
    more = f" (and {hidden} more)" if hidden > 0 else ""
    hint = _ON_HINT if reads_enabled else _OFF_HINT
    names = ", ".join(json.dumps(path, ensure_ascii=False) for path in listed[:MAX_LISTED])
    return f"New images from this call: {names}{more}. {hint}"


def _new_images(
    workspace_root: Path, candidates: list[str], started_at: float, base_dirs: Sequence[Path | str],
) -> list[str]:
    root_real = Path(os.path.realpath(workspace_root))
    roots = (root_real, Path(os.path.abspath(workspace_root)))
    bases = [Path(base) for base in base_dirs] + [root_real]
    found: list[str] = []
    seen: set[str] = set()
    for token in candidates:
        relative = _qualifying_path(token, bases, roots, started_at)
        if relative is not None and os.path.normcase(relative) not in seen:
            seen.add(os.path.normcase(relative))
            found.append(relative)
    return found


def _candidates(texts: Iterable[str]) -> list[str]:
    """Distinct normalised tokens in first-seen order, at most ``MAX_CANDIDATES``."""
    tokens: dict[str, None] = {}
    for text in texts:
        for raw in _raw_tokens(_scan_window(text)):
            for variant in _variants(raw):
                if len(tokens) >= MAX_CANDIDATES:
                    return list(tokens)
                tokens.setdefault(variant, None)
    return list(tokens)


def _scan_window(text: str) -> str:
    if len(text) <= 2 * MAX_SCAN_CHARS:
        return text
    return f"{text[:MAX_SCAN_CHARS]}\n{text[-MAX_SCAN_CHARS:]}"


def _raw_tokens(text: str) -> Iterator[str]:
    """Image-suffixed path tokens; a quoted path with spaces is yielded as well."""
    for match in _SUFFIX_PATTERN.finditer(text):
        end, dot = match.end(), match.start()
        floor = max(0, dot - MAX_TOKEN_CHARS)
        start = dot
        while start > floor and text[start - 1] not in _TOKEN_STOPS:
            start -= 1
        yield text[start:end]
        line_floor = text.rfind("\n", floor, dot) + 1 or floor
        segment = text[line_floor:dot]
        for quote in _QUOTES:
            opened = segment.rfind(quote)
            if opened >= 0 and " " in segment[opened + 1:]:
                yield f"{segment[opened + 1:]}{match.group(0)}"


def _variants(raw: str) -> Iterator[str]:
    escaped = _JSON_ESCAPE_PREFIX.match(raw)
    forms = [raw, raw[escaped.end():]] if escaped else [raw]
    for form in forms:
        token = _normalize(form)
        if token:
            yield token


def _normalize(raw: str) -> str:
    token = raw.strip().strip(_QUOTES)
    if "://" in token:  # a URL, never a workspace file
        return ""
    if not _DRIVE_PATTERN.match(token) and ":" in token:
        token = token.rsplit(":", 1)[-1]
    return _BACKSLASH_RUN.sub("/", token).strip()


def _qualifying_path(
    token: str, bases: list[Path], roots: tuple[Path, Path], started_at: float
) -> str | None:
    try:
        path = Path(token)
        options = [path] if path.is_absolute() else [base / path for base in bases]
        for option in options:
            # String-only containment first: no filesystem call ever reaches a path outside
            # the workspace (a UNC or network path from untrusted output would block or
            # open a connection).
            lexical = Path(os.path.abspath(option))
            if not any(lexical.is_relative_to(root) for root in roots):
                continue
            relative = _checked_relative(option, roots[0], started_at)
            if relative is not None:
                return relative
    except (OSError, ValueError):  # one unusable token never hides the others.
        return None
    return None


def _checked_relative(candidate: Path, root_real: Path, started_at: float) -> str | None:
    """Workspace-relative POSIX path when ``candidate`` is a fresh regular file inside."""
    try:
        info = os.stat(candidate)  # follows links; stale or missing tokens stop before realpath
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_mtime < started_at - MTIME_SLACK_SECONDS:
        return None
    real = Path(os.path.realpath(candidate))
    if not real.is_relative_to(root_real):  # case-insensitive on Windows; another drive is False
        return None
    return real.relative_to(root_real).as_posix()
