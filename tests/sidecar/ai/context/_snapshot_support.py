"""Snapshot helpers for ``test_prompt_snapshot.py``.

Underscored module name keeps pytest from discovering this file as a test
target. Two exports:

* :func:`redact` — normalize per-machine / per-run variance with stable
  placeholders before snapshot comparison.
* :func:`assert_matches_snapshot` — compare assembled prompt text to a
  golden file under ``tests/sidecar/ai/context/snapshots/``. With
  ``JENNY_UPDATE_SNAPSHOTS=1`` set, the helper writes the snapshot instead
  of comparing.

Snapshot drift discipline (read this before deleting a snapshot):

The whole point of these tests is to catch silent prompt-cache regressions
when section ordering, the ``<!-- CACHE_BOUNDARY -->`` marker, or
runtime-overlay insertion order changes. If a snapshot fails:

1. Read the unified diff in the pytest output.
2. Decide whether the change is intentional (a deliberate prompt-policy
   shift) or accidental (a reorder bug).
3. If intentional, rerun with ``JENNY_UPDATE_SNAPSHOTS=1`` to regenerate.
4. If accidental, fix the regression.

Do **not** delete or weaken a snapshot to make a failing test pass.
"""

from __future__ import annotations

import difflib
import os
import re
from pathlib import Path

import pytest

UPDATE_ENV_VAR = "JENNY_UPDATE_SNAPSHOTS"
PLACEHOLDER_WORKSPACE_ROOT = "<<WORKSPACE_ROOT>>"
PLACEHOLDER_EXPERIMENT_BODY = "<<EXPERIMENT_BODY>>"
FIXED_DATE = "2026-01-01"

_ISO_DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
# Capture lines starting at "Variant: <key>\n" through to the next blank line.
_EXPERIMENT_BODY_RE = re.compile(
    r"(Variant:\s*\S+\n)(?:.+\n)+?(?=\n\n|\Z)",
    re.MULTILINE,
)


def redact(text: str, *, workspace_root: Path, fixed_date: str = FIXED_DATE) -> str:
    """Replace per-machine and per-run variance with stable placeholders.

    Normalizes (variable per machine / per run):
      - workspace path strings (Windows + POSIX) → ``<<WORKSPACE_ROOT>>``
      - ISO dates ``YYYY-MM-DD`` → *fixed_date*
      - experiment treatment-variant body → ``<<EXPERIMENT_BODY>>``
      - trailing whitespace per line

    Preserves (must remain stable for the test to mean anything):
      - ``<!-- CACHE_BOUNDARY -->`` marker
      - section ordering inside :class:`StructuredSystemPrompt`
      - runtime-overlay headings from
        :mod:`sidecar.ai.context.runtime_message_markers`
      - bootstrap file bodies (sourced from fixture workspace)
    """
    raw_root = str(workspace_root)
    posix_root = raw_root.replace("\\", "/")
    text = text.replace(raw_root, PLACEHOLDER_WORKSPACE_ROOT)
    text = text.replace(posix_root, PLACEHOLDER_WORKSPACE_ROOT)
    text = _ISO_DATE_RE.sub(fixed_date, text)
    text = _EXPERIMENT_BODY_RE.sub(
        rf"\1{PLACEHOLDER_EXPERIMENT_BODY}\n",
        text,
    )
    text = "\n".join(line.rstrip() for line in text.splitlines())
    return text + "\n" if not text.endswith("\n") else text


def assert_matches_snapshot(actual: str, snapshot_path: Path) -> None:
    """Compare *actual* to the golden file at *snapshot_path*.

    With ``JENNY_UPDATE_SNAPSHOTS=1`` set in the environment, the helper
    writes the file (creating parent directories as needed) and returns
    without asserting. Otherwise:

    - missing file ⇒ ``pytest.fail`` instructing the env-var rerun
    - drift ⇒ ``pytest.fail`` with a unified diff and the same instruction
    """
    if os.environ.get(UPDATE_ENV_VAR) == "1":
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        snapshot_path.write_text(actual, encoding="utf-8", newline="\n")
        return
    if not snapshot_path.exists():
        pytest.fail(
            f"Snapshot missing: {snapshot_path}.\n"
            f"Re-run with {UPDATE_ENV_VAR}=1 to bootstrap the snapshot."
        )
    expected = snapshot_path.read_text(encoding="utf-8")
    if expected == actual:
        return
    diff = "\n".join(
        difflib.unified_diff(
            expected.splitlines(),
            actual.splitlines(),
            fromfile=f"snapshot:{snapshot_path.name}",
            tofile="actual",
            lineterm="",
        )
    )
    pytest.fail(
        f"Snapshot drift at {snapshot_path}:\n{diff}\n\n"
        f"If the change is intentional, re-run with {UPDATE_ENV_VAR}=1."
    )


__all__ = [
    "FIXED_DATE",
    "PLACEHOLDER_EXPERIMENT_BODY",
    "PLACEHOLDER_WORKSPACE_ROOT",
    "UPDATE_ENV_VAR",
    "assert_matches_snapshot",
    "redact",
]
