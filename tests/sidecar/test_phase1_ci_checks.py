from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
import tomllib
from datetime import date
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load_script_module(script_name: str) -> ModuleType:
    script_path = ROOT / "scripts" / "checks" / script_name
    spec = importlib.util.spec_from_file_location(f"phase1_{script_name}", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError(f"unable to load script module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    # Register before exec: @dataclass resolves cls.__module__ via sys.modules
    # (py3.11 KW_ONLY check), so unregistered modules crash on dataclass defs.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_release_metadata_fixture(root: Path, *, client_version: str | None = None) -> None:
    _write(
        root / "package.json",
        (
            '{\n'
            '  "version": "0.1.0",\n'
            '  "dependencies": {"electron-updater": "^6.8.3"},\n'
            '  "repository": {"url": "https://github.com/SaltyPretz3l/jenny.git"}\n'
            '}\n'
        ),
    )
    _write(
        root / "pyproject.toml",
        '[project]\nname = "companion-sidecar"\nversion = "0.1.0"\n',
    )
    _write(root / "sidecar" / "protocol.py", 'API_VERSION = "2026-04-13"\n')
    _write(
        root / "services" / "backend" / "sidecar-client.js",
        "const API_VERSION = '2026-04-13';\n",
    )
    _write(
        root / "services" / "backend" / "managed-sidecar-lifecycle.js",
        (
            "const config = { clientVersion: service.appVersion };\n"
            if client_version is None
            else f"const config = {{ clientVersion: '{client_version}' }};\n"
        ),
    )
    _write(
        root / "electron-builder.yml",
        (
            "publish:\n"
            "  - provider: github\n"
            "    owner: SaltyPretz3l\n"
            "    repo: jenny\n"
        ),
    )
    _write(root / "RELEASE_NOTES.md", "# Release Notes\n\n## 0.1.0 - Unreleased\n")


def test_release_metadata_check_passes_for_current_repo(capsys) -> None:
    module = _load_script_module("check_release_metadata.py")

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: release metadata check" in output


def test_release_metadata_check_detects_client_version_drift(tmp_path) -> None:
    module = _load_script_module("check_release_metadata.py")
    _write_release_metadata_fixture(tmp_path, client_version="0.2.0")

    violations = module.validate_release_metadata(tmp_path)

    assert any("managed clientVersion" in violation for violation in violations)


def test_markdown_link_check_detects_missing_local_link(tmp_path) -> None:
    module = _load_script_module("check_markdown_links.py")
    _write(tmp_path / "README.md", "See [missing](docs/missing.md).\n")

    violations = module.validate_markdown_links(tmp_path)

    assert violations == ["README.md:1 broken local markdown link: docs/missing.md"]


def test_markdown_link_check_accepts_repo_absolute_and_fragment_links(tmp_path) -> None:
    module = _load_script_module("check_markdown_links.py")
    _write(tmp_path / "docs" / "guide.md", "# Title\n\n## Setup Notes\n")
    _write(
        tmp_path / "README.md",
        "Read [guide](docs/guide.md#setup-notes) and [absolute](C:/dev/jenny/docs/guide.md:1).\n",
    )

    violations = module.validate_markdown_links(tmp_path)

    assert violations == []


def test_markdown_link_check_scans_the_dist_export_set(tmp_path) -> None:
    # The public export ships dist_manifest.json's set; a doc only that manifest
    # includes used to go unchecked because only the stage manifest was read.
    module = _load_script_module("check_markdown_links.py")
    packaging = tmp_path / "scripts" / "packaging"
    _write(packaging / "github_stage_manifest.json", json.dumps({"include_paths": ["README.md"]}))
    _write(packaging / "dist_manifest.json", json.dumps({
        "include_paths": ["CONTRIBUTING.md"],
        "include_globs": ["docs/**/*"],
        "exclude_globs": ["docs/private/**"],
    }))
    _write(tmp_path / "README.md", "Fine.\n")
    _write(tmp_path / "CONTRIBUTING.md", "See [gone](docs/gone.md).\n")
    _write(tmp_path / "docs" / "guide.md", "See [also gone](missing.md).\n")
    _write(tmp_path / "docs" / "private" / "notes.md", "See [ignored](nowhere.md).\n")
    _write(tmp_path / "unshipped.md", "See [ignored](nowhere.md).\n")

    violations = module.validate_markdown_links(tmp_path)

    assert violations == [
        "CONTRIBUTING.md:1 broken local markdown link: docs/gone.md",
        "docs/guide.md:1 broken local markdown link: missing.md",
    ]


def _write_fresh_required_docs(module: ModuleType, root: Path, *, except_doc: str | None = None) -> None:
    for relative_path in module.REQUIRED_DOCS:
        if relative_path == except_doc:
            continue
        _write(root / relative_path, "---\nlast_reviewed: 2026-05-05\n---\n\n# Doc\n")


def test_docs_freshness_check_requires_last_reviewed_frontmatter(tmp_path) -> None:
    module = _load_script_module("check_docs_freshness.py")
    _write_fresh_required_docs(
        module, tmp_path, except_doc="docs/process/TESTING_STRATEGY.md"
    )
    _write(tmp_path / "docs" / "process" / "TESTING_STRATEGY.md", "# Testing\n")

    violations = module.validate_docs_freshness(tmp_path, today=date(2026, 5, 5))

    assert violations == [
        "docs/process/TESTING_STRATEGY.md missing last_reviewed frontmatter"
    ]


def test_docs_freshness_check_accepts_current_review_date(tmp_path) -> None:
    module = _load_script_module("check_docs_freshness.py")
    _write_fresh_required_docs(module, tmp_path)

    violations = module.validate_docs_freshness(tmp_path, today=date(2026, 5, 5))

    assert violations == []


def test_docs_freshness_check_covers_agent_instruction_surface() -> None:
    module = _load_script_module("check_docs_freshness.py")

    assert "AGENTS.md" in module.REQUIRED_DOCS
    assert "docs/process/MODEL_RELEASE_TUNEUP.md" in module.REQUIRED_DOCS
    assert "docs/process/WORKSPACE_MANIFEST_SYSTEM.md" in module.REQUIRED_DOCS


def test_run_all_wires_phase1_policy_checks() -> None:
    module = _load_script_module("run_all.py")

    assert "check_release_metadata.py" in module.CHECKS
    assert "check_release_manifest_block.py" in module.CHECKS
    assert "check_release_version_policy.py" in module.CHECKS
    assert "check_markdown_links.py" in module.CHECKS
    assert "check_docs_freshness.py" in module.CHECKS


def test_backend_seam_scan_prunes_generated_and_ignored_trees(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("check_backend_seam_boundary.py")
    _write(tmp_path / "services" / "main" / "live.js", "module.exports = {};\n")
    _write(tmp_path / "artifacts" / "generated.js", "module.exports = {};\n")
    _write(tmp_path / "node_modules" / "dependency.js", "module.exports = {};\n")
    _write(tmp_path / "tests" / "fixture.js", "module.exports = {};\n")
    monkeypatch.setattr(module, "ROOT", tmp_path)

    scanned = {path.relative_to(tmp_path).as_posix() for path in module.iter_scan_files()}

    assert scanned == {"services/main/live.js"}


def test_run_all_reports_current_check_and_elapsed_time(monkeypatch, capsys) -> None:
    module = _load_script_module("run_all.py")
    monkeypatch.setattr(module, "CHECKS", ["first.py", "second.py"])
    observed_kwargs = []

    def _fake_run(command, **kwargs):
        observed_kwargs.append(kwargs)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(module, "run_bounded", _fake_run)

    assert module.main() == 0
    output = capsys.readouterr().out
    assert "RUN [1/2] first.py" in output
    assert "PASS: first.py (" in output
    assert "RUN [2/2] second.py" in output
    assert "PASS: all policy checks (" in output
    # The checks run in parallel, so only the reporting order is fixed.
    assert sorted(kwargs["label"] for kwargs in observed_kwargs) == sorted(module.CHECKS)
    assert output.index("RUN [1/2] first.py") < output.index("RUN [2/2] second.py")
    assert all(kwargs["timeout_seconds"] == module.CHECK_TIMEOUT_SECONDS for kwargs in observed_kwargs)
    assert all(kwargs["cwd"] == module.ROOT for kwargs in observed_kwargs)
    assert all(kwargs["encoding"] is None for kwargs in observed_kwargs)


def test_run_all_reports_in_list_order_and_stops_at_the_first_failing_check(monkeypatch, capsys) -> None:
    # Checks run in parallel (2026-10-04); a later check finishing first, or
    # failing, must not reorder the report or outrank an earlier failure.
    module = _load_script_module("run_all.py")
    monkeypatch.setattr(module, "CHECKS", ["slow_pass.py", "slow_fail.py", "fast_fail.py"])

    def _fake_run(command, **kwargs):
        label = kwargs["label"]
        if label.startswith("slow"):
            time.sleep(0.3)
        code = 0 if label == "slow_pass.py" else (3 if label == "slow_fail.py" else 7)
        return subprocess.CompletedProcess(command, code, stdout=f"out {label}", stderr="")

    monkeypatch.setattr(module, "run_bounded", _fake_run)

    assert module.main() == 3
    output = capsys.readouterr().out
    assert output.index("PASS: slow_pass.py") < output.index("FAIL: slow_fail.py")
    assert "fast_fail.py" not in output.replace("RUN [3/3] fast_fail.py", "")
    assert "RUN [3/3]" not in output


def test_run_ci_uses_sidecar_coverage_gate() -> None:
    module = _load_script_module("run_ci.py")
    flat_commands = [" ".join(stage.command) for stage in module.STAGES]

    # run_ci.py runs pytest with sidecar coverage measurement enabled, fanned
    # out via pytest-xdist (fixed -n so the heavy wave budgets the host).
    assert any("--cov=sidecar" in command for command in flat_commands)
    assert any("--dist=loadscope" in command for command in flat_commands)
    assert any("--durations=25" in command for command in flat_commands)
    assert any("--durations-min=1.0" in command for command in flat_commands)

    node_stage = next(stage for stage in module.STAGES if stage.name == "node_test_safe")
    assert node_stage.env == {"JENNY_TEST_WORKERS": "14"}
    assert "--timeout-ms=1200000" in node_stage.command
    assert module.DEFAULT_GLOBAL_TIMEOUT_SECONDS == 1800

    # pytest and the Node lane never overlap: together they timed out jsdom and
    # subprocess-timing tests that pass with each lane alone (2026-10-03).
    pytest_stage = next(stage for stage in module.STAGES if stage.name == "pytest_sidecar")
    assert pytest_stage.command[pytest_stage.command.index("-n") + 1] == "12"
    assert pytest_stage.wave < node_stage.wave
    package_stage = next(stage for stage in module.STAGES if stage.name == "smoke_packaged_flow")
    assert package_stage.wave == 4
    assert package_stage.wave > node_stage.wave
    assert package_stage.command[-5:] == [
        "--timeout-seconds",
        "480",
        "--step-timeout-seconds",
        "480",
        "--allow-stale-source",
    ]

    # The coverage floor is the single source of truth in pyproject.toml
    # [tool.coverage.report] fail_under (since 2026-06-13); run_ci.py and
    # package.json no longer pass --cov-fail-under inline -- pytest-cov reads
    # fail_under when no flag is given. Pin it against the baseline artifact
    # rather than a literal: coverage_baseline.json names pyproject as its
    # hard_floor_source, so the two must agree or a rung can roll back unseen.
    # This assertion read ">= 70" while both artifacts had already moved to 75.
    # See pyproject.toml and docs/plans/TEST_COVERAGE_RATCHET.md.
    assert not any("--cov-fail-under" in command for command in flat_commands)
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    fail_under = pyproject["tool"]["coverage"]["report"]["fail_under"]
    assert isinstance(fail_under, (int, float))
    baseline = json.loads(
        (ROOT / "scripts" / "checks" / "coverage_baseline.json").read_text(encoding="utf-8")
    )
    assert fail_under == baseline["sidecar"]["hard_floor_pct"]


def test_run_ci_runs_sidecar_coverage_ratchet_after_the_pytest_stage() -> None:
    # check_coverage_ratchet.py used to run only in the billing-blocked ci.yml
    # coverage job; run_ci.py now writes coverage.json and gates it locally.
    module = _load_script_module("run_ci.py")
    pytest_stage = next(stage for stage in module.STAGES if stage.name == "pytest_sidecar")
    ratchet_stage = next(stage for stage in module.STAGES if stage.name == "coverage_ratchet_sidecar")

    assert "--cov-report=json:coverage.json" in pytest_stage.command
    assert ratchet_stage.command[1:] == ["scripts/checks/check_coverage_ratchet.py", "--scope=sidecar"]
    assert ratchet_stage.wave > pytest_stage.wave



def test_run_ci_lets_python_stages_write_bytecode_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    # A shell that exports PYTHONDONTWRITEBYTECODE made pytest redo its assertion
    # rewriting in every worker on every run (102 s vs 83 s, 2026-10-04).
    module = _load_script_module("run_ci.py")
    plain = module.Stage("plain", ["x"], wave=1)
    with_env = module.Stage("with-env", ["x"], wave=1, env={"JENNY_TEST_WORKERS": "14"})

    monkeypatch.delenv("PYTHONDONTWRITEBYTECODE", raising=False)
    assert module._stage_env(plain) is None

    monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "1")
    for stage in (plain, with_env):
        env = module._stage_env(stage)
        assert env is not None and "PYTHONDONTWRITEBYTECODE" not in env
    assert module._stage_env(with_env)["JENNY_TEST_WORKERS"] == "14"


def test_run_ci_power_throttling_keeper_walks_only_the_gates_own_tree() -> None:
    # Windows 11 EcoQoS parked the gate's windowless test processes on the
    # efficiency cores (a 7.7 s jsdom file took 45 s); the keeper opts every
    # descendant out, so its tree walk must be exact and cycle-safe.
    module = _load_script_module("power_throttling_keeper.py")
    parents = {10: 1, 11: 10, 12: 11, 13: 10, 20: 2, 21: 20, 0: 0, 30: 31, 31: 30}

    assert module._descendant_pids(parents, 10) == {11, 12, 13}
    assert module._descendant_pids(parents, 99) == set()
    assert module._descendant_pids(parents, 30) == {31, 30}
    # A stale parent PID (reused by a newer process) must not adopt an orphan:
    # pid 13 claims parent 10 but the caller says that edge is not real.
    assert module._descendant_pids(parents, 10, lambda parent, child: child != 13) == {11, 12}


def test_run_ci_power_throttling_keeper_is_a_no_op_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_script_module("power_throttling_keeper.py")
    monkeypatch.setattr(module.sys, "platform", "linux")

    assert module._start_power_throttling_keeper() is None


@pytest.mark.skipif(not sys.platform.startswith("win"), reason="Windows power throttling only")
def test_run_ci_power_throttling_keeper_opts_out_a_spawned_child(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_script_module("power_throttling_keeper.py")
    # start() marks the tree as covered for child runners; keep that out of
    # the rest of this pytest worker's environment.
    monkeypatch.setenv(module.ACTIVE_ENV_VAR, "0")
    assert _load_script_module("run_ci.py")._start_power_throttling_keeper.__module__ == (
        "scripts.checks.power_throttling_keeper")
    keeper = module._start_power_throttling_keeper()
    assert keeper is not None
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
    try:
        deadline = time.monotonic() + 5
        while child.pid not in keeper._handled and time.monotonic() < deadline:
            time.sleep(0.05)
        assert child.pid in keeper._handled
        keeper.stop()
        assert keeper.sweep() == 0, "a handled process is not opted out twice"
        # Windows reuses PIDs: a process holding a handled PID with another
        # creation time is a new process and still needs the opt-out.
        keeper._handled[child.pid] -= 1
        assert keeper.sweep() == 1
        assert keeper.root_alive()
        # A stopped keeper no longer claims the tree for runners started later.
        assert os.environ.get(module.ACTIVE_ENV_VAR) == "0"
        watcher = module._PowerThrottlingKeeper(child.pid)
        assert watcher.root_alive()
        child.kill()
        child.wait()
        assert not watcher.root_alive(), "an exited root reads as gone while its handle is still held"
    finally:
        child.kill()
        child.wait()
        keeper.stop()
    assert not keeper._thread.is_alive()

def test_run_ci_lints_the_sidecar_with_ruff_beside_eslint() -> None:
    # Sidecar ruff joined the gate on 2026-09-25 (sweep S5); `make lint` runs the same command.
    module = _load_script_module("run_ci.py")
    names = [stage.name for stage in module.STAGES]
    lint_stage = next(stage for stage in module.STAGES if stage.name == "lint")
    ruff_stage = next(stage for stage in module.STAGES if stage.name == "lint_py")

    assert names.index("lint_py") == names.index("lint") + 1
    assert ruff_stage.wave == lint_stage.wave == 1
    assert ruff_stage.command == [sys.executable, "-m", "ruff", "check", "sidecar", "tests/sidecar"]
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    expected = "lint:\n\tpython -m ruff check sidecar tests/sidecar\n"
    assert expected in makefile.replace("\r\n", "\n")


def _write_ratchet_fixture(root: Path) -> dict[str, Path]:
    baseline = root / "baseline.json"
    baseline.write_text(json.dumps({
        "epsilon": 0.5,
        "js": {"overall_lines_pct": 70.0, "ratchet_enforced": True, "per_file": {"a.js": 50.0}},
        "sidecar": {"overall_lines_pct": 80.0, "ratchet_enforced": True, "per_module": {"sidecar/x.py": 90.0}},
    }), encoding="utf-8")
    js_summary = root / "coverage-summary.json"
    # Stale JS artifact that would fail both the floor and the deleted-test smell.
    js_summary.write_text(json.dumps({
        "total": {"lines": {"pct": 10.0}},
        "a.js": {"lines": {"covered": 0, "total": 10}},
    }), encoding="utf-8")
    py_summary = root / "coverage.json"
    py_summary.write_text(json.dumps({
        "totals": {"percent_covered": 80.5},
        "files": {"sidecar/x.py": {"summary": {"covered_lines": 9, "num_statements": 10}}},
    }), encoding="utf-8")
    return {"baseline": baseline, "js": js_summary, "py": py_summary, "c8rc": root / "missing.c8rc.json"}


def _ratchet_args(paths: dict[str, Path], *extra: str) -> list[str]:
    return [
        f"--baseline={paths['baseline']}", f"--js-summary={paths['js']}",
        f"--py-summary={paths['py']}", f"--c8rc={paths['c8rc']}", *extra,
    ]


def test_coverage_ratchet_sidecar_scope_ignores_a_stale_js_artifact(tmp_path, capsys) -> None:
    module = _load_script_module("check_coverage_ratchet.py")
    paths = _write_ratchet_fixture(tmp_path)

    # Mutation: with both scopes the stale JS artifact fails the gate.
    assert module.main(_ratchet_args(paths)) == 1
    capsys.readouterr()

    assert module.main(_ratchet_args(paths, "--scope=sidecar")) == 0
    output = capsys.readouterr().out
    assert "js: scope not selected" in output
    assert "PASS: sidecar:" in output


def test_coverage_ratchet_sidecar_scope_still_fails_a_sidecar_smell(tmp_path, capsys) -> None:
    module = _load_script_module("check_coverage_ratchet.py")
    paths = _write_ratchet_fixture(tmp_path)
    paths["py"].write_text(json.dumps({
        "totals": {"percent_covered": 80.5},
        "files": {"sidecar/x.py": {"summary": {"covered_lines": 0, "num_statements": 10}}},
    }), encoding="utf-8")

    assert module.main(_ratchet_args(paths, "--scope=sidecar")) == 1
    assert "deleted-test smell" in capsys.readouterr().out
    assert module.main(_ratchet_args(paths, "--scope=bogus")) == 2


def test_run_ci_timeout_reaping_has_a_bounded_kill_fallback() -> None:
    module = _load_script_module("run_ci.py")

    class FakeProcess:
        waits = 0
        killed = False

        def wait(self, *, timeout):
            self.waits += 1
            if self.waits == 1:
                raise module.subprocess.TimeoutExpired(["hung-stage"], timeout)
            return 0

        def kill(self):
            self.killed = True

    process = FakeProcess()
    module._reap_stage_process(process)
    assert process.killed is True
    assert process.waits == 2
