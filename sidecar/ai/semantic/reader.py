"""Read-only catalog access for ``knowledge_search`` (builtin tools subprocess).

The main sidecar owns the catalog writer (``runtime.py``). ``knowledge_search``
runs in the builtin tools subprocess, which receives the catalog settings on
argv (no secrets: the embedder is loopback-only and unauthenticated) and opens
the index read-only, lazily, on the first query. A missing or not-yet-built
index is not an error: the search falls back to exact words.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Sequence
from pathlib import Path

from sidecar.ai.config_models import SemanticCatalogConfig
from sidecar.ai.config_parsing import parse_semantic_catalog_config
from sidecar.ai.semantic.catalog import SearchResult, SemanticCatalog
from sidecar.ai.semantic.provider import EmbeddingProviderError, OpenAICompatibleEmbeddingProvider
from sidecar.ai.semantic.store import CatalogStore, CatalogStoreError

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_settings: SemanticCatalogConfig | None = None
_catalog: SemanticCatalog | None = None


def configure_catalog_reader(settings: SemanticCatalogConfig | None) -> None:
    """Install (or clear, with ``None``) the reader settings; closes a previous reader."""
    global _settings, _catalog  # noqa: PLW0603 - one reader per tools process.
    with _lock:
        previous = _catalog
        _settings = settings if settings is not None and settings.enabled else None
        _catalog = None
    if previous is not None:
        previous.close()


def configure_catalog_reader_from_cli(  # noqa: PLR0913 - one argv flag each.
    *,
    db_path: str,
    base_url: str,
    model_key: str,
    query_template: str,
    dims: str,
    allowed: bool,
) -> bool:
    """Install the reader from the tools subprocess argv; returns whether it is on.

    Invalid or missing settings leave the reader off (exact-word search only).
    ``allowed`` is false in hosted mode, which never reaches the catalog.
    """
    if not allowed or not db_path.strip():
        configure_catalog_reader(None)
        return False
    try:
        dims_value = int(dims.strip() or "0")
    except ValueError:
        dims_value = -1
    settings = parse_semantic_catalog_config({
        "enabled": True,
        "db_path": db_path,
        "base_url": base_url,
        "model_key": model_key,
        "query_template": query_template,
        "document_template": "{text}",
        "dims": dims_value,
    })
    configure_catalog_reader(settings)
    return settings is not None


def reader_configured() -> bool:
    with _lock:
        return _settings is not None


def _open(settings: SemanticCatalogConfig) -> SemanticCatalog:
    provider = OpenAICompatibleEmbeddingProvider(
        settings.base_url, settings.api_key, dims=settings.dims
    )
    try:
        store = CatalogStore(Path(settings.db_path), read_only=True)
    except CatalogStoreError:
        provider.close()
        raise
    return SemanticCatalog(
        store,
        provider,
        model_key=settings.model_key,
        query_template=settings.query_template,
        document_template=settings.document_template,
        dims=settings.dims,
    )


def search_catalog(
    query: str,
    *,
    root_paths: Sequence[str],
    limit: int,
    timeout_seconds: float,
    accept: Callable[[str, str], bool] | None = None,
) -> SearchResult | None:
    """Semantic hits for ``query`` within ``root_paths``; ``None`` when not configured.

    Never raises: an unavailable index or embedder comes back as a
    ``SearchResult`` with a ``reason`` code and no hits.
    """
    global _catalog  # noqa: PLW0603 - lazily opened process reader.
    with _lock:
        settings = _settings
        catalog = _catalog
        if settings is None:
            return None
        if catalog is None:
            try:
                catalog = _open(settings)
            except (CatalogStoreError, EmbeddingProviderError) as error:
                return SearchResult(reason=error.code)
            _catalog = catalog
    return catalog.search(
        query, root_paths=root_paths, limit=limit, timeout_seconds=timeout_seconds, accept=accept
    )
