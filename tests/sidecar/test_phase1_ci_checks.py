from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tomllib
from datetime import date
from pathlib import Path
from types import ModuleType

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
    assert all(kwargs["label"] == check for check, kwargs in zip(module.CHECKS, observed_kwargs))
    assert all(kwargs["timeout_seconds"] == module.CHECK_TIMEOUT_SECONDS for kwargs in observed_kwargs)
    assert all(kwargs["cwd"] == module.ROOT for kwargs in observed_kwargs)
    assert all(kwargs["encoding"] is None for kwargs in observed_kwargs)


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
    assert node_stage.env == {"JENNY_TEST_WORKERS": "10"}
    assert "--timeout-ms=600000" in node_stage.command
    assert module.DEFAULT_GLOBAL_TIMEOUT_SECONDS == 900

    package_stage = next(stage for stage in module.STAGES if stage.name == "smoke_packaged_flow")
    assert package_stage.wave == 3
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
