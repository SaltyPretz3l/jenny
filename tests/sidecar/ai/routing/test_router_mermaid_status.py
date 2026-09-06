from __future__ import annotations

from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.router import ChatRouter


class _StubEngine:
    def generate_with_tools(self, **kwargs: Any):  # noqa: ANN003
        del kwargs

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _StubMCPClient:
    def __init__(self, descriptors: list[MCPToolDescriptor]) -> None:
        self._descriptors = descriptors

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        return list(self._descriptors)

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        for descriptor in self._descriptors:
            if descriptor.name == tool_name:
                return descriptor
        return None


def _mermaid_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="mermaid_generate",
        description="Generate Mermaid",
        input_schema={"type": "object"},
        side_effecting=False,
        server_name="tools",
    )


def test_router_marks_mermaid_as_config_disabled_when_flag_is_off() -> None:
    router = ChatRouter(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_mermaid_enabled=False,
        ),
        engine=_StubEngine(),
        mcp_client=_StubMCPClient([_mermaid_descriptor()]),
        context_builder=ContextBuilder(None),
    )

    status = router.tools_status["mermaid_generate"]
    assert status["available"] is False
    assert status["reason"] == "config disabled"


def test_router_marks_mermaid_as_available_when_flag_is_on() -> None:
    router = ChatRouter(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_mermaid_enabled=True,
        ),
        engine=_StubEngine(),
        mcp_client=_StubMCPClient([_mermaid_descriptor()]),
        context_builder=ContextBuilder(None),
    )

    status = router.tools_status["mermaid_generate"]
    assert status["available"] is True
    assert status["reason"] is None
