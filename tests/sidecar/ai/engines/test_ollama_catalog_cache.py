"""Idempotence contract for the derived Ollama catalog cache.

F18a: catalog discovery runs on a renderer poll, and every pass unconditionally
rewrote this file -- an atomic replace (temp write + fsync + rename) per tick
for a payload that had not changed. At the 15s poll interval that is up to 240
pointless file replaces an hour against the user's state directory. Only a
genuine catalog change (or an entry that has aged out) may earn a write.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.engines import ollama_catalog_cache as cache_module
from sidecar.ai.engines.ollama_catalog_cache import (
    SCHEMA_VERSION,
    load_ollama_catalog_cache,
    write_ollama_catalog_cache,
)

BASE_URL = "http://127.0.0.1:11434"
DAEMON_VERSION = "0.5.7"
MODELS: list[Any] = [
    {"id": "llama3:8b", "capabilities": {"vision": False, "thinking": True}},
    {"id": "qwen3:14b", "template_family": "qwen"},
]


@pytest.fixture
def counted_writes(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    calls: list[Path] = []
    real = cache_module.write_json_atomic

    def _counting(path: Path, payload: dict[str, Any]) -> bool:
        calls.append(path)
        return real(path, payload)

    monkeypatch.setattr(cache_module, "write_json_atomic", _counting)
    return calls


def _write(
    cache_path: Path,
    models: list[Any],
    *,
    base_url: str = BASE_URL,
    daemon_version: str | None = DAEMON_VERSION,
):
    return write_ollama_catalog_cache(
        cache_path=cache_path,
        base_url=base_url,
        daemon_version=daemon_version,
        models=models,
    )


def test_repeat_write_of_an_unchanged_catalog_does_not_touch_the_file(
    tmp_path: Path,
    counted_writes: list[Path],
) -> None:
    cache_path = tmp_path / "ollama-catalog.json"

    first = _write(cache_path, MODELS)
    assert first is not None
    assert len(counted_writes) == 1

    # Simulate the poller: eight more discovery passes with the same catalog.
    for _ in range(8):
        repeat = _write(cache_path, MODELS)
        assert repeat is not None
        # The returned hit still describes the live cache entry.
        assert repeat.models == first.models
        assert repeat.cached_at == first.cached_at
        assert repeat.expires_at == first.expires_at
        assert repeat.daemon_version == DAEMON_VERSION

    assert len(counted_writes) == 1, "an unchanged catalog must not be rewritten"


def test_a_changed_catalog_still_writes(tmp_path: Path, counted_writes: list[Path]) -> None:
    cache_path = tmp_path / "ollama-catalog.json"

    _write(cache_path, MODELS)
    assert len(counted_writes) == 1

    changed = _write(cache_path, [*MODELS, {"id": "gemma3:12b"}])
    assert changed is not None
    assert len(counted_writes) == 2
    assert [entry["id"] for entry in changed.models][-1] == "gemma3:12b"

    hit = load_ollama_catalog_cache(
        cache_path=cache_path, base_url=BASE_URL, daemon_version=DAEMON_VERSION
    )
    assert hit is not None
    assert len(hit.models) == 3

    # A model REMOVED from the daemon is also a change.
    _write(cache_path, MODELS[:1])
    assert len(counted_writes) == 3


def test_a_different_base_url_or_daemon_version_is_a_separate_entry(
    tmp_path: Path,
    counted_writes: list[Path],
) -> None:
    cache_path = tmp_path / "ollama-catalog.json"

    _write(cache_path, MODELS)
    _write(cache_path, MODELS, base_url="http://127.0.0.1:11435")
    _write(cache_path, MODELS, daemon_version="0.6.0")
    assert len(counted_writes) == 3

    # ...and each of those is then itself idempotent.
    _write(cache_path, MODELS)
    _write(cache_path, MODELS, base_url="http://127.0.0.1:11435")
    _write(cache_path, MODELS, daemon_version="0.6.0")
    assert len(counted_writes) == 3


def test_an_expired_entry_is_rewritten_even_when_the_models_match(
    tmp_path: Path,
    counted_writes: list[Path],
) -> None:
    cache_path = tmp_path / "ollama-catalog.json"
    stale = datetime.now(timezone.utc) - timedelta(days=2)
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "updated_at": _iso(stale),
                "catalogs": [
                    {
                        "base_url": BASE_URL,
                        "daemon_version": DAEMON_VERSION,
                        "models": MODELS,
                        "cached_at": _iso(stale),
                        "expires_at": _iso(stale + timedelta(hours=1)),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    refreshed = _write(cache_path, MODELS)

    assert refreshed is not None
    assert len(counted_writes) == 1, "an aged-out entry must be refreshed"
    assert refreshed.expires_at > _iso(datetime.now(timezone.utc))


def test_on_disk_schema_version_stays_at_one(tmp_path: Path) -> None:
    cache_path = tmp_path / "ollama-catalog.json"
    _write(cache_path, MODELS)
    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert SCHEMA_VERSION == 1


def test_parameter_size_quantization_and_digest_round_trip(tmp_path: Path) -> None:
    cache_path = tmp_path / "ollama-catalog.json"
    models: list[Any] = [
        {
            "id": "batiai/gemma4-12b:q6",
            "size": 9_800_000_000,
            "parameter_size": "12.0B",
            "quantization_level": "Q6_K",
            "digest": "sha256:" + "a" * 64,
        }
    ]
    _write(cache_path, models)

    hit = load_ollama_catalog_cache(cache_path=cache_path, base_url=BASE_URL, daemon_version=DAEMON_VERSION)

    assert hit is not None
    assert hit.models == models


def test_parameter_size_quantization_and_digest_are_bounded_on_write(tmp_path: Path) -> None:
    cache_path = tmp_path / "ollama-catalog.json"
    models: list[Any] = [
        {
            "id": "custom:tag",
            "parameter_size": "p" * 100,
            "quantization_level": "q" * 100,
            "digest": "d" * 200,
        }
    ]
    _write(cache_path, models)

    hit = load_ollama_catalog_cache(cache_path=cache_path, base_url=BASE_URL, daemon_version=DAEMON_VERSION)

    assert hit is not None
    entry = hit.models[0]
    assert entry["parameter_size"] == "p" * 32
    assert entry["quantization_level"] == "q" * 32
    assert entry["digest"] == "d" * 128


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
