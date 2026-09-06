"""Tests for the VCR replay staleness guard (strict mode + unused_keys)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.sidecar.ai.context.vcr_adapter import VCREngine


def _write_fixture(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "cassette.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_matched_lookup_returns_recorded_payload_and_records_access(tmp_path: Path) -> None:
    messages = [{"role": "user", "content": "hello"}]
    key = VCREngine._hash_messages(messages)  # noqa: SLF001
    engine = VCREngine(_write_fixture(tmp_path, {key: {"content": "world"}}))

    assert engine.generate(prompt="", messages=messages) == "world"
    # The matched key was accessed, so nothing is reported stale.
    assert engine.unused_keys() == set()


def test_non_strict_falls_back_on_miss(tmp_path: Path) -> None:
    engine = VCREngine(_write_fixture(tmp_path, {"_fallback": {"content": "default"}}))

    result = engine.generate(prompt="", messages=[{"role": "user", "content": "unmatched"}])

    assert result == "default"


def test_strict_raises_on_miss_instead_of_silent_fallback(tmp_path: Path) -> None:
    engine = VCREngine(
        _write_fixture(tmp_path, {"_fallback": {"content": "default"}}),
        strict=True,
    )

    with pytest.raises(KeyError, match="stale"):
        engine.generate(prompt="", messages=[{"role": "user", "content": "unmatched"}])


def test_unused_keys_flags_stale_recorded_entries(tmp_path: Path) -> None:
    used = [{"role": "user", "content": "used"}]
    used_key = VCREngine._hash_messages(used)  # noqa: SLF001
    engine = VCREngine(
        _write_fixture(
            tmp_path,
            {
                used_key: {"content": "ok"},
                "deadbeefdeadbeef": {"content": "stale"},
                "_fallback": {"content": "default"},
            },
        )
    )

    engine.generate(prompt="", messages=used)

    # The never-matched recorded key is reported; _fallback is excluded.
    assert engine.unused_keys() == {"deadbeefdeadbeef"}
