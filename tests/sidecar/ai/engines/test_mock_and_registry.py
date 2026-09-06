"""
Targeted coverage tests for sidecar/ai/engines/mock.py and a smoke test for
sidecar/ai/engines/provider_registry.py.

The goal is to hit every branch in MockEngine that the engine-suite tests miss.
No source files are modified. All fakes/stubs live here.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import pytest

from sidecar.ai.engines.mock import MockEngine
from sidecar.ai.engines.base import ModelModality
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.tools.models import GenerationResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _json_rf() -> ResponseFormat:
    return ResponseFormat(type="json_object")


def _text_rf() -> ResponseFormat:
    return ResponseFormat(type="text")


def _make_engine(
    enable_vision: bool = True,
    tool_call_responses: Optional[List[GenerationResult]] = None,
) -> MockEngine:
    return MockEngine(
        enable_vision=enable_vision,
        tool_call_responses=tool_call_responses,
    )


def _sys_msg(content: str) -> dict:
    return {"role": "system", "content": content}


def _user_msg(content: str) -> dict:
    return {"role": "user", "content": content}


def _tool_msg(content: str) -> dict:
    return {"role": "tool", "content": content}


class _FakeStore:
    """Minimal stand-in for the provider capability profile store."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def record_probe_result(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)


# ===========================================================================
# 1. supported_modalities (lines 41-46)
# ===========================================================================


class TestSupportedModalities:
    def test_all_modalities_by_default(self) -> None:
        e = _make_engine()
        mods = e.supported_modalities
        assert ModelModality.TEXT in mods
        assert ModelModality.VISION in mods

    def test_vision_disabled(self) -> None:
        e = _make_engine(enable_vision=False)
        mods = e.supported_modalities
        assert ModelModality.VISION not in mods


# ===========================================================================
# 2. supports_tool_calling (line 50)
# ===========================================================================


class TestSupportsToolCalling:
    def test_always_true(self) -> None:
        assert _make_engine().supports_tool_calling is True


# ===========================================================================
# 3. set_provider_capability_profile_store (line 53)
# ===========================================================================


class TestSetProviderCapabilityProfileStore:
    def test_store_is_set(self) -> None:
        e = _make_engine()
        store = _FakeStore()
        e.set_provider_capability_profile_store(store)
        assert e._provider_capability_profile_store is store

    def test_store_none_is_accepted(self) -> None:
        e = _make_engine()
        e.set_provider_capability_profile_store(None)
        assert e._provider_capability_profile_store is None


# ===========================================================================
# 4. load_model + _record_capability_probe_success (lines 66-83)
# ===========================================================================


class TestLoadModel:
    def test_load_model_sets_ready(self) -> None:
        e = _make_engine()
        e.load_model("some/model")
        assert e.model_name == "some/model"
        assert e._is_ready is True

    def test_load_model_with_store_records_probe(self) -> None:
        e = _make_engine()
        store = _FakeStore()
        e.set_provider_capability_profile_store(store)
        e.load_model("mock-model")
        assert len(store.calls) == 1
        call = store.calls[0]
        assert call["endpoint_id"] == "mock"
        assert call["model_id"] == "mock-model"
        assert call["probe_status"] == "ready"
        assert call["features"].chat_supported is True

    def test_load_model_without_store_does_not_raise(self) -> None:
        e = _make_engine()
        # No store set — should silently skip the recording branch.
        e.load_model("no-store-model")
        assert e._is_ready is True

    def test_load_model_store_exception_is_swallowed(self) -> None:
        """If the probe recording raises, load_model must not propagate."""
        e = _make_engine()
        broken_store = MagicMock()
        broken_store.record_probe_result.side_effect = RuntimeError("boom")
        e.set_provider_capability_profile_store(broken_store)
        # Must not raise.
        e.load_model("boom-model")
        assert e._is_ready is True


# ===========================================================================
# 5. generate — all branches (lines 96-147)
# ===========================================================================


