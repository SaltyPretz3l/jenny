"""Behaviour tests for the live test-run progress tracker."""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.tools.builtins.test_progress import TestProgressTracker


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def make(
    command: str = "pytest",
    clock: FakeClock | None = None,
    cwd: Path | None = None,
) -> TestProgressTracker:
    root = cwd or Path.cwd()
    return TestProgressTracker(
        command=command,
        cwd=root,
        workspace_root=root,
        clock=clock or FakeClock(),
        start_manifest_thread=False,
    )


def feed(tracker: TestProgressTracker, text: str) -> None:
    for line in text.splitlines():
        tracker.feed_line(line)


def snap(tracker: TestProgressTracker, *, final: bool = False) -> dict[str, object]:
    snapshot = tracker.snapshot(final=final)
    assert snapshot is not None
    return snapshot


def grid_of(snapshot: dict[str, object]) -> dict[str, object]:
    grid = snapshot["grid"]
    assert isinstance(grid, dict)
    return grid


# ----------------------------------------------------------------------------- pytest


def test_pytest_xdist_verbose_lines_count_and_report_percent() -> None:
    tracker = make("pytest -n 4 tests")
    assert tracker.snapshot() is None
    feed(
        tracker,
        "============ test session starts ============\n"
        "4 workers [200 items]\n"
        "[gw3] [ 54%] PASSED tests/sidecar/a/test_x.py::test_name\n"
        "[gw1] [ 55%] FAILED tests/sidecar/a/test_x.py::test_bad[a b-c]\n"
        "[gw2] [ 56%] SKIPPED tests/sidecar/a/test_y.py::test_skip\n",
    )
    assert tracker.has_update()
    snapshot = snap(tracker)
    assert snapshot["runner"] == "pytest"
    assert snapshot["total"] == 200
    assert snapshot["total_unit"] == "tests"
    assert (snapshot["passed"], snapshot["failed"], snapshot["skipped"]) == (1, 1, 1)
    assert snapshot["tests"] == snapshot["done"] == 3
    assert snapshot["percent"] == 56.0
    assert snapshot["failures"] == [
        {"file": "tests/sidecar/a/test_x.py", "name": "test_bad[a b-c]", "at": 0.55}
    ]
    assert not tracker.has_update()


def test_pytest_serial_verbose_lines_with_parametrized_names() -> None:
    tracker = make()
    feed(
        tracker,
        "collected 40 items\n"
        "tests/a/test_x.py::test_one PASSED                      [  3%]\n"
        "tests/a/test_x.py::test_m[a b-c] FAILED                 [  6%]\n"
        "tests/a/test_x.py::test_s SKIPPED (no gpu)              [  9%]\n"
        "tests/a/test_x.py::test_x XFAIL (flaky)                 [ 12%]\n"
        "tests/a/test_x.py::test_y XPASS                         [ 15%]\n",
    )
    snapshot = snap(tracker)
    assert snapshot["total"] == 40
    assert (snapshot["passed"], snapshot["failed"], snapshot["skipped"]) == (2, 1, 2)
    assert snapshot["percent"] == 15.0
    failures = snapshot["failures"]
    assert isinstance(failures, list)
    assert failures[0]["name"] == "test_m[a b-c]"
    assert failures[0]["file"] == "tests/a/test_x.py"


def test_pytest_collected_line_honours_deselected() -> None:
    tracker = make()
    feed(tracker, "collecting ... collected 100 items / 5 deselected / 95 selected")
    assert snap(tracker)["total"] == 95
    other = make()
    feed(other, "collected 100 items / 5 deselected")
    assert snap(other)["total"] == 95


def test_pytest_normal_lines_with_wrapped_continuation() -> None:
    tracker = make()
    feed(
        tracker,
        "============ test session starts ============\n"
        "collected 30 items\n"
        "tests/a/test_x.py ..F.                                   [ 13%]\n"
        "tests/a/test_y.py s.x..                                  [ 30%]\n"
        ".....                                                    [ 46%]\n",
    )
    snapshot = snap(tracker)
    assert (snapshot["passed"], snapshot["failed"], snapshot["skipped"]) == (11, 1, 2)
    assert snapshot["percent"] == 46.0
    # The file is known, the test name is not until the short summary arrives.
    assert snapshot["failures"] == [
        {"file": "tests/a/test_x.py", "name": "tests/a/test_x.py", "at": 0.13}
    ]


