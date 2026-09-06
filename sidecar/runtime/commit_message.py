"""Generate a Conventional Commit message from a staged git diff.

One-shot, off-transcript engine call: feeds the staged diff to the configured
engine and returns a single plain-text Conventional Commit message. The diff
never leaves the machine and never enters the chat transcript. Never raises —
every failure path returns an empty string so the caller degrades gracefully.
"""

from __future__ import annotations

import logging
import re
from typing import TypedDict

from sidecar.ai.container import BrainContainer
from sidecar.ai.feature_flags import FEATURE_PROMPT_CACHE, is_feature_flag_enabled
from sidecar.ai.routing.retry import (
    QUERY_SOURCE_BACKGROUND_CLASSIFIER,
    execute_with_provider_retry,
)
from sidecar.runtime.diagnostics import log_event

_MAX_TOKENS = 220
_TEMPERATURE = 0.2
# Cap the diff fed to the model so a large staged changeset stays well within
# the context budget (~3K tokens) and generation stays fast. The model only
# needs a representative slice to write a sensible subject.
_MAX_DIFF_CHARS = 12_000

# A unified git diff opens each file section with a "diff --git " header line.
# Counting these lets us report — deterministically, with no extra model call —
# how many files the model could NOT see once the diff is clipped to the cap, so
# it does not over-claim coverage of a partial changeset.
_DIFF_FILE_HEADER_RE = re.compile(r"^diff --git ", re.MULTILINE)

_SYSTEM_PROMPT = (
    "You write Conventional Commit messages from a git diff.\n"
    "Rules:\n"
    "- Format the first line as: type(scope): subject\n"
    "- type is one of: feat, fix, refactor, perf, test, docs, build, chore, "
    "style, ci.\n"
    "- scope is optional; use a short module or area name when one is obvious "
    "from the changed paths.\n"
    '- subject: imperative mood ("add", not "added"/"adds"), no trailing '
    "period, at most 72 characters.\n"
    "- Optionally add one blank line then a short body (wrapped near 72 "
    "columns) explaining WHY, only when the change is non-trivial.\n"
    "- Ground the message strictly in the diff. Do not invent changes, file "
    "names, or issue numbers.\n"
    "- Output ONLY the commit message. No code fences, no preamble, no "
    "surrounding quotes."
)


def _strip_code_fences(text: str) -> str:
    """Remove a leading/trailing markdown code fence from the model output."""
    stripped = text.strip()
    stripped = re.sub(r"^```[a-zA-Z]*\s*", "", stripped)
    stripped = re.sub(r"\s*```$", "", stripped)
    return stripped.strip()


def _count_diff_files(diff: str) -> int:
    """Count file sections (``diff --git`` headers) in a unified diff."""
    return len(_DIFF_FILE_HEADER_RE.findall(diff))


class DiffTruncation(TypedDict):
    """Deterministic description of how clipping a diff to the cap affects it."""

    truncated: bool
    total_files: int
    shown_files: int
    omitted_files: int


def summarize_diff_truncation(diff: str) -> DiffTruncation:
    """Describe whether feeding ``diff`` to the model truncates it, and by how much.

    Deterministic and model-free. Returns ``truncated`` (bool) plus
    ``total_files`` / ``shown_files`` / ``omitted_files`` (ints). A file counts
    as "shown" only when its ``diff --git`` header survives the clip; a header
    that falls past the cap counts as omitted (the safe direction — we never
    claim a file was shown to the model when it was not).
    """
    normalized = str(diff or "")
    total_files = _count_diff_files(normalized)
    if len(normalized) <= _MAX_DIFF_CHARS:
        return {
            "truncated": False,
            "total_files": total_files,
            "shown_files": total_files,
            "omitted_files": 0,
        }
    shown_files = _count_diff_files(normalized[:_MAX_DIFF_CHARS])
    return {
        "truncated": True,
        "total_files": total_files,
        "shown_files": shown_files,
        "omitted_files": max(total_files - shown_files, 0),
    }


def _build_user_message(diff: str) -> str:
    """Wrap the (size-capped) staged diff in the user-facing prompt.

    When the diff overflows the cap, prepend an explicit note — including HOW
    MANY files are unseen (computed deterministically, no extra model call) — so
    the model knows it is summarizing a partial changeset and does not over-claim
    coverage of files it never saw.
    """
    truncation = summarize_diff_truncation(diff)
    clipped = diff[:_MAX_DIFF_CHARS]
    parts = ["Generate a Conventional Commit message for these staged changes:"]
    if truncation["truncated"]:
        omitted = int(truncation["omitted_files"])
        total = int(truncation["total_files"])
        if omitted > 0:
            parts.append(
                "NOTE: This diff was truncated to fit the context budget. "
                f"{omitted} of {total} changed file(s) are NOT shown below. "
                "Summarize the overall change at a suitable altitude; do not "
                "describe or enumerate changes you cannot see, and keep the "
                "subject general enough to cover the files that are missing."
            )
        else:
            parts.append(
                "NOTE: This diff was truncated to fit the context budget and may "
                "be incomplete. Summarize only what is visible; do not claim "
                "changes you cannot see."
            )
        clipped = f"{clipped}\n…(diff truncated for length)"
    parts.append(f"<diff>\n{clipped}\n</diff>")
    return "\n\n".join(parts)


def generate_commit_message(
    brain_container: BrainContainer,
    diff: str,
    logger: logging.Logger,
) -> str:
    """Generate a single Conventional Commit message from the staged diff.

    Returns the trimmed message string, or an empty string on any failure
    (no diff, no brain stack, engine error). Never raises — all errors are
    caught and logged.
    """
    normalized_diff = str(diff or "").strip()
    if not normalized_diff:
        return ""
    if brain_container.stack is None:
        log_event(
            logger,
            logging.WARNING,
            component="runtime.commit_message",
            event="commit_message.generate_skipped",
            message="Skipped commit-message generation — no brain stack available",
        )
        return ""

    user_message = _build_user_message(normalized_diff)
    prompt_cache_enabled = is_feature_flag_enabled(
        brain_container.stack.config.feature_flags or {},
        FEATURE_PROMPT_CACHE,
    )

    try:
        raw = execute_with_provider_retry(
            operation=lambda context: brain_container.stack.engine.generate(
                prompt=user_message,
                max_tokens=context.max_tokens,
                temperature=_TEMPERATURE,
                # Background classifier call: "low" sends an explicit
                # think:false so a thinking-capable model cannot burn its
                # 16k thinking headroom on a commit message while holding
                # the single Ollama slot (see suggestions.py).
                reasoning_effort="low",
                prompt_cache_enabled=prompt_cache_enabled,
                system=_SYSTEM_PROMPT,
                response_format=None,
            ),
            logger=logger,
            component="runtime.commit_message",
            event_prefix="runtime.commit_message.retry",
            request_source=QUERY_SOURCE_BACKGROUND_CLASSIFIER,
            provider=brain_container.stack.config.engine_type,
            model=brain_container.stack.config.model,
            initial_max_tokens=_MAX_TOKENS,
            feature_flags=brain_container.stack.config.feature_flags,
        )
    except Exception:
        log_event(
            logger,
            logging.WARNING,
            component="runtime.commit_message",
            event="commit_message.generate_failed",
            message="Engine call failed during commit-message generation",
        )
        return ""

    return _strip_code_fences(str(raw or ""))
