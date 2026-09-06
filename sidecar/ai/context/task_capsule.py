"""Compact coding-task orientation for local model turns."""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from sidecar.ai.personality.sanitization import sanitize_bootstrap
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_manifest import get_workspace_manifest_cache
from sidecar.runtime.diagnostics import log_event, sanitize_diagnostic_text

logger = logging.getLogger(__name__)

TASK_CAPSULE_HEADING = "## Coding Task Capsule"
DEFAULT_MAX_CHARS = 1_800
MAX_GUIDANCE_FILE_BYTES = 16_384
MAX_GUIDANCE_CHARS = 220
MAX_TOOL_NAMES = 8
MAX_ENTRY_POINTS = 6
MAX_TOP_DIRS = 6
ELLIPSIS_CHARS = 3
GUIDANCE_FILES = ("AGENTS.md", "INVENTORY.md", "WORKSPACE_MANIFEST.md")

_CODE_TASK_RE = re.compile(
    r"\b("
    r"code|codebase|repo|repository|source|implementation|implement|fix|bug|"
    r"test|tests|failing|trace|debug|refactor|module|file|files|class|"
    r"function|runtime|renderer|electron|sidecar|ipc|protocol|tool|"
    r"context|prompt|lsp|manifest|schema|migration"
    r")\b",
    re.IGNORECASE,
)
_UI_RE = re.compile(r"\b(ui|ux|renderer|css|html|chat|settings|sidebar|transcript)\b", re.I)
_ELECTRON_RE = re.compile(r"\b(electron|ipc|preload|main\.js|service|safeStorage|settings)\b", re.I)
_SIDECAR_RE = re.compile(
    r"\b(sidecar|python|json-rpc|protocol|runtime|memory|ollama|vllm|lsp)\b",
    re.I,
)
_PATH_RE = re.compile(r"[A-Za-z]:[\\/][^\s'\"`<>]+|/(?:Users|home|tmp|var)/[^\s'\"`<>]+")


@dataclass(frozen=True)
class TaskCapsuleLimits:
    max_chars: int = DEFAULT_MAX_CHARS
    max_guidance_chars: int = MAX_GUIDANCE_CHARS


@dataclass(frozen=True)
class _CacheEntry:
    created_at: float
    value: str


@dataclass(frozen=True)
class _GuidanceFile:
    name: str
    path: Path
    size: int
    mtime_ns: int