class TestGenerate:
    def test_generate_no_messages_returns_balanced(self) -> None:
        e = _make_engine()
        result = e.generate("hello")
        assert "hello" in result
        assert "Mock sidecar response" in result

    def test_generate_with_messages_uses_last_content(self) -> None:
        e = _make_engine()
        messages = [_user_msg("what is 2+2?")]
        result = e.generate("ignored prompt", messages=messages)
        assert "what is 2+2?" in result

    def test_generate_history_hint_with_prior_messages(self) -> None:
        e = _make_engine()
        messages = [_user_msg("first"), _user_msg("second")]
        result = e.generate("p", messages=messages)
        assert "1 prior message" in result

    def test_generate_single_message_no_history_hint(self) -> None:
        e = _make_engine()
        messages = [_user_msg("solo")]
        result = e.generate("p", messages=messages)
        assert "prior message" not in result

    def test_generate_system_message_excluded_from_prior_count(self) -> None:
        e = _make_engine()
        messages = [_sys_msg("system stuff"), _user_msg("only user")]
        result = e.generate("p", messages=messages)
        # System message should not count toward prior messages
        assert "prior message" not in result

    def test_generate_with_system_kwarg_prepended(self) -> None:
        e = _make_engine()
        result = e.generate("hi", system="personality profile: concise")
        assert "Mock concise response" in result

    # --- personality profiles ---

    def test_generate_concise_profile(self) -> None:
        e = _make_engine()
        msgs = [_sys_msg("personality profile: concise"), _user_msg("tell me")]
        result = e.generate("p", messages=msgs)
        assert result.startswith("Mock concise response")

    def test_generate_creative_profile(self) -> None:
        e = _make_engine()
        msgs = [_sys_msg("personality profile: creative"), _user_msg("inspire")]
        result = e.generate("p", messages=msgs)
        assert "Mock creative response" in result
        assert "experiment" in result

    def test_generate_mentor_profile(self) -> None:
        e = _make_engine()
        msgs = [_sys_msg("personality profile: mentor"), _user_msg("guide me")]
        result = e.generate("p", messages=msgs)
        assert "Mock mentor response" in result
        assert "Step 1" in result

    def test_generate_active_profile_concise(self) -> None:
        e = _make_engine()
        msgs = [_sys_msg("active profile: concise"), _user_msg("hi")]
        result = e.generate("p", messages=msgs)
        assert result.startswith("Mock concise response")

    def test_generate_active_profile_creative(self) -> None:
        e = _make_engine()
        msgs = [_sys_msg("active profile: creative"), _user_msg("create")]
        result = e.generate("p", messages=msgs)
        assert "Mock creative response" in result

    def test_generate_active_profile_mentor(self) -> None:
        e = _make_engine()
        msgs = [_sys_msg("active profile: mentor"), _user_msg("mentor")]
        result = e.generate("p", messages=msgs)
        assert "Mock mentor response" in result

    # --- JSON response_format ---

    def test_generate_json_format_non_planner(self) -> None:
        e = _make_engine()
        result = e.generate("q", response_format=_json_rf())
        data = json.loads(result)
        assert "response" in data



# ===========================================================================
# 6. _is_interactive_planner_request (lines 151-159)
# ===========================================================================




class TestPersonalityFromMessages:
    def test_default_balanced(self) -> None:
        msgs = [_user_msg("hi")]
        assert MockEngine._personality_from_messages(msgs) == "balanced"

    def test_concise_personality_profile(self) -> None:
        msgs = [_sys_msg("personality profile: concise")]
        assert MockEngine._personality_from_messages(msgs) == "concise"

    def test_creative_personality_profile(self) -> None:
        msgs = [_sys_msg("personality profile: creative")]
        assert MockEngine._personality_from_messages(msgs) == "creative"

    def test_mentor_personality_profile(self) -> None:
        msgs = [_sys_msg("personality profile: mentor")]
        assert MockEngine._personality_from_messages(msgs) == "mentor"

    def test_active_concise(self) -> None:
        msgs = [_sys_msg("active profile: concise")]
        assert MockEngine._personality_from_messages(msgs) == "concise"

    def test_active_creative(self) -> None:
        msgs = [_sys_msg("active profile: creative")]
        assert MockEngine._personality_from_messages(msgs) == "creative"

    def test_active_mentor(self) -> None:
        msgs = [_sys_msg("active profile: mentor")]
        assert MockEngine._personality_from_messages(msgs) == "mentor"


