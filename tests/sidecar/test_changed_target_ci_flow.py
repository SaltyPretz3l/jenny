from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType


def _load_script_module(script_name: str) -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / script_name
    module_name = f"test_loader_{script_name}"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError(f"unable to load script module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _write_mapping(repo_root: Path, mapping: dict[str, object]) -> Path:
    map_path = repo_root / "scripts" / "checks" / "changed_target_test_map.json"
    map_path.parent.mkdir(parents=True, exist_ok=True)
    map_path.write_text(json.dumps(mapping), encoding="utf-8")
    return map_path


def _write_test_file(repo_root: Path, relative_path: str) -> None:
    path = repo_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("def test_stub() -> None:\n    assert True\n", encoding="utf-8")


def _git(repo_root: Path, *arguments: str) -> None:
    subprocess.run(
        ["git", *arguments],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )


def test_run_changed_target_tests_falls_back_to_all_mapped_tests_when_git_is_unavailable(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    _write_test_file(repo_root, "tests/sidecar/ai/engines/test_factory.py")
    _write_test_file(repo_root, "tests/sidecar/ai/tools/test_executor.py")
    map_path = _write_mapping(
        repo_root,
        {
            "rules": [
                {
                    "target_prefixes": ["sidecar/ai/engines/"],
                    "required_tests": ["tests/sidecar/ai/engines/test_factory.py"],
                },
                {
                    "target_prefixes": ["sidecar/ai/tools/"],
                    "required_tests": ["tests/sidecar/ai/tools/test_executor.py"],
                },
            ]
        },
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main(["--dry-run"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "fallback reason" in output
    assert "tests/sidecar/ai/engines/test_factory.py" in output
    assert "tests/sidecar/ai/tools/test_executor.py" in output


def test_run_changed_target_tests_selects_mapped_tests_for_explicit_changed_file(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    _write_test_file(repo_root, "tests/sidecar/ai/engines/test_factory.py")
    _write_test_file(repo_root, "tests/sidecar/ai/tools/test_executor.py")
    map_path = _write_mapping(
        repo_root,
        {
            "rules": [
                {
                    "target_prefixes": ["sidecar/ai/engines/"],
                    "required_tests": ["tests/sidecar/ai/engines/test_factory.py"],
                },
                {
                    "target_prefixes": ["sidecar/ai/tools/"],
                    "required_tests": ["tests/sidecar/ai/tools/test_executor.py"],
                },
            ]
        },
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main(
        [
            "--dry-run",
            "--changed-file",
            "sidecar/ai/tools/executor.py",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "tests/sidecar/ai/tools/test_executor.py" in output
    assert "tests/sidecar/ai/engines/test_factory.py" not in output


def test_run_changed_target_tests_preserves_exact_file_selectors(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    _write_test_file(repo_root, "tests/sidecar/test_exact.py")
    map_path = _write_mapping(
        repo_root,
        {
            "rules": [
                {
                    "target_prefixes": ["services/backend/backend-auth.js"],
                    "required_tests": ["tests/sidecar/test_exact.py"],
                }
            ]
        },
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)
    rules, violations = module._load_mapping_rules()

    assert violations == []
    assert rules[0].target_prefixes == ("services/backend/backend-auth.js",)
    selected, selectors = module._select_mapped_tests(
        changed_files=["services/backend/backend-auth.js"],
        rules=rules,
    )
    assert selected == ["tests/sidecar/test_exact.py"]
    assert selectors == ["services/backend/backend-auth.js"]
    sibling_selected, _ = module._select_mapped_tests(
        changed_files=["services/backend/backend-auth-extra.js"],
        rules=rules,
    )
    assert sibling_selected == []


def test_run_changed_target_tests_supports_skip_fallback_mode(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    _write_test_file(repo_root, "tests/sidecar/ai/tools/test_executor.py")
    map_path = _write_mapping(
        repo_root,
        {
            "rules": [
                {
                    "target_prefixes": ["sidecar/ai/tools/"],
                    "required_tests": ["tests/sidecar/ai/tools/test_executor.py"],
                }
            ]
        },
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main(["--dry-run", "--fallback-mode", "skip"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "fallback reason" in output
    assert "selected_tests=0" in output
    assert "tests/sidecar/ai/tools/test_executor.py" not in output


def test_run_changed_target_tests_reports_no_selection_for_non_mapped_change(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    _write_test_file(repo_root, "tests/sidecar/ai/tools/test_executor.py")
    map_path = _write_mapping(
        repo_root,
        {
            "rules": [
                {
                    "target_prefixes": ["sidecar/ai/tools/"],
                    "required_tests": ["tests/sidecar/ai/tools/test_executor.py"],
                }
            ]
        },
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main(
        [
            "--dry-run",
            "--changed-file",
            "renderer/App.tsx",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "selected_tests=0" in output


def test_run_changed_target_tests_uses_merge_base_range_when_git_is_available(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True, exist_ok=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 0, "abc123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "abc123...HEAD"]:
            return 0, "sidecar/ai/tools/executor.py\n", ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, "", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(base_ref=None, head_ref=None)

    assert fallback_reason is None
    assert changed_files == ["sidecar/ai/tools/executor.py"]


def test_run_changed_target_tests_falls_back_to_local_main_when_origin_main_is_unavailable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True, exist_ok=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 1, "", "no merge-base"
        if args == ["merge-base", "main", "HEAD"]:
            return 0, "remote123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "remote123...HEAD"]:
            return 0, "sidecar/ai/tools/executor.py\n", ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, " M sidecar/ai/engines/provider_http.py\n", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(base_ref=None, head_ref=None)

    assert fallback_reason is None
    assert changed_files == [
        "sidecar/ai/tools/executor.py",
        "sidecar/ai/engines/provider_http.py",
    ]


def test_run_changed_target_tests_falls_back_to_git_status_when_merge_bases_are_unavailable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True, exist_ok=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args[0] == "merge-base":
            return 1, "", "no merge-base"
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, " M sidecar/ai/engines/provider_http.py\n", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(base_ref=None, head_ref=None)

    assert fallback_reason is not None
    assert "git merge-base failed" in fallback_reason
    assert changed_files == ["sidecar/ai/engines/provider_http.py"]


def test_run_changed_target_tests_selects_mapped_tests_for_committed_deletion(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _git(repo_root, "init")
    _git(repo_root, "config", "user.email", "tests@example.invalid")
    _git(repo_root, "config", "user.name", "Jenny Tests")
    source_path = repo_root / "sidecar" / "runtime" / "retry.py"
    source_path.parent.mkdir(parents=True)
    source_path.write_text("RETRY = True\n", encoding="utf-8")
    _write_test_file(repo_root, "tests/sidecar/runtime/test_retry.py")
    _git(repo_root, "add", ".")
    _git(repo_root, "commit", "-m", "add mapped source")
    source_path.unlink()
    _git(repo_root, "add", "-A")
    _git(repo_root, "commit", "-m", "delete mapped source")
    monkeypatch.setattr(module, "ROOT", repo_root)

    result = module.resolve_selection(
        rules=[
            module.MappingRule(
                target_prefixes=("sidecar/runtime/",),
                required_tests=("tests/sidecar/runtime/test_retry.py",),
            )
        ],
        explicit_changed_files=[],
        base_ref="HEAD~1",
        head_ref="HEAD",
        fallback_mode=module.FALLBACK_ALL_MAPPED,
    )

    assert result.changed_files == ("sidecar/runtime/retry.py",)
    assert result.selected_tests == ("tests/sidecar/runtime/test_retry.py",)


def test_run_changed_target_tests_uses_full_fallback_when_all_merge_bases_fail(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("run_changed_target_tests.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args[0] == "merge-base":
            return 1, "", "no merge base"
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, " M sidecar/ai/engines/provider_http.py\n", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)
    result = module.resolve_selection(
        rules=[
            module.MappingRule(
                target_prefixes=("sidecar/ai/engines/",),
                required_tests=("tests/sidecar/ai/engines/test_factory.py",),
            ),
            module.MappingRule(
                target_prefixes=("sidecar/ai/tools/",),
                required_tests=("tests/sidecar/ai/tools/test_executor.py",),
            ),
        ],
        explicit_changed_files=[],
        base_ref=None,
        head_ref=None,
        fallback_mode=module.FALLBACK_ALL_MAPPED,
    )

    assert result.source == "fallback"
    assert result.changed_files == ("sidecar/ai/engines/provider_http.py",)
    assert result.fallback_reason is not None
    assert "git merge-base failed" in result.fallback_reason
    assert result.selected_tests == (
        "tests/sidecar/ai/engines/test_factory.py",
        "tests/sidecar/ai/tools/test_executor.py",
    )


def _fake_ci_stages(module: ModuleType) -> list[object]:
    # One stage per wave keeps completion order deterministic even though
    # stages within a wave run concurrently.
    return [
        module.Stage("pre-stage", ["pre-stage"], wave=0),
        module.Stage("post-stage", ["post-stage"], wave=1),
        module.Stage("packaging-stage", ["packaging-stage"], wave=2),
    ]


def _fake_popen_type(module: ModuleType, observed: list[list[str]], returncode_for):
    class _FakeProcess:
        pid = 12345

        def __init__(self, command: list[str], **kwargs) -> None:
            assert kwargs["cwd"] == module.ROOT
            assert kwargs["text"] is True
            observed.append(command)
            self.returncode = returncode_for(command)
            self.stdout = io.StringIO("")

        def wait(self, timeout=None) -> int:
            assert timeout is not None
            return self.returncode

        def poll(self) -> int:
            return self.returncode

    return _FakeProcess


def test_run_ci_streams_stage_output_and_heartbeats(monkeypatch, capsys) -> None:
    module = _load_script_module("run_ci.py")
    stage = module.Stage("observed", ["observed"], wave=1)

    class FakeProcess:
        stdout = io.StringIO("running tests/example.test.js\n")
        returncode = 0
        waits = 0

        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def wait(self, timeout=None) -> int:
            self.waits += 1
            if self.waits == 1:
                raise module.subprocess.TimeoutExpired(["observed"], timeout)
            return self.returncode

    monkeypatch.setattr(module.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(module, "HEARTBEAT_INTERVAL_SECONDS", 0.01)

    result = module._run_stage_buffered(
        stage,
        verbose=False,
        deadline=module.time.monotonic() + 10,
    )
    output = capsys.readouterr().out

    assert result.passed is True
    assert "[observed +" in output
    assert "START observed" in output
    assert "running tests/example.test.js" in output
    assert "HEARTBEAT running" in output
    assert "PASS" in output


def test_run_ci_windows_tree_cleanup_falls_back_when_taskkill_fails(
    monkeypatch, capsys
) -> None:
    module = _load_script_module("run_ci.py")

    class FakeProcess:
        pid = 4321
        killed = False

        def poll(self):
            return None

        def kill(self) -> None:
            self.killed = True

    process = FakeProcess()
    monkeypatch.setattr(module.sys, "platform", "win32")
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Completed",
            (),
            {"returncode": 1, "stdout": "", "stderr": "access denied"},
        )(),
    )

    module._terminate_process_tree(process)
    captured = capsys.readouterr()

    assert process.killed is True
    assert "access denied" in captured.err


def test_run_ci_rejects_empty_stage_filter(monkeypatch, capsys) -> None:
    module = _load_script_module("run_ci.py")
    monkeypatch.setenv("JENNY_CI_STAGE_FILTER", ",")

    try:
        module._filter_stages(_fake_ci_stages(module))
    except SystemExit as error:
        assert error.code == 2
    else:
        raise AssertionError("empty stage filter was accepted")

    assert "JENNY_CI_STAGE_FILTER" in capsys.readouterr().out


def test_run_ci_runs_active_app_stages_in_order(monkeypatch, capsys) -> None:
    module = _load_script_module("run_ci.py")
    monkeypatch.setattr(module, "STAGES", _fake_ci_stages(module))
    monkeypatch.setattr(sys, "argv", ["run_ci.py"])
    monkeypatch.delenv("JENNY_CI_SERIAL", raising=False)
    monkeypatch.delenv("JENNY_CI_STAGE_FILTER", raising=False)

    observed: list[list[str]] = []

    monkeypatch.setattr(
        module.subprocess,
        "Popen",
        _fake_popen_type(module, observed, lambda _command: 0),
    )

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    # Waves are barriers: one stage per wave means strict execution order.
    assert observed == [["pre-stage"], ["post-stage"], ["packaging-stage"]]
    assert "PASS: active app CI gate" in output


def test_run_ci_reports_packaging_failure_without_skipping_stages(monkeypatch, capsys) -> None:
    # A non-wave-0 failure must not skip later stages (all stages required,
    # every failure reported in one run) and must exit non-zero.
    module = _load_script_module("run_ci.py")
    monkeypatch.setattr(module, "STAGES", _fake_ci_stages(module))
    monkeypatch.setattr(sys, "argv", ["run_ci.py"])
    monkeypatch.delenv("JENNY_CI_SERIAL", raising=False)
    monkeypatch.delenv("JENNY_CI_STAGE_FILTER", raising=False)

    observed: list[list[str]] = []

    monkeypatch.setattr(
        module.subprocess,
        "Popen",
        _fake_popen_type(
            module,
            observed,
            lambda command: 2 if command == ["post-stage"] else 0,
        ),
    )

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert observed == [["pre-stage"], ["post-stage"], ["packaging-stage"]]
    assert "FAIL: post-stage" in output


def test_run_ci_policy_failure_stops_everything(monkeypatch, capsys) -> None:
    # Wave 0 is the policy barrier: its failure must prevent every later
    # stage from being scheduled, and the summary must name them NOT RUN.
    module = _load_script_module("run_ci.py")
    monkeypatch.setattr(module, "STAGES", _fake_ci_stages(module))
    monkeypatch.setattr(sys, "argv", ["run_ci.py"])
    monkeypatch.delenv("JENNY_CI_SERIAL", raising=False)
    monkeypatch.delenv("JENNY_CI_STAGE_FILTER", raising=False)

    observed: list[list[str]] = []

    monkeypatch.setattr(
        module.subprocess,
        "Popen",
        _fake_popen_type(
            module,
            observed,
            lambda command: 1 if command == ["pre-stage"] else 0,
        ),
    )

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert observed == [["pre-stage"]]
    assert "NOT RUN: post-stage" in output
    assert "NOT RUN: packaging-stage" in output
