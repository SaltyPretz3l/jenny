import csv

import pytest

from scripts.observe.perf_baseline_diff import main


def compare(tmp_path, before, after):
    paths = [tmp_path / "before.csv", tmp_path / "after.csv"]
    for path, rows in zip(paths, [before, after], strict=True):
        with path.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    return main(["--before", str(paths[0]), "--after", str(paths[1])])


def row(**changes):
    return {"total_cold_ms": 100, "optional_ms": "", "model": "m", "lane": "full", "engine": "llama", "profile_state": "fresh", "route": "local", "cache_state": "cold", "prompt_id": "p", "prompt": "hello", "notes": "electron-ready-basis", **changes}


@pytest.mark.parametrize("after", [[row(total_cold_ms="")], [row(), row(total_cold_ms="bad")]])
def test_missing_samples_fail(tmp_path, after):
    assert compare(tmp_path, [row(), row()], after) == 2


def test_missing_metric_fails(tmp_path):
    assert compare(tmp_path, [row(optional_ms=5)], [row()]) == 2


def test_zero_baseline_increase_is_regression(tmp_path):
    assert compare(tmp_path, [row(total_cold_ms=0)], [row(total_cold_ms=1)]) == 1


@pytest.mark.parametrize("changes", [{"model": "other"}, {"lane": "startup"}, {"engine": "replay"}, {"notes": "app-ready-basis"}, {"notes": "electron-ready-basis; launch-path=harness-start-js"}, {"profile_state": "old"}, {"route": "cloud"}, {"cache_state": "warm"}])
def test_incompatible_baselines_fail(tmp_path, changes):
    assert compare(tmp_path, [row()], [row(**changes)]) == 2


def test_random_prompt_mix_and_run_counts_still_compare(tmp_path, capsys):
    before = [row(prompt_id="p", prompt="hello"), row(prompt_id="q", prompt="other")]
    after = [row(prompt_id="r", prompt="third")]
    assert compare(tmp_path, before, after) == 0
    assert "different prompts" in capsys.readouterr().out


def test_matching_complete_baselines_pass(tmp_path):
    assert compare(tmp_path, [row(total_cold_ms=0)], [row(total_cold_ms=0)]) == 0


def test_required_total_metric_missing_from_both_baselines(tmp_path):
    sample = row(optional_ms=10)
    del sample["total_cold_ms"]
    assert compare(tmp_path, [sample], [sample]) == 2


def test_missing_configuration_metadata_fails(tmp_path):
    sample = row()
    del sample["model"]
    assert compare(tmp_path, [sample], [sample]) == 2


def test_missing_timing_basis_fails(tmp_path):
    sample = row(process_spawn_to_app_ready_ms=10, notes="")
    assert compare(tmp_path, [sample], [sample]) == 2
