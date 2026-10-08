"""Derived import facts for a suggested change (Plan Plus W3, working spec decision 4).

Only what the text and the workspace prove: an import the change removes, and a
newly added relative import whose target is neither in the workspace nor
suggested as a new file. Paths are resolved through the workspace guard, so a
target outside the workspace (including through a link) is never reported;
nothing is read, only checked for existence. Electron shows these next to the
suggestion; the model's own claims stay labelled as assumptions.
"""

from __future__ import annotations

import os
import posixpath
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sidecar.ai.tools.builtins.propose_suggestion import LiveSuggestion
    from sidecar.ai.tools.workspace import WorkspaceGuard


def path_key(path: str) -> str:
    """Comparable workspace-relative path: forward slashes, no ``./``, case-folded on Windows."""
    normalized = str(path or "").strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.casefold() if os.name == "nt" else normalized


MAX_FACTS = 10
_MAX_SCAN_CHARS = 65536
_PY_IMPORT = re.compile(
    r"^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import\b|import[ \t]+([\w.]+))", re.MULTILINE
)
_JS_IMPORT = re.compile(
    r"""(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*|^\s*import\s*)['"]([^'"\n]+)['"]""", re.MULTILINE
)
_JS_SUFFIXES = (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json")
_JS_FILES = (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte")


def _is_python(path: str) -> bool:
    return path.endswith(".py")


def _imports(path: str, text: str) -> list[str]:
    scan = text[:_MAX_SCAN_CHARS]
    if _is_python(path):
        return [match.group(1) or match.group(2) for match in _PY_IMPORT.finditer(scan)]
    if path.endswith(_JS_FILES):
        return [match.group(1) for match in _JS_IMPORT.finditer(scan)]
    return []


def _python_target(file_dir: str, spec: str) -> str | None:
    """Workspace path (no extension) a relative Python import names, else None."""
    dots = len(spec) - len(spec.lstrip("."))
    rest = spec[dots:]
    if not dots or not rest:  # absolute imports and `from . import x` are not provable here
        return None
    depth = len([part for part in file_dir.split("/") if part])
    if dots - 1 > depth:  # climbs above the workspace root
        return None
    base = file_dir
    for _ in range(dots - 1):
        base = posixpath.dirname(base)
    return posixpath.normpath(posixpath.join(base, *rest.split(".")))


def _js_target(file_dir: str, spec: str) -> str | None:
    if not spec.startswith(("./", "../")):
        return None
    return posixpath.normpath(posixpath.join(file_dir, spec))


def _candidates(target: str, python: bool) -> list[str]:
    if python:
        return [f"{target}.py", f"{target}/__init__.py"]
    if target.endswith(_JS_SUFFIXES):
        return [target]
    return [target, *(f"{target}{suffix}" for suffix in _JS_SUFFIXES),
            *(f"{target}/index{suffix}" for suffix in _JS_SUFFIXES[:6])]


def _exists(workspace: WorkspaceGuard, candidate: str) -> bool | None:
    """True or False when the guard resolves the path inside the workspace, else None."""
    try:
        # Non-strict resolution checks containment (links included) without requiring the file.
        return workspace.resolve_write_path(candidate).exists()
    except Exception:  # noqa: BLE001 - outside the workspace or invalid: not provable
        return None


def derive_import_facts(  # noqa: PLR0913 - keyword-only facts of one suggestion.
    *,
    relative_path: str,
    kind: str,
    old_string: str,
    new_string: str,
    workspace: WorkspaceGuard,
    live: tuple[LiveSuggestion, ...] = (),
) -> list[dict[str, str]]:
    """``[{kind: "import_removed" | "import_missing", name, target?}]`` for this change."""
    before = _imports(relative_path, old_string) if kind == "replace" else []
    after = _imports(relative_path, new_string)
    facts: list[dict[str, str]] = [
        {"kind": "import_removed", "name": spec}
        for spec in dict.fromkeys(before)
        if spec not in after
    ]
    python = _is_python(relative_path)
    file_dir = posixpath.dirname(relative_path.replace("\\", "/"))
    creates = {path_key(item.path) for item in live if item.kind == "create"}
    for spec in dict.fromkeys(after):
        if spec in before:
            continue
        target = _python_target(file_dir, spec) if python else _js_target(file_dir, spec)
        if not target or target.startswith(".."):
            continue
        candidates = _candidates(target, python)
        if any(path_key(candidate) in creates for candidate in candidates):
            continue
        found = [_exists(workspace, candidate) for candidate in candidates]
        if any(found) or None in found:
            continue
        facts.append({"kind": "import_missing", "name": spec, "target": target})
    return facts[:MAX_FACTS]


__all__ = ("MAX_FACTS", "derive_import_facts", "path_key")
