from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

import sidecar.ai.semantic.catalog as catalog_module
import sidecar.ai.semantic.extract as extract_module
import sidecar.ai.semantic.store as store_module
from sidecar.ai.error_codes import (
    CMP_CATALOG_CAPACITY_REACHED,
    CMP_CATALOG_EMBEDDER_UNAVAILABLE,
)
from sidecar.ai.semantic.catalog import CatalogRootSpec, SemanticCatalog, StepResult
from sidecar.ai.semantic.store import CatalogStore
from tests.sidecar.ai.semantic.fakes import FakeClock, FakeProvider, refused, unavailable

QUERY_TEMPLATE = "query: {text}"
DOCUMENT_TEMPLATE = "title: {title} | text: {text}"


def _write(root: Path, rel_path: str, text: str) -> Path:
    path = root / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _catalog(
    tmp_path: Path,
    *,
    provider: FakeProvider | None = None,
    clock: FakeClock | None = None,
    model_key: str = "model-a",
    store: CatalogStore | None = None,
) -> SemanticCatalog:
    return SemanticCatalog(
        store or CatalogStore(tmp_path / "index" / "catalog.db"),
        provider or FakeProvider(),
        model_key=model_key,
        query_template=QUERY_TEMPLATE,
        document_template=DOCUMENT_TEMPLATE,
        dims=0,
        clock=clock or FakeClock(),
    )


def _step(catalog: SemanticCatalog, roots: list[Path], **kwargs: object) -> StepResult:
    options: dict[str, object] = {"max_chunks": 16, "max_seconds": 1.5, "rescan": False}
    options.update(kwargs)
    return catalog.index_step(
        [CatalogRootSpec(str(root)) for root in roots],
        max_chunks=int(options["max_chunks"]),  # type: ignore[call-overload]
        max_seconds=float(options["max_seconds"]),  # type: ignore[arg-type]
        rescan=bool(options["rescan"]),
    )


def _until_caught_up(catalog: SemanticCatalog, roots: list[Path], **kwargs: object) -> StepResult:
    for _ in range(200):
        result = _step(catalog, roots, **kwargs)
        assert result.error is None, result.error
        if not result.more:
            return result
    raise AssertionError("catalog never caught up")


@pytest.fixture
def notes(tmp_path: Path) -> Path:
    root = tmp_path / "notes"
    _write(root, "cats.md", "# Cats\n\nCats purr softly and chase mice around the barn.")
    _write(root, "rockets.txt", "Rockets burn fuel to climb into orbit around the planet.")
    _write(root, "cooking/soup.md", "Simmer onions, carrots and garlic for a warm soup.")
    _write(root, "photo.png", "not really an image")
    return root


def test_index_then_search_ranks_by_meaning(tmp_path: Path, notes: Path) -> None:
    provider = FakeProvider()
    catalog = _catalog(tmp_path, provider=provider)

    result = _until_caught_up(catalog, [notes])

    assert result.state == "caught_up"
    assert result.counts["documents"] == 3  # the .png is never cataloged
    assert result.counts["indexed"] == 3
    assert result.counts["embedded"] == result.counts["chunks"] == 3
    embedded_texts = [text for call in provider.calls for text in call]
    assert "title: rockets.txt | text: Rockets burn fuel to climb into orbit around the planet." in (
        embedded_texts
    )

    found = catalog.search("rockets fuel orbit", root_paths=[str(notes)], limit=3)

    assert provider.calls[-1] == ["query: rockets fuel orbit"]
    assert found.reason is None and found.partial is False
    assert [hit.rel_path for hit in found.hits][0] == "rockets.txt"
    top = found.hits[0]
    assert top.locator == "L1-1"
    assert top.root_path == os.path.realpath(notes)
    assert top.snippet.startswith("Rockets burn fuel")
    assert top.score > found.hits[1].score


