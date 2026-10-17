"""Process-level owner of the conversation index store.

Ownership (AGENTS.md): bounded, observable, durable subsystem state owned by
the sidecar. The durable part is one derived-cache SQLite file at the
Electron-supplied ``conversation_index.db_path`` (caps in ``store.py``, schema
registered as ``sidecar.conversation_index``); the process-global part is the
single ``ConversationStore`` opened lazily on the first ``conversations.*``
call. It is reopened when the path changes and closed and dropped (so Electron
can delete the files) when the config block is absent or disabled. A failed
open is retried after ``OPEN_RETRY_SECONDS``. Calls arrive on different worker
threads, so every transition runs under one lock.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.config_models import ConversationIndexConfig
from sidecar.ai.config_parsing import parse_conversation_index_config
from sidecar.ai.conversations.store import ConversationIndexError, ConversationStore

logger = logging.getLogger(__name__)

OPEN_RETRY_SECONDS = 30.0


@dataclass
class _RuntimeState:
    db_path: str | None = None
    store: ConversationStore | None = None
    failed_at: float | None = None


_lock = threading.RLock()
_state = _RuntimeState()


def _settings_from(config: Any) -> ConversationIndexConfig | None:
    """Accept a ``RuntimeConfig`` (parsed field) or a raw dict config."""
    if isinstance(config, dict):
        return parse_conversation_index_config(config.get("conversation_index"))
    settings = getattr(config, "conversation_index", None)
    return settings if isinstance(settings, ConversationIndexConfig) else None


def _drop_current() -> None:
    store = _state.store
    _state.store = None
    if store is not None:
        try:
            store.close()
        except Exception:  # noqa: BLE001 - closing a replaced store is best effort.
            logger.warning("conversation index close failed")


def _retry_due() -> bool:
    failed_at = _state.failed_at
    return failed_at is None or time.monotonic() - failed_at >= OPEN_RETRY_SECONDS


def configure_conversation_index(config: Any) -> ConversationStore | None:
    """Sync the process store with ``config``; returns the current store.

    ``None`` (no config object at all) leaves the store untouched; a config
    whose ``conversation_index`` is absent, invalid or disabled closes it.
    """
    if config is None:
        return current_store()
    settings = _settings_from(config)
    with _lock:
        if settings is None or not settings.enabled:
            _drop_current()
            _state.db_path, _state.failed_at = None, None
            return None
        if settings.db_path == _state.db_path and (
            _state.store is not None or not _retry_due()
        ):
            return _state.store
        _drop_current()
        _state.db_path = settings.db_path
        try:
            _state.store = ConversationStore(Path(settings.db_path))
            _state.failed_at = None
        except ConversationIndexError as error:
            logger.warning("conversation index unavailable",
                           extra={"error_type": type(error.__cause__ or error).__name__})
            _state.failed_at = time.monotonic()
        return _state.store


def current_store() -> ConversationStore | None:
    with _lock:
        return _state.store
