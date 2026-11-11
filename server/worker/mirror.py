"""Synced-workspace mirror steps (row 106), run as the job UID by a fixed helper process.

``apply`` (before the command): apply the host's staged delta from ``/inputs`` to the ``/workspace``
volume and return the pre-run manifest. ``collect`` (in the successor incarnation, when no command
code is alive): diff ``/workspace`` against that manifest and copy changed regular files into the
outbox the host reads. Neither step runs concurrently with job code, but earlier commands may have
left symlinks, special files or odd permissions in the persistent volume, so every step uses lstat,
never follows a link and replaces a non-directory parent instead of writing through it. The host
re-validates everything it reads from the outbox; this side only bounds and shapes it.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import unicodedata
import uuid

MAX_SYNC_JSON_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_ENTRIES = 400_000
OUTBOX_MAX_BYTES = 256 * 1024 * 1024
OUTBOX_MAX_ENTRIES = 10_000
CHUNK = 1024 * 1024
HELPER_ARG_COUNT = 2
DIR_MODE = 0o755
FILE_MODE = 0o644
WORKSPACE_MODE = 0o700


class MirrorError(ValueError):
    """The delta or the mirror cannot be handled under the synced contract."""


def fold(name: str) -> str:
    """Match the host's NTFS-style fold (services/execution/sandbox-protected-paths.js)."""
    return unicodedata.normalize("NFKC", name).upper().lower().rstrip(". ")


def _relative(value: object) -> list[str]:
    if not isinstance(value, str) or not value or value.startswith("/") or "\x00" in value:
        raise MirrorError("mirror_path_invalid")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise MirrorError("mirror_path_invalid")
    return parts


def _lstat(path: str) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _writable_dir(path: str) -> None:
    # Earlier commands own the volume's files and may have removed their own write bits.
    os.chmod(path, stat.S_IMODE(os.lstat(path).st_mode) | stat.S_IRWXU)


def remove(path: str) -> None:
    """Remove a file, link, special file or real directory tree; never follow a link."""
    info = _lstat(path)
    if info is None:
        return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(path)
        return
    # An explicit stack: a command can nest directories deeper than Python's recursion limit.
    stack = [(path, False)]
    while stack:
        current, emptied = stack.pop()
        if emptied:
            os.rmdir(current)
            continue
        _writable_dir(current)
        stack.append((current, True))
        for entry in os.scandir(current):
            child = os.path.join(current, entry.name)
            if entry.is_dir(follow_symlinks=False):
                stack.append((child, False))
            else:
                os.unlink(child)


def _real_parent(root: str, parts: list[str]) -> str | None:
    current = root
    for part in parts:
        current = os.path.join(current, part)
        info = _lstat(current)
        if info is None or not stat.S_ISDIR(info.st_mode):
            return None
    return current


def _ensure_dir(root: str, parts: list[str]) -> str:
    current = root
    for part in parts:
        target = os.path.join(current, part)
        info = _lstat(target)
        if info is not None and not stat.S_ISDIR(info.st_mode):
            remove(target)
            info = None
        if info is None:
            try:
                os.mkdir(target, DIR_MODE)
            except PermissionError:
                _writable_dir(current)
                os.mkdir(target, DIR_MODE)
        current = target
    return current