# ===========================================================================
# 9. _compose_profiled_response (lines 194-214)
# ===========================================================================


class TestComposeProfiledResponse:
    def test_concise(self) -> None:
        result = MockEngine._compose_profiled_response("concise", "hi", "")
        assert result.startswith("Mock concise response")

    def test_concise_with_hint(self) -> None:
        result = MockEngine._compose_profiled_response("concise", "hi", " hint")
        assert "hint" in result

    def test_creative(self) -> None:
        result = MockEngine._compose_profiled_response("creative", "idea", "")
        assert "Mock creative response" in result

    def test_mentor(self) -> None:
        result = MockEngine._compose_profiled_response("mentor", "goal", "")
        assert "Step 1" in result
        assert "Step 2" in result
        assert "Step 3" in result

    def test_balanced(self) -> None:
        result = MockEngine._compose_profiled_response("balanced", "question", "")
        assert "Mock sidecar response" in result

    def test_unknown_profile_falls_back_to_balanced(self) -> None:
        result = MockEngine._compose_profiled_response("nonexistent", "msg", "")
        assert "Mock sidecar response" in result


# ===========================================================================
# 10. generate_with_tools (lines 228-265)
# ===========================================================================


class TestGenerateWithTools:
    def test_tool_message_returns_completion(self) -> None:
        e = _make_engine()
        msgs = [_tool_msg("file read ok")]
        result = e.generate_with_tools("", [], messages=msgs)
        assert isinstance(result, GenerationResult)
        assert "file read ok" in result.content
        assert result.finish_reason == "stop"

    def test_scripted_tool_call_responses_consumed_in_order(self) -> None:
        scripted = [
            GenerationResult(content="first", finish_reason="stop"),
            GenerationResult(content="second", finish_reason="stop"),
        ]
        e = _make_engine(tool_call_responses=scripted)
        # No user message → no /tool prefix → falls through to scripted list
        r1 = e.generate_with_tools("", [])
        r2 = e.generate_with_tools("", [])
        assert r1.content == "first"
        assert r2.content == "second"
        # After exhaustion, falls through to generate()
        r3 = e.generate_with_tools("hello", [])
        assert "Mock sidecar response" in r3.content

    def test_tool_command_read_dispatched(self) -> None:
        e = _make_engine()
        msgs = [_user_msg("/tool read /etc/hosts")]
        result = e.generate_with_tools("", [], messages=msgs)
        assert result.finish_reason == "tool_calls"
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].tool_id == "read_file"
        assert result.tool_calls[0].arguments["path"] == "/etc/hosts"

    def test_generate_with_tools_fallback_to_generate(self) -> None:
        e = _make_engine()
        msgs = [_user_msg("just talk to me")]
        result = e.generate_with_tools("", [], messages=msgs)
        assert result.finish_reason == "stop"
        assert "Mock sidecar response" in result.content

    def test_no_messages_falls_through_to_generate(self) -> None:
        e = _make_engine()
        result = e.generate_with_tools("hello there", [])
        assert "Mock sidecar response" in result.content


# ===========================================================================
# 11. _messages_with_system (lines 272-284)
# ===========================================================================


