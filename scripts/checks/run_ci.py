"""Run the canonical local CI quality gate.

Stages run in waves: independent stages within a wave execute concurrently
(subprocesses, so threads are fine), and each wave is a barrier -- wave N+1
only starts once every stage in wave N has finished. A failure in wave 0
(the cheap policy gate) stops everything immediately since it gates the
rest of the suite; failures in later waves do not skip subsequent waves --
every stage still runs and is reported.

Set JENNY_CI_SERIAL=1 to fall back to the exact legacy serial behavior
(same stage list and commands, run one at a time with streamed output).
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NPM_COMMAND = "npm.cmd" if sys.platform.startswith("win") else "npm"

# pytest-xdist fans the sidecar suite out across 8 workers. The Node lane uses
# 10 workers so the concurrent wave keeps two logical CPUs of headroom for each
# child process's own threads and Windows filesystem/antivirus work. Eight Node
# workers stretched the lane to 420.8s; twelve plus pytest ended the Node parent
# early under contention even though the same 12-worker lane passed standalone.
_PYTEST_WORKERS = "8"
_NODE_WORKERS = "10"
DEFAULT_GLOBAL_TIMEOUT_SECONDS = 900
HEARTBEAT_INTERVAL_SECONDS = 15
FAILURE_TAIL_LINES = 200


@dataclass(frozen=True)
class Stage:
    name: str
    command: list[str]
    wave: int
    env: dict[str, str] | None = field(default=None)


# Coverage floor lives in pyproject.toml [tool.coverage.report] fail_under
# (single source of truth); pytest-cov reads it with no --cov-fail-under flag.
# See docs/plans/TEST_COVERAGE_RATCHET.md.
_PYTEST_CMD = [
    sys.executable, "-m", "pytest", "tests/sidecar",
    "-n", _PYTEST_WORKERS, "--dist=loadscope",
    "-vv", "--durations=25", "--durations-min=1.0",
    "--cov=sidecar", "--cov-report=term-missing",
]

# Timeout-enforced wrapper so a hanging Node suite can't stall the gate;
# --include-load runs the *.load.test.js perf suites (excluded from the
# fast/stable lanes) exactly once, here on the heavy lane. Budget is a hang
# backstop, not a pacing target: per-file timeouts catch real hangs, and this
# lane includes the load files but runs at the proven 10-worker width. Keep the
# whole lock-wait + execution budget at 10 minutes: a test lane must never
# consume the old 15-minute lock allowance before execution even begins.
_NODE_TEST_CMD = [NPM_COMMAND, "run", "test:safe", "--", "--timeout-ms=600000", "--include-load"]

STAGES: list[Stage] = [
    Stage("policy", [sys.executable, "scripts/checks/run_all.py"], wave=0),
    Stage("backend_contract_tests",
          [sys.executable, "scripts/checks/run_backend_contract_tests.py"], wave=1),
    Stage("mypy", [sys.executable, "-m", "mypy", "sidecar"], wave=1),
    Stage("lint", [NPM_COMMAND, "run", "lint"], wave=1),
    Stage(
        "smoke_packaged_flow",
        [
            sys.executable,
            "scripts/packaging/smoke_packaged_flow.py",
            "--timeout-seconds",
                "480",
            "--step-timeout-seconds",
                "480",
            "--allow-stale-source",
        ],
        # Packaging is the serial release tail so its process tree does not
        # compete with the settled 10-Node + 8-pytest heavy wave.
        wave=3,
    ),
    Stage("pytest_sidecar", _PYTEST_CMD, wave=2),
    Stage("node_test_safe", _NODE_TEST_CMD, wave=2, env={"JENNY_TEST_WORKERS": _NODE_WORKERS}),
]

_PRINT_LOCK = threading.Lock()


@dataclass
class StageResult:
    stage: Stage
    passed: bool
    duration: float
    output: str
    ran: bool = True


def _stage_env(stage: Stage) -> dict[str, str] | None:
    if stage.env is None:
        return None
    merged = dict(os.environ)
    merged.update(stage.env)
    return merged


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if sys.platform.startswith("win"):
        try:
            taskkill_result = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
            if taskkill_result.returncode == 0:
                return
            detail = (taskkill_result.stderr or taskkill_result.stdout or "taskkill failed").strip()
            print(f"WARN: taskkill failed; killing parent process: {detail[-500:]}", file=sys.stderr)
        except (OSError, subprocess.TimeoutExpired):
            pass
        try:
            process.kill()
        except OSError:
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def _print_stage_event(stage: Stage, started_at: float, message: str) -> None:
    elapsed = time.monotonic() - started_at
    timestamp = time.strftime("%H:%M:%S")
    with _PRINT_LOCK:
        print(f"[{timestamp}] [{stage.name} +{elapsed:.1f}s] {message}", flush=True)


def _stream_stage_output(
    process: subprocess.Popen[str],
    stage: Stage,
    started_at: float,
    output_tail: deque[str],
) -> None:
    stream = process.stdout
    if stream is None:
        return
    try:
        for line in iter(stream.readline, ""):
            output_tail.append(line)
            _print_stage_event(stage, started_at, line.rstrip("\r\n"))
    except (OSError, ValueError) as error:
        output_tail.append(f"output monitor stopped: {error}\n")


def _reap_stage_process(process: subprocess.Popen[str]) -> None:
    try:
        process.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        return


def _run_stage_buffered(stage: Stage, *, verbose: bool, deadline: float) -> StageResult:
    start = time.monotonic()
    remaining = deadline - start
    if remaining <= 0:
        return StageResult(stage=stage, passed=False, duration=0.0,
                           output="global CI deadline exhausted before stage start")
    _ = verbose  # Kept for CLI compatibility; live output is now always enabled.
    _print_stage_event(stage, start, f"START {' '.join(stage.command)}")
    try:
        process = subprocess.Popen(
            stage.command,
            cwd=ROOT,
            env=_stage_env(stage),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
            start_new_session=not sys.platform.startswith("win"),
        )
    except OSError as error:
        duration = time.monotonic() - start
        output = f"unable to start stage: {error}"
        _print_stage_event(stage, start, f"FAIL {output}")
        return StageResult(stage=stage, passed=False, duration=duration, output=output)

    output_tail: deque[str] = deque(maxlen=FAILURE_TAIL_LINES)
    reader = threading.Thread(
        target=_stream_stage_output,
        args=(process, stage, start, output_tail),
        name=f"ci-output-{stage.name}",
        daemon=True,
    )
    reader.start()
    returncode: int | None = None
    timed_out = False
    try:
        while returncode is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                returncode = process.wait(
                    timeout=min(HEARTBEAT_INTERVAL_SECONDS, remaining)
                )
            except subprocess.TimeoutExpired:
                _print_stage_event(
                    stage,
                    start,
                    f"HEARTBEAT running; {max(0, deadline - time.monotonic()):.0f}s global budget left",
                )
    finally:
        if timed_out:
            _print_stage_event(stage, start, "GLOBAL TIMEOUT; terminating process tree")
            _terminate_process_tree(process)
            _reap_stage_process(process)
            returncode = -1
        reader.join(timeout=5)

    duration = time.monotonic() - start
    passed = returncode == 0
    output = "".join(output_tail)
    if returncode == -1:
        output += "\nGLOBAL TIMEOUT: stage process tree terminated at the CI deadline.\n"

    status = "PASS" if passed else "FAIL"
    _print_stage_event(stage, start, f"{status} ({duration:.1f}s)")

    return StageResult(stage=stage, passed=passed, duration=duration, output=output)


def _run_stage_serial(stage: Stage, *, deadline: float) -> StageResult:
    return _run_stage_buffered(stage, verbose=True, deadline=deadline)


def _waves(stages: list[Stage]) -> list[list[Stage]]:
    by_wave: dict[int, list[Stage]] = {}
    for stage in stages:
        by_wave.setdefault(stage.wave, []).append(stage)
    return [by_wave[key] for key in sorted(by_wave)]


def _filter_stages(stages: list[Stage]) -> list[Stage]:
    # Test-only seam: JENNY_CI_STAGE_FILTER=name,name restricts the run to a
    # subset of stages (by name) without touching the real stage list. Unknown
    # names are a hard error so a typo can't silently no-op the filter.
    raw = os.environ.get("JENNY_CI_STAGE_FILTER")
    if not raw:
        return stages
    requested = [n.strip() for n in raw.split(",") if n.strip()]
    known = {s.name for s in stages}
    if not requested:
        print("ERROR: JENNY_CI_STAGE_FILTER must name at least one stage")
        print(f"Known stage names: {', '.join(sorted(known))}")
        raise SystemExit(2)
    unknown = [n for n in requested if n not in known]
    if unknown:
        print(f"ERROR: unknown stage name(s) in JENNY_CI_STAGE_FILTER: {', '.join(unknown)}")
        print(f"Known stage names: {', '.join(sorted(known))}")
        raise SystemExit(2)
    wanted = set(requested)
    return [s for s in stages if s.name in wanted]


def _print_list(stages: list[Stage], *, serial: bool) -> None:
    mode = "SERIAL (JENNY_CI_SERIAL=1)" if serial else "WAVES"
    print(f"=== run_ci.py --list ({mode}) ===")
    if serial:
        for stage in stages:
            print(f"  [{stage.name}] {' '.join(stage.command)}")
        return
    for wave_stages in _waves(stages):
        wave_no = wave_stages[0].wave
        print(f"wave {wave_no}:")
        for stage in wave_stages:
            print(f"  [{stage.name}] {' '.join(stage.command)}")


def _run_serial(stages: list[Stage], *, deadline: float) -> list[StageResult]:
    results: list[StageResult] = []
    for stage in stages:
        result = _run_stage_serial(stage, deadline=deadline)
        results.append(result)
        if not result.passed and stage.wave == 0:
            return results
    return results


def _run_waves(stages: list[Stage], *, verbose: bool, fail_fast: bool,
               deadline: float) -> list[StageResult]:
    results: list[StageResult] = []
    stopped = False

    for wave_stages in _waves(stages):
        if stopped:
            results.extend(
                StageResult(stage=s, passed=False, duration=0.0, output="", ran=False)
                for s in wave_stages
            )
            continue

        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {
                pool.submit(_run_stage_buffered, stage, verbose=verbose, deadline=deadline): stage
                for stage in wave_stages
            }
            for future in as_completed(futures):
                results.append(future.result())

        wave_failed = any(not r.passed for r in results[-len(wave_stages):])
        if wave_stages[0].wave == 0 and wave_failed:
            # Policy barrier: stop everything, nothing later gets scheduled.
            stopped = True
        elif fail_fast and wave_failed:
            stopped = True

    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--list",
        action="store_true",
        help="Print the resolved waves/stages/commands without running them.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Compatibility flag; stage output is always streamed live.",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="On first failure, skip scheduling remaining stages (already-running ones finish).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_GLOBAL_TIMEOUT_SECONDS,
        help="Hard global gate budget including every stage and lock wait (default: 900).",
    )
    args = parser.parse_args()

    serial_mode = os.environ.get("JENNY_CI_SERIAL") == "1"
    stages = _filter_stages(STAGES)

    if args.list:
        _print_list(stages, serial=serial_mode)
        return 0

    if args.timeout_seconds <= 0 or args.timeout_seconds > DEFAULT_GLOBAL_TIMEOUT_SECONDS:
        parser.error(f"--timeout-seconds must be between 1 and {DEFAULT_GLOBAL_TIMEOUT_SECONDS}")
    deadline = time.monotonic() + args.timeout_seconds

    if serial_mode:
        results = _run_serial(stages, deadline=deadline)
    else:
        results = _run_waves(stages, verbose=args.verbose, fail_fast=args.fail_fast,
                             deadline=deadline)

    failed = [r.stage.name for r in results if r.ran and not r.passed]
    not_run = [r.stage.name for r in results if not r.ran]

    print("=== SUMMARY ===")
    for result in results:
        if not result.ran:
            print(f"NOT RUN: {result.stage.name}")
            continue
        status = "PASS" if result.passed else "FAIL"
        print(f"{status}: {result.stage.name} ({result.duration:.1f}s)")

    if failed or not_run:
        parts = failed + [f"{n} (NOT RUN)" for n in not_run]
        print(f"FAIL: {', '.join(parts)}")
        return 1

    print("PASS: active app CI gate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
