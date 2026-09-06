"""Harness-snapshot coverage for the engine-keyed loop profile.

Lives in its own module because both existing harness_snapshot test files sit
above the repo file-size ceiling.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.memory.store import MemoryStore
from sidecar.runtime.harness_snapshot import HarnessSnapshotBuilder


class _StubEngine:
    capabilities = {"thinking": True}
    supports_tool_calling = True


class _StubMcp:
    @property
    def available_tools(self):
        return []

    def diagnostics(self):
        return SimpleNamespace(connected=(), failures=())

    def tool_descriptor(self, _tool_name: str):
        return None


def _runtime_section(tmp_path: Path, **config_overrides: Any) -> dict[str, Any]:
    user_data = tmp_path / "user-data"
    user_data.mkdir(exist_ok=True)
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                **config_overrides,
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubMcp(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )
        return builder._build_runtime_section()
    finally:
        memory_store.close()


def test_runtime_section_publishes_the_local_loop_profile(tmp_path: Path) -> None:
    loop_profile = _runtime_section(tmp_path, engine_type="ollama")["loop_profile"]

    assert loop_profile == {
        "profile": "local",
        "max_iterations_chat": 8,
        "max_iterations_task": 30,
        # 2026-08-30: local working-time default raised to 1800 seconds.
        "max_loop_wall_seconds": 1_800.0,
        "max_tools_per_turn": 20,
        "tools_execution_timeout_seconds": 120.0,
        "chunk_inactivity_seconds": 120.0,
    }


def test_runtime_section_publishes_the_cloud_loop_profile(tmp_path: Path) -> None:
    loop_profile = _runtime_section(tmp_path, engine_type="codex-cli")["loop_profile"]

    assert loop_profile == {
        "profile": "cloud",
        "max_iterations_chat": 40,
        "max_iterations_task": 300,
        "max_loop_wall_seconds": 28_800.0,
        "max_tools_per_turn": 200,
        "tools_execution_timeout_seconds": 1_800.0,
        "chunk_inactivity_seconds": 300.0,
    }


def test_runtime_section_reports_local_when_the_rollback_flag_is_set(tmp_path: Path) -> None:
    loop_profile = _runtime_section(
        tmp_path,
        engine_type="chatgpt",
        feature_flags={"cloud_loop_profile": False},
    )["loop_profile"]

    assert loop_profile["profile"] == "local"
    assert loop_profile["max_iterations_task"] == 30
    assert loop_profile["chunk_inactivity_seconds"] == 120.0