class TestMessagesWithSystem:
    def test_empty_messages_empty_system_returns_empty(self) -> None:
        result = MockEngine._messages_with_system([], "")
        assert result == []

    def test_system_kwarg_prepended_when_no_system_in_messages(self) -> None:
        msgs = [_user_msg("hello")]
        result = MockEngine._messages_with_system(msgs, "be helpful")
        assert result[0] == {"role": "system", "content": "be helpful"}
        assert result[1] == {"role": "user", "content": "hello"}

    def test_system_kwarg_not_duplicated_when_already_present(self) -> None:
        msgs = [_sys_msg("primary system"), _user_msg("hi")]
        result = MockEngine._messages_with_system(msgs, "primary system")
        # Exact duplicate of the primary prompt is not prepended twice.
        system_msgs = [m for m in result if m["role"] == "system"]
        assert len(system_msgs) == 1
        assert system_msgs[0]["content"] == "primary system"

    def test_system_kwarg_prepends_ahead_of_other_system_rows(self) -> None:
        # Mirrors the Ollama/vLLM builders: an overlay or compaction-summary
        # system row must not knock the primary prompt out of the request.
        msgs = [_sys_msg("## Compacted Conversation Summary\nstuff"), _user_msg("hi")]
        result = MockEngine._messages_with_system(msgs, "primary system")
        assert result[0] == {"role": "system", "content": "primary system"}
        assert result[1]["role"] == "system"
        assert result[2] == {"role": "user", "content": "hi"}

    def test_empty_role_message_skipped(self) -> None:
        msgs = [{"role": "", "content": "something"}, _user_msg("real")]
        result = MockEngine._messages_with_system(msgs, "")
        assert len(result) == 1
        assert result[0]["role"] == "user"

    def test_empty_content_message_skipped(self) -> None:
        msgs = [{"role": "user", "content": ""}, _user_msg("real")]
        result = MockEngine._messages_with_system(msgs, "")
        assert len(result) == 1

    def test_none_messages_handled(self) -> None:
        result = MockEngine._messages_with_system(None, "sys")
        assert result == [{"role": "system", "content": "sys"}]

    def test_whitespace_system_not_prepended(self) -> None:
        msgs = [_user_msg("hello")]
        result = MockEngine._messages_with_system(msgs, "   ")
        assert all(m["role"] != "system" for m in result)


# ===========================================================================
# 12. _mock_tool_call_result — all command branches (lines 287-406)
# ===========================================================================


