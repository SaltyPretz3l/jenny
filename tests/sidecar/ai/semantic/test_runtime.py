from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.error_codes import CMP_CATALOG_INDEX_UNAVAILABLE, CMP_CATALOG_NOT_CONFIGURED
from sidecar.ai.semantic import runtime
from sidecar.ai.semantic.store import CatalogStore
from sidecar.ai.tools.registry import build_tool_bindings


def _config(tmp_path: Path, **overrides: Any) -> Any:
    block: dict[str, Any] = {
        "enabled": True,
        "db_path": str(tmp_path / "catalog.db"),
        "base_url": "http://127.0.0.1:8123/v1",
        "model_key": "model-a",
        "query_template": "q: {text}",
        "document_template": "{title}: {text}",
        "dims": 0,
    }
    block.update(overrides)
    return parse_runtime_config({"semantic_catalog": block})


@pytest.fixture(autouse=True)
def _reset_runtime() -> Iterator[None]:
    runtime.configure_semantic_catalog({})
    yield
    runtime.configure_semantic_catalog({})


def test_builds_once_and_reuses_for_the_same_settings(tmp_path: Path) -> None:
    first = runtime.configure_semantic_catalog(_config(tmp_path))

    assert first is not None
    assert runtime.configure_semantic_catalog(_config(tmp_path)) is first
    assert runtime.current_catalog() is first
    assert runtime.configure_semantic_catalog(None) is first  # no config object: untouched


def test_relevant_change_rebuilds_and_closes_the_old_store(tmp_path: Path) -> None:
    first = runtime.configure_semantic_catalog(_config(tmp_path))
    second = runtime.configure_semantic_catalog(_config(tmp_path, model_key="model-b"))

    assert first is not None and second is not None and second is not first
    assert first._store.closed is True
    third = runtime.configure_semantic_catalog(_config(tmp_path, db_path=str(tmp_path / "b.db")))
    assert second._store.closed is True and third is not None


def test_disabled_config_closes_the_store_so_files_can_be_deleted(tmp_path: Path) -> None:
    catalog = runtime.configure_semantic_catalog(_config(tmp_path))
    assert catalog is not None
    catalog.status()

    assert runtime.configure_semantic_catalog(_config(tmp_path, enabled=False)) is None

    assert runtime.current_catalog() is None
    assert runtime.unavailable_reason() == CMP_CATALOG_NOT_CONFIGURED
    db = tmp_path / "catalog.db"
    db.rename(tmp_path / "moved.db")
    (tmp_path / "moved.db").unlink()
    for suffix in ("-wal", "-shm"):
        sidecar_file = Path(f"{db}{suffix}")
        if sidecar_file.exists():
            sidecar_file.unlink()


def test_newer_index_schema_is_unavailable_with_a_reason(tmp_path: Path) -> None:
    db = tmp_path / "catalog.db"
    CatalogStore(db).close()
    with closing(sqlite3.connect(db)) as connection:
        connection.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
        connection.commit()

    assert runtime.configure_semantic_catalog(_config(tmp_path)) is None
    assert runtime.unavailable_reason() == CMP_CATALOG_INDEX_UNAVAILABLE


def test_a_failed_open_is_retried_after_the_interval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = tmp_path / "catalog.db"
    CatalogStore(db).close()
    with closing(sqlite3.connect(db)) as connection:
        connection.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
        connection.commit()
    clock = [100.0]
    monkeypatch.setattr(runtime.time, "monotonic", lambda: clock[0])
    assert runtime.configure_semantic_catalog(_config(tmp_path)) is None

    with closing(sqlite3.connect(db)) as connection:
        connection.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
        connection.commit()
    assert runtime.configure_semantic_catalog(_config(tmp_path)) is None, "not before the interval"
    clock[0] += runtime.BUILD_RETRY_SECONDS
    assert runtime.configure_semantic_catalog(_config(tmp_path)) is not None


def test_raw_dict_configs_are_accepted(tmp_path: Path) -> None:
    raw = {
        "semantic_catalog": {
            "enabled": True,
            "db_path": str(tmp_path / "catalog.db"),
            "base_url": "http://localhost:9000/v1",
            "model_key": "m",
            "query_template": "{text}",
            "document_template": "{text}",
        }
    }

    assert runtime.configure_semantic_catalog(raw) is not None


def test_tool_registry_build_syncs_the_catalog(tmp_path: Path) -> None:
    build_tool_bindings(config=_config(tmp_path))

    assert runtime.current_catalog() is not None

    build_tool_bindings(config=parse_runtime_config({}))

    assert runtime.current_catalog() is None