def test_pytest_quiet_run_infers_total_names_failures_and_reconciles() -> None:
    tracker = make()
    feed(
        tracker,
        ".F..s  [ 50%]\n"
        ".F..s  [100%]\n"
        "=========================== short test summary info ============================\n"
        "FAILED tests/a/test_x.py::test_bad - assert 1 == 2\n"
        "FAILED tests/b/test_y.py::test_bad[a b] - boom\n"
        "========== 2 failed, 6 passed, 2 skipped in 1.23s ==========\n",
    )
    snapshot = snap(tracker)
    assert snapshot["total"] == 10
    assert snapshot["percent"] == 100.0
    failures = snapshot["failures"]
    assert isinstance(failures, list)
    assert [(f["file"], f["name"]) for f in failures] == [
        ("tests/a/test_x.py", "test_bad"),
        ("tests/b/test_y.py", "test_bad[a b]"),
    ]
    assert grid_of(snapshot)["count"] == 10


def test_pytest_quiet_short_summary_adds_failures_not_seen_live() -> None:
    tracker = make()
    feed(
        tracker,
        "collected 3 items\n"
        "tests/a.py ...  [100%]\n"
        "=========================== short test summary info ============================\n"
        "ERROR tests/c/test_z.py::test_setup - fixture 'x' not found\n"
        "5 passed, 1 error in 0.2s\n",
    )
    snapshot = snap(tracker)
    assert snapshot["failures"] == [{"file": "tests/c/test_z.py", "name": "test_setup", "at": 1.0}]


def test_pytest_final_line_reconciles_counts() -> None:
    tracker = make("pytest -n 8")
    feed(
        tracker,
        "8 workers [16068 items]\n"
        "[gw3] [  0%] PASSED tests/a/test_x.py::test_name\n"
        "=== 3 failed, 15944 passed, 121 skipped, 2 errors in 83.54s (0:01:23) ===\n",
    )
    snapshot = snap(tracker, final=True)
    assert (snapshot["passed"], snapshot["failed"], snapshot["skipped"]) == (15944, 5, 121)
    assert snapshot["tests"] == snapshot["done"] == 16070
    assert snapshot["total"] == 16070
    assert snapshot["percent"] == 100.0
    assert snapshot["final"] is True
    assert snapshot["eta_ms"] == 0


def test_pytest_percent_is_computed_when_not_printed() -> None:
    tracker = make()
    feed(tracker, "collected 4 items\ntests/a.py::t1 PASSED\ntests/a.py::t2 PASSED\n")
    assert snap(tracker)["percent"] == 50.0


def test_eta_is_null_below_ten_percent_then_uses_observed_rate() -> None:
    clock = FakeClock()
    tracker = make(clock=clock)
    feed(tracker, "collected 100 items\n.....  [  5%]")
    first = snap(tracker)
    assert first["eta_ms"] is None
    clock.now += 10.0
    feed(tracker, ".............................................  [ 50%]")
    second = snap(tracker)
    assert second["percent"] == 50.0
    assert second["eta_ms"] == 10_000
    assert second["elapsed_ms"] == 10_000


def test_failure_lists_are_capped_for_snapshot_and_summary() -> None:
    tracker = make()
    lines = ["8 workers [200 items]"]
    lines += [f"[gw1] [ 10%] FAILED tests/a/test_x.py::test_{i}" for i in range(60)]
    feed(tracker, "\n".join(lines))
    snapshot = snap(tracker)
    assert snapshot["failed"] == 60
    assert isinstance(snapshot["failures"], list)
    assert len(snapshot["failures"]) == 50
    summary = tracker.summary()
    assert summary is not None
    assert isinstance(summary["failures"], list)
    assert len(summary["failures"]) == 20
    progress = tracker.background_progress()
    assert progress is not None
    assert isinstance(progress["failures"], list)
    assert len(progress["failures"]) == 10
    assert isinstance(progress["failure_marks"], list)
    assert len(progress["failure_marks"]) == 50


# ----------------------------------------------------------------------------- TAP