class TestMockToolCallResult:
    def _call(self, text: str) -> "GenerationResult | None":
        e = _make_engine()
        return e._mock_tool_call_result(text)

    def test_non_tool_prefix_returns_none(self) -> None:
        assert self._call("hello world") is None
        assert self._call("") is None

    def test_empty_payload_returns_error(self) -> None:
        result = self._call("/tool ")
        assert result is not None
        assert "empty" in result.content.lower()

    def test_unparseable_payload_returns_error(self) -> None:
        # shlex fails on unmatched quotes
        result = self._call("/tool 'unclosed")
        assert result is not None
        assert "parsed" in result.content.lower()

    # --- read ---
    def test_read_command(self) -> None:
        result = self._call("/tool read /some/file.txt")
        assert result is not None
        assert result.finish_reason == "tool_calls"
        assert result.tool_calls[0].tool_id == "read_file"
        assert result.tool_calls[0].arguments == {"path": "/some/file.txt"}

    # --- list ---
    def test_list_command_with_path(self) -> None:
        result = self._call("/tool list /my/dir")
        assert result is not None
        assert result.tool_calls[0].tool_id == "list_dir"
        assert result.tool_calls[0].arguments == {"path": "/my/dir"}

    def test_list_command_no_path_defaults_to_dot(self) -> None:
        result = self._call("/tool list")
        assert result is not None
        assert result.tool_calls[0].tool_id == "list_dir"
        assert result.tool_calls[0].arguments == {"path": "."}

    # --- write ---
    def test_write_command(self) -> None:
        result = self._call("/tool write /out.txt:::hello world")
        assert result is not None
        assert result.tool_calls[0].tool_id == "write_file"
        args = result.tool_calls[0].arguments
        assert args["path"] == "/out.txt"
        assert args["content"] == "hello world"

    def test_write_command_missing_delimiter_falls_through(self) -> None:
        result = self._call("/tool write nodivider")
        # No ::: → falls to unrecognized
        assert result is not None
        assert "not recognized" in result.content

    # --- edit ---
    def test_edit_command(self) -> None:
        result = self._call("/tool edit myfile.py:::old text:::new text")
        assert result is not None
        assert result.tool_calls[0].tool_id == "edit_file"
        args = result.tool_calls[0].arguments
        assert args["file_path"] == "myfile.py"
        assert args["old_string"] == "old text"
        assert args["new_string"] == "new text"
        assert args["replace_all"] is False

    def test_edit_command_replace_all(self) -> None:
        result = self._call("/tool edit myfile.py:::old:::new:::all")
        assert result is not None
        assert result.tool_calls[0].arguments["replace_all"] is True
        assert result.tool_calls[0].arguments["new_string"] == "new"

    def test_edit_command_missing_delimiters_falls_through(self) -> None:
        result = self._call("/tool edit nodivider")
        assert result is not None
        assert "not recognized" in result.content

    # --- shell ---
    def test_shell_command(self) -> None:
        result = self._call("/tool shell ls -la")
        assert result is not None
        assert result.tool_calls[0].tool_id == "run_command"
        assert result.tool_calls[0].arguments["command"] == "ls -la"

    # --- git status ---
    def test_git_status(self) -> None:
        result = self._call("/tool git status")
        assert result is not None
        assert result.tool_calls[0].tool_id == "git_status"

    def test_git_status_with_cwd(self) -> None:
        result = self._call("/tool git status /my/repo")
        assert result is not None
        assert result.tool_calls[0].tool_id == "git_status"
        assert result.tool_calls[0].arguments["cwd"] == "/my/repo"

    # --- git log ---
    def test_git_log_no_args(self) -> None:
        result = self._call("/tool git log")
        assert result is not None
        assert result.tool_calls[0].tool_id == "git_log"

    def test_git_log_with_count(self) -> None:
        result = self._call("/tool git log 10")
        assert result is not None
        assert result.tool_calls[0].arguments["max_count"] == 10

    def test_git_log_with_count_and_cwd(self) -> None:
        result = self._call("/tool git log 5 /repo")
        assert result is not None
        args = result.tool_calls[0].arguments
        assert args["max_count"] == 5
        assert args["cwd"] == "/repo"

    def test_git_log_with_cwd_no_count(self) -> None:
        result = self._call("/tool git log /my/repo")
        assert result is not None
        assert result.tool_calls[0].arguments.get("cwd") == "/my/repo"

    # --- git diff ---
    def test_git_diff_no_args(self) -> None:
        result = self._call("/tool git diff")
        assert result is not None
        assert result.tool_calls[0].tool_id == "git_diff"

    def test_git_diff_staged(self) -> None:
        result = self._call("/tool git diff staged")
        assert result is not None
        assert result.tool_calls[0].arguments.get("staged") is True

    def test_git_diff_staged_with_ref(self) -> None:
        result = self._call("/tool git diff staged ref=HEAD~1")
        assert result is not None
        args = result.tool_calls[0].arguments
        assert args.get("staged") is True
        assert args.get("ref") == "HEAD~1"

    def test_git_diff_with_path(self) -> None:
        result = self._call("/tool git diff path=/some/file.py")
        assert result is not None
        assert result.tool_calls[0].arguments.get("path") == "/some/file.py"

    def test_git_diff_with_cwd_keyword(self) -> None:
        result = self._call("/tool git diff cwd=/repo")
        assert result is not None
        assert result.tool_calls[0].arguments.get("cwd") == "/repo"

    def test_git_diff_with_bare_cwd(self) -> None:
        result = self._call("/tool git diff /some/repo")
        assert result is not None
        assert result.tool_calls[0].arguments.get("cwd") == "/some/repo"

    def test_git_diff_multi_tokens_ref_and_path(self) -> None:
        result = self._call("/tool git diff ref=abc123 path=foo.py")
        assert result is not None
        args = result.tool_calls[0].arguments
        assert args.get("ref") == "abc123"
        assert args.get("path") == "foo.py"

    def test_git_diff_staged_then_ref_in_secondary_tokens(self) -> None:
        # "staged" consumed first, then remaining[0] is ref=…, remaining[1] is ref= again
        # to hit the for-loop ref= branch we need remaining to have 2+ items
        result = self._call("/tool git diff staged ref=HEAD~1 ref=HEAD~2")
        assert result is not None
        # The second ref= overwrites the first via the for-loop branch (line 390)
        assert result.tool_calls[0].arguments.get("ref") == "HEAD~2"

    def test_git_diff_staged_then_path_in_secondary_tokens(self) -> None:
        # remaining[0]=ref=a, remaining[1]=path=b → hits line 392 branch
        result = self._call("/tool git diff staged ref=HEAD path=somefile.py")
        assert result is not None
        args = result.tool_calls[0].arguments
        assert args.get("ref") == "HEAD"
        assert args.get("path") == "somefile.py"

    def test_git_diff_staged_then_cwd_in_secondary_tokens(self) -> None:
        # remaining[0]=ref=a, remaining[1]=cwd=/repo → hits line 393-394 branch
        result = self._call("/tool git diff staged ref=HEAD cwd=/my/repo")
        assert result is not None
        args = result.tool_calls[0].arguments
        assert args.get("cwd") == "/my/repo"

    # --- git show ---
    def test_git_show_no_ref(self) -> None:
        result = self._call("/tool git show")
        assert result is not None
        assert result.tool_calls[0].tool_id == "git_show"

    def test_git_show_with_ref(self) -> None:
        result = self._call("/tool git show abc123")
        assert result is not None
        assert result.tool_calls[0].arguments["ref"] == "abc123"

    def test_git_show_with_ref_and_cwd(self) -> None:
        result = self._call("/tool git show abc123 /repo")
        assert result is not None
        args = result.tool_calls[0].arguments
        assert args["ref"] == "abc123"
        assert args["cwd"] == "/repo"

    # --- unrecognized git subcommand ---
    def test_git_unknown_subcommand_falls_through(self) -> None:
        result = self._call("/tool git unknown-cmd")
        assert result is not None
        assert "not recognized" in result.content

    # --- completely unknown command ---
    def test_unknown_command(self) -> None:
        result = self._call("/tool frob foo bar")
        assert result is not None
        assert "not recognized" in result.content