def test_search_filters_by_root(tmp_path: Path, notes: Path) -> None:
    other = tmp_path / "other"
    _write(other, "rockets-too.md", "Rockets burn fuel to climb into orbit.")
    catalog = _catalog(tmp_path)
    _until_caught_up(catalog, [notes, other])

    found = catalog.search("rockets orbit", root_paths=[str(other)])

    assert [hit.rel_path for hit in found.hits] == ["rockets-too.md"]


def test_numpy_and_python_scoring_rank_identically(
    tmp_path: Path, notes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog = _catalog(tmp_path)
    _until_caught_up(catalog, [notes])
    fast = catalog.search("warm soup with onions", root_paths=[str(notes)], limit=5)

    monkeypatch.setattr(catalog_module, "_load_numpy", lambda: None)
    slow = catalog.search("warm soup with onions", root_paths=[str(notes)], limit=5)

    assert [(hit.rel_path, hit.score) for hit in slow.hits] == [
        (hit.rel_path, hit.score) for hit in fast.hits
    ]
    assert slow.hits[0].rel_path == "cooking/soup.md"


def test_search_is_partial_at_the_scan_cap(
    tmp_path: Path, notes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog = _catalog(tmp_path)
    _until_caught_up(catalog, [notes])
    monkeypatch.setattr(catalog_module, "MAX_SIMILARITY_SCAN_ROWS", 2)

    found = catalog.search("cats", root_paths=[str(notes)], limit=5)

    assert found.partial is True
    assert len(found.hits) == 2
    assert "cats.md" not in {hit.rel_path for hit in found.hits}  # oldest row not scanned


def test_search_is_partial_when_the_deadline_passes(tmp_path: Path, notes: Path) -> None:
    clock = FakeClock()
    provider = FakeProvider(clock=clock)
    catalog = _catalog(tmp_path, provider=provider, clock=clock)
    _until_caught_up(catalog, [notes])
    provider.seconds_per_call = 5.0  # the query embed alone overruns the deadline

    found = catalog.search("cats", root_paths=[str(notes)], timeout_seconds=1.5)

    assert found.partial is True
    assert found.hits == []


def test_search_provider_failure_is_a_reason_not_an_exception(
    tmp_path: Path, notes: Path
) -> None:
    provider = FakeProvider()
    catalog = _catalog(tmp_path, provider=provider)
    _until_caught_up(catalog, [notes])
    provider.fail_with = unavailable()

    found = catalog.search("cats", root_paths=[str(notes)])

    assert found.hits == []
    assert found.reason == CMP_CATALOG_EMBEDDER_UNAVAILABLE


def test_step_provider_failure_is_returned_in_the_result(tmp_path: Path, notes: Path) -> None:
    provider = FakeProvider()
    provider.fail_with = unavailable()
    catalog = _catalog(tmp_path, provider=provider)

    result = _step(catalog, [notes])

    assert result.error == {"code": CMP_CATALOG_EMBEDDER_UNAVAILABLE, "message": "embedder is down"}
    assert result.more is True and result.state == "working"
    assert result.counts["chunks"] == 3 and result.counts["embedded"] == 0

    provider.fail_with = RuntimeError("socket exploded")
    assert _step(catalog, [notes]).error["code"] == CMP_CATALOG_EMBEDDER_UNAVAILABLE  # type: ignore[index]


def test_step_respects_the_chunk_budget(tmp_path: Path) -> None:
    root = tmp_path / "many"
    for index in range(7):
        _write(root, f"note-{index}.md", f"Note number {index} about topic {index}.")
    catalog = _catalog(tmp_path)

    first = _step(catalog, [root], max_chunks=3)

    assert first.step["embedded"] == 3
    assert first.more is True
    assert _until_caught_up(catalog, [root], max_chunks=3).counts["embedded"] == 7


def test_step_respects_the_time_budget(tmp_path: Path) -> None:
    root = tmp_path / "many"
    for index in range(6):
        _write(root, f"note-{index}.md", f"Note number {index}.")
    clock = FakeClock()
    provider = FakeProvider(batch_size=1, clock=clock, seconds_per_call=1.0)
    catalog = _catalog(tmp_path, provider=provider, clock=clock)

    result = _step(catalog, [root], max_chunks=64, max_seconds=1.5)

    assert result.step["embedded"] == 2  # 0.0 -> 1.0 (in budget) -> 2.0 (expired)
    assert result.step["elapsed_ms"] == 2000
    assert result.more is True


def test_scan_resumes_across_steps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "many"
    for index in range(5):
        _write(root, f"note-{index}.md", f"Note number {index}.")
    monkeypatch.setattr(catalog_module, "MAX_SCAN_FILES_PER_ROOT_STEP", 2)
    catalog = _catalog(tmp_path)

    first = _step(catalog, [root])
    assert first.step["scanned"] == 2
    assert catalog.status()["roots"][0]["scan_complete"] is False

    result = _until_caught_up(catalog, [root])

    assert result.counts["indexed"] == 5
    assert catalog.status()["roots"][0]["scan_complete"] is True


def test_unchanged_sha_keeps_chunks_and_vectors(tmp_path: Path, notes: Path) -> None:
    provider = FakeProvider()
    catalog = _catalog(tmp_path, provider=provider)
    _until_caught_up(catalog, [notes])
    calls_before = len(provider.calls)
    cats = notes / "cats.md"
    os.utime(cats, ns=(cats.stat().st_atime_ns, cats.stat().st_mtime_ns + 5_000_000_000))

    result = _until_caught_up(catalog, [notes], rescan=True)

    assert len(provider.calls) == calls_before  # nothing re-embedded
    assert result.counts["indexed"] == 3

    cats.write_text("# Cats\n\nCats nap in the sun all afternoon.", encoding="utf-8")
    os.utime(cats, ns=(cats.stat().st_atime_ns, cats.stat().st_mtime_ns + 10_000_000_000))
    _until_caught_up(catalog, [notes], rescan=True)

    assert any("Cats nap in the sun" in text for text in provider.calls[-1])


def test_deleted_file_is_purged_only_after_a_complete_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "many"
    for index in range(5):
        _write(root, f"note-{index}.md", f"Note number {index}.")
    catalog = _catalog(tmp_path)
    _until_caught_up(catalog, [root])
    (root / "note-0.md").unlink()
    monkeypatch.setattr(catalog_module, "MAX_SCAN_FILES_PER_ROOT_STEP", 2)

    partial_scan = _step(catalog, [root], rescan=True)

    assert partial_scan.counts["documents"] == 5  # scan incomplete: nothing purged
    assert partial_scan.more is True

    result = _until_caught_up(catalog, [root])

    assert result.counts["documents"] == 4
    assert result.counts["chunks"] == result.counts["embedded"] == 4


def test_removed_root_is_purged(tmp_path: Path, notes: Path) -> None:
    other = tmp_path / "other"
    _write(other, "a.md", "Alpha.")
    _write(other, "b.md", "Beta.")
    catalog = _catalog(tmp_path)
    _until_caught_up(catalog, [notes, other])

    result = _step(catalog, [notes])

    assert result.step["purged"] == 2
    assert result.counts["roots"] == 1
    assert result.counts["documents"] == 3


def test_model_switch_drops_old_vectors_only_after_full_coverage(
    tmp_path: Path, notes: Path
) -> None:
    store = CatalogStore(tmp_path / "index" / "catalog.db")
    old = _catalog(tmp_path, store=store, model_key="model-a")
    _until_caught_up(old, [notes])
    new = _catalog(tmp_path, store=store, model_key="model-b")

    first = _step(new, [notes], max_chunks=1)

    status = new.status()
    assert first.more is True
    assert status["coverage"]["embedded"] == 1
    assert status["coverage"]["other_models"] == {"model-a": 3}
    assert len(new.search("cats", root_paths=[str(notes)], limit=5).hits) == 1

    _until_caught_up(new, [notes], max_chunks=1)

    assert new.status()["coverage"]["other_models"] == {}


def test_links_escaping_the_root_are_never_read(tmp_path: Path) -> None:
    root = tmp_path / "root"
    _write(root, "inside.md", "Inside note.")
    outside = tmp_path / "outside"
    _write(outside, "secret.md", "TOP SECRET outside content.")
    made_link = False
    try:
        os.symlink(outside / "secret.md", root / "linked-secret.md")
        made_link = True
    except (OSError, NotImplementedError):
        pass
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(outside), str(root / "junction"))
        made_link = True
    if not made_link:
        pytest.skip("the OS refused to create a symlink or junction")
    provider = FakeProvider()
    catalog = _catalog(tmp_path, provider=provider)

    result = _until_caught_up(catalog, [root])

    assert result.counts["documents"] == 1
    assert not any("TOP SECRET" in text for call in provider.calls for text in call)


def test_binary_and_oversize_files_are_skipped_with_reasons(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "root"
    _write(root, "ok.md", "Fine text.")
    (root / "blob.txt").write_bytes(b"\x00\x01\x02binary\x00data")
    _write(root, "huge.md", "x" * 200)
    monkeypatch.setattr(extract_module, "MAX_TEXT_FILE_BYTES", 100)
    catalog = _catalog(tmp_path)

    result = _until_caught_up(catalog, [root])

    assert result.counts["skipped"] == 2
    root_status = catalog.status()["roots"][0]
    assert root_status["skipped_reasons"] == {"binary": 1, "too_large": 1}
    assert root_status["path"] == os.path.realpath(root)


def test_status_shape_and_purge_all_resets_scan_state(tmp_path: Path, notes: Path) -> None:
    catalog = _catalog(tmp_path)
    _until_caught_up(catalog, [notes])

    status = catalog.status()
    assert status["available"] is True
    assert status["schema_version"] == store_module.SEMANTIC_CATALOG_SCHEMA_VERSION
    assert status["model_key"] == "model-a"
    assert set(status["counts"]) == {
        "roots", "documents", "indexed", "pending", "failed", "skipped", "chunks", "embedded",
    }
    assert status["roots"][0]["indexed"] == 3 and status["roots"][0]["scan_complete"] is True
    assert status["size_bytes"] > 0
    assert status["capacity"]["reached"] is False and status["capacity"]["code"] is None

    assert catalog.purge(None) == 3
    assert catalog.status()["counts"]["documents"] == 0

    rebuilt = _until_caught_up(catalog, [notes])
    assert rebuilt.counts["indexed"] == 3


def test_caps_stop_additions_and_are_reported(
    tmp_path: Path, notes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store_module, "MAX_CATALOG_DOCUMENTS", 2)
    catalog = _catalog(tmp_path)

    result = _until_caught_up(catalog, [notes])

    assert result.counts["documents"] == 2
    capacity = catalog.status()["capacity"]
    assert capacity["documents"] is True
    assert capacity["code"] == CMP_CATALOG_CAPACITY_REACHED


def test_chunk_cap_skips_documents_with_cap_reached(
    tmp_path: Path, notes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store_module, "MAX_CATALOG_CHUNKS", 1)
    catalog = _catalog(tmp_path)

    result = _until_caught_up(catalog, [notes])

    assert result.counts["chunks"] == 1
    assert result.counts["skipped"] == 2
    status = catalog.status()
    assert status["roots"][0]["skipped_reasons"] == {"cap_reached": 2}
    assert status["capacity"]["chunks"] is True


class _TickingClock:
    """Every read advances one second, so any budget expires at its first check."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        self.now += 1.0
        return self.now


def test_a_rescan_opens_every_root_even_when_the_first_uses_the_budget(tmp_path: Path) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    _write(root_a, "one.md", "alpha text")
    _write(root_b, "two.md", "beta text")
    store = CatalogStore(tmp_path / "index" / "catalog.db")
    _until_caught_up(_catalog(tmp_path, store=store), [root_a, root_b])
    assert all(row.scan_complete_at is not None for row in store.roots())

    hurried = _catalog(tmp_path, store=store, clock=_TickingClock())  # type: ignore[arg-type]
    _step(hurried, [root_a, root_b], rescan=True, max_seconds=0.5)
    by_path = {Path(row.path).name: row for row in store.roots()}
    assert by_path["b"].scan_complete_at is None, "b's cycle opened though a used the budget"
    for _ in range(3):
        _step(hurried, [root_a, root_b], rescan=False, max_seconds=0.5)
    assert all(row.scan_complete_at is not None for row in store.roots())


def test_a_slow_walk_over_seen_files_still_records_new_ones(tmp_path: Path) -> None:
    root = tmp_path / "notes"
    for index in range(5):
        _write(root, f"seen-{index}.md", f"old note {index}")
    store = CatalogStore(tmp_path / "index" / "catalog.db")
    _until_caught_up(_catalog(tmp_path, store=store), [root])
    _write(root, "zz-new.md", "a brand new note")
    store.begin_rescan(store.roots()[0].root_key)
    hurried = _catalog(tmp_path, store=store, clock=_TickingClock())  # type: ignore[arg-type]
    # Every budget check fails, yet each step records at least one file.
    for _ in range(10):
        _step(hurried, [root], max_seconds=0.5)
    assert store.roots()[0].scan_complete_at is not None


def test_a_seen_prefix_longer_than_the_visit_cap_still_completes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "notes"
    for index in range(6):
        _write(root, f"seen-{index}.md", f"old note {index}")
    store = CatalogStore(tmp_path / "index" / "catalog.db")
    _until_caught_up(_catalog(tmp_path, store=store), [root])
    _write(root, "zz-new.md", "a brand new note")
    store.begin_rescan(store.roots()[0].root_key)
    monkeypatch.setattr(catalog_module, "MAX_SCAN_VISITS_PER_ROOT_STEP", 2)
    catalog = _catalog(tmp_path, store=store)

    for _ in range(5):
        _step(catalog, [root])

    assert store.roots()[0].scan_complete_at is not None
    assert "zz-new.md" in store.document_stats(store.roots()[0].root_key)


def test_a_scan_walks_each_file_once_per_cycle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "many"
    for index in range(5):
        _write(root, f"note-{index}.md", f"Note number {index}.")
    walked: list[Path] = []
    real_walk = catalog_module.iter_supported_files

    def counting_walk(guard):  # type: ignore[no-untyped-def]
        for path in real_walk(guard):
            walked.append(path)
            yield path

    monkeypatch.setattr(catalog_module, "iter_supported_files", counting_walk)
    monkeypatch.setattr(catalog_module, "MAX_SCAN_FILES_PER_ROOT_STEP", 2)
    catalog = _catalog(tmp_path)

    _until_caught_up(catalog, [root])

    assert len(walked) == 5, "a later step re-walked files an earlier step already recorded"
    walked.clear()
    catalog.purge(None)
    _until_caught_up(catalog, [root])
    assert len(walked) == 5, "a purge must restart the walk from the top"


def test_a_folder_counts_as_done_only_once_its_chunks_are_embedded(
    tmp_path: Path, notes: Path
) -> None:
    provider = FakeProvider()
    catalog = _catalog(tmp_path, provider=provider)
    provider.fail_with = unavailable()
    result = _step(catalog, [notes])
    assert result.error is not None, "extracted, but the embedder is down"
    root = catalog.status()["roots"][0]
    assert root["indexed"] == 0 and root["pending"] == 3

    provider.fail_with = None
    _until_caught_up(catalog, [notes])
    root = catalog.status()["roots"][0]
    assert root["indexed"] == 3 and root["pending"] == 0


class _PickyProvider(FakeProvider):
    """Refuses any request that contains a poison passage or more than ``max_ok`` texts."""

    def __init__(self, *, max_ok: int = 16, poison: str = "") -> None:
        super().__init__()
        self.max_ok = max_ok
        self.poison = poison
        self.sizes: list[int] = []

    def embed_many(self, texts, *, timeout_seconds):  # type: ignore[no-untyped-def]
        self.sizes.append(len(texts))
        assert timeout_seconds >= catalog_module.EMBED_REQUEST_TIMEOUT_SECONDS
        if len(texts) > self.max_ok or (self.poison and any(self.poison in t for t in texts)):
            raise refused()
        return super().embed_many(texts, timeout_seconds=timeout_seconds)


def test_a_batch_the_embedder_cannot_finish_shrinks_until_it_can(tmp_path: Path) -> None:
    root = tmp_path / "notes"
    for index in range(12):
        _write(root, f"note-{index}.md", f"note number {index} about topic {index}")
    provider = _PickyProvider(max_ok=2)
    catalog = _catalog(tmp_path, provider=provider)
    result = _until_caught_up(catalog, [root])
    assert result.counts["embedded"] == 12
    assert max(provider.sizes[-3:]) <= 2, "it settled on a batch the embedder finishes"


def test_one_passage_the_embedder_always_refuses_fails_only_its_document(
    tmp_path: Path,
) -> None:
    root = tmp_path / "notes"
    _write(root, "a-good.md", "plain good note")
    _write(root, "b-bad.md", "POISON passage")
    _write(root, "c-good.md", "another good note")
    provider = _PickyProvider(poison="POISON")
    catalog = _catalog(tmp_path, provider=provider)
    result = _until_caught_up(catalog, [root])
    assert result.counts["embedded"] == 2
    assert result.counts["failed"] == 1
    root_status = catalog.status()["roots"][0]
    assert root_status["failed"] == 1 and root_status["pending"] == 0


def test_an_embedder_that_refuses_everything_stops_failing_documents(tmp_path: Path) -> None:
    root = tmp_path / "notes"
    for index in range(8):
        _write(root, f"note-{index}.md", f"note {index}")
    provider = _PickyProvider(poison="note")
    catalog = _catalog(tmp_path, provider=provider)
    errors = 0
    for _ in range(80):
        result = _step(catalog, [root])
        errors += result.error is not None
    assert result.counts["failed"] == catalog_module.MAX_CONSECUTIVE_POISONED
    assert errors > 0, "after a few failed documents the step reports the embedder error"


def test_cap_skipped_file_retries_only_after_scan_capacity_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store_module, "MAX_CATALOG_CHUNKS", 1)
    root = tmp_path / "notes"
    first = _write(root, "a.md", "Rockets burn fuel in orbit.")
    store = CatalogStore(tmp_path / "index" / "catalog.db")
    catalog = _catalog(tmp_path, store=store)
    try:
        _until_caught_up(catalog, [root])
        _write(root, "b.md", "Cats purr and chase mice.")
        initial = _until_caught_up(catalog, [root], rescan=True)
        assert initial.counts["indexed"] == initial.counts["skipped"] == 1
        assert store.count_skipped_for_cap() == 1
        assert catalog.status()["roots"][0]["skipped_reasons"] == {"cap_reached": 1}

        for _ in range(3):
            full = _until_caught_up(catalog, [root], rescan=True)
            assert full.counts["indexed"] == full.counts["skipped"] == 1
            assert full.step["extracted"] == 0
            assert store.count_skipped_for_cap() == 1
            assert store.roots()[0].scan_complete_at is not None

        first.unlink()
        purged = _until_caught_up(catalog, [root], rescan=True)
        assert purged.step["purged"] == 1 and purged.step["extracted"] == 0
        assert purged.counts["chunks"] == 0 and store.count_skipped_for_cap() == 1
        assert store.roots()[0].scan_complete_at is not None

        recovered = _until_caught_up(catalog, [root], rescan=True)
        assert recovered.counts["indexed"] == recovered.counts["embedded"] == 1
        assert recovered.counts["skipped"] == store.count_skipped_for_cap() == 0
        assert store.roots()[0].scan_complete_at is not None
        assert [hit.rel_path for hit in catalog.search("cats purr", root_paths=[str(root)]).hits] == [
            "b.md"
        ]
    finally:
        catalog.close()
