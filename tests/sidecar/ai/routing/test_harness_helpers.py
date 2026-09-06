from __future__ import annotations

from sidecar.ai.routing.harness_helpers import MAX_RESPONSE_CHARS


def test_shared_tool_response_bound_is_stable() -> None:
    assert MAX_RESPONSE_CHARS == 16_000
