from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]


def _load_script_module(script_path: str) -> ModuleType:
    path = ROOT / script_path
    spec = importlib.util.spec_from_file_location(
        f"phase3_{script_path.replace('/', '_')}", path
    )
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError(f"unable to load script module: {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_phase3_security_invariants_accept_repository() -> None:
    module = _load_script_module("scripts/checks/check_phase3_security_invariants.py")

    violations = module.validate_phase3_security_invariants(ROOT)

    assert violations == []


def test_source_attribution_requires_executable_calls(tmp_path) -> None:
    module = _load_script_module("scripts/checks/check_phase3_security_invariants.py")
    tool_execution = tmp_path / "sidecar" / "ai" / "routing" / "tool_execution.py"
    transport = tmp_path / "sidecar" / "ai" / "mcp" / "transport_stdio.py"
    tool_execution.parent.mkdir(parents=True)
    transport.parent.mkdir(parents=True)
    tool_execution.write_text(
        "def _build_output_chunk_emitter():\n"
        "    # tool_name=tool_name\n"
        "    pass\n\n"
        "def approval_if_needed():\n"
        "    # scan_tool_arguments\n"
        "    pass\n\n"
        "def execute_tool():\n"
        "    # tool_name=result_tool_name\n"
        "    pass\n",
        encoding="utf-8",
    )
    transport.write_text(
        "def _sanitize_mcp_detail():\n"
        "    # tool_name=\"mcp_stdio\"\n"
        "    pass\n",
        encoding="utf-8",
    )

    violations = module._validate_source_attribution(tmp_path)

    assert "sidecar/ai/routing/tool_execution.py missing executable sanitizer attribution" in violations
    assert "sidecar/ai/mcp/transport_stdio.py missing executable sanitizer attribution" in violations


def test_phase3_security_check_is_registered_in_policy_runner() -> None:
    module = _load_script_module("scripts/checks/run_all.py")

    assert "check_phase3_security_invariants.py" in module.CHECKS
