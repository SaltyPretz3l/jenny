"""Filter interface + shared line-classifier machinery for output distillation.

A filter recognizes a command/output *shape* (test, build, lint) and reduces its
raw text to an errors-first ``DistillOutput``: every classified error/failure
line is kept verbatim, and runs of pass/progress "parade" lines collapse into
``OmittedSegment``s. The orchestrator stores the segments and splices the
bounded recovery markers in place of the placeholders this module emits.

Heuristics are a clean-room reimplementation of the *pattern* behind repowise's
filters (AGPL-3.0 — behavioral spec only, no code copied): pure, deterministic,
index-free, biased to KEEP (over-keeping a line is safe; dropping a real error
is not).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Protocol

# A run of dropped lines shorter than this stays verbatim — collapsing one or
# two lines into a marker + a stored ref is not worth it.
DEFAULT_MIN_OMIT_LINES = 3

# Sentinel placeholder spliced into ``kept`` where a run was omitted. NUL is
# safe: sanitization strips all control chars before distillation runs, so it
# can never collide with real output content.
_SENTINEL_PREFIX = "\x00JENNY_OMIT:"
_SENTINEL_SUFFIX = "\x00"


@dataclass
class OmittedSegment:
    text: str
    line_count: int


@dataclass
class DistillOutput:
    kept: str
    omitted: list[OmittedSegment] = field(default_factory=list)


class OutputFilter(Protocol):
    name: str

    def matches(self, *, command: str, content: str) -> bool: ...

    def distill(self, raw: str) -> DistillOutput: ...


def omission_placeholder(index: int) -> str:
    """The sentinel that marks where the *index*-th omitted segment belongs."""
    return f"{_SENTINEL_PREFIX}{index}{_SENTINEL_SUFFIX}"


# Leading env-var assignments (FOO=bar cmd ...) and interpreter/runner wrappers a
# model habitually prefixes. Reimplemented from the documented normalize behavior.
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*\s+")
_RUNNER_PREFIXES = (
    "uv run ",
    "uvx ",
    "npx ",
    "pnpm exec ",
    "yarn ",
    "poetry run ",
    "pipenv run ",
    "pdm run ",
    "python -m ",
    "python3 -m ",
    "py -m ",
)
_EXE_SUFFIXES = (".exe", ".cmd", ".bat", ".ps1")


def normalize_command(command: str) -> str:
    """Strip env assignments + runner wrappers and collapse the argv[0] exe path
    to its bare (extension-less) basename, lowercased. So ``uv run pytest``,
    ``python -m pytest`` and ``.venv\\Scripts\\pytest.exe`` all normalize to
    ``pytest``-prefixed text for shape matching."""
    text = (command or "").strip()

    while True:
        match = _ENV_ASSIGN_RE.match(text)
        if not match:
            break
        text = text[match.end():]

    # Alternate: collapse the argv[0] exe path, then strip one runner wrapper,
    # until stable — so `/usr/bin/python3 -m pytest` reduces past both the path
    # AND the `python -m` wrapper. Each pass strictly shortens, so it terminates.
    changed = True
    while changed:
        changed = False

        parts = text.split(maxsplit=1)
        if parts:
            exe = parts[0].replace("\\", "/").rsplit("/", 1)[-1]
            for suffix in _EXE_SUFFIXES:
                if exe.lower().endswith(suffix):
                    exe = exe[: -len(suffix)]
                    break
            rest = parts[1] if len(parts) > 1 else ""
            collapsed = f"{exe} {rest}".strip() if rest else exe
            if collapsed != text:
                text = collapsed
                changed = True

        lowered = text.lower()
        for prefix in _RUNNER_PREFIXES:
            if lowered.startswith(prefix):
                text = text[len(prefix):].lstrip()
                changed = True
                break

    return text.lower()


def command_selects_program(norm: str, tokens: tuple[str, ...]) -> bool:
    """True when a token names the normalized command's program (optionally
    with its leading subcommand words) at an argv boundary. A token appearing
    only as a later argument (``echo pytest``) must not select a filter —
    substring matching replaced unrelated output with omission markers."""
    return any(norm == token or norm.startswith(token + " ") for token in tokens)


def distill_lines(
    raw: str,
    *,
    keep_line: Callable[[str], bool],
    min_omit_lines: int = DEFAULT_MIN_OMIT_LINES,
) -> DistillOutput:
    """Keep every line for which *keep_line* is true; collapse maximal runs of
    dropped lines (>= *min_omit_lines*) into ``OmittedSegment``s, splicing an
    ordered placeholder where each run stood. In-order; nothing is reordered."""
    lines = raw.split("\n")
    kept_parts: list[str] = []
    omitted: list[OmittedSegment] = []
    run: list[str] = []

    def flush_run() -> None:
        if not run:
            return
        if len(run) >= min_omit_lines:
            kept_parts.append(omission_placeholder(len(omitted)))
            omitted.append(OmittedSegment(text="\n".join(run), line_count=len(run)))
        else:
            kept_parts.extend(run)
        run.clear()

    for line in lines:
        if keep_line(line):
            flush_run()
            kept_parts.append(line)
        else:
            run.append(line)
    flush_run()

    return DistillOutput(kept="\n".join(kept_parts), omitted=omitted)
