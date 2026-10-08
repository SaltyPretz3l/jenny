"""Process-level owner of the semantic catalog instance.

Ownership (AGENTS.md): this is a bounded, observable, durable subsystem state
owned by the sidecar. The durable part is one derived-cache SQLite file at the
Electron-supplied ``db_path`` (caps in ``store.py``, schema version registered as
``sidecar.semantic_catalog``); the process-global part is the single
``SemanticCatalog`` built from the current ``RuntimeConfig.semantic_catalog``.
It is rebuilt only when the relevant settings change (db path, embedder URL,
model key, templates, dims, key) and dropped (its SQLite connection closed, so
Electron can delete the files) when the config is absent or disabled. Index
steps and searches arrive on different worker threads, so every transition runs
under one lock. ``catalog.status`` exposes the state.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.config_models import SemanticCatalogConfig
from sidecar.ai.config_parsing import parse_semantic_catalog_config
from sidecar.ai.error_codes import CMP_CATALOG_NOT_CONFIGURED
from sidecar.ai.semantic.catalog import SemanticCatalog
from sidecar.ai.semantic.provider import EmbeddingProviderError, OpenAICompatibleEmbeddingProvider
from sidecar.ai.semantic.store import CatalogStore, CatalogStoreError

logger = logging.getLogger(__name__)

BUILD_RETRY_SECONDS = 30.0


@dataclass
class _RuntimeState:
    signature: tuple[Any, ...] | None = None
    catalog: SemanticCatalog | None = None
    reason: str = CMP_CATALOG_NOT_CONFIGURED
    failed_at: float | None = None


_lock = threading.RLock()
_state = _RuntimeState()


def _settings_from(config: Any) -> SemanticCatalogConfig | None:
    """Accept a ``RuntimeConfig`` (parsed field) or a raw dict config."""
    if isinstance(config, dict):
        return parse_semantic_catalog_config(
            config.get("semantic_catalog"), api_key=config.get("semantic_catalog_api_key")
        )
    settings = getattr(config, "semantic_catalog", None)
    return settings if isinstance(settings, SemanticCatalogConfig) else None


def _signature(settings: SemanticCatalogConfig) -> tuple[Any, ...]:
    return (
        settings.db_path,
        settings.base_url,
        settings.model_key,
        settings.query_template,
        settings.document_template,
        settings.dims,
        settings.api_key,
    )


def _build(settings: SemanticCatalogConfig) -> tuple[SemanticCatalog | None, str]:
    try:
        provider = OpenAICompatibleEmbeddingProvider(
            settings.base_url, settings.api_key, dims=settings.dims
        )
    except EmbeddingProviderError as error:
        return None, error.code
    try:
        store = CatalogStore(Path(settings.db_path))
    except CatalogStoreError as error:
        provider.close()
        logger.warning("semantic catalog index unavailable", extra={"code": error.code})
        return None, error.code
    catalog = SemanticCatalog(
        store,
        provider,
        model_key=settings.model_key,
        query_template=settings.query_template,
        document_template=settings.document_template,
        dims=settings.dims,
    )
    return catalog, CMP_CATALOG_NOT_CONFIGURED


def _retry_due() -> bool:
    failed_at = _state.failed_at
    return failed_at is not None and time.monotonic() - failed_at >= BUILD_RETRY_SECONDS


def _drop_current() -> None:
    catalog = _state.catalog
    _state.catalog = None
    if catalog is not None:
        try:
            catalog.close()
        except Exception:  # noqa: BLE001 - closing a replaced catalog is best effort.
            logger.warning("semantic catalog close failed")


def configure_semantic_catalog(config: Any) -> SemanticCatalog | None:
    """Sync the process catalog with ``config``; returns the current catalog.

    ``None`` means "no config object at all" (e.g. the config-free default
    registry build) and leaves the catalog untouched; a config whose
    ``semantic_catalog`` is absent, invalid or disabled drops and closes it.
    """
    if config is None:
        return current_catalog()
    settings = _settings_from(config)
    with _lock:
        if settings is None or not settings.enabled:
            _drop_current()
            _state.signature = None
            _state.reason = CMP_CATALOG_NOT_CONFIGURED
            return None
        signature = _signature(settings)
        # A failed open (a locked file, say) is retried after a short interval
        # instead of being cached for these settings.
        if signature == _state.signature and not _retry_due():
            return _state.catalog
        _drop_current()
        _state.catalog, _state.reason = _build(settings)
        _state.signature = signature
        _state.failed_at = None if _state.catalog is not None else time.monotonic()
        return _state.catalog


def current_catalog() -> SemanticCatalog | None:
    with _lock:
        return _state.catalog


def unavailable_reason() -> str:
    """The CMP-CAT code explaining why ``current_catalog()`` is ``None``."""
    with _lock:
        return _state.reason
