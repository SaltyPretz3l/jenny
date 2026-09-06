import pytest

from sidecar.ai.routing import provider_stream_normalizer
from sidecar.ai.routing.provider_stream_normalizer import (
    NORMALIZED_KIND_FAILED,
    NORMALIZED_KIND_TOOL_CALL_COMPLETED,
    ProviderStreamNormalizer,
)


@pytest.mark.parametrize("limit_kind", ["count", "aggregate_bytes"])
def test_rejected_ollama_tool_call_batch_emits_no_completed_calls(
    monkeypatch: pytest.MonkeyPatch,
    limit_kind: str,
) -> None:
    tool_calls = [
        {"function": {"name": "one", "arguments": "{}"}},
        {"function": {"name": "two", "arguments": "{}"}},
        {"function": {"name": "three", "arguments": "{}"}},
    ]
    if limit_kind == "count":
        monkeypatch.setattr(provider_stream_normalizer, "MAX_PROVIDER_TOOL_CALLS", 2)
    else:
        monkeypatch.setattr(
            provider_stream_normalizer,
            "MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES",
            3,
        )
        tool_calls = tool_calls[:2]

    events = list(
        ProviderStreamNormalizer(provider="ollama").process_chunk(
            {"message": {"tool_calls": tool_calls}}
        )
    )

    assert sum(event.kind == NORMALIZED_KIND_FAILED for event in events) == 1
    assert all(event.kind != NORMALIZED_KIND_TOOL_CALL_COMPLETED for event in events)