# ===========================================================================
# 13. _tool_result (lines 410-412)
# ===========================================================================


class TestToolResult:
    def test_tool_result_returns_generation_result(self) -> None:
        result = MockEngine._tool_result("read_file", {"path": "/x"})
        assert isinstance(result, GenerationResult)
        assert result.finish_reason == "tool_calls"
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].tool_id == "read_file"

    def test_tool_result_call_id_is_deterministic(self) -> None:
        r1 = MockEngine._tool_result("list_dir", {"path": "."})
        r2 = MockEngine._tool_result("list_dir", {"path": "."})
        assert r1.tool_calls[0].call_id == r2.tool_calls[0].call_id


# ===========================================================================
# 14. _safe_split (lines 435-439)
# ===========================================================================


class TestSafeSplit:
    def test_normal_split(self) -> None:
        tokens = MockEngine._safe_split("read /etc/hosts")
        assert tokens == ["read", "/etc/hosts"]

    def test_quoted_token(self) -> None:
        tokens = MockEngine._safe_split('"my file.txt"')
        assert tokens == ["my file.txt"]

    def test_unmatched_quote_returns_empty(self) -> None:
        tokens = MockEngine._safe_split("'unclosed")
        assert tokens == []

    def test_empty_string(self) -> None:
        assert MockEngine._safe_split("") == []

    def test_whitespace_only(self) -> None:
        assert MockEngine._safe_split("   ") == []