class TaskCapsuleCache:
    """Small in-process cache for generated task capsules."""

    def __init__(
        self,
        *,
        generator: Callable[[Path, str], str] | None = None,
        clock: Callable[[], float] = time.monotonic,
        max_entries: int = 16,
        ttl_seconds: float = 60.0,
    ) -> None:
        self._generator = generator or _generate_task_capsule_uncached
        self._clock = clock
        self._max_entries = max(1, int(max_entries))
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._entries: OrderedDict[tuple[str, str, str], _CacheEntry] = OrderedDict()
        self._lock = threading.RLock()

    def read(
        self,
        workspace_root: str | Path | None,
        latest_user_content: str,
        *,
        state_key: str = "",
        generator: Callable[[Path, str], str] | None = None,
    ) -> str:
        root = _resolve_root(workspace_root)
        if root is None:
            return ""
        key = (
            str(root),
            _intent_bucket(latest_user_content),
            _stable_hash(state_key)[:16],
        )
        now = self._clock()
        with self._lock:
            cached = self._entries.get(key)
            if cached is not None and now - cached.created_at <= self._ttl_seconds:
                self._entries.move_to_end(key)
                return cached.value

        value = (generator or self._generator)(root, latest_user_content)
        with self._lock:
            self._entries[key] = _CacheEntry(created_at=now, value=value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
        return value


def looks_like_coding_task(value: str) -> bool:
    return bool(_CODE_TASK_RE.search(str(value or "")))


def build_coding_task_capsule(  # noqa: PLR0913 - explicit prompt-enrichment inputs.
    workspace_root: str | Path | None,
    *,
    latest_user_content: str,
    enabled: bool,
    tool_statuses: Iterable[Any] | None = None,
    limits: TaskCapsuleLimits | None = None,
    cache: TaskCapsuleCache | None = None,
) -> str:
    """Return a bounded repo-orientation capsule or an empty string."""

    if enabled is not True or not looks_like_coding_task(latest_user_content):
        return ""
    root = _resolve_root(workspace_root)
    if root is None:
        return ""

    applied_limits = limits or TaskCapsuleLimits()
    tool_status_snapshot = tuple(tool_statuses or ())
    try:
        manifest = _read_workspace_manifest(root)
        if _manifest_unavailable(manifest):
            return ""
        guidance_files = _guidance_files(root)
        state_key = "|".join(
            (
                _manifest_state_key(manifest),
                _guidance_state_key(guidance_files),
                _navigation_tool_state_key(tool_status_snapshot),
            )
        )

        def generate(_root: Path, _latest_user_content: str) -> str:
            return _render_capsule(
                root=_root,
                latest_user_content=_latest_user_content,
                manifest=manifest,
                guidance_files=guidance_files,
                tool_statuses=tool_status_snapshot,
                limits=applied_limits,
            )

        capsule_cache = cache or _CACHE
        return capsule_cache.read(
            root,
            latest_user_content,
            state_key=state_key,
            generator=generate,
        )
    except Exception as error:  # noqa: BLE001 - prompt enrichment must fail closed.
        log_event(
            logger,
            logging.WARNING,
            component="ai.context.task_capsule",
            event="task_capsule.build_failed",
            message="Coding task capsule generation failed closed.",
            status="skipped",
            data={"error": _sanitize_error_text(error)},
        )
        return ""


def _generate_task_capsule_uncached(root: Path, latest_user_content: str) -> str:
    manifest = _read_workspace_manifest(root)
    if _manifest_unavailable(manifest):
        return ""
    return _render_capsule(
        root=root,
        latest_user_content=latest_user_content,
        manifest=manifest,
        guidance_files=_guidance_files(root),
        tool_statuses=None,
        limits=TaskCapsuleLimits(),
    )


_CACHE = TaskCapsuleCache()


def _read_workspace_manifest(root: Path) -> dict[str, object]:
    return get_workspace_manifest_cache().read(root)


def _render_capsule(  # noqa: PLR0913 - explicit prompt section inputs.
    *,
    root: Path,
    latest_user_content: str,
    manifest: dict[str, object],
    guidance_files: list[_GuidanceFile],
    tool_statuses: Iterable[Any] | None,
    limits: TaskCapsuleLimits,
) -> str:
    route = _route_for_prompt(latest_user_content)
    guidance_file_names = [item.name for item in guidance_files]
    entry_points = _string_list(manifest.get("entry_points"), limit=MAX_ENTRY_POINTS)
    top_dirs = _top_dir_names(manifest.get("top_dirs"), limit=MAX_TOP_DIRS)
    tools = _available_navigation_tools(tool_statuses)
    checks = _checks_for_route(route)
    guardrails = _guidance_snippets(guidance_files, max_chars=limits.max_guidance_chars)

    lines = [
        TASK_CAPSULE_HEADING,
        f"Likely ownership route: {route}",
        f"Read first: {_format_list(guidance_file_names)}",
        f"Entry points: {_format_list(entry_points)}",
        f"Top directories: {_format_list(top_dirs)}",
        f"Available navigation tools: {_format_list(tools)}",
        f"Suggested checks: {_format_list(checks)}",
        (
            "Public surface: check protocol, IPC, persisted schema, tool ids, "
            "renderer-visible UI, and manifests if touched."
        ),
    ]
    if guardrails:
        lines.append(f"Repo guardrails: {guardrails}")
    return _cap_text("\n".join(lines), limits.max_chars)


def _resolve_root(workspace_root: str | Path | None) -> Path | None:
    try:
        guard = WorkspaceGuard(str(workspace_root) if workspace_root is not None else None)
        return guard.require_root()
    except ToolExecutionFailure:
        return None


def _manifest_unavailable(manifest: dict[str, object]) -> bool:
    return not isinstance(manifest, dict) or bool(manifest.get("error"))


def _manifest_state_key(manifest: dict[str, object]) -> str:
    git = manifest.get("git") if isinstance(manifest.get("git"), dict) else {}
    totals = manifest.get("totals") if isinstance(manifest.get("totals"), dict) else {}
    entry_points = _string_list(manifest.get("entry_points"), limit=MAX_ENTRY_POINTS)
    top_dirs = _top_dir_names(manifest.get("top_dirs"), limit=MAX_TOP_DIRS)
    raw_key = "|".join(
        (
            str(git.get("branch") if isinstance(git, dict) else ""),
            str(git.get("head_sha7") if isinstance(git, dict) else ""),
            str(git.get("dirty_count") if isinstance(git, dict) else ""),
            str(totals.get("files_scanned") if isinstance(totals, dict) else ""),
            str(totals.get("truncated") if isinstance(totals, dict) else ""),
            ",".join(entry_points),
            ",".join(top_dirs),
        )
    )
    return _stable_hash(raw_key)[:16]


def _route_for_prompt(prompt: str) -> str:
    text = str(prompt or "")
    if _SIDECAR_RE.search(text):
        return "sidecar runtime (docs/manifests/sidecar-runtime.md)"
    if _ELECTRON_RE.search(text):
        return "electron wiring (docs/manifests/electron-wiring.md)"
    if _UI_RE.search(text):
        return "ui/ux (docs/manifests/ui-ux.md)"
    return "workspace manifest routing (WORKSPACE_MANIFEST.md)"


def _guidance_files(root: Path) -> list[_GuidanceFile]:
    guard = WorkspaceGuard(str(root))
    files: list[_GuidanceFile] = []
    for name in GUIDANCE_FILES:
        guidance_file = _safe_guidance_file(guard, name)
        if guidance_file is not None:
            files.append(guidance_file)
    return files


def _guidance_state_key(files: list[_GuidanceFile]) -> str:
    raw_key = "|".join(f"{item.name}:{item.size}:{item.mtime_ns}" for item in files)
    return _stable_hash(raw_key)[:16]


def _guidance_snippets(files: list[_GuidanceFile], *, max_chars: int) -> str:
    snippets: list[str] = []
    for guidance_file in files:
        try:
            content = _read_guidance_text(guidance_file.path)
        except OSError:
            continue
        snippet = _first_signal_line(content)
        if snippet:
            snippets.append(f"{guidance_file.name}: {snippet}")
    return _cap_text("; ".join(snippets), max_chars)


def _safe_guidance_file(guard: WorkspaceGuard, name: str) -> _GuidanceFile | None:
    if Path(name).name != name:
        return None
    try:
        path = guard.resolve_read_path(name)
        stat = path.stat()
    except ToolExecutionFailure:
        return None
    except OSError:
        return None
    if not path.is_file():
        return None
    return _GuidanceFile(
        name=name,
        path=path,
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
    )


def _read_guidance_text(path: Path) -> str:
    with path.open("rb") as handle:
        data = handle.read(MAX_GUIDANCE_FILE_BYTES)
    return data.decode("utf-8", errors="replace")


def _first_signal_line(content: str) -> str:
    for raw_line in str(content or "").splitlines():
        line = _sanitize_line(raw_line)
        if not line or line.startswith(("#", "---", "|")):
            continue
        return line
    return ""


def _available_navigation_tools(
    tool_statuses: Iterable[Any] | None,
) -> list[str]:
    if tool_statuses is None:
        return []
    wanted = {
        "glob_files",
        "grep_search",
        "list_dir",
        "read_file",
        "workspace_manifest_read",
        "lsp",
        "git_diff",
        "git_show",
    }
    tools: list[str] = []
    for status in tool_statuses:
        name = str(getattr(status, "name", "") or "").strip()
        if name in wanted and getattr(status, "available", False) is True and name not in tools:
            tools.append(name)
        if len(tools) >= MAX_TOOL_NAMES:
            break
    return tools


def _navigation_tool_state_key(tool_statuses: Iterable[Any] | None) -> str:
    return ",".join(_available_navigation_tools(tool_statuses))


def _checks_for_route(route: str) -> list[str]:
    if route.startswith("sidecar runtime"):
        return [
            "python -m pytest <focused sidecar tests>",
            "python scripts/checks/check_workspace_manifest.py",
        ]
    if route.startswith("electron wiring"):
        return [
            "npm run test:safe -- <focused Node tests>",
            "Use Jenny's safe runner; never parallelize Electron-backed files "
            "with raw node --test.",
            "python scripts/checks/check_workspace_manifest.py",
        ]
    if route.startswith("ui/ux"):
        return [
            "npm run test:safe -- <focused renderer tests>",
            "Use Jenny's safe runner; never parallelize Electron-backed files "
            "with raw node --test.",
        ]
    return ["check the routed domain manifest before broad search"]


def _string_list(value: object, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = _sanitize_line(item)
        if text:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _top_dir_names(value: object, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    names: list[str] = []
    for item in value:
        source = item.get("name") if isinstance(item, dict) else item
        text = _sanitize_line(source)
        if text:
            names.append(text)
        if len(names) >= limit:
            break
    return names


def _sanitize_line(value: object) -> str:
    text = " ".join(str(value or "").split())
    text = sanitize_bootstrap(text, source_name="task_capsule.guidance")
    text = _redact_paths(text)
    return " ".join(text.split())[:240]


def _format_list(values: list[str]) -> str:
    return ", ".join(values) if values else "none"


def _cap_text(text: str, max_chars: int) -> str:
    limit = max(1, int(max_chars))
    if len(text) <= limit:
        return text
    if limit <= ELLIPSIS_CHARS:
        return text[:limit]
    return f"{text[: limit - ELLIPSIS_CHARS].rstrip()}..."


def _sanitize_error_text(error: BaseException) -> str:
    text = sanitize_diagnostic_text(str(error), limit=180)
    return _redact_paths(text)


def _redact_paths(text: str) -> str:
    return _PATH_RE.sub("[path]", text)


def _intent_bucket(value: str) -> str:
    route = _route_for_prompt(value)
    return route.split(" ", 1)[0] or "workspace"


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()
