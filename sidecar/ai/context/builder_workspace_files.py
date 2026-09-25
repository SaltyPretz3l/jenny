"""Workspace file loaders for the context builder (BOOTSTRAP/* and agentj.md).

Split out of ``builder.py`` so the hub stays under the size ratchet. The
methods keep the hub's cache fields and lock; ``_log_partial_context`` stays on
the hub because tests patch ``sidecar.ai.context.builder.log_event``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sidecar.ai.context.builder_shared import (
    _UNSET_ROOT,
    BOOTSTRAP_DIRNAME,
    BOOTSTRAP_FILES,
    MAX_BOOTSTRAP_FILE_BYTES,
    MAX_BOOTSTRAP_PROMPT_BYTES,
    MAX_WORKSPACE_INSTRUCTION_BYTES,
    WORKSPACE_INSTRUCTION_FILENAME,
    _sanitize_bootstrap_content,
)
from sidecar.ai.context.context_io import read_bounded_context_text, truncate_utf8


class _BuilderWorkspaceFilesMixin:
    # Hub-owned state (set in ContextBuilder.__init__); bare annotations tell mypy
    # the concrete types when this mixin is checked in isolation. No runtime effect.
    _cached_bootstrap_blocks: list[str] | None
    _cached_bootstrap_mtime: str | None
    _cached_workspace_instruction_block: str | None
    _cached_workspace_instruction_mtime: str | None
    _cache_lock: Any

    def _effective_workspace_root(self, request_workspace_root: Any) -> Path | None:
        raise NotImplementedError

    @staticmethod
    def _log_partial_context(*, source_kind: str, source_name: str, reason: str) -> None:
        raise NotImplementedError

    def _load_bootstrap_blocks(self, root: Any = _UNSET_ROOT) -> list[str]:
        with self._cache_lock:
            return self._load_bootstrap_blocks_locked(self._effective_workspace_root(root))

    def _load_bootstrap_blocks_locked(self, root: Path | None) -> list[str]:
        if root is None:
            return []
        # One builder now serves different request roots turn to turn, so the
        # cache key carries the root as well as the file mtimes.
        mtime_key = f"{root}|{self._bootstrap_mtime_key(root)}"
        if mtime_key == self._cached_bootstrap_mtime and self._cached_bootstrap_blocks is not None:
            return self._cached_bootstrap_blocks
        blocks: list[str] = []
        used_bytes = 0
        for filename in BOOTSTRAP_FILES:
            path = root / BOOTSTRAP_DIRNAME / filename
            if not path.exists():
                continue
            read_result = read_bounded_context_text(
                path,
                authorized_root=root,
                max_bytes=MAX_BOOTSTRAP_FILE_BYTES,
                truncate=True,
            )
            if read_result.text is None:
                self._log_partial_context(
                    source_kind="bootstrap",
                    source_name=filename,
                    reason=read_result.reason or "read_failed",
                )
                continue
            content = _sanitize_bootstrap_content(
                read_result.text,
                source_name=filename,
            )
            if content:
                separator_bytes = 2 if blocks else 0
                remaining = MAX_BOOTSTRAP_PROMPT_BYTES - used_bytes - separator_bytes
                if remaining <= 0:
                    self._log_partial_context(
                        source_kind="bootstrap",
                        source_name=filename,
                        reason="aggregate_budget",
                    )
                    break
                block, aggregate_truncated = truncate_utf8(
                    f"### {filename}\n{content}",
                    remaining,
                    suffix="\n[bootstrap context truncated]",
                )
                blocks.append(block)
                used_bytes += separator_bytes + len(block.encode("utf-8"))
                if read_result.truncated or aggregate_truncated:
                    self._log_partial_context(
                        source_kind="bootstrap",
                        source_name=filename,
                        reason=(
                            "aggregate_budget" if aggregate_truncated else "file_budget"
                        ),
                    )
                if aggregate_truncated:
                    break
        self._cached_bootstrap_blocks = blocks
        self._cached_bootstrap_mtime = mtime_key
        return blocks

    def _load_workspace_instruction_block(self, root: Any = _UNSET_ROOT) -> str:
        with self._cache_lock:
            return self._load_workspace_instruction_block_locked(
                self._effective_workspace_root(root)
            )

    def _load_workspace_instruction_block_locked(self, root: Path | None) -> str:
        if root is None:
            return ""
        path = root / WORKSPACE_INSTRUCTION_FILENAME
        mtime_key = f"{root}|{self._workspace_instruction_mtime_key(path)}"
        if (
            mtime_key == self._cached_workspace_instruction_mtime
            and self._cached_workspace_instruction_block is not None
        ):
            return self._cached_workspace_instruction_block
        block = ""
        read_result = read_bounded_context_text(
            path,
            authorized_root=root,
            max_bytes=MAX_WORKSPACE_INSTRUCTION_BYTES,
            truncate=True,
        )
        normalized = str(read_result.text or "").strip()
        if path.exists() and (read_result.text is None or read_result.truncated):
            self._log_partial_context(
                source_kind="workspace_instruction",
                source_name=WORKSPACE_INSTRUCTION_FILENAME,
                reason=(
                    read_result.reason
                    or ("file_budget" if read_result.truncated else "read_failed")
                ),
            )
        if normalized:
            block = f"## Workspace Instructions ({WORKSPACE_INSTRUCTION_FILENAME})\n{normalized}"
        self._cached_workspace_instruction_block = block
        self._cached_workspace_instruction_mtime = mtime_key
        return block

    @staticmethod
    def _bootstrap_mtime_key(root: Path) -> str:
        parts: list[str] = []
        for filename in BOOTSTRAP_FILES:
            path = root / BOOTSTRAP_DIRNAME / filename
            try:
                parts.append(str(path.stat().st_mtime_ns))
            except OSError:
                parts.append("0")
        return ":".join(parts)

    @staticmethod
    def _workspace_instruction_mtime_key(path: Path) -> str:
        try:
            return str(path.stat().st_mtime_ns)
        except OSError:
            return "0"
