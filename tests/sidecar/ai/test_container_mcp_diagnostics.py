"""Diagnostics preferences cross the builtin MCP subprocess argv boundary."""

from pathlib import Path

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.container_mcp_servers import _default_mcp_servers


@pytest.mark.parametrize("frozen", [False, True])
@pytest.mark.parametrize(
    "preferences",
    [
        ("debug", "sanitized_snippets", "debug", "sanitized_snippets"),
        ("invalid-level", "invalid-mode", "info", "redacted"),
    ],
)
def test_builtin_server_forwards_validated_diagnostics_preferences(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    frozen: bool,
    preferences: tuple[str, str, str, str],
) -> None:
    monkeypatch.setattr("sidecar.ai.container_mcp_servers.sys.frozen", frozen, raising=False)
    level, mode, expected_level, expected_mode = preferences
    config = RuntimeConfig(diagnostics_log_level=level, diagnostics_capture_mode=mode)

    args = _default_mcp_servers(config, tmp_path)[0].args

    assert "--diagnostics-log-level" in args
    assert args[args.index("--diagnostics-log-level") + 1] == expected_level
    assert "--diagnostics-capture-mode" in args
    assert args[args.index("--diagnostics-capture-mode") + 1] == expected_mode
