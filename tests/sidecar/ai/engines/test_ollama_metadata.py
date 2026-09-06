from __future__ import annotations

import threading
from types import SimpleNamespace

from sidecar.ai.engines import ollama_metadata


def test_is_likely_thinking_model_qwen36_tag() -> None:
    assert ollama_metadata.is_likely_thinking_model("qwen3.6:35b-a3b") is True


def test_is_likely_thinking_model_qwen36_bare() -> None:
    assert ollama_metadata.is_likely_thinking_model("qwen36:35b") is True


def test_is_likely_thinking_model_qwen35_still_detected() -> None:
    assert ollama_metadata.is_likely_thinking_model("qwen3.5:9b") is True


def test_is_likely_thinking_model_thinking_keyword() -> None:
    assert ollama_metadata.is_likely_thinking_model("mystery-thinking-model") is True


def test_is_likely_thinking_model_negative_cases() -> None:
    assert ollama_metadata.is_likely_thinking_model("llama3.2:7b") is False
    assert ollama_metadata.is_likely_thinking_model("gemma3:4b") is False
    assert ollama_metadata.is_likely_thinking_model("") is False
    assert ollama_metadata.is_likely_thinking_model(None) is False  # type: ignore[arg-type]


def test_build_tools_payload_skips_deferred_placeholder_tools() -> None:
    payload = ollama_metadata.build_tools_payload(
        [
            {"name": "mcp__git__commit", "description": "Commit", "defer_loading": True},
            {
                "name": "tool_search",
                "description": "Search tools",
                "parameters": {"type": "object", "properties": {}},
            },
        ]
    )

    names = [item["function"]["name"] for item in payload]
    assert names == ["tool_search"]


def test_build_tools_payload_cached_invalidates_when_schema_or_description_changes() -> None:
    engine = SimpleNamespace(_cached_tools_key=None, _cached_tools_payload=None)
    first_tools = [
        {
            "name": "read_file",
            "description": "Read a file",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        }
    ]
    second_tools = [
        {
            "name": "read_file",
            "description": "Read a file with optional page ranges",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "pages": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["path"],
            },
        }
    ]

    first = ollama_metadata.build_tools_payload_cached(engine, first_tools)
    second = ollama_metadata.build_tools_payload_cached(engine, second_tools)

    assert second is not first
    assert "pages" in second[0]["function"]["parameters"]["properties"]
    assert second[0]["function"]["description"] == "Read a file with optional page ranges"


