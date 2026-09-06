"""Contract-version policy shared by the release cut and the release checks.

Pure validation only: refuse a release when ``API_VERSION`` or the diagnostics
``SCHEMA_VERSION`` moved since the previous ``v*`` tag without release-notes
evidence. Lives under scripts/checks/ so the distributed source tree (which
drops the maintainer release tooling) can run the same policy.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

_API_VERSION_PY_RE = re.compile(r'^\s*API_VERSION\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)
_API_VERSION_JS_RE = re.compile(r"""const\s+API_VERSION\s*=\s*['"]([^'"]+)['"]""")
_SCHEMA_VERSION_PY_RE = re.compile(r"^\s*SCHEMA_VERSION\s*=\s*(\d+)", re.MULTILINE)

_CONTRACT_SURFACES: tuple[tuple[str, str, "re.Pattern[str]"], ...] = (
    (
        "API_VERSION (sidecar/protocol.py)",
        "sidecar/protocol.py",
        _API_VERSION_PY_RE,
    ),
    (
        "API_VERSION (services/backend/sidecar-client.js)",
        "services/backend/sidecar-client.js",
        _API_VERSION_JS_RE,
    ),
    (
        "SCHEMA_VERSION (sidecar/runtime/diagnostics.py)",
        "sidecar/runtime/diagnostics.py",
        _SCHEMA_VERSION_PY_RE,
    ),
)


def _previous_release_tag(root: Path) -> str | None:
    """Return the most recent ``v*`` tag, or None if no release tags exist."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "tag", "--list", "v*", "--sort=-v:refname"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    for line in proc.stdout.splitlines():
        candidate = line.strip()
        if candidate:
            return candidate
    return None


def _git_show(root: Path, tag: str, relpath: str) -> str | None:
    """Return file content at ``tag``, or None if the file/tag is unavailable."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "show", f"{tag}:{relpath}"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return proc.stdout


def _extract_value(pattern: "re.Pattern[str]", text: str | None) -> str | None:
    if not text:
        return None
    match = pattern.search(text)
    return match.group(1) if match else None


def _release_notes_section(root: Path, version: str) -> str:
    path = root / "RELEASE_NOTES.md"
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^##\s+{re.escape(version)}\b.*?(?=^##\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    return match.group(0) if match else ""


def _section_documents_contract_change(section: str) -> bool:
    if not section:
        return False
    if re.search(r"^###\s+(Contract changes|Migration notes)", section, re.MULTILINE):
        return True
    return any(
        keyword in section
        for keyword in ("API_VERSION", "SCHEMA_VERSION", "schema_version", "schema version")
    )


def validate_contract_versions(root: Path, version: str) -> list[str]:
    """Refuse a release when contract versions moved without release-notes evidence.

    The release cut validates ``API_VERSION`` and the diagnostics
    ``SCHEMA_VERSION``. If either constant moved since the previous ``v*`` tag,
    the new ``RELEASE_NOTES.md`` section must mention the constant explicitly
    or include a ``### Contract changes`` or ``### Migration notes``
    subsection. Nothing here mutates these constants.
    """
    prior_tag = _previous_release_tag(root)
    if prior_tag is None:
        return []

    moved: list[tuple[str, str, str]] = []
    for label, relpath, pattern in _CONTRACT_SURFACES:
        prior_text = _git_show(root, prior_tag, relpath)
        prior_value = _extract_value(pattern, prior_text)
        current_path = root / relpath
        current_value: str | None = None
        if current_path.exists():
            current_value = _extract_value(
                pattern, current_path.read_text(encoding="utf-8")
            )
        if prior_value is None or current_value is None:
            continue
        if prior_value != current_value:
            moved.append((label, prior_value, current_value))

    if not moved:
        return []

    section = _release_notes_section(root, version)
    if _section_documents_contract_change(section):
        return []

    detail = ", ".join(f"{label} {old!r}->{new!r}" for label, old, new in moved)
    return [
        "contract version moved without release notes evidence: "
        f"{detail}; mention the constant in the {version} section or add a "
        "'### Contract changes' / '### Migration notes' subsection"
    ]
