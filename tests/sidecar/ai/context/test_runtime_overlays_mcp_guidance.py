"""Row 53 S5: the static ``mcp:rea`` guidance rides the request only while rea is connected.

The section is folded into the ``## Session Environment`` runtime message, after
its facts, so it inherits that message's registered (self-replacing) heading,
its leading position and the runtime-overlay token accounting.
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sidecar.ai.config_models import MCPServerConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.runtime_message_markers import SESSION_ENVIRONMENT_HEADING
from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    append_session_environment_runtime_system_message,
)
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.mcp.presets import preset_guidance
from sidecar.ai.mcp.tool_namespace import namespace_mcp_tool_name
from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.catalog import MANAGED_SIDECAR_SURFACE, normalize_runtime_descriptor
from tests.sidecar.ai.tools.test_assembly import MODE_ASSIST, _descriptor

_HEADING = "# Connected tool guidance: rea"


def _log_context() -> RuntimeOverlayLogContext:
    return RuntimeOverlayLogContext(
        logger=logging.getLogger("test.mcp-guidance"),
        component="ai.router",
        event="ai.router.session_environment_overlay_failed",
        request_id="req-1",
        session_id=None,
    )


def _row(name: str) -> MCPServerConfig:
    return MCPServerConfig(name=name, transport="stdio", command="rea")


def _config(*rows: MCPServerConfig, **overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = {
        "session_environment_overlay_enabled": True,
        "tools_python_runtime_enabled": False,
        "mcp_servers": rows,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _prompt_schemas(*server_names: str) -> list[dict[str, Any]]:
    descriptors = [_descriptor("read_file", tool_family="filesystem")]
    for server_name in server_names:
        descriptors.append(
            normalize_runtime_descriptor(
                MCPToolDescriptor(
                    name=namespace_mcp_tool_name(server_name, "binary_session"),
                    description="Report the session.",
                    input_schema={"type": "object"},
                    side_effecting=True,
                    server_name=server_name,
                )
            )
        )
    contract = assemble_tool_contract(
        tuple(descriptors),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=False,
            workspace_root_present=True,
        ),
    )
    assert {
        entry.descriptor.connection_id for entry in contract.entries if entry.available
    } == {None, *(f"mcp:{name}" for name in server_names)}
    return list(contract.prompt_schemas)


def _render(tmp_path: Path, config: Any, schemas: list[dict[str, Any]]) -> list[str]:
    messages: list[str] = []
    append_session_environment_runtime_system_message(
        messages,
        config=config,
        context_builder=ContextBuilder(tmp_path),
        tool_schemas=schemas,
        session_id=None,
        log_context=_log_context(),
    )
    return messages


def test_guidance_follows_the_session_environment_facts_when_rea_is_in_the_contract(
    tmp_path: Path,
) -> None:
    messages = _render(tmp_path, _config(_row("rea")), _prompt_schemas("rea"))

    assert len(messages) == 1
    message = messages[0]
    section = f"{_HEADING}\n{preset_guidance('rea')}"
    assert message.startswith(SESSION_ENVIRONMENT_HEADING)
    assert message.endswith(f"\n\n{section}")
    assert message.count(_HEADING) == 1
    assert message.index("workspace_root:") < message.index(_HEADING)
    assert len(section) <= 1_800


def test_guidance_is_absent_without_a_rea_tool_in_the_contract(tmp_path: Path) -> None:
    messages = _render(tmp_path, _config(_row("rea")), _prompt_schemas())

    assert len(messages) == 1
    assert _HEADING not in messages[0]
    assert "mcp__rea__" not in messages[0]


def test_a_server_named_otherwise_gets_no_guidance(tmp_path: Path) -> None:
    messages = _render(tmp_path, _config(_row("rea2")), _prompt_schemas("rea2"))

    assert "Connected tool guidance" not in messages[0]


def test_guidance_survives_the_session_environment_kill_switch(tmp_path: Path) -> None:
    config = _config(_row("rea"), session_environment_overlay_enabled=False)

    messages = _render(tmp_path, config, _prompt_schemas("rea"))

    assert messages == [f"{SESSION_ENVIRONMENT_HEADING}\n{_HEADING}\n{preset_guidance('rea')}"]
    assert _render(tmp_path, config, _prompt_schemas()) == []


def test_reinserting_the_runtime_overlays_keeps_one_copy(tmp_path: Path) -> None:
    builder = ContextBuilder(tmp_path)
    runtime = _render(tmp_path, _config(_row("rea")), _prompt_schemas("rea"))
    working = builder.insert_runtime_system_messages(
        [{"role": "system", "content": "base"}, {"role": "user", "content": "hi"}], runtime
    )

    # The pressure advisory and compaction re-insert the overlay list into
    # messages that already carry it; the registered heading replaces it.
    working = builder.insert_runtime_system_messages(working, runtime)

    assert sum(_HEADING in str(message["content"]) for message in working) == 1