def test_build_tools_payload_cache_publishes_key_and_payload_as_one_state() -> None:
    key_barrier = threading.Barrier(2)
    second_payload_written = threading.Event()

    class _LegacyRaceEngine:
        def __setattr__(self, name: str, value: object) -> None:
            # Deterministically reproduces the old split-key/payload race. The
            # fixed implementation performs neither legacy attribute write.
            if name == "_cached_tools_key":
                object.__setattr__(self, name, value)
                key_barrier.wait(timeout=2.0)
                return
            if name == "_cached_tools_payload":
                tool_name = value[0]["function"]["name"]  # type: ignore[index]
                if tool_name == "tool_a":
                    assert second_payload_written.wait(timeout=2.0)
                object.__setattr__(self, name, value)
                if tool_name == "tool_b":
                    second_payload_written.set()
                return
            object.__setattr__(self, name, value)

    engine = _LegacyRaceEngine()
    tools_a = [{"name": "tool_a", "parameters": {}}]
    tools_b = [{"name": "tool_b", "parameters": {}}]
    threads = [
        threading.Thread(target=ollama_metadata.build_tools_payload_cached, args=(engine, tools_a)),
        threading.Thread(target=ollama_metadata.build_tools_payload_cached, args=(engine, tools_b)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3.0)
        assert not thread.is_alive()

    payload_b = ollama_metadata.build_tools_payload_cached(engine, tools_b)
    assert payload_b[0]["function"]["name"] == "tool_b"
    state = engine._cached_tools_state  # noqa: SLF001
    assert state[1][0]["function"]["name"] in state[0][0]


def test_refresh_tool_capability_uses_model_name_allowlist_for_list_caps(caplog) -> None:
    enabled, source = ollama_metadata.refresh_tool_capability(
        "qwen3.6:35b-a3b",
        {"capabilities": ["completion", "vision"]},
    )

    assert enabled is True
    assert source == "model_name_allowlist"
    assert "matched allowlist 'qwen3.6'" in caplog.text


def test_refresh_tool_capability_list_caps_without_allowlist_stays_disabled() -> None:
    enabled, source = ollama_metadata.refresh_tool_capability(
        "gemma3:4b",
        {"capabilities": ["completion", "vision"]},
    )

    assert enabled is False
    assert source == "capabilities"


def test_refresh_tool_capability_trusts_non_empty_dict_caps() -> None:
    enabled, source = ollama_metadata.refresh_tool_capability(
        "qwen3.6:35b-a3b",
        {"capabilities": {"tools": False, "vision": True}},
    )

    assert enabled is False
    assert source == "capabilities"


def test_refresh_tool_capability_allowlists_gpt_oss_list_caps(caplog) -> None:
    # The exact shape Ollama reported for the user's gpt-oss:20b weather turn:
    # a non-empty capability list that omits "tools".
    enabled, source = ollama_metadata.refresh_tool_capability(
        "gpt-oss:20b",
        {"capabilities": ["completion", "thinking"]},
    )

    assert enabled is True
    assert source == "model_name_allowlist"
    assert "matched allowlist 'gpt-oss'" in caplog.text


def test_refresh_tool_capability_allowlists_gpt_oss_dict_caps_when_tools_absent() -> None:
    # Catalog/normalized dict caps that omit the "tools" key entirely — an
    # omission, not an explicit denial, so the allowlist override applies.
    enabled, source = ollama_metadata.refresh_tool_capability(
        "gpt-oss:20b",
        {"capabilities": {"thinking": True}},
    )

    assert enabled is True
    assert source == "model_name_allowlist"


def test_refresh_tool_capability_dict_caps_explicit_tools_false_is_authoritative() -> None:
    # An explicit ``tools: False`` must stay disabled even for an allowlisted
    # family — a denial is not an omission.
    enabled, source = ollama_metadata.refresh_tool_capability(
        "gpt-oss:20b",
        {"capabilities": {"tools": False, "thinking": True}},
    )

    assert enabled is False
    assert source == "capabilities"


def test_refresh_tool_capability_allowlists_hf_namespaced_qwen_tag(caplog) -> None:
    # Registry-pulled tags carry an hf.co/<org>/ prefix; the bare family in the
    # final path segment must still match the allowlist.
    enabled, source = ollama_metadata.refresh_tool_capability(
        "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS",
        {"capabilities": ["completion", "vision"]},
    )

    assert enabled is True
    assert source == "model_name_allowlist"
    assert "matched allowlist 'qwen3.6'" in caplog.text


def test_detect_vision_hf_namespaced_qwen_vl_tag() -> None:
    # The vision name fallback must strip the hf.co/<org>/ namespace; without it
    # "hf.co/unsloth/qwen2.5-vl-...".startswith("qwen2.5-vl") is False and the tag
    # would only recover via the unreliable /api/show family fields.
    supported, source = ollama_metadata.detect_vision(
        "hf.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M", None
    )
    assert supported is True
    assert source == "model_name"


def test_detect_vision_without_info_reports_model_name_source() -> None:
    supported, source = ollama_metadata.detect_vision(
        "hf.co/unsloth/Llama-3.1-8B-Instruct-GGUF:Q4_K_M", None
    )
    assert supported is False
    assert source == "model_name"


def test_detect_vision_capabilities_without_vision_stays_unsupported() -> None:
    supported, source = ollama_metadata.detect_vision(
        "llama3.1:8b", {"capabilities": ["completion", "tools"]}
    )
    assert supported is False
    assert source == "unsupported"


def test_detect_vision_ignores_vision_in_registry_namespace() -> None:
    # Detection keys off the bare model family, not the org/namespace — a "vision"
    # substring in the path prefix must not promote a non-vision model.
    supported, source = ollama_metadata.detect_vision(
        "hf.co/vision-labs/Llama-3.1-8B-GGUF:Q4_K_M", None
    )
    assert supported is False
    assert source == "model_name"


def test_is_likely_thinking_model_hf_namespaced_qwen36_tag() -> None:
    assert (
        ollama_metadata.is_likely_thinking_model(
            "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS"
        )
        is True
    )


def test_detect_thinking_hf_namespaced_qwen36_via_model_name() -> None:
    # No /api/show payload: detection must land on the model-name fallback after
    # stripping the namespace, reporting "model_name" rather than a family field.
    supported, source = ollama_metadata.detect_thinking(
        "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS", None
    )
    assert supported is True
    assert source == "model_name"
