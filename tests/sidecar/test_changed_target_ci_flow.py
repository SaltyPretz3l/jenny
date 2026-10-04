from __future__ import annotations

import importlib.util
import io
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
