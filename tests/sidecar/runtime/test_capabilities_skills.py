from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import WorkspaceStatus
from sidecar.runtime.capabilities import initialize_response


def test_initialize_response_exposes_skills_loaded_for_multi_scope_builder() -> None:
    stack = SimpleNamespace(
        config=RuntimeConfig(
            feature_flags={"skills_system": True},
            skills_bundled_root="C:/skills/bundled",
            skills_user_root="C:/skills/user",
        ),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(available_tools=[]),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root="C:/workspace",
                exists=True,
                skills_loaded=3,
                bootstrap_loaded=0,
                instruction_file_name="agentj.md",
                instruction_file_present=True,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"feature_flags": {"skills_system": True}}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    assert response["result"]["skills_loaded"] == 3
    assert response["result"]["workspace_status"]["skills_loaded"] == 3
    assert response["result"]["workspace_status"]["instruction_file_name"] == "agentj.md"
    assert response["result"]["workspace_status"]["instruction_file_present"] is True
