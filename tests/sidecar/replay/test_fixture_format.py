"""Meta-tests for the replay-fixture loader and schema validator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tests.sidecar.replay.fixture_format import (
    ALLOWED_FIXTURE_FAMILIES,
    ALLOWED_PROVIDERS,
    ALLOWED_TARGET_PHASES,
    ALLOWED_TURN_EVENT_KINDS,
    SCHEMA_VERSION,
    Fixture,
    FixtureValidationError,
    build_engine_event,
    build_generation_result,
    build_loop_event,
    discover_fixtures,
    fixtures_root,
    load_fixture,
)


def _valid_fixture_doc() -> dict[str, Any]:
    """Return a minimal but completely valid fixture document for tweaking."""
    return {
        "schema_version": SCHEMA_VERSION,
        "metadata": {
            "fixture_family": "native_tool_schema_stream",
            "provider": "ollama",
            "model": "qwen2.5-coder:14b",
            "description": "Minimal happy-path fixture used by loader meta-tests.",
            "target_phase": 3,
        },
        "raw_chunks": [{"message": {"role": "assistant", "content": "Hi."}, "done": True}],
        "expected_engine_events": [{"_class": "StreamingEvent", "kind": "content", "text": "Hi."}],
        "expected_loop_events": [{"_class": "TokenDeltaEvent", "delta": "Hi.", "token_index": 0}],
        "expected_notifications": [
            {"method": "chat.token", "params": {"delta": "Hi.", "role": "assistant", "sequence": 0}}
        ],
        "expected_turn_events": [
            {
                "kind": "assistant_text_segment",
                "tool_call_id": None,
                "payload": {"text": "Hi."},
            }
        ],
        "expected_generation_result": {
            "content": "Hi.",
            "thinking_text": "",
            "tool_calls": [],
            "finish_reason": "stop",
        },
    }


def _write(tmp_path: Path, document: Any, name: str = "fixture.json") -> Path:
    target = tmp_path / name
    target.write_text(json.dumps(document), encoding="utf-8")
    return target


def test_load_fixture_happy_path(tmp_path: Path) -> None:
    path = _write(tmp_path, _valid_fixture_doc())
    fixture = load_fixture(path)
    assert isinstance(fixture, Fixture)
    assert fixture.schema_version == SCHEMA_VERSION
    assert fixture.metadata.fixture_family == "native_tool_schema_stream"
    assert fixture.metadata.target_phase == 3
    assert fixture.path == path


def test_load_fixture_rejects_wrong_schema_version(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["schema_version"] = 2
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="schema_version"):
        load_fixture(path)


def test_load_fixture_rejects_missing_top_level_key(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    del document["raw_chunks"]
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="missing required top-level keys"):
        load_fixture(path)


def test_load_fixture_rejects_unknown_fixture_family(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["metadata"]["fixture_family"] = "totally_invented_family"
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="ALLOWED_FIXTURE_FAMILIES"):
        load_fixture(path)


def test_load_fixture_rejects_unknown_provider(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["metadata"]["provider"] = "anthropic"
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="ALLOWED_PROVIDERS"):
        load_fixture(path)


def test_load_fixture_rejects_unknown_target_phase(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["metadata"]["target_phase"] = 1
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="target_phase"):
        load_fixture(path)


def test_load_fixture_rejects_disallowed_notification_method(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["expected_notifications"] = [{"method": "chat.reasoning", "params": {"delta": "x"}}]
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="ALLOWED_NOTIFICATION_METHODS"):
        load_fixture(path)


def test_load_fixture_rejects_disallowed_turn_event_kind(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["expected_turn_events"] = [
        {"kind": "thinking_segment", "tool_call_id": None, "payload": {}}
    ]
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="16 valid persisted kinds"):
        load_fixture(path)


def test_load_fixture_rejects_unknown_engine_event_class(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["expected_engine_events"] = [
        {"_class": "ImaginaryEvent", "kind": "content", "text": ""}
    ]
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="ENGINE_EVENT_CLASS_REGISTRY"):
        load_fixture(path)


def test_load_fixture_rejects_unknown_loop_event_class(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["expected_loop_events"] = [{"_class": "MysteryEvent"}]
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="LOOP_EVENT_CLASS_REGISTRY"):
        load_fixture(path)


def test_load_fixture_rejects_invalid_json(tmp_path: Path) -> None:
    path = tmp_path / "broken.json"
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(FixtureValidationError, match="not valid JSON"):
        load_fixture(path)


def test_load_fixture_rejects_top_level_array(tmp_path: Path) -> None:
    path = tmp_path / "array.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(FixtureValidationError, match="JSON object"):
        load_fixture(path)


def test_load_fixture_rejects_tool_call_missing_required_keys(tmp_path: Path) -> None:
    document = _valid_fixture_doc()
    document["expected_generation_result"]["tool_calls"] = [{"tool_id": "x"}]
    path = _write(tmp_path, document)
    with pytest.raises(FixtureValidationError, match="tool_id and arguments"):
        load_fixture(path)


def test_build_engine_event_constructs_streaming_event() -> None:
    event = build_engine_event({"_class": "StreamingEvent", "kind": "content", "text": "hello"})
    assert event.kind == "content"
    assert event.text == "hello"


def test_build_loop_event_constructs_token_delta() -> None:
    event = build_loop_event({"_class": "TokenDeltaEvent", "delta": "x", "token_index": 7})
    assert event.delta == "x"
    assert event.token_index == 7


def test_build_generation_result_constructs_tool_calls() -> None:
    result = build_generation_result(
        {
            "content": "ok",
            "tool_calls": [
                {
                    "tool_id": "read_file",
                    "arguments": {"path": "x"},
                    "call_id": "call_1",
                }
            ],
            "finish_reason": "tool_calls",
        }
    )
    assert result.content == "ok"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "read_file"
    assert result.tool_calls[0].call_id == "call_1"


def test_discover_fixtures_returns_sorted_list_for_existing_dir(tmp_path: Path) -> None:
    (tmp_path / "b.json").write_text("{}", encoding="utf-8")
    (tmp_path / "a.json").write_text("{}", encoding="utf-8")
    paths = discover_fixtures(tmp_path)
    assert [p.name for p in paths] == ["a.json", "b.json"]


def test_discover_fixtures_returns_empty_for_missing_dir(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    assert discover_fixtures(missing) == []


def test_allowed_constants_have_expected_cardinality() -> None:
    # Phase 12B widened ALLOWED_FIXTURE_FAMILIES (+1 conversation_scenario)
    # and ALLOWED_TARGET_PHASES (+1 target_phase=12). Phase 12D widens
    # ALLOWED_TURN_EVENT_KINDS from 16 to 18 (plan_object + plan_document).
    # The provider set is unchanged.
    assert len(ALLOWED_FIXTURE_FAMILIES) == 10
    assert len(ALLOWED_PROVIDERS) == 3
    assert len(ALLOWED_TARGET_PHASES) == 6
    assert len(ALLOWED_TURN_EVENT_KINDS) == 18


def test_fixtures_root_resolves_under_repo_tests_dir() -> None:
    root = fixtures_root()
    assert root.parts[-3:] == ("tests", "fixtures", "replays")