def test_tap_counts_skips_suites_and_failure_file(tmp_path: Path) -> None:
    location = tmp_path / "t" / "a.test.js"
    tracker = make("node --test", cwd=tmp_path)
    feed(
        tracker,
        "TAP version 13\n"
        "# Subtest: suite A\n"
        "    # Subtest: inner ok\n"
        "    ok 1 - inner ok\n"
        "      ---\n"
        "      duration_ms: 0.5\n"
        "      ...\n"
        "    # Subtest: inner skip\n"
        "    ok 2 - inner skip # SKIP not now\n"
        "      ---\n"
        "      duration_ms: 0\n"
        "      ...\n"
        "    # Subtest: inner bad\n"
        "    not ok 3 - inner bad\n"
        "      ---\n"
        "      duration_ms: 1\n"
        f"      location: '{location}:12:3'\n"
        "      failureType: 'testCodeFailure'\n"
        "      ...\n"
        "    1..3\n"
        "ok 1 - suite A\n"
        "  ---\n"
        "  duration_ms: 2\n"
        "  type: 'suite'\n"
        "  ...\n"
        "1..1\n",
    )
    snapshot = snap(tracker)
    assert snapshot["runner"] == "tap"
    assert snapshot["unit"] == "none"
    assert snapshot["total"] is None
    assert snapshot["percent"] is None
    assert snapshot["eta_ms"] is None
    assert snapshot["grid"] is None
    assert (snapshot["tests"], snapshot["passed"], snapshot["failed"], snapshot["skipped"]) == (
        3,
        1,
        1,
        1,
    )
    assert snapshot["failures"] == [{"file": "t/a.test.js", "name": "inner bad", "at": 0.0}]


def test_tap_final_lines_reconcile_counts() -> None:
    tracker = make("node --test")
    feed(
        tracker,
        "TAP version 13\n"
        "ok 1 - a\n"
        "not ok 2 - b\n"
        "ok 3 - c # TODO later\n"
        "1..3\n"
        "# tests 10\n"
        "# suites 2\n"
        "# pass 6\n"
        "# fail 2\n"
        "# cancelled 0\n"
        "# skipped 1\n"
        "# todo 1\n",
    )
    snapshot = snap(tracker, final=True)
    assert (snapshot["tests"], snapshot["passed"], snapshot["failed"], snapshot["skipped"]) == (
        10,
        6,
        2,
        2,
    )


# ----------------------------------------------------------------------------- node safe

NODE_SAFE_SMALL = (
    "[run-node-tests-safe] files 3\n"
    "[run-node-tests-safe] progress 1/3 pass tests/a.test.js (12 tests)\n"
    "[run-node-tests-safe] progress 2/3 fail tests/b.test.js (4 tests)\n"
)


def test_node_safe_small_run_uses_order_grid() -> None:
    tracker = make("node scripts/run-node-tests-safe.js")
    feed(tracker, NODE_SAFE_SMALL)
    snapshot = snap(tracker)
    assert snapshot["runner"] == "node_safe"
    assert snapshot["total"] == 3
    assert snapshot["total_unit"] == "files"
    assert (snapshot["done"], snapshot["tests"], snapshot["failed"]) == (2, 16, 1)
    assert snapshot["unit"] == "order"
    assert grid_of(snapshot)["states"] == "pfr"
    assert "labels" not in snapshot
    assert snapshot["failures"] == [{"file": "tests/b.test.js", "name": "b.test.js", "at": 0.6667}]
    feed(tracker, "[run-node-tests-safe] progress 3/3 pass tests/c.test.js\n")
    last = snap(tracker, final=True)
    assert last["tests"] == 16
    assert grid_of(last)["states"] == "pfp"


def test_node_safe_file_grid_labels_follow_finish_order() -> None:
    tracker = make("node scripts/run-node-tests-safe.js")
    lines = ["[run-node-tests-safe] files 14"]
    lines.append("[run-node-tests-safe] progress 1/14 pass tests/z.test.js (2 tests)")
    lines.append("[run-node-tests-safe] progress 2/14 fail tests/a.test.js (3 tests)")
    feed(tracker, "\n".join(lines))
    first = snap(tracker)
    assert first["unit"] == "file"
    grid = grid_of(first)
    assert grid["count"] == 14
    assert grid["px"] == 6
    assert grid["states"] == "pf" + "-" * 12
    assert first["labels_from"] == 0
    assert first["labels"] == ["tests/z.test.js", "tests/a.test.js"]
    feed(tracker, "[run-node-tests-safe] progress 3/14 pass tests/m.test.js (1 tests)")
    second = snap(tracker)
    assert second["labels_from"] == 2
    assert second["labels"] == ["tests/m.test.js"]
    assert grid_of(second)["states"] == "pfp" + "-" * 11
    third = snap(tracker)
    assert "labels" not in third


# ----------------------------------------------------------------------------- grids


def manifest(count: int, width: int = 3) -> list[str]:
    return [f"tests/f{i:0{width}d}.py" for i in range(count)]