def _copy(source: str, target_dir: str, name: str, *, mode: int) -> None:
    temp = os.path.join(target_dir, f".jenny-sync-{uuid.uuid4().hex}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    src = os.open(source, flags)
    try:
        if not stat.S_ISREG(os.fstat(src).st_mode):
            raise MirrorError("mirror_input_invalid")
        try:
            dst = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        except PermissionError:
            _writable_dir(target_dir)
            dst = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            while chunk := os.read(src, CHUNK):
                view = memoryview(chunk)
                while view:
                    view = view[os.write(dst, view):]
        finally:
            os.close(dst)
    finally:
        os.close(src)
    target = os.path.join(target_dir, name)
    info = _lstat(target)
    if info is not None and stat.S_ISDIR(info.st_mode):
        remove(target)
    os.replace(temp, target)


def _read_sync(inputs: str) -> dict:
    path = os.path.join(inputs, "sync.json")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SYNC_JSON_BYTES:
            raise MirrorError("mirror_sync_invalid")
        data = b""
        while chunk := os.read(fd, CHUNK):
            data += chunk
    finally:
        os.close(fd)
    try:
        sync = json.loads(data.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise MirrorError("mirror_sync_invalid") from exc
    keys = {"schema_version", "full", "directories", "files", "deletes", "trees", "protected"}
    if not isinstance(sync, dict) or set(sync) != keys or sync["schema_version"] != 1:
        raise MirrorError("mirror_sync_invalid")
    return sync


def apply_delta(inputs: str, workspace: str) -> None:
    """Make the mirror match the folder: wipe on a full sync, remove, create, then copy."""
    sync = _read_sync(inputs)
    # An earlier command may have opened up the mirror root; the job UID owns it.
    os.chmod(workspace, WORKSPACE_MODE)
    if sync["full"] is True:
        _writable_dir(workspace)
        _clear(workspace)
    for relative in [*sync["trees"], *sync["deletes"]]:
        parts = _relative(relative)
        parent = _real_parent(workspace, parts[:-1])
        # Beneath a link or file nothing of the real tree exists to remove; the link itself is
        # listed on its own when the host resyncs it.
        if parent is not None:
            _writable_dir(parent)
            remove(os.path.join(parent, parts[-1]))
    for relative in sync["directories"]:
        _ensure_dir(workspace, _relative(relative))
    files_dir = os.path.join(inputs, "files")
    for item in sync["files"]:
        # Each file is [path, staged name, size, sha256].
        if not isinstance(item, list) or len(item) != 4:  # noqa: PLR2004
            raise MirrorError("mirror_sync_invalid")
        parts = _relative(item[0])
        name = item[1]
        if not isinstance(name, str) or not name.isalnum():
            raise MirrorError("mirror_sync_invalid")
        parent = _ensure_dir(workspace, parts[:-1])
        _copy(os.path.join(files_dir, name), parent, parts[-1], mode=FILE_MODE)


def manifest(workspace: str) -> dict[str, list]:
    """path -> [kind, size, mtime_ns, ctime_ns, ino, nlink], kind d|f|l|s.

    A command can reset a file's mtime but not its ctime, so a hidden edit still shows.
    """
    result: dict[str, list] = {}
    stack = [(workspace, "")]
    while stack:
        directory, prefix = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except PermissionError:
            _writable_dir(directory)
            entries = list(os.scandir(directory))
        for entry in entries:
            relative = f"{prefix}/{entry.name}" if prefix else entry.name
            info = os.lstat(entry.path)
            mode = info.st_mode
            kind = ("d" if stat.S_ISDIR(mode) else "f" if stat.S_ISREG(mode)
                    else "l" if stat.S_ISLNK(mode) else "s")
            result[relative] = [kind, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                                info.st_ino, info.st_nlink]
            if len(result) > MAX_MANIFEST_ENTRIES:
                raise MirrorError("mirror_manifest_limit")
            if kind == "d":
                stack.append((entry.path, relative))
    return result


def _protected_root(relative: str, names: set[str], paths: list[list[str]]) -> str | None:
    """The protected root plus one level, so a cache write under node_modules resyncs only that
    subtree on the next run, not the whole tree."""
    parts = relative.split("/")
    folded = [fold(part) for part in parts]
    for length in range(1, len(parts) + 1):
        if folded[length - 1] in names or any(prefix == folded[:length] for prefix in paths):
            return "/".join(parts[: length + 1])
    return None


def _changes(before: dict[str, list], after: dict[str, list]) -> list[tuple[str, str, list]]:
    changes = []
    for relative, now in after.items():
        old = before.get(relative)
        if old is None:
            changes.append((relative, "added", now))
        elif old[0] != now[0]:
            changes.append((relative, "deleted", old))
            changes.append((relative, "added", now))
        elif now[0] != "d" and old[1:5] != now[1:5]:
            changes.append((relative, "modified", now))
    changes.extend((relative, "deleted", old) for relative, old in before.items()
                   if relative not in after)
    return changes


def _refusal(info: list) -> str | None:
    if info[0] == "l":
        return "symlink"
    if info[0] == "s":
        return "special"
    return "hardlink" if info[0] == "f" and info[5] != 1 else None


def _clear(outbox: str) -> None:
    for entry in os.scandir(outbox):
        remove(os.path.join(outbox, entry.name))


def _write_json(outbox: str, value: dict) -> None:
    temp = os.path.join(outbox, ".changes.json.tmp")
    with open(temp, "w", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"))
    os.replace(temp, os.path.join(outbox, "changes.json"))


def _copy_out(source: str, target: str, expected: list) -> tuple[int, str] | None:
    fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_ino != expected[4]:
            return None
        digest = hashlib.sha256()
        size = 0
        with open(target, "xb") as out:
            while chunk := os.read(fd, CHUNK):
                digest.update(chunk)
                out.write(chunk)
                size += len(chunk)
        return size, digest.hexdigest()
    finally:
        os.close(fd)


def collect(
    workspace: str, outbox: str, before: dict[str, list], job_id: str, protected: dict
) -> dict:
    """Write ``changes.json`` plus ``files/<n>`` for the host; returns the changes record."""
    os.chmod(workspace, WORKSPACE_MODE)
    _clear(outbox)
    after = manifest(workspace)
    names = {fold(name) for name in protected.get("names", [])}
    paths = [[fold(part) for part in value.split("/")] for value in protected.get("paths", [])]
    entries: list[dict] = []
    collapsed: set[str] = set()
    pending: list[tuple[str, str, list]] = []
    for relative, change, info in sorted(_changes(before, after)):
        root = _protected_root(relative, names, paths)
        if root is not None:
            parts = root.split("/")
            covered = any("/".join(parts[:end]) in collapsed for end in range(1, len(parts)))
            if not covered and root not in collapsed:
                collapsed.add(root)
                kind = "file" if root == relative and info[0] != "d" else "directory"
                entries.append({"path": root, "change": "modified", "kind": kind,
                                "refused": "protected"})
            continue
        kind = "directory" if info[0] == "d" else "file"
        refused = _refusal(info) if change != "deleted" else None
        if change == "deleted" or kind == "directory":
            entries.append({"path": relative, "change": change, "kind": kind})
        elif refused:
            entries.append({"path": relative, "change": change, "kind": "file", "refused": refused})
        else:
            pending.append((relative, change, info))
    total = sum(info[1] for _, _, info in pending)
    if len(entries) + len(pending) > OUTBOX_MAX_ENTRIES or total > OUTBOX_MAX_BYTES:
        record = {"schema_version": 1, "job_id": job_id, "status": "write_back_too_large",
                  "entries": []}
        _write_json(outbox, record)
        return record
    files_dir = os.path.join(outbox, "files")
    os.mkdir(files_dir)
    for number, (relative, change, info) in enumerate(pending):
        try:
            copied = _copy_out(os.path.join(workspace, *relative.split("/")),
                               os.path.join(files_dir, str(number)), info)
        except OSError:
            # A mode-000 file must not cost the command every other change it made.
            copied = None
        if copied is None:
            entries.append({"path": relative, "change": change, "kind": "file",
                            "refused": "unreadable"})
            continue
        entries.append({"path": relative, "change": change, "kind": "file", "file": str(number),
                        "size": copied[0], "sha256": copied[1]})
    record = {"schema_version": 1, "job_id": job_id, "status": "ok", "entries": entries}
    _write_json(outbox, record)
    return record


def helper_entry_code() -> str:
    package_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    return (
        "import sys,os;sys.path.insert(0," + repr(package_root) + ");\n"
        "try: from server.worker.mirror import helper_main;helper_main()"
        "\nexcept BaseException: os._exit(125)"
    )


def helper_main() -> None:
    """Fixed helper: ``apply`` prints the pre-run manifest; ``collect`` reads it from stdin."""
    if len(sys.argv) != HELPER_ARG_COUNT or sys.argv[1] not in {"apply", "collect"}:
        os._exit(125)
    os.chdir("/")
    from .supervisor import INPUTS_DIR, OUTBOX_DIR, WORKSPACE_DIR

    try:
        if sys.argv[1] == "apply":
            apply_delta(INPUTS_DIR, WORKSPACE_DIR)
            sys.stdout.write(json.dumps(manifest(WORKSPACE_DIR), separators=(",", ":")))
        else:
            # The protected set comes from the host's read-only sync.json, never from the job.
            request = json.loads(sys.stdin.read())
            protected = _read_sync(INPUTS_DIR)["protected"]
            collect(WORKSPACE_DIR, OUTBOX_DIR, request["manifest"], request["job_id"], protected)
            sys.stdout.write("ok")
        sys.stdout.flush()
    except (OSError, ValueError, KeyError, TypeError):
        os._exit(124)
