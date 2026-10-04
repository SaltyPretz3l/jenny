"""Absolute paths in builtin tool error text (HB-017).

The model and the timeline see a path the call's own arguments name verbatim
or one inside the call's bound workspace root; every other absolute path (a
resolved link target outside the workspace, a profile or system path from an
exception) becomes ``<path>``. Logs get no exceptions: call
``redact_error_paths`` without a keeper.
"""

from __future__ import annotations

import ntpath
import posixpath
import re
from collections.abc import Callable, Mapping

PATH_PLACEHOLDER = "<path>"
_ERROR_PATH_RE = re.compile(
    r"""(?P<quote>["'])(?P<quoted>(?:[A-Za-z]:\\|/|\\\\)[^"'\r\n]+)(?P=quote)"""
    r"|\((?P<parenthesized>(?:[A-Za-z]:\\|/|\\\\)[^)\r\n]+)\)"
    r"|\[(?P<bracketed>(?:[A-Za-z]:\\|/|\\\\)[^\]\r\n]+)\]"
    r"|(?P<bare>\b[A-Za-z]:\\[^\s:<>|?*\"'()\[\],;]+"
    # Extended-length (\\?\C:\..., \\?\UNC\...) and UNC (\\server\share\...) paths.
    r"|\\\\\?\\[^\s<>|?*\"'()\[\],;]+"
    r"|\\\\[^\s\\/:<>|?*\"'()\[\],;]+\\[^\s:<>|?*\"'()\[\],;]+"
    r"|(?<!\w)/(?:[^\s:/]+/)*[^\s:/\"'()\[\],;]+)"
)
# A bare path followed by more path text may have been cut at a space
# (``...\safe dir\..\..\x``): its prefix must never vouch for the tail.
_PATH_CONTINUATION_RE = re.compile(r"[ \t]+\S*[\\/]")
_WINDOWS_DRIVE_RE = re.compile(r"[A-Za-z]:[\\/]")
_HARNESS_ARGUMENT_PREFIX = "_jenny_"
_MAX_ARGUMENT_DEPTH = 4

PathKeeper = Callable[[str], bool]


def redact_error_paths(message: str, *, keep: PathKeeper | None = None) -> str:
    """Replace absolute paths in ``message`` with ``<path>`` unless ``keep`` allows them."""

    def _replace(match: re.Match[str]) -> str:
        bare = match.group("bare")
        # A bare path's trailing dots end the sentence, not the path.
        path = bare.rstrip(".") if bare else next(
            match.group(name)
            for name in ("quoted", "parenthesized", "bracketed")
            if match.group(name) is not None
        )
        cut_at_space = (
            bool(bare) and _PATH_CONTINUATION_RE.match(match.string, match.end()) is not None
        )
        if keep is not None and not cut_at_space and keep(path):
            return match.group(0)
        if bare:
            return PATH_PLACEHOLDER + bare[len(path):]
        text = match.group(0)
        return f"{text[0]}{PATH_PLACEHOLDER}{text[-1]}"

    return _ERROR_PATH_RE.sub(_replace, str(message))


def _is_windows_path(text: str) -> bool:
    return bool(_WINDOWS_DRIVE_RE.match(text))


def _fold_windows_path(text: str) -> str:
    return text.replace("/", "\\").casefold()


def _argument_strings(value: object, depth: int = 0) -> list[str]:
    if isinstance(value, str):
        return [value]
    if depth >= _MAX_ARGUMENT_DEPTH:
        return []
    if isinstance(value, Mapping):
        return [
            text
            for key, entry in value.items()
            if not str(key).startswith(_HARNESS_ARGUMENT_PREFIX)
            for text in _argument_strings(entry, depth + 1)
        ]
    if isinstance(value, (list, tuple)):
        return [text for entry in value for text in _argument_strings(entry, depth + 1)]
    return []


def _within_root(path: str, root: str) -> bool:
    windows = _is_windows_path(path)
    if windows != _is_windows_path(root):
        return False
    flavor = ntpath if windows else posixpath
    candidate = flavor.normcase(flavor.normpath(path))
    base = flavor.normcase(flavor.normpath(root))
    if candidate == base:
        return True
    prefix = base if base.endswith(flavor.sep) else base + flavor.sep
    return candidate.startswith(prefix)


def error_path_keeper(*, arguments: object, workspace_root: object) -> PathKeeper:
    """Keep paths the call's own arguments name verbatim or that sit inside its workspace root.

    Harness-injected ``_jenny_*`` argument keys never vouch for a path: the model
    did not write them. Windows paths compare case- and separator-insensitively;
    POSIX paths compare exactly. Containment is lexical after ``..`` folding.
    """
    argument_texts = _argument_strings(arguments)
    folded_texts = [_fold_windows_path(text) for text in argument_texts]
    root_text = str(workspace_root) if workspace_root else ""

    def _keep(path: str) -> bool:
        if _is_windows_path(path):
            folded = _fold_windows_path(path)
            if any(folded in text for text in folded_texts):
                return True
        elif any(path in text for text in argument_texts):
            return True
        return bool(root_text) and _within_root(path, root_text)

    return _keep
