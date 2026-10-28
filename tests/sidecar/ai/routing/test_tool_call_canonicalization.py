from sidecar.ai.routing import tool_call_canonicalization
from sidecar.ai.routing.tool_call_canonicalization import (
    WEB_SEARCH_QUERY_FROM_PROMPT,
    canonicalize_tool_call_arguments,
    canonicalize_tool_calls,
    repair_web_search_query_arguments,
)
from sidecar.ai.tools.models import ToolCallRequest


def test_tool_name_alias_uses_canonical_id_for_idless_call() -> None:
    canonical_calls, aliases, _coalesced = canonicalize_tool_calls(
        (
            ToolCallRequest(
                tool_id="list_files",
                arguments={"path": "."},
                call_id="",
            ),
        )
    )

    tool_name_alias = next(alias for alias in aliases if alias.get("from") == "list_files")
    assert canonical_calls[0].call_id == "call_1"
    assert tool_name_alias["call_id"] == canonical_calls[0].call_id


def test_canonicalization_strips_forged_plan_artifact_capability() -> None:
    canonical_calls, _aliases, _coalesced = canonicalize_tool_calls(
        (
            ToolCallRequest(
                tool_id="create_artifact",
                arguments={
                    "artifact_kind": "script",
                    "_jenny_plan_artifact_write": True,
                },
                call_id="forged-capability",
            ),
        )
    )

    assert "_jenny_plan_artifact_write" not in canonical_calls[0].arguments


def test_argument_canonicalization_keeps_the_stripped_capability_out() -> None:
    canonical_calls, _aliases, _coalesced = canonicalize_tool_calls(
        (
            ToolCallRequest(
                tool_id="write_file",
                arguments={"file_path": "a.txt", "_jenny_plan_artifact_write": True},
                call_id="forged",
            ),
        )
    )

    (call,), _argument_aliases, conflicts = canonicalize_tool_call_arguments(canonical_calls)

    assert conflicts == ()
    assert "_jenny_plan_artifact_write" not in call.arguments
    assert call.arguments["path"] == "a.txt"


def test_empty_web_search_query_takes_the_prompt_first_line_capped_and_tagged() -> None:
    prompt = "  \n" + "q" * 300 + "\nSecond line with details."
    empty = ToolCallRequest(tool_id="web_search", arguments={}, call_id="call_search")
    filled = ToolCallRequest(
        tool_id="web_search", arguments={"query": "kept"}, call_id="call_kept"
    )

    (repaired, kept), repairs = repair_web_search_query_arguments(
        (empty, filled), latest_user_content=prompt
    )

    assert repaired.arguments == {"query": "q" * 200}
    assert repaired.argument_repairs == (WEB_SEARCH_QUERY_FROM_PROMPT,)
    assert kept is filled
    assert repairs == [{"call_id": "call_search", "tool": "web_search", "field": "query"}]


def test_blank_prompt_leaves_web_search_untouched() -> None:
    call = ToolCallRequest(tool_id="web_search", arguments={}, call_id="call_search")

    assert repair_web_search_query_arguments((call,), latest_user_content=" \n ") == (
        (call,),
        [],
    )


def test_public_names_are_exported() -> None:
    exported = set(tool_call_canonicalization.__all__)

    assert {"canonical_model_tool_id", "canonicalize_generation_result"} <= exported
    assert all(hasattr(tool_call_canonicalization, name) for name in exported)
