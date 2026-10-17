"""Process-level conversation index ownership and the semantic embedder accessor."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_parsing import parse_conversation_index_config
from sidecar.ai.conversations import runtime
from sidecar.ai.semantic import runtime as semantic_runtime


def _config(path: Path | str, **overrides: Any) -> Any:
    block: dict[str, Any] = {"enabled": True, "db_path": str(path)}
    block.update(overrides)
    return parse_runtime_config({"conversation_index": block})


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    runtime.configure_conversation_index({})
    semantic_runtime.configure_semantic_catalog({})
    yield
    runtime.configure_conversation_index({})
    semantic_runtime.configure_semantic_catalog({})


def test_config_block_parsing(tmp_path: Path) -> None:
    good = parse_conversation_index_config({"enabled": True, "db_path": str(tmp_path / "c.db")})
    assert good is not None and good.enabled and good.db_path == str(tmp_path / "c.db")
    assert parse_conversation_index_config(None) is None
    assert parse_conversation_index_config({"enabled": False, "db_path": str(tmp_path)}) is None
    assert parse_conversation_index_config({"enabled": True, "db_path": "relative.db"}) is None
    assert parse_conversation_index_config({"enabled": True}) is None
    assert parse_runtime_config({}).conversation_index is None
    assert _config(tmp_path / "c.db").conversation_index == good


def test_opens_once_and_reuses(tmp_path: Path) -> None:
    first = runtime.configure_conversation_index(_config(tmp_path / "c.db"))

    assert first is not None
    assert runtime.configure_conversation_index(_config(tmp_path / "c.db")) is first
    assert runtime.configure_conversation_index(None) is first
    assert runtime.current_store() is first


def test_path_change_and_disable_close_the_store(tmp_path: Path) -> None:
    first = runtime.configure_conversation_index(_config(tmp_path / "a.db"))
    second = runtime.configure_conversation_index(_config(tmp_path / "b.db"))

    assert first is not None and first.closed and second is not None
    assert runtime.configure_conversation_index(parse_runtime_config({})) is None
    assert second.closed
    (tmp_path / "b.db").unlink()  # closed, so Electron can delete the file


def test_failed_open_is_retried_after_the_interval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    config = _config(blocker / "c.db")
    now = [100.0]
    monkeypatch.setattr(runtime.time, "monotonic", lambda: now[0])

    assert runtime.configure_conversation_index(config) is None
    blocker.unlink()
    blocker.mkdir()
    now[0] += 10
    assert runtime.configure_conversation_index(config) is None  # not yet retried
    now[0] += runtime.OPEN_RETRY_SECONDS
    assert runtime.configure_conversation_index(config) is not None


def test_current_embedder_reads_the_live_catalog(tmp_path: Path) -> None:
    assert semantic_runtime.current_embedder() is None
    config = parse_runtime_config({"semantic_catalog": {
        "enabled": True, "db_path": str(tmp_path / "catalog.db"),
        "base_url": "http://127.0.0.1:9/v1", "model_key": "model-a",
        "query_template": "q: {text}", "document_template": "{title}: {text}", "dims": 128,
    }})
    catalog = semantic_runtime.configure_semantic_catalog(config)
    assert catalog is not None

    embedder = semantic_runtime.current_embedder()

    assert embedder is not None
    assert (embedder.model_key, embedder.query_template, embedder.document_template,
            embedder.dims) == ("model-a", "q: {text}", "{title}: {text}", 128)
    assert embedder.provider is catalog.provider
