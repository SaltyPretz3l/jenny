"""Multi-stage test commands: run_ci.py stage prefixes and sequential runner lanes."""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.tools.builtins.test_progress_stages import MAX_STAGES, StagedTestProgress


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def make(command: str = "python scripts/checks/run_ci.py") -> StagedTestProgress:
    return StagedTestProgress(
        command=command,
        cwd=Path.cwd(),
        workspace_root=Path.cwd(),
        clock=FakeClock(),
        start_manifest_thread=False,
    )


def feed(tracker: StagedTestProgress, lines: list[str]) -> None:
    for line in lines:
        tracker.feed_line(line)


def snap(tracker: StagedTestProgress, *, final: bool = False) -> dict[str, object]:
    snapshot = tracker.snapshot(final=final)
    assert snapshot is not None
    return snapshot


def ci(stage: str, line: str, at: float = 1.0) -> str:
    """One line exactly as run_ci.py `_print_stage_event` prints it."""
    return f"[12:27:{int(at) % 60:02d}] [{stage} +{at:.1f}s] {line}"


PYTEST_CMD = (
    r"G:\Work\jenny\.venv\Scripts\python.exe -m pytest tests/sidecar -n 12 --dist=loadscope -vv"
)


def test_run_ci_follows_the_biggest_pytest_stage_then_hands_over_to_the_node_lane() -> None:
    tracker = make()
    feed(
        tracker,
        [
            "[power-throttling keeper] opted 3 process(es) out",
            ci("policy", "START python scripts/checks/run_all.py", 0.0),
            ci("policy", "PASS: all policy checks", 4.0),
            ci("policy", "PASS (4.2s)", 4.2),
            ci(
                "backend_contract_tests",
                "START python scripts/checks/run_backend_contract_tests.py",
            ),
            ci("pytest_sidecar", f"START {PYTEST_CMD}"),
            ci("lint", "START npm run lint"),
            ci("backend_contract_tests", "........................ [ 60%]", 3.0),
        ],
    )
    first = snap(tracker)
    assert first["runner"] == "pytest"
    assert first["stage"] == 0
    assert first["total"] == 40  # inferred from the -q percent

    feed(
        tracker,
        [
            ci("pytest_sidecar", "12 workers [200 items]", 5.0),
            ci("lint", "> eslint .", 5.0),
            ci("pytest_sidecar", "[gw3] [  1%] PASSED tests/sidecar/a/test_x.py::test_one", 6.0),
            ci("pytest_sidecar", "[gw1] [  1%] FAILED tests/sidecar/b/test_y.py::test_two", 6.1),
            ci("backend_contract_tests", "................ [100%]", 6.2),
            ci("pytest_sidecar", "HEARTBEAT running; 1700s global budget left", 30.0),
        ],
    )
    sidecar = snap(tracker)
    assert sidecar["stage"] == 1
    assert sidecar["total"] == 200
    assert (sidecar["passed"], sidecar["failed"]) == (1, 1)  # backend lines never leak in
    assert [f["name"] for f in sidecar["failures"]] == ["test_two"]  # type: ignore[index, union-attr]
    assert tracker._named["pytest_sidecar"].tracker._command == PYTEST_CMD

    feed(
        tracker,
        [
            ci("backend_contract_tests", "40 passed in 6.30s", 6.3),
            ci("backend_contract_tests", "PASS (6.5s)", 6.5),
            ci("pytest_sidecar", "========= 1 failed, 199 passed in 300.00s =========", 300.0),
            ci("pytest_sidecar", "FAIL (301.0s)", 301.0),
        ],
    )
    assert not tracker.has_update() or snap(tracker)["stage"] == 1

    feed(
        tracker,
        [
            ci(
                "node_test_safe",
                "START npm run test:safe -- --timeout-ms=1200000 --include-load",
                0.0,
            ),
            ci("node_test_safe", "> jenny@1.6.0 test:safe", 0.5),
            ci("node_test_safe", "[run-node-tests-safe] files 3", 1.0),
            ci(
                "node_test_safe",
                "[run-node-tests-safe] progress 1/3 fail tests/a.test.js (4 tests)",
                2.0,
            ),
        ],
    )
    node = snap(tracker)
    assert node["stage"] == 2
    assert node["runner"] == "node_safe"
    assert (node["done"], node["total"]) == (1, 3)

    summary = tracker.summary()
    assert summary is not None
    assert summary["runner"] == "pytest"  # the first failing stage leads the finished row
    assert summary["failed"] == 2
    assert [f["name"] for f in summary["failures"]] == ["test_two", "a.test.js"]  # type: ignore[index, union-attr]


