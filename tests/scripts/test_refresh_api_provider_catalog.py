from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.release.refresh_api_provider_catalog import build_snapshot, main


def _source() -> dict:
    return {
        "openrouter": {
            "models": {
                "openai/gpt-6-luna": {
                    "modalities": {"input": ["text", "image"], "output": ["text"]},
                    "limit": {"context": 1_050_000, "output": 128_000},
                    "tool_call": True,
                    "reasoning": True,
                    "cost": {"input": 0.1, "output": 0.5, "cache_read": 0.01},
                    "description": "copied fields stop here",
                },
                "image/only": {"modalities": {"output": ["image"]}, "limit": {"context": 10}},
                "bad id with spaces": {
                    "modalities": {"output": ["text"]},
                    "limit": {"context": 10},
                },
                "no/context": {"modalities": {"output": ["text"]}, "limit": {"context": 0}},
                "huge/output": {
                    "modalities": {"output": ["text"]},
                    "limit": {"context": 1000, "output": 5000},
                    "cost": {"input": float("nan"), "output": 1},
                },
            }
        },
        "unknown-provider": {"models": {"x": {}}},
    }


def test_snapshot_keeps_only_closed_fields_for_preset_providers() -> None:
    snapshot = build_snapshot(_source(), generated_at="2026-10-25")
    rows = snapshot["providers"]["openrouter"]
    assert [row["id"] for row in rows] == ["huge/output", "openai/gpt-6-luna"]
    luna = rows[1]
    assert luna == {
        "id": "openai/gpt-6-luna",
        "context_length": 1_050_000,
        "max_output_tokens": 128_000,
        "tools": True,
        "vision": True,
        "reasoning": True,
        "cost_per_mtok_usd": {"input": 0.1, "output": 0.5, "cache_read": 0.01},
    }
    huge = rows[0]
    assert huge["max_output_tokens"] == huge["context_length"]
    assert "cost_per_mtok_usd" not in huge
    assert "unknown-provider" not in snapshot["providers"]
    assert snapshot["providers"]["groq"] == []


def test_snapshot_refuses_a_non_object_source() -> None:
    with pytest.raises(ValueError):
        build_snapshot([], generated_at="2026-10-25")


def test_main_writes_lf_json(tmp_path: Path) -> None:
    source = tmp_path / "api.json"
    source.write_text(json.dumps(_source()), encoding="utf-8")
    out = tmp_path / "catalog.json"
    assert main([str(source), "--out", str(out)]) == 0
    raw = out.read_bytes()
    assert b"\r\n" not in raw
    assert json.loads(raw)["schema_version"] == 1