# ===========================================================================
# 15. _strip_wrapping_quotes (lines 443-449)
# ===========================================================================


class TestStripWrappingQuotes:
    def test_double_quoted(self) -> None:
        assert MockEngine._strip_wrapping_quotes('"hello"') == "hello"

    def test_single_quoted(self) -> None:
        assert MockEngine._strip_wrapping_quotes("'hello'") == "hello"

    def test_no_quotes(self) -> None:
        assert MockEngine._strip_wrapping_quotes("hello") == "hello"

    def test_single_char_not_stripped(self) -> None:
        assert MockEngine._strip_wrapping_quotes('"') == '"'

    def test_mismatched_quotes_not_stripped(self) -> None:
        assert MockEngine._strip_wrapping_quotes("\"hello'") == "\"hello'"


# ===========================================================================
# 16. stream (lines 463-481)
# ===========================================================================


class TestStream:
    def test_stream_yields_words(self) -> None:
        import unittest.mock as mock_module

        e = _make_engine()
        # Patch time.sleep so the test doesn't actually sleep
        with mock_module.patch("sidecar.ai.engines.mock.time.sleep"):
            chunks = list(e.stream("hello world"))
        # Each word+space emitted separately
        joined = "".join(chunks).strip()
        assert "hello" in joined
        assert "world" in joined

    def test_stream_json_format_yields_single_chunk(self) -> None:
        import unittest.mock as mock_module

        e = _make_engine()
        with mock_module.patch("sidecar.ai.engines.mock.time.sleep"):
            chunks = list(e.stream("q", response_format=_json_rf()))
        assert len(chunks) == 1
        data = json.loads(chunks[0])
        assert "response" in data

    def test_stream_with_messages(self) -> None:
        import unittest.mock as mock_module

        e = _make_engine()
        msgs = [_user_msg("streaming test")]
        with mock_module.patch("sidecar.ai.engines.mock.time.sleep"):
            chunks = list(e.stream("p", messages=msgs))
        joined = "".join(chunks)
        assert "streaming test" in joined


# ===========================================================================
# 17. generate_with_vision (lines 490-492)
# ===========================================================================


class TestGenerateWithVision:
    def test_vision_returns_result(self) -> None:
        e = _make_engine()
        result = e.generate_with_vision("what do you see?", ["img1.jpg", "img2.jpg"])
        assert isinstance(result, GenerationResult)
        assert "2 image(s)" in result.content
        assert "what do you see?" in result.content

    def test_vision_empty_images(self) -> None:
        e = _make_engine()
        result = e.generate_with_vision("describe", [])
        assert "0 image(s)" in result.content


# ===========================================================================
# 19. unload_model (lines 507-508)
# ===========================================================================


class TestUnloadModel:
    def test_unload_resets_state(self) -> None:
        e = _make_engine()
        e.load_model("some-model")
        assert e._is_ready is True
        e.unload_model()
        assert e.model_name is None
        assert e._is_ready is False


# ===========================================================================
# 20. Smoke test — provider_registry.py exports
# ===========================================================================


class TestProviderRegistry:
    def test_all_exports_importable(self) -> None:
        from sidecar.ai.engines.provider_registry import (
            CodexCliEngine,
            OllamaEngine,
            OpenAICompatibleEngine,
            ReplayEngine,
            VLLMEngine,
        )

        for cls in (CodexCliEngine, OllamaEngine, OpenAICompatibleEngine, ReplayEngine, VLLMEngine):
            assert cls is not None

    def test_all_is_defined(self) -> None:
        import sidecar.ai.engines.provider_registry as reg

        assert hasattr(reg, "__all__")
        expected = {
            "CodexCliEngine",
            "OllamaEngine",
            "OpenAICompatibleEngine",
            "ReplayEngine",
            "ResponsesDescriptorEngine",
            "VLLMEngine",
        }
        assert set(reg.__all__) == expected