def test_run_ci_bookkeeping_lines_never_reach_a_stage() -> None:
    tracker = make()
    feed(
        tracker,
        [
            ci("pytest_sidecar", f"START {PYTEST_CMD}"),
            ci("pytest_sidecar", "HEARTBEAT running; 900s global budget left"),
            ci("pytest_sidecar", "PASS (1.0s)"),
            "=== SUMMARY ===",
            "PASS: pytest_sidecar (1.0s)",
            "PASS: active app CI gate",
        ],
    )
    assert tracker.snapshot() is None
    assert tracker.summary() is None


def test_sequential_lanes_hand_over_from_node_to_pytest() -> None:
    tracker = make("npm run test:affected")
    feed(
        tracker,
        [
            "[affected] node lane: 2 file(s) -> run-node-tests-safe.js",
            "[run-node-tests-safe] files 2",
            "[run-node-tests-safe] progress 1/2 pass tests/a.test.js (3 tests)",
            "[run-node-tests-safe] progress 2/2 pass tests/b.test.js (5 tests)",
            "[run-node-tests-safe] 2 passed, 0 failed",
        ],
    )
    assert snap(tracker)["runner"] == "node_safe"
    feed(
        tracker,
        [
            "[affected] python lane: 1 test file(s) -> pytest -q",
            "....F..... [100%]",
            "FAILED tests/sidecar/test_q.py::test_bad - assert 1 == 2",
            "1 failed, 9 passed in 0.50s",
        ],
    )
    pytest = snap(tracker)
    assert (pytest["runner"], pytest["stage"], pytest["failed"]) == ("pytest", 1, 1)
    summary = tracker.summary()
    assert summary is not None
    assert (summary["runner"], summary["failed"], summary["passed"]) == ("pytest", 1, 9)


def test_tap_lines_after_a_finished_node_run_do_not_take_over() -> None:
    tracker = make("npm test")
    feed(
        tracker,
        [
            "[run-node-tests-safe] files 1",
            "[run-node-tests-safe] progress 1/1 fail tests/a.test.js (2 tests)",
            "TAP version 13",
            "not ok 1 - breaks",
        ],
    )
    snapshot = snap(tracker)
    assert (snapshot["runner"], snapshot["stage"]) == ("node_safe", 0)


def test_a_single_pytest_command_is_stage_zero() -> None:
    tracker = make("pytest -q")
    feed(tracker, ["..F. [100%]", "1 failed, 3 passed in 0.10s"])
    snapshot = snap(tracker, final=True)
    assert (snapshot["stage"], snapshot["failed"], snapshot["passed"]) == (0, 1, 3)
    summary = tracker.summary()
    assert summary is not None
    assert "stage" not in summary


def test_non_test_output_stops_costing_after_the_detection_window() -> None:
    tracker = make("npm run build")
    feed(tracker, [f"bundling chunk {n}" for n in range(300)])
    feed(tracker, ["collected 5 items", "..... [100%]"])
    assert tracker.snapshot() is None


def test_stage_count_is_bounded() -> None:
    tracker = make()
    feed(tracker, [ci(f"stage_{n}", "START python -m pytest -q") for n in range(MAX_STAGES + 5)])
    feed(tracker, [ci(f"stage_{MAX_STAGES + 2}", "..... [100%]")])
    assert len(tracker._stages) == MAX_STAGES
    assert tracker.snapshot() is None
