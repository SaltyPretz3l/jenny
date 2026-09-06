"""Atomic request-runtime capacity allocation for bounded sub-agent work."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Iterable


class SubAgentSlotLimitExceededError(RuntimeError):
    """Raised when the global sub-agent active-run ceiling is reached."""


class SubAgentSlotPerParentLimitExceededError(RuntimeError):
    """Raised when a parent would exceed its child-slot ceiling."""


@dataclass
class SubAgentSlotLease:
    parent_agent_id: str
    agent_id: str
    _allocator: "SubAgentSlotAllocator"
    _released: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._allocator.release(self)

    def __enter__(self) -> "SubAgentSlotLease":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        self.release()


class SubAgentSlotAllocator:
    """Bounded allocator with atomic multi-slot reservation and idempotent leases."""

    def __init__(
        self,
        *,
        max_active_sub_agents: int = 1,
        max_sub_agents_per_parent: int = 1,
    ) -> None:
        self._max_active_sub_agents = max(int(max_active_sub_agents or 1), 1)
        self._max_sub_agents_per_parent = max(int(max_sub_agents_per_parent or 1), 1)
        self._active_by_agent: dict[str, str] = {}
        self._active_by_parent: dict[str, set[str]] = {}
        self._lock = threading.Lock()

    def acquire(self, *, parent_agent_id: str, agent_id: str) -> SubAgentSlotLease:
        return self.acquire_many(parent_agent_id=parent_agent_id, agent_ids=(agent_id,))[0]

    def acquire_many(
        self,
        *,
        parent_agent_id: str,
        agent_ids: Iterable[str],
    ) -> tuple[SubAgentSlotLease, ...]:
        """Reserve all requested slots under one lock or mutate no allocator state."""

        normalized_parent = str(parent_agent_id or "").strip()
        normalized_agents = tuple(str(agent_id or "").strip() for agent_id in agent_ids)
        if not normalized_parent:
            raise ValueError("parent_agent_id is required")
        if not normalized_agents:
            raise ValueError("at least one agent_id is required")
        if any(not agent_id for agent_id in normalized_agents):
            raise ValueError("agent_id is required")
        if len(set(normalized_agents)) != len(normalized_agents):
            raise ValueError("agent_ids must be unique")

        with self._lock:
            parent_children = self._active_by_parent.get(normalized_parent, set())
            if len(parent_children) + len(normalized_agents) > self._max_sub_agents_per_parent:
                raise SubAgentSlotPerParentLimitExceededError(
                    f"parent sub-agent capacity unavailable: {normalized_parent}"
                )
            if len(self._active_by_agent) + len(normalized_agents) > self._max_active_sub_agents:
                raise SubAgentSlotLimitExceededError("too many active sub-agent runs")
            if any(agent_id in self._active_by_agent for agent_id in normalized_agents):
                raise SubAgentSlotLimitExceededError("sub-agent slot is already active")
            for agent_id in normalized_agents:
                self._active_by_agent[agent_id] = normalized_parent
            self._active_by_parent.setdefault(normalized_parent, set()).update(normalized_agents)

        return tuple(
            SubAgentSlotLease(
                parent_agent_id=normalized_parent,
                agent_id=agent_id,
                _allocator=self,
            )
            for agent_id in normalized_agents
        )

    def release(self, lease: SubAgentSlotLease) -> None:
        normalized_agent = str(lease.agent_id or "").strip()
        normalized_parent = str(lease.parent_agent_id or "").strip()
        with self._lock:
            if self._active_by_agent.get(normalized_agent) != normalized_parent:
                return
            self._active_by_agent.pop(normalized_agent, None)
            children = self._active_by_parent.get(normalized_parent)
            if children is not None:
                children.discard(normalized_agent)
                if not children:
                    self._active_by_parent.pop(normalized_parent, None)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "active_sub_agents": len(self._active_by_agent),
                "max_active_sub_agents": self._max_active_sub_agents,
                "max_sub_agents_per_parent": self._max_sub_agents_per_parent,
                "active_parent_count": len(self._active_by_parent),
            }


__all__ = [
    "SubAgentSlotAllocator",
    "SubAgentSlotLease",
    "SubAgentSlotLimitExceededError",
    "SubAgentSlotPerParentLimitExceededError",
]
