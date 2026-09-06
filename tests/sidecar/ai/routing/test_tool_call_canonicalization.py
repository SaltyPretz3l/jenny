from sidecar.ai.routing.tool_call_canonicalization import canonicalize_tool_calls
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
