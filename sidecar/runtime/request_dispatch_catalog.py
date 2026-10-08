"""Semantic catalog JSON-RPC dispatch (``catalog.*``), beside the memory dispatcher.

The catalog is synced from the live stack config on every call (a no-op unless
the relevant settings changed). An unconfigured catalog answers with a result
``{available: false, reason}`` so Electron can show the feature as inert.
Hosted mode never reaches here: these methods are not in ``HOST_ALLOWED_RPC_METHODS``.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import (
    CMP_CATALOG_INDEX_UNAVAILABLE,
    CMP_CATALOG_INVALID_PARAMS,
    CMP_PROTO_VERSION_MISMATCH,
)
from sidecar.ai.semantic.catalog import CatalogRootSpec, SemanticCatalog
from sidecar.ai.semantic.runtime import configure_semantic_catalog, unavailable_reason
from sidecar.protocol import (
    CATALOG_INDEX_STEP_METHOD,
    CATALOG_PURGE_METHOD,
    CATALOG_SEARCH_METHOD,
    CATALOG_STATUS_METHOD,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
MAX_ROOT_PARAMS = 256
MAX_PATH_CHARS = 4096
MAX_QUERY_CHARS = 2000
DEFAULT_MAX_CHUNKS = 16
MAX_STEP_CHUNKS = 64
DEFAULT_MAX_SECONDS = 1.5
MIN_STEP_SECONDS = 0.1
MAX_STEP_SECONDS = 5.0
DEFAULT_SEARCH_LIMIT = 8
MAX_SEARCH_LIMIT = 20
CATALOG_METHODS = frozenset(
    {CATALOG_INDEX_STEP_METHOD, CATALOG_SEARCH_METHOD, CATALOG_STATUS_METHOD, CATALOG_PURGE_METHOD}
)

CatalogCall = Callable[[SemanticCatalog], dict[str, Any]]


def _mapping(params: Any) -> dict[str, Any]:
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    return params


def _path(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_PATH_CHARS:
        raise ValueError("each root path must be a non-empty string")
    return value


def _path_list(value: Any, *, field: str) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_ROOT_PARAMS:
        raise ValueError(f"{field} must be a list of at most {MAX_ROOT_PARAMS} paths")
    return [_path(item) for item in value]


def _bounded_int(value: Any, *, field: str, default: int, maximum: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"{field} must be an integer between 1 and {maximum}")
    return value


def _seconds(value: Any) -> float:
    if value is None:
        return DEFAULT_MAX_SECONDS
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("budget.max_seconds must be a number")
    seconds = float(value)
    if not math.isfinite(seconds) or not MIN_STEP_SECONDS <= seconds <= MAX_STEP_SECONDS:
        raise ValueError(
            f"budget.max_seconds must be between {MIN_STEP_SECONDS} and {MAX_STEP_SECONDS}"
        )
    return seconds


def _index_step_call(params: dict[str, Any]) -> CatalogCall:
    raw_roots = params.get("roots", [])
    if not isinstance(raw_roots, list) or len(raw_roots) > MAX_ROOT_PARAMS:
        raise ValueError("roots must be a list of {path} objects")
    roots = [
        CatalogRootSpec(_path(item.get("path") if isinstance(item, dict) else None))
        for item in raw_roots
    ]
    budget = params.get("budget", {})
    if not isinstance(budget, dict):
        raise ValueError("budget must be an object")
    max_chunks = _bounded_int(
        budget.get("max_chunks"), field="budget.max_chunks",
        default=DEFAULT_MAX_CHUNKS, maximum=MAX_STEP_CHUNKS,
    )
    max_seconds = _seconds(budget.get("max_seconds"))
    rescan = params.get("rescan", False)
    if not isinstance(rescan, bool):
        raise ValueError("rescan must be a boolean")
    return lambda catalog: catalog.index_step(
        roots, max_chunks=max_chunks, max_seconds=max_seconds, rescan=rescan
    ).to_dict()


def _search_call(params: dict[str, Any]) -> CatalogCall:
    query = params.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY_CHARS:
        raise ValueError(f"query must be 1..{MAX_QUERY_CHARS} characters")
    roots = _path_list(params.get("roots"), field="roots")
    limit = _bounded_int(
        params.get("limit"), field="limit", default=DEFAULT_SEARCH_LIMIT, maximum=MAX_SEARCH_LIMIT
    )
    return lambda catalog: catalog.search(query, root_paths=roots, limit=limit).to_dict()


def _purge_call(params: dict[str, Any]) -> CatalogCall:
    purge_all = params.get("all", False)
    if purge_all is not True and purge_all is not False:
        raise ValueError("all must be a boolean")
    if purge_all:
        if "roots" in params:
            raise ValueError("pass either roots or all, not both")
        targets: list[str] | None = None
    else:
        targets = _path_list(params.get("roots"), field="roots")
    return lambda catalog: {"ok": True, "purged_documents": catalog.purge(targets)}


def _status_call(_params: dict[str, Any]) -> CatalogCall:
    return lambda catalog: catalog.status()


_PARSERS: dict[str, Callable[[dict[str, Any]], CatalogCall]] = {
    CATALOG_INDEX_STEP_METHOD: _index_step_call,
    CATALOG_SEARCH_METHOD: _search_call,
    CATALOG_STATUS_METHOD: _status_call,
    CATALOG_PURGE_METHOD: _purge_call,
}


def _outcome(initialized: bool, response: dict[str, Any] | None) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized, shutdown_requested=False, response=response, notifications=[]
    )


def _current_catalog(brain_container: BrainContainer) -> SemanticCatalog | None:
    stack = brain_container.stack
    return configure_semantic_catalog(getattr(stack, "config", None) or {})


def process_catalog_method(  # noqa: PLR0913 - mirrors the dispatcher boundary.
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch catalog.* JSON-RPC methods.  Returns None for any other method."""
    parser = _PARSERS.get(method)
    if parser is None:
        return None
    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(initialized, version_error)
    if message_id is None:
        return _outcome(initialized, None)
    try:
        call = parser(_mapping(params))
    except ValueError as error:
        return _outcome(initialized, error_response(
            message_id,
            code=INVALID_PARAMS_CODE,
            message=f"{method} invalid params",
            data={"code": CMP_CATALOG_INVALID_PARAMS, "detail": str(error)},
        ))
    return _outcome(initialized, _run(method, message_id, call, brain_container, logger))


def _run(
    method: str,
    message_id: Any,
    call: CatalogCall,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> dict[str, Any]:
    try:
        catalog = _current_catalog(brain_container)
        if catalog is None:
            return result_response(
                message_id, {"available": False, "reason": unavailable_reason()}
            )
        result = call(catalog)
    except Exception as error:  # noqa: BLE001 - a catalog fault must not end the sidecar.
        log_event(
            logger,
            logging.WARNING,
            component="runtime.request_dispatch",
            event="sidecar.runtime.catalog.failed",
            message="Semantic catalog request failed without terminating the sidecar.",
            status="degraded",
            data={"method": method, "error_type": type(error).__name__},
        )
        return error_response(
            message_id,
            code=INTERNAL_ERROR_CODE,
            message=f"{method} failed",
            data={"code": CMP_CATALOG_INDEX_UNAVAILABLE, "error_type": type(error).__name__},
        )
    return result_response(message_id, {"available": True, **result})
