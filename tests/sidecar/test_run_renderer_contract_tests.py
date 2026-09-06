from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _load_runner() -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / "run_renderer_contract_tests.py"
    spec = importlib.util.spec_from_file_location("run_renderer_contract_tests_for_tests", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive load guard
        raise RuntimeError("failed to load run_renderer_contract_tests.py module spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_curated_subset_is_non_empty_and_unique() -> None:
    module = _load_runner()
    subset = module.RENDERER_CONTRACT_TESTS
    assert len(subset) >= 5, "the blocking subset should cover the core contract surfaces"
    assert len(subset) == len(set(subset)), "no duplicate entries in the curated subset"


def test_every_curated_file_exists_and_is_a_test_file() -> None:
    """A renamed/deleted contract test must not silently drop from the gate."""
    module = _load_runner()
    for rel in module.RENDERER_CONTRACT_TESTS:
        assert rel.endswith(".test.js"), f"{rel} must be a *.test.js file"
        assert (module.ROOT / rel).is_file(), f"{rel} is missing on disk"


def test_no_curated_file_is_dropped_by_parallel_only() -> None:
    """`--parallel-only` (the lane the runner uses) drops sequential-risk AND
    stable-lane-excluded basenames. If a curated file matched either, it would
    silently NOT run and the gate would pass anyway (false green). Re-derive
    the selection with the actual safe-runner logic and assert every curated
    file survives into the parallel run group."""
    node = shutil.which("node")
    if node is None:  # pragma: no cover - node is present in the lanes that run this
        pytest.skip("node is not available")
    module = _load_runner()
    script = (
        "const s=require('./scripts/run-node-tests-safe');"
        "const files=JSON.parse(process.argv[1]);"
        "const kept=new Set(s.selectRunGroups({parallelOnly:true,childArgs:files}).parallelArgs);"
        "process.stdout.write(JSON.stringify(files.filter((f)=>!kept.has(f))));"
    )
    result = subprocess.run(
        [node, "-e", script, json.dumps(module.RENDERER_CONTRACT_TESTS)],
        cwd=module.ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    dropped = json.loads(result.stdout)
    assert dropped == [], (
        f"these curated files would be silently dropped by --parallel-only "
        f"(sequential-risk or stable-lane-excluded): {dropped}"
    )