def test_file_grid_px6_labels_once_and_extra_file_appends_a_cell() -> None:
    tracker = make()
    tracker.set_manifest(manifest(20))
    feed(tracker, "collected 100 items\ntests/f000.py .  [  1%]")
    first = snap(tracker)
    assert first["unit"] == "file"
    grid = grid_of(first)
    assert (grid["count"], grid["group"], grid["px"]) == (20, 1, 6)
    assert grid["states"] == "r" + "-" * 19
    assert first["labels_from"] == 0
    assert first["labels"] == manifest(20)
    feed(tracker, "tests/extra/test_new.py .  [  2%]")
    second = snap(tracker)
    assert grid_of(second)["count"] == 21
    assert second["labels_from"] == 20
    assert second["labels"] == ["tests/extra/test_new.py"]
    assert "labels" not in snap(tracker)


def test_file_grid_px4_between_1000_and_2500_files() -> None:
    tracker = make()
    tracker.set_manifest(manifest(1200, 4))
    feed(tracker, "collected 5000 items\ntests/f0000.py .  [  1%]")
    grid = grid_of(snap(tracker))
    assert (grid["count"], grid["group"], grid["px"]) == (1200, 1, 4)


def test_file_grid_groups_neighbouring_files_with_worst_state() -> None:
    clock = FakeClock()
    tracker = make(clock=clock)
    tracker.set_manifest(manifest(3000, 4))
    feed(
        tracker,
        "collected 9000 items\n"
        "tests/f0000.py F  [  1%]\n"  # cell 0: failed + untouched neighbour
        "tests/f0002.py .  [  1%]\n"  # cell 1: passing + untouched neighbour
        "tests/f0004.py .  [  1%]\n"  # cell 2: both files pass
        "tests/f0005.py .  [  1%]",
    )
    clock.now += 10.0
    snapshot = snap(tracker)
    grid = grid_of(snapshot)
    assert (grid["count"], grid["group"], grid["px"]) == (1500, 2, 4)
    states = grid["states"]
    assert isinstance(states, str)
    assert len(states) == 1500
    assert states[:4] == "frp-"
    labels = snapshot["labels"]
    assert isinstance(labels, list)
    assert len(labels) == 1500
    assert labels[0] == "tests/… · 2 files"


def test_grouped_cell_of_only_skipped_files_is_skipped_state() -> None:
    clock = FakeClock()
    tracker = make(clock=clock)
    tracker.set_manifest(manifest(2600, 4))
    feed(tracker, "collected 9000 items\ntests/f0000.py s  [  1%]\ntests/f0001.py s  [  1%]")
    clock.now += 10.0
    assert grid_of(snap(tracker))["states"][0] == "s"  # type: ignore[index]


def test_order_unit_when_manifest_is_missing_or_small() -> None:
    tracker = make()
    feed(tracker, "collected 20 items\n.....F....  [ 50%]")
    snapshot = snap(tracker)
    assert snapshot["unit"] == "order"
    grid = grid_of(snapshot)
    assert (grid["count"], grid["group"], grid["px"]) == (20, 1, 6)
    assert grid["states"] == "ppppp" + "f" + "pppp" + "r" + "-" * 9
    assert "labels" not in snapshot
    final = snap(tracker, final=True)
    assert "r" not in str(grid_of(final)["states"])

    small = make()
    small.set_manifest(manifest(5))
    feed(small, "collected 20 items\ntests/f000.py ..  [ 10%]")
    assert snap(small)["unit"] == "order"


def test_order_unit_is_capped_at_one_thousand_cells() -> None:
    tracker = make()
    feed(tracker, "collected 5000 items\n.....  [ 1%]")
    grid = grid_of(snap(tracker))
    assert grid["count"] == 1000
    assert len(str(grid["states"])) == 1000


def test_unknown_total_has_no_grid() -> None:
    tracker = make()
    feed(tracker, "=== test session starts ===\ntests/a.py::t PASSED")
    snapshot = snap(tracker)
    assert snapshot["unit"] == "none"
    assert snapshot["grid"] is None
    assert snapshot["percent"] is None


def test_grid_is_null_until_the_manifest_is_ready_or_has_failed() -> None:
    tracker = TestProgressTracker(
        command="pytest tests",
        cwd=Path.cwd(),
        workspace_root=Path.cwd(),
        clock=FakeClock(),
        manifest_budget_seconds=0.0,
    )
    feed(tracker, "collected 20 items\ntests/f000.py .  [ 5%]")
    tracker.set_manifest(None)  # discovery failed or timed out
    snapshot = snap(tracker)
    assert snapshot["unit"] == "order"


