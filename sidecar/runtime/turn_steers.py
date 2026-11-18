"""Mid-turn steering (row 180): ``session.user_steer_arrived`` parks the person's messages.

Mirrors the mid-turn mail and job-notice hops (``turn_state``, ``turn_job_notices``): an
unversioned inbound notification is admitted onto the matching live turn's queue, a contextvar
hands the queue to the worker's tool loop, and the loop drains it at the top of its next
iteration. A parked item also wakes listeners (the MCP stdio client uses one to end a blocking
background-job wait). Items are the person's own text and image references: logs carry ids and
counts only, never a body or an image name.
"""

from __future__ import annotations

import logging
import re
import threading
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Iterator, TypeGuard

from sidecar.protocol import SESSION_USER_STEER_ARRIVED_METHOD, SESSION_USER_STEER_WITHDRAWN_METHOD
from sidecar.runtime.turn_state import TurnLookup

MAX_STEER_ITEMS = 8
MAX_STEER_CONTENT_BYTES = 32 * 1024
MAX_STEER_IMAGES_PER_ITEM = 4
# Decoded images stay in the working messages for the rest of the turn and ride every later
# generation, so the turn's total is bounded too (charged once, never refunded).
MAX_STEER_IMAGES_PER_TURN = 8
MAX_ITEMS_PER_FRAME = 16

_ITEM_ID_RE = re.compile(r"^outbox_[a-z0-9_]{1,80}$")

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SteerItem:
    """One parked steer: the person's text (file blocks already inlined) and image attachments."""

    item_id: str
    content: str
    images: tuple[dict[str, Any], ...] = ()


def _content_bytes(item: SteerItem) -> int:
    return len(item.content.encode("utf-8"))


@dataclass
class PendingSteerQueue:
    """Steer items parked for the tool loop, bounded per turn (not per drain).

    At most ``MAX_STEER_ITEMS`` items and ``MAX_STEER_CONTENT_BYTES`` of UTF-8 content are held
    or consumed per turn, the earliest kept; an item id is accepted at most once, even after a
    drain or a withdrawal. A withdrawal frees its item and byte allowance, never its id.
    """

    _items: list[SteerItem] = field(default_factory=list)
    _accepted_ids: set[str] = field(default_factory=set)
    # Live allowance: item id -> content bytes (a withdrawal frees it, the id stays accepted).
    _counted: dict[str, int] = field(default_factory=dict)
    _images_taken: int = 0
    _listeners: dict[int, Callable[[], None]] = field(default_factory=dict)
    _listener_sequence: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def push(self, items: list[SteerItem]) -> tuple[list[str], int]:
        """Queue items in order; returns (accepted item ids, dropped item count)."""
        accepted: list[str] = []
        dropped = 0
        with self._lock:
            for item in items:
                size = _content_bytes(item)
                if (
                    item.item_id in self._accepted_ids
                    or len(self._counted) >= MAX_STEER_ITEMS
                    or sum(self._counted.values()) + size > MAX_STEER_CONTENT_BYTES
                    or self._images_taken + len(item.images) > MAX_STEER_IMAGES_PER_TURN
                ):
                    dropped += 1
                    continue
                self._accepted_ids.add(item.item_id)
                self._counted[item.item_id] = size
                self._images_taken += len(item.images)
                self._items.append(item)
                accepted.append(item.item_id)
            listeners = list(self._listeners.values()) if accepted else []
        # Listeners run outside the lock and must never break the admitting reader thread.
        for listener in listeners:
            try:
                listener()
            except Exception:  # noqa: BLE001
                _log.warning(
                    "Steer wake listener failed",
                    extra={"event": "sidecar.runtime.user_steer.wake_failed"},
                )
        return accepted, dropped

    def withdraw(self, item_ids: list[str]) -> list[str]:
        """Remove still-parked items; returns the ids removed (drained or unknown ids: ignored)."""
        wanted = set(item_ids)
        removed: list[str] = []
        with self._lock:
            kept: list[SteerItem] = []
            for item in self._items:
                if item.item_id in wanted:
                    removed.append(item.item_id)
                    self._counted.pop(item.item_id, None)
                else:
                    kept.append(item)
            self._items = kept
        return removed

    def drain(self) -> list[SteerItem]:
        """Return and clear the parked items (the per-turn bound is not reset)."""
        with self._lock:
            items, self._items = self._items, []
        return items

    def has_pending(self) -> bool:
        """True while at least one item is parked and not yet drained or withdrawn."""
        with self._lock:
            return bool(self._items)

    def add_wake_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Call ``listener`` after each push that parks an item; returns the remover."""
        with self._lock:
            self._listener_sequence += 1
            key = self._listener_sequence
            self._listeners[key] = listener

        def remove() -> None:
            with self._lock:
                self._listeners.pop(key, None)

        return remove


_PENDING_STEERS: ContextVar[PendingSteerQueue | None] = ContextVar(
    "sidecar_pending_steers",
    default=None,
)


@contextmanager
def bind_pending_steers(queue: PendingSteerQueue) -> Iterator[None]:
    token: Token[PendingSteerQueue | None] = _PENDING_STEERS.set(queue)
    try:
        yield
    finally:
        _PENDING_STEERS.reset(token)


def current_pending_steers() -> PendingSteerQueue | None:
    return _PENDING_STEERS.get()


def _non_empty_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _encodable_text(value: Any) -> TypeGuard[str]:
    """Non-blank text with no lone surrogate (a valid JSON escape no provider can take)."""
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _normalize_item(raw: Any) -> SteerItem | None:
    """Return a clean item, or None when the entry is malformed or over a per-item bound."""
    if not isinstance(raw, dict):
        return None
    item_id = raw.get("item_id")
    content = raw.get("content")
    images = raw.get("images", [])
    if not isinstance(item_id, str) or not _ITEM_ID_RE.fullmatch(item_id):
        return None
    if not _encodable_text(content):
        return None
    if not isinstance(images, list) or len(images) > MAX_STEER_IMAGES_PER_ITEM:
        return None
    if not all(isinstance(image, dict) for image in images):
        return None
    return SteerItem(item_id=item_id, content=content, images=tuple(images))


def _live_queue(
    params: dict[str, Any], lookup: TurnLookup, logger: logging.Logger, event: str
) -> tuple[PendingSteerQueue, dict[str, str]] | None:
    """The live turn's queue for a well-formed, current frame; else None (logged by id only)."""
    session_id = _non_empty_str(params.get("session_id"))
    request_id = _non_empty_str(params.get("request_id"))
    if not session_id or not request_id:
        logger.warning("Ignored malformed steer frame", extra={"event": f"{event}.invalid"})
        return None
    handle = lookup(session_id)
    queue = getattr(handle, "pending_steers", None)
    live = handle is not None and handle.request_id == request_id
    context = {"session_id": session_id, "request_id": request_id}
    if not live or not isinstance(queue, PendingSteerQueue):
        logger.info(
            "Ignored steer frame for a turn that is not live",
            extra={"event": f"{event}.stale", **context},
        )
        return None
    return queue, context


