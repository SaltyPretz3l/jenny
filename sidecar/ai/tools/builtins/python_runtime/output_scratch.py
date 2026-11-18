"""Render a python run's own scratch paths as ``<scratch>/name`` (T1).

``error_paths`` turns every path outside the workspace and the call's arguments
into ``<path>``, so a file the run wrote under its own scratch directory came
back unnamed. The run's scratch root is not secret from the run: its paths keep
their relative part and lose only the machine-specific prefix. Every other
outside path stays redacted.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from pathlib import Path

from sidecar.ai.tools.error_paths import PathKeeper, error_path_keeper

SCRATCH_PLACEHOLDER = "<scratch>"
_SEPARATORS = r"[\\/]+"
# What may follow a path inside prose or a quoted repr.
_PATH_STOP = r"""\s"'()\[\],;<>|?*:"""
_ROOT_END = rf"(?=[{_PATH_STOP}\\/.]|$)"
_REST = rf"(?:{_SEPARATORS}(?P<rest>[^{_PATH_STOP}]*))?"


def _root_texts(scratch_root: Path) -> list[str]:
    texts = [str(scratch_root)]
    try:
        resolved = str(scratch_root.resolve())
    except (OSError, ValueError):
        resolved = texts[0]
    if resolved not in texts:
        texts.append(resolved)
    return texts


def _root_pattern(root_text: str) -> str:
    parts = [part for part in re.split(r"[\\/]+", root_text) if part]
    lead = r"[\\/]{2}" if root_text.startswith(("\\\\", "//")) else (
        "/" if root_text.startswith("/") else ""
    )
    return lead + _SEPARATORS.join(re.escape(part) for part in parts)


def scratch_keeper(base: PathKeeper, scratch_root: Path) -> PathKeeper:
    """``base`` plus the scratch root, so its paths survive until they are rewritten."""
    scratch_keep = error_path_keeper(arguments=None, workspace_root=scratch_root)
    return lambda path: base(path) or scratch_keep(path)


def scratch_renderer(
    scratch_root: Path, workspace_root: Path | None
) -> Callable[[str], str] | None:
    """A text rewriter for the scratch root, or None when it must not apply.

    It does not apply when the scratch root sits inside the bound workspace: those
    paths are workspace paths and render as they always did.
    """
    if workspace_root is not None:
        try:
            if scratch_root.resolve().is_relative_to(workspace_root.resolve()):
                return None
        except (OSError, ValueError):
            return None
    flags = re.IGNORECASE if os.name == "nt" else 0
    pattern = re.compile(
        "(?:" + "|".join(_root_pattern(text) for text in _root_texts(scratch_root)) + ")"
        + _ROOT_END + _REST,
        flags,
    )

    def _replace(match: re.Match[str]) -> str:
        rest = re.sub(r"[\\/]+", "/", match.group("rest") or "")
        return f"{SCRATCH_PLACEHOLDER}/{rest}" if rest else SCRATCH_PLACEHOLDER

    return lambda text: pattern.sub(_replace, text)
