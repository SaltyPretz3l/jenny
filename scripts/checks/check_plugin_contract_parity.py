"""Compare generated JS/Python plugin-contract validators on one corpus.

Byte-diffs the JS probe's result document against the Python validator's
result document for every case in the shared parity corpus, then also runs
the generator's own `--check` staleness gate so a hand-edited generated file
(instead of a schema + regen) fails this check too.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.bounded_process import resolve_executable, run_bounded  # noqa: E402
from scripts.checks.plugin_parity_corpus import load_parity_corpus  # noqa: E402
from sidecar.ai.plugins.generated_plugin_contracts import validate  # noqa: E402

PROBE_PATH = ROOT / "scripts" / "checks" / "plugin_contract_probe.js"
GENERATOR_PATH = ROOT / "scripts" / "generate_plugin_contracts.py"
MAX_DIFF_CASES = 20
# Both spawns below are reachable from the pytest suite (tests/sidecar/ai/plugins/
# test_plugin_contract_parity.py imports _node_results), so an unbounded wait here
# hangs a whole test run instead of failing it -- the plugins suite has no other
# external wait, and a run stuck for 4.5h on 2026-08-29 had no bounded seam to
# fail at. Both children are sub-second in practice; the ceiling only has to sit
# far enough above that to never fire on a loaded machine.
SUBPROCESS_TIMEOUT_SECONDS = 120


def _run_bounded(command: list[str], *, input_text: str | None) -> subprocess.CompletedProcess[str]:
    return run_bounded(
        command,
        label="Plugin contract parity subprocess",
        timeout_seconds=SUBPROCESS_TIMEOUT_SECONDS,
        cwd=ROOT,
        input_text=input_text,
    )


def _python_results(corpus: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [validate(item["contract"], item["value"]) for item in corpus]


def _node_results(corpus: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node = resolve_executable("node", needed_for="the plugin-contract parity probe")
    completed = _run_bounded(
        [node, str(PROBE_PATH)],
        # Keep lone-surrogate fixtures escaped on the UTF-8 subprocess seam.
        # JSON.parse reconstructs the same JS string without asking Python's
        # encoder to represent an invalid Unicode scalar directly.
        input_text=json.dumps(corpus, ensure_ascii=True),
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown Node probe failure").strip()
        raise RuntimeError(f"Plugin contract Node probe failed: {detail[-500:]}")
    return json.loads(completed.stdout)


def _diff_excerpt(corpus: list[dict[str, Any]], javascript: list[dict[str, Any]], python: list[dict[str, Any]]) -> list[str]:
    lines = []
    for item, js_result, py_result in zip(corpus, javascript, python, strict=True):
        if js_result != py_result:
            lines.append(f"{item['id']}: javascript={json.dumps(js_result, ensure_ascii=False)} python={json.dumps(py_result, ensure_ascii=False)}")
        if len(lines) >= MAX_DIFF_CASES:
            lines.append("... (truncated)")
            break
    return lines


def main() -> int:
    # sys.executable, never a PATH "python": under an active venv the launcher
    # and the base interpreter are both on PATH, and a PATH lookup can land on
    # the system Python that has none of this project's dependencies.
    stale = _run_bounded([sys.executable, str(GENERATOR_PATH), "--check"], input_text=None)
    if stale.returncode != 0:
        print("Plugin contract generator is stale:")
        print(stale.stdout.strip())
        print(stale.stderr.strip())
        return 1

    corpus, _expectations = load_parity_corpus()
    javascript = _node_results(corpus)
    python = _python_results(corpus)
    if javascript != python:
        print("Plugin contract parity: MISMATCH")
        for line in _diff_excerpt(corpus, javascript, python):
            print(f"  - {line}")
        return 1

    print(f"Plugin contract parity: PASS ({len(corpus)} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
