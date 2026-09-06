"""Deterministic, zero-LLM, flag-gated tool-output distillation.

Compresses noisy shell command output before the model reads it — errors first,
with recovery through the command's complete persisted capture. A clean-room
reimplementation of the *pattern* behind repowise's distill capability (repowise
is AGPL-3.0 — behavioral spec only, no code copied).

This module is the orchestrator seam: ``distill_command_output`` routes to a
per-shape filter, stores each omitted segment for internal retention, and splices
markers that point to the command's complete persisted output. It is
net-positive-only and falls back to raw on any exception, mirroring
``_persist_large_output``'s best-effort posture.

``open_omission_store`` is the shared per-workspace store cache: one WAL
connection per db path, reused across ``run_command`` calls
instead of a connect/PRAGMA/migrate cycle per call. The ``OmissionStore``
methods are RLock-guarded, so sharing one instance across callers is safe.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.tools.distill.filters.base import (
    DistillOutput,
    OmittedSegment,
    omission_placeholder,
)
from sidecar.ai.tools.distill.omission_store import OmissionStore, estimate_tokens
from sidecar.ai.tools.distill.router import select_filter
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, WorkspaceStoreKind

logger = logging.getLogger(__name__)

_DISTILL_ENABLED = False

# Inputs beyond this skip distillation entirely: the redaction pipeline (a
# ~25-regex pass) would run over the whole stream, and the model only ever sees
# the first MAX_OUTPUT_CHARS anyway — the full raw is on disk via
# full_output_path. 2M chars comfortably covers a large noisy test log.
MAX_DISTILL_INPUT_CHARS = 2_000_000

# How much of the (raw) combined output the pre-redaction filter sniff reads.
# Command-based matching ignores this; it only bounds the content fallback.
FILTER_SNIFF_CHARS = 16_000
_TOKENS_PER_KILO = 1000
FULL_OUTPUT_PATH_PLACEHOLDER = "{jenny_full_output_path}"

# Shared store cache: db path → open store. Bounded LRU; evicted stores are
# closed. Small cap — a sidecar process realistically touches 1-2 workspace
# roots (plus worktrees), and each entry holds one SQLite WAL connection.
_STORE_CACHE_MAX = 8
_STORE_CACHE: OrderedDict[str, OmissionStore] = OrderedDict()
_STORE_CACHE_LOCK = threading.Lock()


def open_omission_store(location: Path | GuardedWorkspaceStore) -> OmissionStore:
    """Return a cached omission store for a standalone path or guarded workspace."""

    if isinstance(location, GuardedWorkspaceStore):
        cache_key = f"workspace:{location.cache_key}"
    else:
        cache_key = f"standalone:{location.resolve(strict=False)}"
    with _STORE_CACHE_LOCK:
        store = _STORE_CACHE.get(cache_key)
        if store is not None:
            _STORE_CACHE.move_to_end(cache_key)
            return store
        if isinstance(location, GuardedWorkspaceStore):
            store = OmissionStore.from_workspace_store(
                location,
                location.resolve(WorkspaceStoreKind.OMISSIONS, "omissions.db"),
            )
        else:
            store = OmissionStore(location)
        _STORE_CACHE[cache_key] = store
        while len(_STORE_CACHE) > _STORE_CACHE_MAX:
            _, evicted = _STORE_CACHE.popitem(last=False)
            try:
                evicted.close()
            except Exception:  # noqa: BLE001 — eviction is best-effort
                logger.debug("failed closing evicted omission store", exc_info=True)
        return store


@dataclass
class DistillResult:
    stdout: str
    stderr: str
    omitted_lines: int = 0
    omitted_segments: int = 0

    @property
    def distilled(self) -> bool:
        return self.omitted_segments > 0


def configure_distill(config: Any | None) -> None:
    """Cache the ``tools_distill_enabled`` flag (mirrors configure_grep_search).

    This cached global is the single runtime source of truth for the shell
    distillation path within one ``build_tool_bindings`` pass.
    """
    global _DISTILL_ENABLED  # noqa: PLW0603 - process-wide configured gate.
    if isinstance(config, dict):
        value = config.get("tools_distill_enabled")
    else:
        value = getattr(config, "tools_distill_enabled", None)
    _DISTILL_ENABLED = value if isinstance(value, bool) else False


def is_distill_enabled() -> bool:
    return _DISTILL_ENABLED


def _format_marker(segment: OmittedSegment) -> str:
    tokens = estimate_tokens(segment.text)
    if tokens >= _TOKENS_PER_KILO:
        token_str = f"~{tokens / _TOKENS_PER_KILO:.1f}k tokens"
    else:
        token_str = f"~{tokens} tokens"
    return (
        f"[{segment.line_count} lines omitted ({token_str}); full output: "
        f"{FULL_OUTPUT_PATH_PLACEHOLDER}]"
    )


def _distill_stream(
    stream: str,
    output_filter: Any,
    store: OmissionStore,
    *,
    source: str,
    stored_refs: list[str],
) -> tuple[str, int, int]:
    """Distill one stream. Returns ``(text, omitted_lines, omitted_segments)``.

    Net-positive is decided *before* anything is stored, with projected size
    computed arithmetically without building the projected string. Puts use
    ``prune=False``; the orchestrator runs ONE protected prune after all
    segments (both streams) are stored, so eviction can never cannibalize a
    sibling segment of the same command (refs are appended to *stored_refs*).
    """
    if not stream:
        return stream, 0, 0

    distilled: DistillOutput = output_filter.distill(stream)
    if not distilled.omitted:
        return stream, 0, 0

    # Exact projected size: kept text with each placeholder swapped for its
    # real-length marker.
    projected_len = len(distilled.kept)
    for index, segment in enumerate(distilled.omitted):
        projected_len += len(_format_marker(segment)) - len(
            omission_placeholder(index)
        )
    if projected_len >= len(stream):
        return stream, 0, 0  # not net-positive → pass through untouched

    text = distilled.kept
    omitted_lines = 0
    for index, segment in enumerate(distilled.omitted):
        ref = store.put(segment.text, source=source, prune=False)
        stored_refs.append(ref)
        text = text.replace(omission_placeholder(index), _format_marker(segment), 1)
        omitted_lines += segment.line_count
    return text, omitted_lines, len(distilled.omitted)


def distill_command_output(
    *,
    stdout: str,
    stderr: str,
    command: str,
    store: OmissionStore,
    source: str,
) -> DistillResult:
    """Route → filter → (errors-first kept + store omitted + splice markers).

    Net-positive-only; falls back to the raw (already-redacted) input on any
    exception, never losing bytes. The caller owns ``exit_code`` and the
    stdout/stderr split.
    """
    try:
        combined = f"{stdout}\n{stderr}" if stderr else stdout
        output_filter = select_filter(command=command, content=combined)
        if output_filter is None:
            return DistillResult(stdout=stdout, stderr=stderr)

        stored_refs: list[str] = []
        new_stdout, out_lines, out_segs = _distill_stream(
            stdout, output_filter, store, source=f"{source}:stdout", stored_refs=stored_refs
        )
        new_stderr, err_lines, err_segs = _distill_stream(
            stderr, output_filter, store, source=f"{source}:stderr", stored_refs=stored_refs
        )
        if stored_refs:
            # One prune per command, with this command's segments protected —
            # TTL/size eviction can never dangle a marker spliced just above.
            store.prune(protect=stored_refs)
        return DistillResult(
            stdout=new_stdout,
            stderr=new_stderr,
            omitted_lines=out_lines + err_lines,
            omitted_segments=out_segs + err_segs,
        )
    except Exception:  # noqa: BLE001 — fallback-to-raw is the security posture
        logger.warning("distill_command_output failed; returning raw", exc_info=True)
        return DistillResult(stdout=stdout, stderr=stderr)


__all__ = [
    "DistillResult",
    "FILTER_SNIFF_CHARS",
    "FULL_OUTPUT_PATH_PLACEHOLDER",
    "MAX_DISTILL_INPUT_CHARS",
    "OmissionStore",
    "configure_distill",
    "distill_command_output",
    "is_distill_enabled",
    "open_omission_store",
    "select_filter",
]
