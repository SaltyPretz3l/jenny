"""catalog.* JSON-RPC dispatch: versioning, params, unavailable results, round trips."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch_catalog as rdc
from sidecar.ai.config import parse_runtime_config
from sidecar.ai.error_codes import (
    CMP_CATALOG_INVALID_PARAMS,
    CMP_CATALOG_NOT_CONFIGURED,
    CMP_PROTO_VERSION_MISMATCH,
)
from sidecar.ai.host_policy import HOST_ALLOWED_RPC_METHODS
from sidecar.ai.semantic import runtime
from sidecar.ai.semantic.catalog import SemanticCatalog
from sidecar.ai.semantic.store import CatalogStore
from sidecar.protocol import (
    API_VERSION,
    CATALOG_INDEX_STEP_METHOD,
    CATALOG_PURGE_METHOD,
    CATALOG_SEARCH_METHOD,
    CATALOG_STATUS_METHOD,
    INBOUND_VERSIONED_REQUEST_METHODS,
)
from sidecar.runtime import server_auxiliary_workers
from tests.sidecar.ai.semantic.fakes import FakeProvider

LOGGER = logging.getLogger("test.request_dispatch_catalog")
METHODS = (
    CATALOG_INDEX_STEP_METHOD,
    CATALOG_SEARCH_METHOD,
    CATALOG_STATUS_METHOD,
    CATALOG_PURGE_METHOD,
)


def _container(config: Any = None) -> Any:
    return SimpleNamespace(stack=SimpleNamespace(config=config or parse_runtime_config({})))


def _run(method: str, params: Any, *, message_id: Any = 7, container: Any = None) -> Any:
    return rdc.process_catalog_method(
        method=method,
        message_id=message_id,
        params=params,
        initialized=True,
        brain_container=container or _container(),
        logger=LOGGER,
    )


def _params(**extra: Any) -> dict[str, Any]:
    return {"accept_version": API_VERSION, **extra}


@pytest.fixture(autouse=True)
def _reset_runtime() -> Iterator[None]:
    runtime.configure_semantic_catalog({})
    yield
    runtime.configure_semantic_catalog({})


@pytest.fixture
def fake_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SemanticCatalog:
    catalog = SemanticCatalog(
        CatalogStore(tmp_path / "catalog.db"),
        FakeProvider(),
        model_key="model-a",
        query_template="{text}",
        document_template="{text}",
        dims=0,
    )
    monkeypatch.setattr(rdc, "_current_catalog", lambda _container: catalog)
    yield catalog
    catalog.close()


def test_methods_are_versioned_routed_off_loop_and_not_hosted() -> None:
    families = server_auxiliary_workers.AUXILIARY_FAMILY_BY_METHOD
    caps = server_auxiliary_workers.DEFAULT_MAX_WORKERS_BY_FAMILY
    for method in METHODS:
        assert method in INBOUND_VERSIONED_REQUEST_METHODS
        assert method in server_auxiliary_workers.AUXILIARY_WORKER_METHODS
        assert method not in HOST_ALLOWED_RPC_METHODS
    assert families[CATALOG_INDEX_STEP_METHOD] == families[CATALOG_PURGE_METHOD] == "catalog"
    assert families[CATALOG_SEARCH_METHOD] == families[CATALOG_STATUS_METHOD] == "catalog_read"
    assert (caps["catalog"], caps["catalog_read"]) == (1, 2)


def test_other_methods_are_not_handled() -> None:
    assert _run("memory.status", _params()) is None


@pytest.mark.parametrize("method", METHODS)
def test_accept_version_mismatch_is_rejected(method: str) -> None:
    outcome = _run(method, {"accept_version": "1999-01-01"})

    assert outcome.response["error"]["data"]["code"] == CMP_PROTO_VERSION_MISMATCH


def test_notifications_get_no_response() -> None:
    outcome = _run(CATALOG_STATUS_METHOD, _params(), message_id=None)

    assert outcome is not None and outcome.response is None


@pytest.mark.parametrize(
    ("method", "params"),
    [
        (CATALOG_INDEX_STEP_METHOD, {"roots": "C:/notes"}),
        (CATALOG_INDEX_STEP_METHOD, {"roots": [{"path": ""}]}),
        (CATALOG_INDEX_STEP_METHOD, {"roots": [], "budget": {"max_chunks": 0}}),
        (CATALOG_INDEX_STEP_METHOD, {"roots": [], "budget": {"max_chunks": 65}}),
        (CATALOG_INDEX_STEP_METHOD, {"roots": [], "budget": {"max_seconds": 0.05}}),
        (CATALOG_INDEX_STEP_METHOD, {"roots": [], "budget": {"max_seconds": 6}}),
        (CATALOG_INDEX_STEP_METHOD, {"roots": [], "rescan": "yes"}),
        (CATALOG_SEARCH_METHOD, {"query": "", "roots": []}),
        (CATALOG_SEARCH_METHOD, {"query": "x" * 2001, "roots": []}),
        (CATALOG_SEARCH_METHOD, {"query": "ok", "roots": "C:/notes"}),
        (CATALOG_SEARCH_METHOD, {"query": "ok", "roots": [], "limit": 21}),
        (CATALOG_PURGE_METHOD, {}),
        (CATALOG_PURGE_METHOD, {"all": "true"}),
        (CATALOG_PURGE_METHOD, {"all": True, "roots": []}),
    ],
)
def test_invalid_params_carry_the_catalog_code(method: str, params: dict[str, Any]) -> None:
    outcome = _run(method, _params(**params))

    error = outcome.response["error"]
    assert error["code"] == -32602
    assert error["data"]["code"] == CMP_CATALOG_INVALID_PARAMS


@pytest.mark.parametrize(
    ("method", "params"),
    [
        (CATALOG_STATUS_METHOD, {}),
        (CATALOG_SEARCH_METHOD, {"query": "x", "roots": []}),
        (CATALOG_INDEX_STEP_METHOD, {"roots": []}),
        (CATALOG_PURGE_METHOD, {"all": True}),
    ],
)
def test_unconfigured_catalog_is_an_inert_result(method: str, params: dict[str, Any]) -> None:
    outcome = _run(method, _params(**params))

    result = outcome.response["result"]
    assert result["available"] is False and result["reason"] == CMP_CATALOG_NOT_CONFIGURED
    assert result["api_version"] == API_VERSION


def test_real_runtime_sync_from_the_stack_config(tmp_path: Path) -> None:
    config = parse_runtime_config({
        "semantic_catalog": {
            "enabled": True,
            "db_path": str(tmp_path / "catalog.db"),
            "base_url": "http://127.0.0.1:9/v1",
            "model_key": "m",
            "query_template": "{text}",
            "document_template": "{text}",
        }
    })

    outcome = _run(CATALOG_STATUS_METHOD, _params(), container=_container(config))

    result = outcome.response["result"]
    assert result["available"] is True and result["counts"]["documents"] == 0


def test_index_search_status_purge_round_trip(
    tmp_path: Path, fake_catalog: SemanticCatalog
) -> None:
    root = tmp_path / "notes"
    root.mkdir()
    (root / "orbit.md").write_text("Rockets climb into orbit.", encoding="utf-8")

    step = _run(CATALOG_INDEX_STEP_METHOD, _params(
        roots=[{"path": str(root)}], budget={"max_chunks": 4, "max_seconds": 1.0}, rescan=True
    )).response["result"]
    assert step["available"] is True
    assert step["state"] == "caught_up" and step["more"] is False
    assert step["counts"]["embedded"] == 1 and step["error"] is None
    assert set(step["step"]) == {"scanned", "extracted", "embedded", "purged", "elapsed_ms"}

    search = _run(CATALOG_SEARCH_METHOD, _params(
        query="rockets orbit", roots=[str(root)], limit=3
    )).response["result"]
    assert search["available"] is True and search["partial"] is False
    assert search["hits"][0]["rel_path"] == "orbit.md"
    assert set(search["hits"][0]) == {"root_path", "rel_path", "locator", "snippet", "score"}

    status = _run(CATALOG_STATUS_METHOD, _params()).response["result"]
    assert status["roots"][0]["indexed"] == 1

    purge = _run(CATALOG_PURGE_METHOD, _params(all=True)).response["result"]
    assert (purge["available"], purge["ok"], purge["purged_documents"]) == (True, True, 1)


def test_catalog_faults_become_error_responses(fake_catalog: SemanticCatalog) -> None:
    fake_catalog._store.close()

    outcome = _run(CATALOG_STATUS_METHOD, _params())

    assert outcome.response["error"]["code"] == -32000
