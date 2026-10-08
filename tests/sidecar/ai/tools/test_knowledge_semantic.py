"""knowledge_search by meaning (semantic catalog, roadmap row 41).

The builtin tools subprocess reads the catalog read-only; a query is fused
with exact-word matches by reciprocal rank, scoped like the grep path, and
falls back to the query's words with a one-line note when no catalog answers.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

import pytest

import sidecar.ai.semantic.reader as reader_module
from sidecar.ai.config_models import RuntimeConfig, SemanticCatalogConfig
from sidecar.ai.container_mcp_servers import _semantic_catalog_mcp_args
from sidecar.ai.semantic.catalog import CatalogRootSpec, SemanticCatalog
from sidecar.ai.semantic.reader import (
    configure_catalog_reader,
    configure_catalog_reader_from_cli,
    reader_configured,
)
from sidecar.ai.semantic.store import CatalogStore, CatalogStoreError
from sidecar.ai.tools.builtins.knowledge import configure_knowledge_tools, knowledge_search_tool
from sidecar.ai.tools.builtins.knowledge.semantic_fusion import (
    NOTE_OFF,
    NOTE_UNAVAILABLE,
    Passage,
    fuse_entries,
    query_terms_pattern,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar.ai.semantic.fakes import FakeProvider, bag_of_words, unavailable

MODEL_KEY = "model-a:none:0"
QUERY_TEMPLATE = "query: {text}"
_WORKSPACE = WorkspaceGuard(None)


class SynonymProvider(FakeProvider):
    """Bag-of-words with one synonym, so a query can match by meaning only."""

    def embed_many(self, texts: Sequence[str], *, timeout_seconds: float) -> list[list[float]]:
        self.calls.append(list(texts))
        if self.fail_with is not None:
            raise self.fail_with
        return [bag_of_words(text.replace("felines", "cats purr"), self.dim) for text in texts]


def _write(root: Path, rel_path: str, text: str) -> None:
    path = root / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _settings(db_path: Path) -> SemanticCatalogConfig:
    return SemanticCatalogConfig(
        enabled=True,
        db_path=str(db_path),
        base_url="http://127.0.0.1:50123/v1",
        model_key=MODEL_KEY,
        query_template=QUERY_TEMPLATE,
        document_template="{text}",
        dims=0,
    )


@pytest.fixture
def notes(tmp_path: Path) -> Path:
    root = tmp_path / "notes"
    _write(root, "cats.md", "# Cats\n\nCats purr softly and chase mice around the barn.")
    _write(root, "rockets.txt", "Rockets burn fuel to climb into orbit around the planet.")
    _write(root, "kitchen/soup.md", "Simmer onions and garlic for a warm soup.")
    configure_knowledge_tools({"tools_knowledge_enabled": True, "knowledge_roots": [str(root)]})
    return root


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> SynonymProvider:
    fake = SynonymProvider()
    monkeypatch.setattr(reader_module, "OpenAICompatibleEmbeddingProvider", lambda *_a, **_k: fake)
    return fake


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    yield
    configure_catalog_reader(None)
    configure_knowledge_tools(None)


def _build_catalog(tmp_path: Path, root: Path) -> Path:
    db_path = tmp_path / "index" / "semantic-catalog.db"
    writer = SemanticCatalog(
        CatalogStore(db_path),
        SynonymProvider(),
        model_key=MODEL_KEY,
        query_template=QUERY_TEMPLATE,
        document_template="{text}",
        dims=0,
    )
    try:
        for _ in range(50):
            step = writer.index_step(
                [CatalogRootSpec(str(root))], max_chunks=16, max_seconds=1.5, rescan=False
            )
            assert step.error is None, step.error
            if not step.more:
                break
    finally:
        writer.close()
    return db_path


def _search(arguments: dict[str, object]) -> dict[str, object]:
    result = knowledge_search_tool(arguments, _WORKSPACE)
    payload = json.loads(result.output)
    assert isinstance(payload, dict)
    payload["_success"] = result.success
    return payload


def test_query_finds_a_passage_by_meaning_that_no_word_matches(
    tmp_path: Path, notes: Path, provider: SynonymProvider
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    payload = _search({"query": "felines"})
    assert payload["_success"] is True
    passages = payload["passages"]
    assert isinstance(passages, list) and passages
    assert passages[0]["path"] == "notes/cats.md"
    assert passages[0]["source"] == "kb:1"
    assert "purr" in passages[0]["text"]
    assert [source["path"] for source in payload["sources"]][0] == "notes/cats.md"
    assert "note" not in payload
    assert provider.calls == [["query: felines"]], "one query embed per call"


def test_query_and_pattern_fuse_files_found_both_ways_first(
    tmp_path: Path, notes: Path, provider: SynonymProvider
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    payload = _search({"query": "felines", "pattern": "around"})
    paths = [source["path"] for source in payload["sources"]]
    assert paths[0] == "notes/cats.md", "found by meaning and by the regex"
    assert "notes/rockets.txt" in paths


def test_path_scope_and_include_glob_also_filter_passages(
    tmp_path: Path, notes: Path, provider: SynonymProvider
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    scoped = _search({"query": "felines", "path": "notes/kitchen"})
    assert {passage["path"] for passage in scoped["passages"]} == {"notes/kitchen/soup.md"}
    globbed = _search({"query": "felines", "include_glob": "*.txt"})
    assert {passage["path"] for passage in globbed["passages"]} == {"notes/rockets.txt"}


def test_include_glob_filters_exact_matches_and_passages_alike(
    tmp_path: Path, notes: Path, provider: SynonymProvider
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    exact = _search({"pattern": ".", "include_glob": "*.txt"})
    assert {source["path"] for source in exact["sources"]} == {"notes/rockets.txt"}
    nested = _search({"query": "felines", "include_glob": "kitchen/*.md"})
    assert {passage["path"] for passage in nested["passages"]} == {"notes/kitchen/soup.md"}


def test_scope_is_applied_before_the_top_results_are_chosen(
    tmp_path: Path, notes: Path, provider: SynonymProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(12):
        _write(notes, f"pets/cat-{index}.md", "Cats purr and cats nap in the sun.")
    _write(notes, "kitchen/cat-recipe.md", "A cat watched me simmer the soup.")
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    monkeypatch.setattr("sidecar.ai.tools.builtins.knowledge.semantic_fusion.SEMANTIC_LIMIT", 3)
    scoped = _search({"query": "felines", "path": "notes/kitchen"})
    assert "notes/kitchen/cat-recipe.md" in {passage["path"] for passage in scoped["passages"]}


def test_without_a_catalog_the_query_matches_its_words_and_says_so(notes: Path) -> None:
    payload = _search({"query": "Where do rockets climb?"})
    assert payload["note"] == NOTE_OFF
    assert payload["pattern"] == "where|rockets|climb"
    assert [source["path"] for source in payload["sources"]] == ["notes/rockets.txt"]
    assert "passages" not in payload


def test_an_unavailable_embedder_falls_back_softly(
    tmp_path: Path, notes: Path, provider: SynonymProvider
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    provider.fail_with = unavailable()
    payload = _search({"query": "rockets"})
    assert payload["note"] == NOTE_UNAVAILABLE
    assert [source["path"] for source in payload["sources"]] == ["notes/rockets.txt"]


def test_an_unbuilt_index_falls_back_without_creating_a_file(
    tmp_path: Path, notes: Path, provider: SynonymProvider
) -> None:
    db_path = tmp_path / "index" / "semantic-catalog.db"
    configure_catalog_reader(_settings(db_path))
    payload = _search({"query": "rockets"})
    assert payload["note"] == NOTE_UNAVAILABLE
    assert not db_path.exists()
    assert not db_path.parent.exists()


def test_pattern_or_query_is_required(notes: Path) -> None:
    with pytest.raises(ToolExecutionFailure, match="pattern"):
        knowledge_search_tool({}, _WORKSPACE)
    with pytest.raises(ToolExecutionFailure, match="query"):
        knowledge_search_tool({"query": "x" * 2001}, _WORKSPACE)


def test_pattern_only_keeps_exact_search_without_an_embed(
    tmp_path: Path, notes: Path, provider: SynonymProvider
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    payload = _search({"pattern": "orbit"})
    assert [source["path"] for source in payload["sources"]] == ["notes/rockets.txt"]
    assert "passages" not in payload and "note" not in payload
    assert provider.calls == []


def test_read_only_store_never_writes(tmp_path: Path, notes: Path) -> None:
    db_path = _build_catalog(tmp_path, notes)
    with pytest.raises(CatalogStoreError):
        CatalogStore(tmp_path / "missing" / "semantic-catalog.db", read_only=True)
    store = CatalogStore(db_path, read_only=True)
    try:
        with pytest.raises(sqlite3.OperationalError):
            store.add_root("x", str(tmp_path))
        assert store.roots(), "reads work"
    finally:
        store.close()


def test_reader_cli_settings_are_validated_and_off_in_hosted_mode(tmp_path: Path) -> None:
    good = {
        "db_path": str(tmp_path / "semantic-catalog.db"),
        "base_url": "http://127.0.0.1:50123/v1",
        "model_key": MODEL_KEY,
        "query_template": QUERY_TEMPLATE,
        "dims": "256",
    }
    assert configure_catalog_reader_from_cli(**good, allowed=True) is True
    assert reader_configured()
    assert configure_catalog_reader_from_cli(**good, allowed=False) is False
    assert not reader_configured()
    assert configure_catalog_reader_from_cli(
        **{**good, "base_url": "http://example.com:80/v1"}, allowed=True
    ) is False
    assert configure_catalog_reader_from_cli(**{**good, "db_path": ""}, allowed=True) is False


def test_container_forwards_reader_settings_but_never_a_key(tmp_path: Path) -> None:
    settings = _settings(tmp_path / "semantic-catalog.db")
    args = _semantic_catalog_mcp_args(RuntimeConfig(semantic_catalog=settings))
    assert args[args.index("--semantic-catalog-db") + 1] == settings.db_path
    assert args[args.index("--semantic-catalog-query-template") + 1] == QUERY_TEMPLATE
    assert _semantic_catalog_mcp_args(RuntimeConfig()) == []
    keyed = SemanticCatalogConfig(**{**settings.__dict__, "api_key": "secret-key"})
    assert _semantic_catalog_mcp_args(RuntimeConfig(semantic_catalog=keyed)) == []


def test_query_terms_and_fusion_helpers() -> None:
    assert query_terms_pattern("a b ?") == r"a\ b\ \?"
    assert query_terms_pattern("Lease lease renewal") == "lease|renewal"
    fused = fuse_entries(
        [("r/a.md", "a"), ("r/b.md", "b")],
        [Passage("r/b.md", "L1", "passage b"), Passage("r/c.md", "L2", "passage c")],
    )
    assert [path for path, _ in fused] == ["r/b.md", "r/a.md", "r/c.md"]
    assert dict(fused)["r/b.md"] == "passage b"


@pytest.mark.parametrize("replace_with_directory", [False, True])
def test_search_omits_passages_and_sources_for_deleted_files(
    tmp_path: Path, notes: Path, provider: SynonymProvider, replace_with_directory: bool
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    deleted = notes / "rockets.txt"
    deleted.unlink()
    if replace_with_directory:
        deleted.mkdir()

    payload = _search({"query": "rockets fuel orbit"})

    assert payload["_success"] is True
    assert "notes/rockets.txt" not in {passage["path"] for passage in payload["passages"]}
    assert "notes/rockets.txt" not in {source["path"] for source in payload["sources"]}


def test_an_inaccessible_hit_is_skipped_instead_of_failing_the_search(
    tmp_path: Path, notes: Path, provider: SynonymProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    real_is_file = Path.is_file

    def denied(self: Path) -> bool:  # only the fusion's own check is denied
        caller = sys._getframe(1).f_code.co_filename
        if self.name == "rockets.txt" and caller.endswith("semantic_fusion.py"):
            raise PermissionError(13, "denied", str(self))
        return real_is_file(self)

    monkeypatch.setattr(Path, "is_file", denied)

    payload = _search({"query": "rockets fuel orbit"})

    assert payload["_success"] is True
    assert "notes/rockets.txt" not in {passage["path"] for passage in payload["passages"]}
    assert payload["passages"]


def test_deleted_hit_frees_a_passage_slot(
    tmp_path: Path, notes: Path, provider: SynonymProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_catalog_reader(_settings(_build_catalog(tmp_path, notes)))
    monkeypatch.setattr("sidecar.ai.tools.builtins.knowledge.semantic_fusion.SEMANTIC_LIMIT", 1)
    before = _search({"query": "felines"})
    assert [passage["path"] for passage in before["passages"]] == ["notes/cats.md"]
    (notes / "cats.md").unlink()

    payload = _search({"query": "felines"})

    assert len(payload["passages"]) == 1
    assert payload["passages"][0]["path"] in {"notes/rockets.txt", "notes/kitchen/soup.md"}