def test_running_cells_decay_after_two_seconds() -> None:
    clock = FakeClock()
    tracker = make(clock=clock)
    tracker.set_manifest(manifest(14))
    feed(
        tracker,
        "collected 100 items\n"
        "tests/f000.py .  [  1%]\n"
        "tests/f001.py s  [  2%]\n"
        "tests/f002.py F  [  3%]",
    )
    assert grid_of(snap(tracker))["states"] == "rrf" + "-" * 11
    assert not tracker.has_update()
    clock.now += 1.9
    assert not tracker.has_update()
    clock.now += 0.2
    assert tracker.has_update()
    assert grid_of(snap(tracker))["states"] == "psf" + "-" * 11
    assert not tracker.has_update()
    feed(tracker, "tests/f003.py .  [  4%]")
    assert grid_of(snap(tracker, final=True))["states"] == "psfp" + "-" * 10


# ----------------------------------------------------------------------------- summary


def test_summary_has_final_grid_without_running_cells() -> None:
    tracker = make("pytest -n 4")
    tracker.set_manifest(manifest(12))
    feed(
        tracker,
        "4 workers [100 items]\n"
        "[gw0] [ 5%] PASSED tests/f000.py::test_a\n"
        "[gw1] [ 6%] FAILED tests/f001.py::test_b\n",
    )
    summary = tracker.summary()
    assert summary is not None
    assert set(summary) == {
        "runner",
        "unit",
        "total",
        "total_unit",
        "tests",
        "passed",
        "failed",
        "skipped",
        "duration_ms",
        "failures",
        "grid",
    }
    assert summary["unit"] == "file"
    assert summary["grid"] == {"count": 12, "group": 1, "px": 6, "states": "pf" + "-" * 10}
    assert summary["failures"] == [{"file": "tests/f001.py", "name": "test_b", "at": 0.06}]
    assert make().summary() is None


def test_background_progress_digest() -> None:
    tracker = make()
    assert tracker.background_progress() is None
    feed(tracker, "collected 10 items\n.F.s  [ 40%]")
    progress = tracker.background_progress()
    assert progress == {
        "runner": "pytest",
        "total_unit": "tests",
        "percent": 40.0,
        "done": 4,
        "total": 10,
        "failed": 1,
        "skipped": 1,
        "failure_marks": [0.4],
        "failures": ["failed test"],
    }


# ----------------------------------------------------------------------------- robustness


def test_no_runner_means_no_snapshot_and_detection_window_is_bounded() -> None:
    tracker = make()
    feed(tracker, "hello\nworld")
    assert tracker.snapshot() is None
    assert tracker.summary() is None
    late = make()
    for index in range(250):
        late.feed_line(f"noise {index}")
    late.feed_line("TAP version 13")
    assert late.snapshot() is None


def test_ansi_and_carriage_returns_are_stripped() -> None:
    tracker = make()
    feed(tracker, "\x1b[1m=== test session starts ===\x1b[0m\r\ncollected 5 items\r")
    feed(tracker, "\x1b[32mtests/a.py\x1b[0m ..  [ 40%]\r")
    snapshot = snap(tracker)
    assert snapshot["total"] == 5
    assert snapshot["passed"] == 2


def test_feed_line_never_raises_on_garbage() -> None:
    tracker = make()
    tracker.feed_line("=== test session starts ===")
    garbage = [
        "",
        "\x00\xff\xfe\x1b[",
        "a" * 200_000,
        "[gw",
        "::",
        "FAILED",
        "[gw1] [ 9%] FAILED ",
        "tests/x.py::" + "y" * 50_000 + " PASSED",
        "[run-node-tests-safe] progress x/y pass z",
        "# tests many",
        "\ud800 surrogate",
    ]
    for line in garbage:
        tracker.feed_line(line)
    tracker.feed_line(b"bytes are not text")  # type: ignore[arg-type]
    tracker.feed_line(None)  # type: ignore[arg-type]
    tracker.feed_line("tests/a.py ..  [ 40%]")
    assert snap(tracker)["passed"] >= 2  # type: ignore[operator]


# ----------------------------------------------------------------------------- S3 review fixes


