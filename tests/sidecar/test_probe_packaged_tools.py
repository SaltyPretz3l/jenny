"""Run the same probe against source; release qualification supplies the binary."""
import sys

from scripts.packaging.probe_packaged_tools import run_probe


def test_real_builtin_tool_roundtrip():
    evidence = run_probe([sys.executable, "-m", "sidecar.ai.mcp.builtin_server"])
    assert evidence == ["unicode + read/write/list/glob/edit/move/delete/temp-script"]


def test_background_job_survives_router_turn_completion(tmp_path):
    from scripts.packaging.probe_packaged_tools import run_router_background_probe  # noqa: PLC0415

    run_router_background_probe(
        [sys.executable, "-m", "sidecar.ai.mcp.builtin_server"], tmp_path, 1)
