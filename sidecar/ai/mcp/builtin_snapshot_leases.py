"""Bounded process-local read-snapshot leases for the builtin MCP server."""

from __future__ import annotations

import os
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass

from sidecar.ai.tools.contracts import ToolHandlerResult

SNAPSHOT_LEASE_TTL_SECONDS = 8 * 60 * 60
MAX_SNAPSHOT_LEASES = 512
DIRECT_MCP_SESSION_ID = "direct-mcp"


@dataclass(frozen=True, slots=True)
class SnapshotLease:
    snapshot_id: str
    session_id: str
    normalized_path: str
    snapshot: dict[str, object]
    created_at: float


class SnapshotLeaseStore:
    """LRU snapshot capabilities scoped to one builtin-server generation."""

    def __init__(
        self,
        *,
        max_leases: int = MAX_SNAPSHOT_LEASES,
        ttl_seconds: float = SNAPSHOT_LEASE_TTL_SECONDS,
    ) -> None:
        self._max_leases = max(1, int(max_leases))
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._leases: OrderedDict[str, SnapshotLease] = OrderedDict()
        self._by_scope_path: dict[tuple[str, str], str] = {}

    def decorate_read_result(
        self,
        *,
        session_id: str,
        result: ToolHandlerResult,
        now: float | None = None,
    ) -> ToolHandlerResult:
        metadata = dict(result.metadata)
        raw_snapshot = metadata.get("read_snapshot")
        snapshot = dict(raw_snapshot) if isinstance(raw_snapshot, dict) else None
        scope = snapshot.get("scope") if snapshot is not None else None
        write_eligible = bool(
            scope == "full" and snapshot is not None and snapshot.get("sha256")
        )
        metadata["snapshot_scope"] = scope
        metadata["write_eligible"] = write_eligible
        metadata.setdefault("content_display_truncated", False)
        if write_eligible and snapshot is not None:
            path = str(snapshot.get("path") or "").strip()
            if path:
                lease = self.register(session_id=session_id, path=path, snapshot=snapshot, now=now)
                snapshot["snapshot_id"] = lease.snapshot_id
                metadata["snapshot_id"] = lease.snapshot_id
                metadata["read_snapshot"] = snapshot
        return ToolHandlerResult(
            output=result.output,
            success=result.success,
            generated_artifacts=result.generated_artifacts,
            error_code=result.error_code,
            metadata=metadata,
            trusted_attachments=result.trusted_attachments,
        )

    def register(
        self,
        *,
        session_id: str,
        path: str,
        snapshot: dict[str, object],
        now: float | None = None,
    ) -> SnapshotLease:
        current = time.monotonic() if now is None else now
        self._expire(current)
        normalized_path = _normalize_path(path)
        key = (_normalize_session(session_id), normalized_path)
        previous = self._by_scope_path.pop(key, None)
        if previous is not None:
            self._leases.pop(previous, None)
        lease = SnapshotLease(
            snapshot_id=f"snap_{uuid.uuid4().hex}",
            session_id=key[0],
            normalized_path=normalized_path,
            snapshot=dict(snapshot),
            created_at=current,
        )
        self._leases[lease.snapshot_id] = lease
        self._by_scope_path[key] = lease.snapshot_id
        self._evict()
        return lease

    def inject(
        self,
        *,
        tool_name: str,
        session_id: str,
        arguments: dict[str, object],
    ) -> dict[str, object]:
        prepared = dict(arguments)
        if tool_name in {"write_file", "edit_file"}:
            if "expected_read_snapshot" in prepared:
                return prepared
            path = prepared.get("path") if tool_name == "write_file" else prepared.get("file_path")
            lease = self._lease_for(session_id, path)
            if lease is not None:
                prepared["expected_read_snapshot"] = dict(lease.snapshot)
        return prepared

    def invalidate_after(
        self,
        *,
        tool_name: str,
        session_id: str,
        result: ToolHandlerResult,
    ) -> None:
        paths: set[str] = set()
        if tool_name == "move_file":
            moves = result.metadata.get("moves")
            if isinstance(moves, list):
                for move in moves:
                    if not isinstance(move, dict) or move.get("status") != "moved":
                        continue
                    for key in ("source", "destination"):
                        path = move.get(key)
                        if isinstance(path, str):
                            paths.add(path)
        elif result.success:
            metadata_path = result.metadata.get("path")
            if isinstance(metadata_path, str):
                paths.add(metadata_path)
        if tool_name in {"write_file", "edit_file", "delete_file", "move_file"}:
            self.invalidate(session_id=session_id, paths=paths)

    def invalidate(self, *, session_id: str, paths: set[str]) -> None:
        normalized_session = _normalize_session(session_id)
        for path in paths:
            key = (normalized_session, _normalize_path(path))
            lease_id = self._by_scope_path.pop(key, None)
            if lease_id is not None:
                self._leases.pop(lease_id, None)

    def _lease_for(self, session_id: str, path: object) -> SnapshotLease | None:
        if not isinstance(path, str) or not path.strip():
            return None
        self._expire(time.monotonic())
        key = (_normalize_session(session_id), _normalize_path(path))
        lease_id = self._by_scope_path.get(key)
        lease = self._leases.get(lease_id) if lease_id is not None else None
        if lease is not None:
            self._leases.move_to_end(lease.snapshot_id)
        return lease

    def _expire(self, now: float) -> None:
        expired = [
            lease_id
            for lease_id, lease in self._leases.items()
            if now - lease.created_at > self._ttl_seconds
        ]
        for lease_id in expired:
            self._discard(lease_id)

    def _evict(self) -> None:
        while len(self._leases) > self._max_leases:
            lease_id = next(iter(self._leases))
            self._discard(lease_id)

    def _discard(self, lease_id: str) -> None:
        lease = self._leases.pop(lease_id, None)
        if lease is not None:
            self._by_scope_path.pop((lease.session_id, lease.normalized_path), None)


def session_scope(arguments: dict[str, object]) -> str:
    raw = arguments.get("_jenny_session_id")
    return _normalize_session(raw if isinstance(raw, str) else DIRECT_MCP_SESSION_ID)


def _normalize_session(value: str) -> str:
    return str(value or DIRECT_MCP_SESSION_ID).strip() or DIRECT_MCP_SESSION_ID


def _normalize_path(value: str) -> str:
    normalized = os.path.normpath(str(value).strip()).replace("\\", "/")
    return normalized.casefold() if os.name == "nt" else normalized
