from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module() -> ModuleType:
    script_path = REPO_ROOT / "scripts" / "checks" / "check_test_file_growth.py"
    spec = importlib.util.spec_from_file_location("check_test_file_growth_for_tests", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive load guard
        raise RuntimeError("failed to load check_test_file_growth.py module spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def check() -> ModuleType:
    return _load_module()


def _write(root: Path, relative: str, line_count: int, *, first_lines: tuple[str, ...] = ()) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    body = [*first_lines, *("// filler" for _ in range(line_count - len(first_lines)))]
    path.write_text("\n".join(body) + "\n", encoding="utf-8")


def _run_main(check: ModuleType, monkeypatch, root: Path, grandfathered: list[str]) -> int:
    list_path = root / check.GRANDFATHERED_RELATIVE_PATH
    list_path.parent.mkdir(parents=True, exist_ok=True)
    list_path.write_text(json.dumps({"files": grandfathered}), encoding="utf-8")
    monkeypatch.setattr(check, "ROOT", root)
    return check.main()


def test_new_file_that_fits_in_its_sibling_fails_and_names_both(check, tmp_path, monkeypatch, capsys) -> None:
    _write(tmp_path, "tests/widget-panel.test.js", 300)
    _write(tmp_path, "tests/widget-panel-edge-cases.test.js", 80)

    assert _run_main(check, monkeypatch, tmp_path, []) == 1
    output = capsys.readouterr().out
    assert "tests/widget-panel-edge-cases.test.js (80 lines) extends tests/widget-panel.test.js (300 lines)" in output
    assert "together 380 lines" in output
    assert "new-test-file:" in output


def test_a_stated_reason_lets_the_new_file_stand(check, tmp_path, monkeypatch, capsys) -> None:
    _write(tmp_path, "tests/widget-panel.test.js", 300)
    _write(
        tmp_path,
        "tests/widget-panel-layout.test.js",
        80,
        first_lines=("'use strict';", "// new-test-file: needs a real browser; the jsdom file stays in the fast lane."),
    )

    assert _run_main(check, monkeypatch, tmp_path, []) == 0
    assert "PASS" in capsys.readouterr().out


def test_an_empty_or_token_reason_does_not_count(check, tmp_path, monkeypatch) -> None:
    _write(tmp_path, "tests/widget-panel.test.js", 300)
    _write(tmp_path, "tests/widget-panel-a.test.js", 80, first_lines=("// new-test-file:",))
    _write(tmp_path, "tests/widget-panel-b.test.js", 80, first_lines=("// new-test-file: because",))

    failures, _stale = check.evaluate(tmp_path, set())
    assert [failure.split(" ")[0] for failure in failures] == [
        "tests/widget-panel-a.test.js",
        "tests/widget-panel-b.test.js",
    ]


def test_a_reason_below_the_scanned_header_does_not_count(check, tmp_path) -> None:
    _write(tmp_path, "tests/widget-panel.test.js", 300)
    late = tuple("// filler" for _ in range(check.REASON_SCAN_LINES)) + (
        "// new-test-file: stated too far down to be read as the file's header.",
    )
    _write(tmp_path, "tests/widget-panel-late.test.js", 80, first_lines=late)

    failures, _stale = check.evaluate(tmp_path, set())
    assert len(failures) == 1


def test_a_pair_over_the_line_cap_passes_and_a_pair_exactly_at_it_fails(check, tmp_path, monkeypatch) -> None:
    _write(tmp_path, "tests/widget-panel.test.js", check.LINE_CAP - 50)
    _write(tmp_path, "tests/widget-panel-extras.test.js", 51)
    assert _run_main(check, monkeypatch, tmp_path, []) == 0

    _write(tmp_path, "tests/widget-panel-extras.test.js", 50)
    failures, _stale = check.evaluate(tmp_path, set())
    assert len(failures) == 1
    assert f"together {check.LINE_CAP} lines" in failures[0]


def test_grandfathered_file_passes_and_a_stale_entry_fails(check, tmp_path, monkeypatch, capsys) -> None:
    _write(tmp_path, "tests/widget-panel.test.js", 300)
    _write(tmp_path, "tests/widget-panel-old.test.js", 80)

    assert _run_main(check, monkeypatch, tmp_path, ["tests/widget-panel-old.test.js"]) == 0
    capsys.readouterr()

    (tmp_path / "tests/widget-panel-old.test.js").unlink()
    assert _run_main(check, monkeypatch, tmp_path, ["tests/widget-panel-old.test.js"]) == 1
    output = capsys.readouterr().out
    assert "no longer apply" in output
    assert "tests/widget-panel-old.test.js" in output


def test_extension_pairs_stay_inside_one_directory_and_pick_the_longest_sibling(check) -> None:
    extensions = check.find_extensions(
        [
            "tests/a.test.js",
            "tests/a-b.test.js",
            "tests/a-b-c.test.js",
            "tests/cli/a-b-d.test.js",
            "tests/ab.test.js",
            "tests/unrelated-name.test.js",
        ]
    )
    assert [(item.path, item.sibling) for item in extensions] == [
        ("tests/a-b.test.js", "tests/a.test.js"),
        ("tests/a-b-c.test.js", "tests/a-b.test.js"),
    ]


def test_scratch_directories_and_other_suffixes_are_not_test_files(check, tmp_path) -> None:
    _write(tmp_path, "tests/widget.test.js", 10)
    _write(tmp_path, "tests/.tmp-run/widget-copy.test.js", 10)
    _write(tmp_path, "tests/helpers/widget-helper.js", 10)

    assert check.list_test_files(tmp_path) == ["tests/widget.test.js"]


def test_an_unsorted_or_malformed_list_is_refused(check, tmp_path, monkeypatch, capsys) -> None:
    _write(tmp_path, "tests/widget.test.js", 10)
    assert _run_main(check, monkeypatch, tmp_path, ["tests/b.test.js", "tests/a.test.js"]) == 1
    assert "sorted" in capsys.readouterr().out

    (tmp_path / check.GRANDFATHERED_RELATIVE_PATH).write_text("{not json", encoding="utf-8")
    assert check.main() == 1
    assert "malformed" in capsys.readouterr().out


def test_the_repository_passes_with_its_committed_list(check) -> None:
    grandfathered, errors = check.load_grandfathered(REPO_ROOT / check.GRANDFATHERED_RELATIVE_PATH)
    assert errors == []
    failures, stale = check.evaluate(REPO_ROOT, grandfathered)
    assert failures == []
    assert stale == []
