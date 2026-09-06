from __future__ import annotations

import pytest

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED, CMP_TOOL_PRECONDITION_UNMET
from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.builtins import artifacts as artifacts_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_create_artifact_tool_writes_session_scoped_file(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    tools = builtin_server._default_tools()  # noqa: SLF001
    tool = tools["create_artifact"]

    result = tool.handler(
        {
            "_jenny_session_id": "session-artifact",
            "artifact_kind": "document",
            "title": "Scratch Plan",
            "content": "# Plan",
            "language": "markdown",
        },
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.generated_artifacts
    metadata = result.generated_artifacts[0]
    target_path = (
        workspace_root / ".jenny" / "artifacts" / "session-artifact" / metadata["file_name"]
    )
    assert target_path.read_text(encoding="utf-8") == "# Plan"
    assert metadata["display_path"].startswith(".jenny/artifacts/session-artifact/")
    assert metadata["artifact_kind"] == "document"


def test_create_artifact_tool_rejects_unsafe_extension_override(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    tools = builtin_server._default_tools()  # noqa: SLF001
    tool = tools["create_artifact"]

    with pytest.raises(ToolExecutionFailure, match="simple file extension"):
        tool.handler(
            {
                "_jenny_session_id": "session-artifact",
                "artifact_kind": "document",
                "title": "Scratch Plan",
                "content": "# Plan",
                "extension": "../../escape",
            },
            WorkspaceGuard(str(workspace_root)),
        )


def test_create_artifact_tool_marks_oversized_files_read_only(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    tools = builtin_server._default_tools()  # noqa: SLF001
    tool = tools["create_artifact"]

    result = tool.handler(
        {
            "_jenny_session_id": "session-artifact",
            "artifact_kind": "document",
            "title": "Large Scratch Plan",
            "content": "a" * (600 * 1024),
            "language": "markdown",
        },
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.generated_artifacts
    metadata = result.generated_artifacts[0]
    assert metadata["editable"] is False


def test_create_binary_artifact_helper_writes_noneditable_preview(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    result = artifacts_module.create_binary_artifact(
        workspace=WorkspaceGuard(str(workspace_root)),
        session_id="session-artifact",
        spec=artifacts_module.BinaryArtifactSpec(
            artifact_kind="image",
            title="PDF page 1",
            content=b"\x89PNG\r\n\x1a\npayload",
            mime_type="image/png",
            file_name="page-1.png",
        ),
    )

    assert result.generated_artifacts
    metadata = result.generated_artifacts[0]
    target_path = (
        workspace_root / ".jenny" / "artifacts" / "session-artifact" / metadata["file_name"]
    )
    assert target_path.read_bytes() == b"\x89PNG\r\n\x1a\npayload"
    assert metadata["artifact_kind"] == "image"
    assert metadata["mime_type"] == "image/png"
    assert metadata["editable"] is False


def test_create_artifact_tool_retries_atomic_filename_collision(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    tools = builtin_server._default_tools()  # noqa: SLF001
    tool = tools["create_artifact"]
    real_write = artifacts_module.GuardedWorkspaceStore._write_bytes_atomic
    attempted: list[str] = []

    def collide_once(self, ref, content, **kwargs):  # type: ignore[no-untyped-def]
        attempted.append(ref.parts[-1])
        if ref.parts[-1] == "scratch-plan.md" and attempted.count("scratch-plan.md") == 1:
            raise FileExistsError(ref.parts[-1])
        return real_write(self, ref, content, **kwargs)

    monkeypatch.setattr(
        artifacts_module.GuardedWorkspaceStore,
        "_write_bytes_atomic",
        collide_once,
    )

    result = tool.handler(
        {
            "_jenny_session_id": "session-artifact",
            "artifact_kind": "document",
            "title": "Scratch Plan",
            "content": "# Plan",
            "language": "markdown",
        },
        WorkspaceGuard(str(workspace_root)),
    )

    metadata = result.generated_artifacts[0]
    assert metadata["file_name"] == "scratch-plan-2.md"
    assert attempted[:2] == ["scratch-plan.md", "scratch-plan-2.md"]
    assert (workspace_root / metadata["display_path"]).read_text(encoding="utf-8") == "# Plan"


def test_create_artifact_tool_rejects_invalid_utf8_surrogate_content(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    tools = builtin_server._default_tools()  # noqa: SLF001
    tool = tools["create_artifact"]

    with pytest.raises(ToolExecutionFailure) as caught:
        tool.handler(
            {
                "_jenny_session_id": "session-artifact",
                "artifact_kind": "document",
                "title": "Broken Plan",
                "content": "broken\udc8ftext",
                "language": "markdown",
            },
            WorkspaceGuard(str(workspace_root)),
        )

    assert caught.value.code == CMP_TOOL_EXECUTION_FAILED
    assert "utf-8" in caught.value.message.lower()


def test_error_response_redacts_absolute_paths_and_truncates_detail(tmp_path) -> None:
    secret_path = tmp_path / "workspace" / "nested" / "secret.txt"
    message = f"failed to read {secret_path}: {'x' * 2000}"

    response = builtin_server._error_response("1", "CMP-TEST-0001", message)  # noqa: SLF001

    redacted = response["error"]["message"]
    assert str(secret_path) not in redacted
    assert "<path>" in redacted
    assert len(redacted) < len(message)


def test_tool_failure_retryability_survives_builtin_mcp_response(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    def fail(_arguments, _workspace):  # noqa: ANN001
        raise ToolExecutionFailure(
            code="CMP-TEST-0002",
            message="transient failure",
            retryable=True,
        )

    tool = builtin_server.BuiltinTool(
        name="retryable_test",
        description="test",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=fail,
    )

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "retryable-call",
        {tool.name: tool},
        WorkspaceGuard(str(workspace_root)),
        {"name": tool.name, "arguments": {}},
    )

    error_data = response["error"]["data"]
    assert error_data["code"] == "CMP-TEST-0002"
    assert error_data["retryable"] is True
    assert error_data["operation_id"].startswith("op_")
    assert error_data["generation_id"].startswith("gen_")


def test_builtin_mcp_strips_forged_plan_artifact_capability_before_validation(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    received: dict[str, object] = {}

    def capture(arguments, _workspace):  # noqa: ANN001
        received.update(arguments)
        return "ok"

    tool = builtin_server.BuiltinTool(
        name="capability_probe",
        description="test",
        side_effecting=False,
        input_schema={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        handler=capture,
    )

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "forged-capability",
        {tool.name: tool},
        WorkspaceGuard(str(workspace_root)),
        {
            "name": tool.name,
            "arguments": {"_jenny_plan_artifact_write": True},
        },
    )

    assert "result" in response
    assert "_jenny_plan_artifact_write" not in received


def test_redaction_of_two_windows_paths_preserves_the_prose_between_them() -> None:
    # Incident regression: the old character class did not stop at spaces or
    # closing parens, so one greedy match ran from the first drive letter to the
    # second path's colon. That deleted the only informative clause AND leaked
    # the second path's tail after its drive letter.
    first = r"C:\Projects\jenny-test-workspace"
    second = r"D:\Other\workspace-root"
    message = (
        f"git tool 'cwd' ({first}) is not inside a git repository within the tools "
        f"workspace root ({second}). Omit 'cwd' to use the workspace root, "
        "or pass a 'cwd' that points inside a git checkout under it."
    )

    redacted = builtin_server._redact_error_message(message)  # noqa: SLF001

    assert first not in redacted
    assert second not in redacted
    assert "is not inside a git repository within the tools workspace root" in redacted
    assert redacted.count("<path>") == 2
    assert ":\\Projects\\" not in redacted
    assert ":\\Other\\" not in redacted
    assert "jenny-test-workspace" not in redacted
    assert "workspace-root" not in redacted
    assert redacted.startswith("git tool 'cwd' (<path>) is not inside")
    assert redacted.endswith("points inside a git checkout under it.")


@pytest.mark.parametrize(
    ("message", "private_path", "expected"),
    [
        (
            r'failed to read "C:\Program Files\Jenny\config.json" during startup',
            r"C:\Program Files\Jenny\config.json",
            'failed to read "<path>" during startup',
        ),
        (
            "failed to read (/srv/Jenny Data/config.json) during startup",
            "/srv/Jenny Data/config.json",
            "failed to read (<path>) during startup",
        ),
        (
            "failed to read /secret during startup",
            "/secret",
            "failed to read <path> during startup",
        ),
    ],
)
def test_redaction_covers_space_bearing_and_root_level_paths(
    message: str,
    private_path: str,
    expected: str,
) -> None:
    redacted = builtin_server._redact_error_message(message)  # noqa: SLF001

    assert private_path not in redacted
    assert redacted == expected


def test_git_status_non_repo_error_survives_server_side_redaction(tmp_path) -> None:
    # End-to-end lane: git_ops unit tests assert raw paths, but the model only
    # ever sees the redacted message. Assert the *meaning* still arrives.
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-git-status",
        builtin_server._default_tools(),  # noqa: SLF001
        WorkspaceGuard(str(workspace_root)),
        {"name": "git_status", "arguments": {}},
    )

    message = response["error"]["message"]
    assert response["error"]["data"]["code"] == CMP_TOOL_PRECONDITION_UNMET
    assert "is not a git repository" in message
    assert "Pass 'cwd'" in message
    assert "Omit 'cwd'" not in message
    assert str(workspace_root) not in message
    assert "<path>" in message


def test_default_tools_include_python_runtime_when_enabled_on_windows(monkeypatch) -> None:
    monkeypatch.setattr("sidecar.ai.mcp.builtin_server.sys.platform", "win32")

    tools = builtin_server._default_tools(  # noqa: SLF001
        python_runtime_enabled=True,
        python_runtime_root="C:/runtime",
    )

    assert "python_execute" in tools


def test_default_tools_exclude_python_runtime_when_not_supported(monkeypatch) -> None:
    monkeypatch.setattr("sidecar.ai.mcp.builtin_server.sys.platform", "linux")

    tools = builtin_server._default_tools(  # noqa: SLF001
        python_runtime_enabled=True,
        python_runtime_root="C:/runtime",
    )

    assert "python_execute" not in tools