def test_trailing_whitespace_does_not_double_count_xdist_failures() -> None:
    """The background tap feeds lines with trailing spaces; the short summary must still match."""
    tracker = make("pytest -n 4")
    feed(
        tracker,
        "4 workers [10 items]\n"
        "[gw1] [ 38%] FAILED test_f05.py::test_fail \n"
        "=========================== short test summary info ============================\n"
        "FAILED test_f05.py::test_fail - assert 1 == 2\n",
    )
    snapshot = snap(tracker)
    failures = snapshot["failures"]
    assert isinstance(failures, list)
    assert [(f["file"], f["name"]) for f in failures] == [("test_f05.py", "test_fail")]


def test_two_pytest_invocations_in_one_command_accumulate() -> None:
    tracker = make("pytest a; pytest b")
    feed(
        tracker,
        "============ test session starts ============\n"
        "collected 3 items\n"
        "a.py::t1 PASSED  [ 33%]\n"
        "a.py::t2 FAILED  [ 66%]\n"
        "a.py::t3 PASSED  [100%]\n"
        "=========================== short test summary info ============================\n"
        "FAILED a.py::t2 - boom\n"
        "======== 1 failed, 2 passed in 0.5s ========\n",
    )
    first = snap(tracker)
    assert first["percent"] == 100.0
    feed(
        tracker,
        "============ test session starts ============\n"
        "collected 2 items\n"
        "b.py::u1 PASSED  [ 50%]\n",
    )
    mid = snap(tracker)
    assert (mid["tests"], mid["passed"], mid["failed"], mid["total"]) == (4, 3, 1, 5)
    assert mid["percent"] == 80.0
    feed(
        tracker,
        "b.py::u2 SKIPPED  [100%]\n"
        "=========================== short test summary info ============================\n"
        "======== 1 passed, 1 skipped in 0.1s ========\n",
    )
    done = snap(tracker, final=True)
    assert (done["tests"], done["passed"], done["failed"], done["skipped"]) == (5, 3, 1, 1)
    assert done["total"] == 5
    assert done["percent"] == 100.0


def test_quiet_second_run_without_a_header_starts_a_new_segment() -> None:
    tracker = make("pytest -q a; pytest -q b")
    feed(tracker, ".F  [100%]\n1 failed, 1 passed in 0.1s\n")
    feed(tracker, "..  [100%]\n")
    snapshot = snap(tracker)
    assert (snapshot["tests"], snapshot["passed"], snapshot["failed"]) == (4, 3, 1)
    assert snapshot["percent"] != 100.0 or snapshot["total"] == 4


def test_non_pytest_in_lines_are_not_final_lines() -> None:
    tracker = make()
    feed(
        tracker,
        "collected 4 items\n"
        "tests/a.py::t1 PASSED  [ 25%]\n"
        "12 files in 3.4s\n"
        "=== 7 widgets in 3.4s ===\n"
        "tests/a.py::t2 PASSED  [ 50%]\n",
    )
    snapshot = snap(tracker)
    assert snapshot["tests"] == 2
    assert snapshot["percent"] == 50.0


def test_final_snapshot_resends_every_label_from_zero() -> None:
    tracker = make()
    tracker.set_manifest(manifest(14))
    feed(tracker, "collected 100 items\ntests/f000.py .  [  1%]")
    first = snap(tracker)
    assert first["labels_from"] == 0
    assert "labels" not in snap(tracker)
    final = snap(tracker, final=True)
    assert final["labels_from"] == 0
    assert final["labels"] == manifest(14)


def test_snapshots_do_not_reclean_labels(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import sidecar.ai.tools.builtins.test_progress as progress_module
    import sidecar.ai.tools.builtins.test_progress_grid as grid_module

    calls = {"count": 0}
    real = progress_module.clean

    def counting(text: str) -> str:
        calls["count"] += 1
        return real(text)

    monkeypatch.setattr(progress_module, "clean", counting)
    monkeypatch.setattr(grid_module, "clean", counting)
    tracker = make()
    tracker.set_manifest(manifest(2600, 4))  # manifest labels are cleaned once, here
    assert calls["count"] >= 2600
    feed(tracker, "collected 9000 items\ntests/f0000.py .  [  1%]")
    snap(tracker)  # group labels computed once for the first send
    calls["count"] = 0
    feed(tracker, "tests/f0001.py .  [  2%]")
    second = snap(tracker)
    assert calls["count"] == 0
    assert "labels" not in second
    assert tracker.summary() is not None
    assert calls["count"] == 0  # the summary never needs labels