def admit_user_steer_arrived(
    params: dict[str, Any], lookup: TurnLookup, logger: logging.Logger
) -> None:
    """Park ``session.user_steer_arrived`` items on the matching live turn's queue.

    A notification: never raises and never answers. Items are the person's data, so the logs
    carry ids and counts only, never content.
    """
    event = "sidecar.runtime.user_steer_arrived"
    try:
        items = params.get("items") if isinstance(params, dict) else None
        if not isinstance(items, list):
            logger.warning("Ignored malformed steer frame", extra={"event": f"{event}.invalid"})
            return
        live = _live_queue(params, lookup, logger, event)
        if live is None:
            return
        queue, context = live
        read = items[:MAX_ITEMS_PER_FRAME]
        valid = [item for item in map(_normalize_item, read) if item is not None]
        accepted, _queue_dropped = queue.push(valid)
        dropped = len(items) - len(accepted)
        if dropped:
            logger.warning(
                "Dropped invalid, duplicate or over-bound steer items",
                extra={"event": f"{event}.dropped", "count": dropped, **context},
            )
        logger.info(
            "Queued steer items",
            extra={"event": event, "accepted": len(accepted), "dropped": dropped, **context},
        )
    except Exception:  # noqa: BLE001 - a notification handler must never break the reader.
        logger.warning("Steer handling failed", extra={"event": f"{event}.failed"})


def admit_user_steer_withdrawn(
    params: dict[str, Any], lookup: TurnLookup, logger: logging.Logger
) -> None:
    """Remove still-parked items named by ``session.user_steer_withdrawn``; drained ids stay."""
    event = "sidecar.runtime.user_steer_withdrawn"
    try:
        item_ids = params.get("item_ids") if isinstance(params, dict) else None
        if not isinstance(item_ids, list):
            logger.warning("Ignored malformed steer frame", extra={"event": f"{event}.invalid"})
            return
        live = _live_queue(params, lookup, logger, event)
        if live is None:
            return
        queue, context = live
        removed = queue.withdraw([item_id for item_id in item_ids if isinstance(item_id, str)])
        logger.info(
            "Withdrew steer items",
            extra={"event": event, "removed": len(removed), "requested": len(item_ids), **context},
        )
    except Exception:  # noqa: BLE001 - a notification handler must never break the reader.
        logger.warning("Steer withdrawal failed", extra={"event": f"{event}.failed"})


# Unversioned session-scoped notifications the multiplexer routes to the live turn.
STEER_NOTIFICATION_HANDLERS = {
    SESSION_USER_STEER_ARRIVED_METHOD: admit_user_steer_arrived,
    SESSION_USER_STEER_WITHDRAWN_METHOD: admit_user_steer_withdrawn,
}
