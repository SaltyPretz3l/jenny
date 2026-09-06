from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from sidecar import server
from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.memory.contracts import build_content_digest
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.routing.harness_helpers import MAX_RESPONSE_CHARS
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.protocol import API_VERSION
from sidecar.runtime.harness_snapshot import HarnessSnapshotBuilder
from sidecar.runtime.provider_capability_profile import (
    ProviderCapabilityFeatures,
    ProviderCapabilityObserved,
    ProviderCapabilityProfileStore,
)
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore


class _StubEngine:
    capabilities = {"thinking": True}
    supports_tool_calling = True


class _StubDiagnosticsClient:
    @property
    def available_tools(self):
        return []

    def diagnostics(self):
        return SimpleNamespace(connected=("jenny_local_tools",), failures=())

    def tool_descriptor(self, _tool_name: str):
        return None


def test_harness_snapshot_builder_includes_history_and_memory_provenance(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    (user_data / "shell-config.json").write_text(
        json.dumps(
            {
                "tools": {"web": True, "pythonRuntime": False, "todo": True},
                "companion": {"mode": "planner"},
                "followUps": [{"id": "fu_1"}],
                "offlineIntelligence": {
                    "mode": "local_only",
                    "preferredLocalModel": "qwen3.5:9b",
                    "summary": "Using a local model when available.",
                },
            }
        ),
        encoding="utf-8",
    )
    (user_data / "tool-permissions.json").write_text(
        json.dumps({"Bash": "deny"}),
        encoding="utf-8",
    )
    (user_data / "sessions.json").write_text(
        json.dumps(
            {
                "schema_version": 3,
                "sessions": {
                    "sess_1": {
                        "id": "sess_1",
                        "title": "Harness Session",
                        "messages": [
                            {
                                "id": "msg_1",
                                "kind": "tool_use",
                                "timestamp": "2026-04-03T10:00:00+00:00",
                                "tool_call": {
                                    "call_id": "call_1",
                                    "tool_name": "read_file",
                                    "approval_state": "auto",
                                    "summary": "Read README",
                                },
                            },
                            {
                                "id": "msg_2",
                                "kind": "tool_result",
                                "timestamp": "2026-04-03T10:00:01+00:00",
                                "tool_result": {
                                    "call_id": "call_1",
                                    "tool_name": "read_file",
                                    "summary": "Read succeeded",
                                    "is_error": False,
                                },
                            },
                        ],
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        approved_memory, _ = memory_store.save_memory(
            session_id="sess_1",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea",
            provenance="user_approved",
        )
        assert approved_memory.provenance == "user_approved"
        memory_store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO pending_memory_candidates (
                session_id, source_request_id, title, lesson_text, lesson_kind,
                confidence, source_excerpt, content_fingerprint, family_key,
                category, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
            """,
            (
                "sess_1",
                "req_1",
                "Response style: concise",
                "Use concise answers unless the user asks for more detail.",
                "response_style",
                0.9,
                "be concise",
                build_content_digest(
                    "response_style",
                    "Use concise answers unless the user asks for more detail.",
                ),
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T00:00:00+00:00",
            ),
        )
        memory_store._connection.commit()  # noqa: SLF001

        router = SimpleNamespace(
            tools_status={
                "inspect_harness": {
                    "available": True,
                    "reason": None,
                    "display_name": "Inspect Harness",
                },
                "read_file": {
                    "available": True,
                    "reason": None,
                    "display_name": "Read File",
                },
                "run_command": {
                    "available": False,
                    "reason": "workspace requirement missing",
                    "display_name": "Run Command",
                },
            },
            tool_schemas=[
                {
                    "name": "inspect_harness",
                    "description": "Inspect harness.",
                    "side_effecting": False,
                },
                {"name": "read_file", "description": "Read a file.", "side_effecting": False},
                {"name": "run_command", "description": "Run a command.", "side_effecting": True},
            ],
        )
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                feature_flags={"skills_system": True},
            ),
            router=router,
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(recent_history_limit=3)

        tool_items = {item["name"]: item for item in snapshot["tools"]["items"]}
        assert tool_items["read_file"]["use_count"] == 1
        assert tool_items["read_file"]["recent_runs"][0]["outcome"] == "success"
        assert tool_items["run_command"]["blocker"] == "workspace requirement missing"
        assert tool_items["run_command"]["permission_policy"] == "deny"

        assert snapshot["memories"]["approved"][0]["provenance"] == "user_approved"
        assert snapshot["memories"]["pending"][0]["provenance"] == "automatic"
        assert snapshot["runtime"]["schema_versions"]
        assert any(
            entry["id"] == "sidecar.memory_store"
            for entry in snapshot["runtime"]["schema_versions"]
        )
        assert snapshot["shell"]["companion"]["mode"] == "planner"
    finally:
        memory_store.close()


def test_runtime_section_includes_redacted_lsp_status(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from sidecar.ai.tools.builtins.lsp.manager import (
        LSPServerCommand,
        LSPUnavailableResult,
    )

    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    configured_ts = r"C:\Sensitive\typescript-language-server.cmd"
    configured_py = r"C:\Sensitive\pyright-langserver.exe"

    def _fake_detect_language_servers(
        *,
        configured_typescript_command: str | None,
        configured_python_command: str | None,
    ):
        assert configured_typescript_command == configured_ts
        assert configured_python_command == configured_py
        return {
            "typescript": LSPServerCommand(
                language="typescript",
                executable=configured_ts,
                source="configured",
            ),
            "python": LSPUnavailableResult(
                language="python",
                reason=f"configured command not found: {configured_py}",
                install_hint="configure tools_lsp_command_python",
                configured_command=configured_py,
            ),
        }

    monkeypatch.setattr(
        "sidecar.runtime.harness_snapshot.detect_language_servers",
        _fake_detect_language_servers,
        raising=False,
    )
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                tools_lsp_enabled=True,
                tools_lsp_command_typescript=configured_ts,
                tools_lsp_command_python=configured_py,
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(sections=["runtime"])
        lsp_status = snapshot["runtime"]["lsp"]

        assert lsp_status == {
            "enabled": True,
            "languages": [
                {
                    "language": "python",
                    "status": "unavailable",
                    "command_present": False,
                    "configured_command_present": True,
                    "source": None,
                    "reason": "configured language-server command was not found",
                },
                {
                    "language": "typescript",
                    "status": "ready",
                    "command_present": True,
                    "configured_command_present": True,
                    "source": "configured",
                    "reason": None,
                },
            ],
        }
        serialized_status = json.dumps(lsp_status)
        assert "Sensitive" not in serialized_status
        assert "pyright-langserver" not in serialized_status
    finally:
        memory_store.close()


def test_runtime_lsp_status_redacts_unconfigured_reason_paths(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from sidecar.ai.tools.builtins.lsp.manager import LSPUnavailableResult

    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")

    def _fake_detect_language_servers(
        *,
        configured_typescript_command: str | None,
        configured_python_command: str | None,
    ):
        return {
            "typescript": LSPUnavailableResult(
                language="typescript",
                reason=r"failed while probing \\server\share\example\secret\tsserver.cmd",
            ),
            "python": LSPUnavailableResult(
                language="python",
                reason="/home/example/My Folder/secret/pylsp failed during startup",
            ),
        }

    monkeypatch.setattr(
        "sidecar.runtime.harness_snapshot.detect_language_servers",
        _fake_detect_language_servers,
        raising=False,
    )
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                tools_lsp_enabled=True,
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(sections=["runtime"])
        lsp_status = snapshot["runtime"]["lsp"]

        assert "<path>" in json.dumps(lsp_status)
        serialized_status = json.dumps(lsp_status)
        assert "server" not in serialized_status
        assert "share" not in serialized_status
        assert "example" not in serialized_status
        assert "secret" not in serialized_status
        assert "tsserver.cmd" not in serialized_status
        assert "My Folder" not in serialized_status
        assert "pylsp" not in serialized_status
    finally:
        memory_store.close()


def test_harness_snapshot_builder_skips_tool_history_when_recent_history_disabled(
    tmp_path: Path, monkeypatch
) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        router = SimpleNamespace(
            tools_status={
                "inspect_harness": {
                    "available": True,
                    "reason": None,
                    "display_name": "Inspect Harness",
                },
            },
            tool_schemas=[
                {
                    "name": "inspect_harness",
                    "description": "Inspect harness.",
                    "side_effecting": False,
                },
            ],
        )
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                feature_flags={"skills_system": True},
            ),
            router=router,
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        def _fail_load_tool_history(*_args, **_kwargs):
            raise AssertionError(
                "_load_tool_history should not run when include_recent_history is false"
            )

        monkeypatch.setattr(builder, "_load_tool_history", _fail_load_tool_history)
        snapshot = builder.inspect(sections=["tools"], include_recent_history=False)

        assert snapshot["filters"]["include_recent_history"] is False
        assert snapshot["tools"]["items"][0]["recent_runs"] == []
    finally:
        memory_store.close()


def test_harness_snapshot_builder_exposes_workspace_instruction_metadata(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    workspace = tmp_path / "workspace"
    user_data.mkdir()
    workspace.mkdir()
    (workspace / "agentj.md").write_text(
        "Follow the workspace instruction file.",
        encoding="utf-8",
    )
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=str(workspace),
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(workspace),
        )

        snapshot = builder.inspect(sections=["workspace"])

        assert snapshot["workspace"]["instruction_file_name"] == "agentj.md"
        assert snapshot["workspace"]["instruction_file_present"] is True
        assert "manifest" not in snapshot["workspace"]
    finally:
        memory_store.close()


def test_harness_snapshot_builder_includes_workspace_manifest_summary_when_enabled(
    tmp_path: Path,
) -> None:
    user_data = tmp_path / "user-data"
    workspace = tmp_path / "workspace"
    user_data.mkdir()
    workspace.mkdir()
    (workspace / "package.json").write_text("{}", encoding="utf-8")
    (workspace / "src").mkdir()
    (workspace / "src" / "index.ts").write_text("export {};\n", encoding="utf-8")
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=str(workspace),
                tools_workspace_manifest_enabled=True,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                feature_flags={"workspace_manifest": True},
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(workspace),
        )

        snapshot = builder.inspect(sections=["workspace"])

        manifest = snapshot["workspace"]["manifest"]
        assert manifest["available"] is True
        assert manifest["project_type"] == ["node"]
        assert manifest["project_markers"] == ["package.json"]
        assert manifest["entry_points"][0] == "src/index.ts"
        assert manifest["totals"]["truncated"] is False
    finally:
        memory_store.close()


def test_harness_snapshot_builder_includes_latest_turn_diagnostics(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    turn_diagnostics = TurnDiagnosticsStore()
    try:
        turn_diagnostics.begin_turn(
            request_id="req_123",
            session_id="sess_1",
            mode="assist",
            agent_id="planner@req_123",
            debug_options={"disable_thinking": True},
        )
        turn_diagnostics.record_request_metrics(
            request_id="req_123",
            mode="assist",
            context_tokens_estimate=512,
            message_count=4,
            tool_schema_count=7,
        )
        turn_diagnostics.record_provider_request(
            request_id="req_123",
            think_enabled=False,
            num_predict=4096,
            temperature=0.7,
            message_count=4,
            tool_count=7,
            tool_capable=True,
        )
        turn_diagnostics.record_first_chunk(request_id="req_123")
        turn_diagnostics.record_visible_output(request_id="req_123", text="Visible answer")
        turn_diagnostics.complete_provider_request(request_id="req_123")

        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="gemma4-e4b-it-q6_k:latest",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                resolved_app_profile_family="gemma4",
                resolved_app_profile_variant="e4b",
                resolved_app_profile_temperature=1.0,
                resolved_app_profile_top_k=40,
                resolved_app_profile_reasoning_parser_start="<|channel>thought",
                resolved_app_profile_reasoning_parser_end="<channel|>",
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
            turn_diagnostics=turn_diagnostics,
        )

        snapshot = builder.inspect(sections=["runtime"])

        latest_turn = snapshot["runtime"]["latest_turn_diagnostics"]
        assert latest_turn["request_id"] == "req_123"
        assert latest_turn["agent_id"] == "planner@req_123"
        assert latest_turn["think_enabled"] is False
        assert latest_turn["mode"] == "assist"
        assert snapshot["runtime"]["orchestration"]["mode"] == "assist"
        assert snapshot["runtime"]["orchestration"]["agent_id"] == "planner@req_123"
        assert snapshot["runtime"]["orchestration"]["sub_agent_concurrency_budget"] == 1
        assert latest_turn["context_tokens_estimate"] == 512
        assert latest_turn["message_count"] == 4
        assert latest_turn["tool_schema_count"] == 7
        assert latest_turn["time_to_provider_request_start_ms"] >= 0
        assert latest_turn["visible_output_tokens_estimate"] > 0
        assert snapshot["runtime"]["active_app_profile"] == {
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser": {
                "start": "<|channel>thought",
                "end": "<channel|>",
            },
        }
    finally:
        memory_store.close()


def test_runtime_section_includes_request_fingerprint(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    turn_diagnostics = TurnDiagnosticsStore()
    try:
        turn_diagnostics.begin_turn(
            request_id="req_fp",
            session_id="sess_fp",
            mode="chat",
        )
        fingerprint = {
            "prefix_hash": "ab12cd34ef567890",
            "tool_schema_hash": "1122334455667788",
            "per_tool_schema_hashes": {"alpha": "aaaa00001111bbbb"},
            "prefix_section_count": 3,
            "tool_schema_count": 1,
            "generated_at": "2026-05-01T12:34:56.789Z",
        }
        turn_diagnostics.record_request_fingerprint(
            request_id="req_fp",
            fingerprint=fingerprint,
        )

        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
            turn_diagnostics=turn_diagnostics,
        )

        snapshot = builder.inspect(sections=["runtime"])

        latest_turn = snapshot["runtime"]["latest_turn_diagnostics"]
        assert latest_turn["request_fingerprint"] == fingerprint
    finally:
        memory_store.close()


def test_turn_diagnostics_store_retains_overlapping_request_snapshots() -> None:
    store = TurnDiagnosticsStore(max_retained_turns=2)

    store.begin_turn(request_id="req_one", session_id="session-1", mode="assist")
    store.record_provider_request(
        request_id="req_one",
        think_enabled=False,
        num_predict=128,
        temperature=0.2,
        message_count=2,
        tool_count=0,
        tool_capable=False,
    )
    store.record_visible_output(request_id="req_one", text="First answer")

    store.begin_turn(request_id="req_two", session_id="session-1", mode="assist")
    store.record_provider_request(
        request_id="req_two",
        think_enabled=True,
        num_predict=256,
        temperature=0.4,
        message_count=3,
        tool_count=1,
        tool_capable=True,
    )

    latest = store.snapshot()
    first = store.get_snapshot_for_request("req_one")
    second = store.get_snapshot_for_request("req_two")

    assert latest is not None
    assert latest["request_id"] == "req_two"
    assert first is not None
    assert first["request_id"] == "req_one"
    assert first["visible_output_chars"] > 0
    assert second is not None
    assert second["provider_tool_capable"] is True

    store.begin_turn(request_id="req_three", session_id="session-1", mode="chat")

    assert store.get_snapshot_for_request("req_one") is None
    assert store.get_snapshot_for_request("req_two") is not None
    assert store.get_snapshot_for_request("req_three") is not None


def test_harness_snapshot_builder_includes_tool_classification_metadata(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(
                tools_status={
                    "read_file": {
                        "available": True,
                        "reason": None,
                        "display_name": "Read File",
                        "source_kind": "builtin",
                        "tool_family": "filesystem",
                    }
                },
                tool_schemas=[
                    {
                        "name": "read_file",
                        "description": "Read a file",
                        "side_effecting": False,
                    }
                ],
            ),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(sections=["tools"])

        item = next(item for item in snapshot["tools"]["items"] if item["name"] == "read_file")
        assert item["name"] == "read_file"
        assert item["source_kind"] == "builtin"
        assert item["tool_family"] == "filesystem"
    finally:
        memory_store.close()


def test_harness_snapshot_builder_uses_bounded_pending_memory_query(
    tmp_path: Path, monkeypatch
) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        captured = {"limit": 0}

        def _capture_pending(limit: int = 0):
            captured["limit"] = int(limit)
            return []

        monkeypatch.setattr(memory_store, "get_pending_candidates_for_harness", _capture_pending)
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
                feature_flags={"skills_system": True},
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(sections=["memories"])

        assert captured["limit"] == 80
        assert snapshot["memories"]["pending"] == []
    finally:
        memory_store.close()


def _retired_inspect_harness_synthetic_tool_uses_snapshot_provider() -> None:
    captured_kwargs: dict[str, object] = {}

    def _provider(**kwargs: object) -> dict[str, object]:
        captured_kwargs.update(kwargs)
        return {
            "generated_at": "2026-04-03T00:00:00+00:00",
            "sections": kwargs.get("sections") or ["tools"],
            "filters": {
                "include_recent_history": kwargs.get("include_recent_history"),
                "recent_history_limit": kwargs.get("recent_history_limit"),
                "include_disabled": kwargs.get("include_disabled"),
            },
            "tools": {
                "items": [
                    {
                        "name": "inspect_harness",
                        "display_name": "Inspect Harness",
                        "description": "verbose description should not reach the model",
                        "enabled": True,
                        "permission_policy": "auto",
                        "read_only": True,
                    }
                ],
                "counts": {"total": 1, "enabled": 1, "disabled": 0},
            },
        }

    router = ChatRouter(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=_StubEngine(),
        mcp_client=_StubDiagnosticsClient(),
        context_builder=ContextBuilder(None),
        harness_snapshot_provider=_provider,
    )

    outcome = router._execute_tool(  # noqa: SLF001
        ToolCallRequest(
            tool_id="inspect_harness",
            arguments={"sections": ["tools"], "recent_history_limit": 2},
        ),
        request_id="req_harness",
        read_snapshot_cache={},
    )

    assert outcome.success is True
    payload = json.loads(outcome.output)
    assert payload["sections"] == ["tools"]
    assert payload["filters"]["include_recent_history"] is False
    assert payload["filters"]["recent_history_limit"] == 2
    assert payload["compact"] is True
    assert "description" not in payload["tools"]["items"][0]
    assert captured_kwargs["include_recent_history"] is False
    assert captured_kwargs["include_disabled"] is True
    assert outcome.metadata["result_kind"] == "harness_snapshot"
    assert outcome.metadata["snapshot_detail"] == "compact"


def _retired_inspect_harness_synthetic_tool_normalizes_malformed_options() -> None:
    captured_kwargs: dict[str, object] = {}

    def _provider(**kwargs: object) -> dict[str, object]:
        captured_kwargs.update(kwargs)
        return {
            "generated_at": "2026-04-03T00:00:00+00:00",
            "sections": ["tools"],
            "filters": {
                "include_recent_history": kwargs.get("include_recent_history"),
                "recent_history_limit": kwargs.get("recent_history_limit"),
                "include_disabled": kwargs.get("include_disabled"),
            },
            "tools": {"items": [], "counts": {"total": 0, "enabled": 0, "disabled": 0}},
        }

    router = ChatRouter(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=_StubEngine(),
        mcp_client=_StubDiagnosticsClient(),
        context_builder=ContextBuilder(None),
        harness_snapshot_provider=_provider,
    )

    outcome = router._execute_tool(  # noqa: SLF001
        ToolCallRequest(
            tool_id="inspect_harness",
            arguments={
                "include_recent_history": "true",
                "include_disabled": "false",
                "recent_history_limit": "not-an-int",
            },
        ),
        request_id="req_harness_malformed_options",
        read_snapshot_cache={},
    )

    payload = json.loads(outcome.output)

    assert outcome.success is True
    assert captured_kwargs["include_recent_history"] is False
    assert captured_kwargs["include_disabled"] is True
    assert captured_kwargs["recent_history_limit"] == 5
    assert payload["filters"] == {
        "include_disabled": True,
        "include_recent_history": False,
        "recent_history_limit": 5,
    }


def _retired_inspect_harness_synthetic_tool_returns_compact_json_when_snapshot_is_large() -> None:
    router = ChatRouter(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=_StubEngine(),
        mcp_client=_StubDiagnosticsClient(),
        context_builder=ContextBuilder(None),
        harness_snapshot_provider=lambda **_kwargs: {
            "generated_at": "2026-04-03T00:00:00+00:00",
            "sections": ["tools", "memories"],
            "filters": {
                "include_recent_history": True,
                "recent_history_limit": 5,
                "include_disabled": True,
            },
            "tools": {
                "items": [
                    {
                        "name": f"tool_{index}",
                        "display_name": f"Tool {index}",
                        "enabled": True,
                        "permission_policy": "auto",
                        "use_count": index,
                        "recent_runs": [],
                        "description": "x" * 1500,
                    }
                    for index in range(30)
                ],
                "counts": {"total": 30, "enabled": 30, "disabled": 0},
            },
            "memories": {
                "approved": [{"title": "Memory", "lesson_text": "y" * 4000}],
                "pending": [],
                "counts": {
                    "approved": 1,
                    "pending": 0,
                    "provenance": {"user_approved": 1, "automatic": 0, "unknown_legacy": 0},
                },
            },
        },
    )

    outcome = router._execute_tool(  # noqa: SLF001
        ToolCallRequest(tool_id="inspect_harness", arguments={}),
        request_id="req_harness_large",
        read_snapshot_cache={},
    )

    payload = json.loads(outcome.output)
    assert outcome.success is True
    assert payload["compact"] is True
    assert payload["tools"]["counts"] == {"total": 30, "enabled": 30, "disabled": 0}
    assert len(payload["tools"]["items"]) == 30
    assert "description" not in payload["tools"]["items"][0]
    assert "lesson_text" not in payload["memories"]["approved"][0]
    assert outcome.content_type == "application/json"
    assert len(outcome.output) <= MAX_RESPONSE_CHARS


def _retired_inspect_harness_synthetic_tool_returns_valid_compact_json_when_snapshot_is_huge() -> (
    None
):
    router = ChatRouter(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=_StubEngine(),
        mcp_client=_StubDiagnosticsClient(),
        context_builder=ContextBuilder(None),
        harness_snapshot_provider=lambda **_kwargs: {
            "generated_at": "2026-04-03T00:00:00+00:00",
            "sections": ["tools", "memories"],
            "filters": {
                "include_recent_history": True,
                "recent_history_limit": 5,
                "include_disabled": True,
            },
            "tools": {
                "items": [
                    {
                        "name": f"tool_{index}",
                        "display_name": f"Tool {index}",
                        "enabled": True,
                        "permission_policy": "auto",
                        "use_count": index,
                        "recent_runs": [],
                        "description": "x" * 3000,
                    }
                    for index in range(240)
                ],
                "counts": {"total": 240, "enabled": 240, "disabled": 0},
            },
            "memories": {
                "approved": [{"title": "Memory", "lesson_text": "y" * 12_000}],
                "pending": [],
                "counts": {
                    "approved": 1,
                    "pending": 0,
                    "provenance": {"user_approved": 1, "automatic": 0, "unknown_legacy": 0},
                },
            },
        },
    )

    outcome = router._execute_tool(  # noqa: SLF001
        ToolCallRequest(tool_id="inspect_harness", arguments={}),
        request_id="req_harness_overflow",
        read_snapshot_cache={},
    )

    payload = json.loads(outcome.output)
    assert outcome.success is True
    assert payload["compact"] is True
    assert payload["omitted"]["tools"]["items"] > 0
    assert "lesson_text" not in payload["memories"]["approved"][0]
    assert outcome.content_type == "application/json"
    assert len(outcome.output) <= MAX_RESPONSE_CHARS


def test_server_process_message_dispatches_harness_inspect(monkeypatch, tmp_path) -> None:
    # initialize builds a REAL container; without this the MonitorManager it
    # creates points at ~/.companion/background-memory, where its constructor
    # prunes (DELETES) terminal status records and recover_stale_monitors()
    # rewrites live running+persistent monitors to state="stale".
    import sidecar.ai.container as container_mod

    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda _cfg: tmp_path / "runtime",
    )
    initialize_outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"accept_version": API_VERSION},
        },
        initialized=False,
    )
    try:
        assert initialize_outcome.initialized is True

        outcome = server.process_message(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "harness.inspect",
                "params": {"accept_version": API_VERSION, "sections": ["runtime"]},
            },
            initialized=True,
        )

        assert outcome.response is not None
        assert outcome.response["result"]["sections"] == ["runtime"]
        assert "runtime" in outcome.response["result"]
    finally:
        # initialize built a REAL engine stack into the module-global
        # _BRAIN_CONTAINER. Leaving it open keeps its subprocess alive and
        # makes every later test in the run depend on this one's ordering.
        server._BRAIN_CONTAINER.close()  # noqa: SLF001


def test_runtime_section_includes_provider_capability_profiles(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    profile_store = ProviderCapabilityProfileStore()
    try:
        profile_store.record_probe_result(
            endpoint_id="ollama@http://localhost:11434",
            model_id="qwen2.5:14b",
            features=ProviderCapabilityFeatures(
                chat_supported=True,
                streaming_supported=True,
                native_tools_supported=True,
            ),
            observed=ProviderCapabilityObserved(max_context_advertised=32768),
            probe_status="ready",
            now=1700000000.0,
        )

        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="qwen2.5:14b",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
            provider_capability_profiles=profile_store,
        )

        snapshot = builder.inspect(sections=["runtime"])

        profiles = snapshot["runtime"]["provider_capability_profiles"]
        assert isinstance(profiles, list)
        assert len(profiles) == 1
        assert profiles[0]["profile_id"] == "ollama@http://localhost:11434::qwen2.5:14b"
        assert profiles[0]["selected_route"] == "native_tools"
        assert profiles[0]["features"]["native_tools_supported"] is True
        assert profiles[0]["observed"]["max_context_advertised"] == 32768
    finally:
        memory_store.close()


def test_runtime_section_provider_capabilities_unchanged(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="qwen2.5:14b",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
            provider_capability_profiles=ProviderCapabilityProfileStore(),
        )

        snapshot = builder.inspect(sections=["runtime"])

        provider_capabilities = snapshot["runtime"]["provider_capabilities"]
        assert set(provider_capabilities) == {
            "ollama",
            "vllm",
            "openai-compatible",
            "codex-cli",
            "chatgpt",
            "plugin_host",
            "replay",
            "mock",
        }
        for entry in provider_capabilities.values():
            assert "engine" in entry
            assert "available" in entry
            assert "reasoning_effort_support" in entry
        assert provider_capabilities["codex-cli"]["requires_secret"] is False
        assert provider_capabilities["codex-cli"]["available"] is False
    finally:
        memory_store.close()


def test_runtime_section_includes_system_pressure_snapshot(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="qwen2.5:14b",
                tools_workspace_root=str(tmp_path),
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(sections=["runtime"])

        pressure = snapshot["runtime"]["system_pressure"]
        assert pressure["status"] in {"ok", "pressured", "unknown"}
        assert pressure["disk"]["path"] == str(tmp_path)
        assert "free_bytes" in pressure["disk"]
    finally:
        memory_store.close()


def test_runtime_section_omits_profiles_when_store_is_none(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="qwen2.5:14b",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(sections=["runtime"])

        assert "provider_capability_profiles" not in snapshot["runtime"]
    finally:
        memory_store.close()


# ---------------------------------------------------------------------------
# Phase 6 — recent_tool_observations surfacing
# ---------------------------------------------------------------------------


def test_runtime_section_includes_recent_tool_observations(tmp_path: Path) -> None:
    """When the audit store has events, ``runtime.recent_tool_observations``
    is a list of public payloads (≤50)."""
    from sidecar.ai.routing.tool_observation import (
        KIND_MODEL_TOOL_REQUESTED,
        KIND_TOOL_EXECUTION_OBSERVED,
        KIND_TURN_COMPLETED,
        ToolObservationEvent,
        ToolObservationStore,
    )

    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        store = ToolObservationStore()
        store.ensure_turn(request_id="req_audit")
        store.record(
            ToolObservationEvent(
                kind=KIND_MODEL_TOOL_REQUESTED,
                request_id="req_audit",
                tool_call_id="c1",
                tool_name="read_file",
                summary="model_tool_requested read_file",
            )
        )
        store.record(
            ToolObservationEvent(
                kind=KIND_TOOL_EXECUTION_OBSERVED,
                request_id="req_audit",
                tool_call_id="c1",
                tool_name="read_file",
                summary="tool_execution_observed read_file",
            )
        )
        store.record(
            ToolObservationEvent(
                kind=KIND_TURN_COMPLETED,
                request_id="req_audit",
                summary="turn_completed chars=4",
            )
        )

        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="qwen2.5:14b",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
            tool_observations=store,
        )

        snapshot = builder.inspect(sections=["runtime"])

        recent = snapshot["runtime"]["recent_tool_observations"]
        assert isinstance(recent, list)
        assert len(recent) == 3
        assert len(recent) <= 50
        assert {entry["kind"] for entry in recent} == {
            KIND_MODEL_TOOL_REQUESTED,
            KIND_TOOL_EXECUTION_OBSERVED,
            KIND_TURN_COMPLETED,
        }
        for entry in recent:
            assert set(entry.keys()) == {
                "kind",
                "request_id",
                "turn_id",
                "tool_call_id",
                "tool_name",
                "summary",
                "error_code",
                "sequence",
            }
    finally:
        memory_store.close()


def test_runtime_section_omits_observations_when_store_is_none(
    tmp_path: Path,
) -> None:
    """``recent_tool_observations`` key is absent (not ``[]``) when no
    store is wired — distinguishes 'no store' from 'empty turn'."""
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="qwen2.5:14b",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
        )

        snapshot = builder.inspect(sections=["runtime"])

        assert "recent_tool_observations" not in snapshot["runtime"]
    finally:
        memory_store.close()


def test_runtime_section_omits_observations_when_store_has_no_turn(
    tmp_path: Path,
) -> None:
    """An empty store (begin_turn never called) leaves the key absent."""
    from sidecar.ai.routing.tool_observation import ToolObservationStore

    user_data = tmp_path / "user-data"
    user_data.mkdir()
    memory_store = MemoryStore(user_data / "sidecar-memory.db")
    try:
        builder = HarnessSnapshotBuilder(
            config=RuntimeConfig(
                engine_type="ollama",
                model="qwen2.5:14b",
                tools_workspace_root=None,
                electron_state_root=str(user_data),
                memory_db_path=str(user_data / "sidecar-memory.db"),
            ),
            router=SimpleNamespace(tools_status={}, tool_schemas=[]),
            engine=_StubEngine(),
            mcp_client=_StubDiagnosticsClient(),
            memory_store=memory_store,
            context_builder=ContextBuilder(None),
            tool_observations=ToolObservationStore(),
        )

        snapshot = builder.inspect(sections=["runtime"])

        assert "recent_tool_observations" not in snapshot["runtime"]
    finally:
        memory_store.close()


_SPLIT_TOOL_MESSAGES = [
    {
        "id": "msg_1",
        "kind": "tool_use",
        "timestamp": "2026-04-03T10:00:00+00:00",
        "tool_call": {
            "call_id": "call_1",
            "tool_name": "read_file",
            "approval_state": "auto",
            "summary": "Read README",
        },
    },
    {
        "id": "msg_2",
        "kind": "tool_result",
        "timestamp": "2026-04-03T10:00:01+00:00",
        "tool_result": {
            "call_id": "call_1",
            "tool_name": "read_file",
            "summary": "Read succeeded",
            "is_error": False,
        },
    },
]


def _history_builder(state_root: Path) -> HarnessSnapshotBuilder:
    builder = HarnessSnapshotBuilder.__new__(HarnessSnapshotBuilder)
    builder._config = SimpleNamespace(
        electron_state_root=str(state_root), electron_sessions_path=None
    )
    return builder


def test_tool_history_reads_the_split_session_layout(tmp_path: Path) -> None:
    """A migrated store has no sessions.json -- only sessions/_index.json + files.

    The monolithic fixture above cannot see this: reading sessions.json alone
    returned an EMPTY tool history on every migrated install. Both layouts must
    yield the same history, so this pins them against each other.
    """
    session = {"id": "sess_1", "title": "Harness Session", "messages": _SPLIT_TOOL_MESSAGES}

    legacy_root = tmp_path / "legacy"
    legacy_root.mkdir()
    (legacy_root / "sessions.json").write_text(
        json.dumps({"schema_version": 3, "sessions": {"sess_1": session}}), encoding="utf-8"
    )

    split_root = tmp_path / "split"
    (split_root / "sessions").mkdir(parents=True)
    (split_root / "sessions" / "_index.json").write_text(
        json.dumps(
            {
                "schema_version": 20,
                "sessions": {
                    "sess_1": {
                        "id": "sess_1",
                        "title": "Harness Session",
                        "session_type": "chat",
                        "message_count": 2,
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    (split_root / "sessions" / "sess_1.json").write_text(
        json.dumps({"schema_version": 20, "session": session}), encoding="utf-8"
    )

    legacy = _history_builder(legacy_root)._load_tool_history(history_limit=3)
    split = _history_builder(split_root)._load_tool_history(history_limit=3)

    assert legacy.get("read_file"), "the legacy monolithic layout must still be read"
    assert split == legacy, "the split layout must produce the same tool history"
    assert len(split["read_file"]["recent_runs"]) == 1
    assert split["read_file"]["recent_runs"][0]["outcome"] == "success"
    assert split["read_file"]["recent_runs"][0]["session_title"] == "Harness Session"
