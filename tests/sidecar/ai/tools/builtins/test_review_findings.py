from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_REVIEW_FINDINGS_INVALID
from sidecar.ai.tools.builtins.review_findings import (
    MAX_FINDINGS,
    MAX_OUTPUT_CHARS,
    report_findings_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar._platform_skips import make_dir_link


def _write_lines(path: Path, count: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(f"line {n}\n" for n in range(1, count + 1)), encoding="utf-8")


def _run(arguments: dict[str, object], root: Path) -> dict[str, object]:
    result = report_findings_tool(arguments, WorkspaceGuard(str(root)))
    assert isinstance(result, ToolHandlerResult)
    assert result.success is True
    payload = json.loads(result.output)
    assert result.metadata == {
        "result_kind": "review_findings",
        "finding_count": len(payload["findings"]),
    }
    return payload


def _one(finding: dict[str, object], root: Path) -> dict[str, object]:
    payload = _run({"findings": [finding]}, root)
    findings = payload["findings"]
    assert isinstance(findings, list) and len(findings) == 1
    return findings[0]


def test_payload_shape_and_note(tmp_path: Path) -> None:
    _write_lines(tmp_path / "src" / "cart.js", 10)
    payload = _run(
        {
            "findings": [
                {
                    "severity": "high",
                    "title": "Total drops tax",
                    "file": "src/cart.js",
                    "line": 7,
                    "body": "  Add tax before rounding.  ",
                }
            ],
            "summary": "  One real bug.  ",
            "scope": " working tree vs HEAD ",
        },
        tmp_path,
    )
    assert set(payload) == {
        "kind",
        "version",
        "scope",
        "summary",
        "counts",
        "findings",
        "dropped",
        "note",
    }
    assert payload["kind"] == "review_findings"
    assert payload["version"] == 1
    assert payload["scope"] == "working tree vs HEAD"
    assert payload["summary"] == "One real bug."
    assert payload["counts"] == {"high": 1, "medium": 0, "low": 0}
    assert payload["dropped"] == 0
    assert payload["note"] == (
        "Shown to the user as a list. Do not repeat the findings; reply in one or two sentences."
    )
    assert payload["findings"] == [
        {
            "index": 1,
            "severity": "high",
            "title": "Total drops tax",
            "body": "Add tax before rounding.",
            "file": "src/cart.js",
            "line": 7,
            "end_line": 7,
            "excerpt": {"start": 6, "lines": ["line 6", "line 7", "line 8"]},
        }
    ]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("critical", "high"),
        ("Blocker", "high"),
        ("P0", "high"),
        ("p1", "high"),
        (" HIGH ", "high"),
        ("error", "high"),
        ("major", "high"),
        ("medium", "medium"),
        ("moderate", "medium"),
        ("p2", "medium"),
        ("Warning", "medium"),
        ("warn", "medium"),
        ("low", "low"),
        ("minor", "low"),
        ("p3", "low"),
        ("nit", "low"),
        ("info", "low"),
        ("suggestion", "low"),
        ("sev-unknown", "medium"),
        ("", "medium"),
        (None, "medium"),
        (3, "medium"),
    ],
)
def test_severity_aliases(tmp_path: Path, raw: object, expected: str) -> None:
    assert _one({"severity": raw, "title": "x"}, tmp_path)["severity"] == expected


def test_title_whitespace_collapsed_capped_and_empty_dropped(tmp_path: Path) -> None:
    payload = _run(
        {
            "findings": [
                {"severity": "low", "title": "  a \n\t b  "},
                {"severity": "high", "title": "   "},
                {"severity": "high"},
                {"severity": "high", "title": 42},
                "not an object",
                {"severity": "medium", "title": "t" * 300, "body": "b" * 3000},
            ]
        },
        tmp_path,
    )
    titles = [finding["title"] for finding in payload["findings"]]
    assert titles == ["t" * 160, "a b"]
    assert payload["findings"][0]["body"] == "b" * 2000
    assert payload["findings"][1]["body"] == ""
    assert payload["dropped"] == 4


def test_file_line_suffix_sets_line_when_absent(tmp_path: Path) -> None:
    _write_lines(tmp_path / "src" / "a.py", 20)
    finding = _one({"title": "x", "file": ".\\src\\a.py:12"}, tmp_path)
    assert (finding["file"], finding["line"], finding["end_line"]) == ("src/a.py", 12, 12)

    finding = _one({"title": "x", "file": "./src/a.py:12:5"}, tmp_path)
    assert (finding["file"], finding["line"]) == ("src/a.py", 12)

    finding = _one({"title": "x", "file": "src/a.py:12", "line": 3}, tmp_path)
    assert (finding["file"], finding["line"]) == ("src/a.py", 3)


def test_absolute_path_inside_workspace_is_relativised(tmp_path: Path) -> None:
    target = tmp_path / "pkg" / "mod.py"
    _write_lines(target, 3)
    finding = _one({"title": "x", "file": f"{target}:2"}, tmp_path)
    assert (finding["file"], finding["line"]) == ("pkg/mod.py", 2)


def test_escaping_path_keeps_finding_without_location(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    _write_lines(tmp_path / "secret.txt", 5)
    for raw in ("../secret.txt", str(tmp_path / "secret.txt"), "a/../../secret.txt:3"):
        finding = _one({"title": "x", "file": raw, "line": 2}, root)
        assert (finding["file"], finding["line"], finding["end_line"]) == ("", 0, 0)
        assert finding["excerpt"] is None


def test_symlink_escape_keeps_finding_without_location(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    outside = tmp_path / "outside"
    _write_lines(outside / "secret.txt", 5)
    make_dir_link(root / "link", outside)
    finding = _one({"title": "x", "file": "link/secret.txt", "line": 2}, root)
    assert (finding["file"], finding["line"], finding["excerpt"]) == ("", 0, None)


def test_line_and_end_line_normalisation(tmp_path: Path) -> None:
    _write_lines(tmp_path / "a.py", 200)
    cases = [
        ({"line": 0}, (0, 0)),
        ({"line": -4}, (0, 0)),
        ({"line": True}, (0, 0)),
        ({"line": "9"}, (9, 9)),
        ({"line": 10, "end_line": 4}, (10, 10)),
        ({"line": 10, "end_line": 14}, (10, 14)),
        ({"line": 10, "end_line": 500}, (10, 60)),
        ({"end_line": 7}, (0, 0)),
    ]
    for extra, expected in cases:
        finding = _one({"title": "x", "file": "a.py", **extra}, tmp_path)
        assert (finding["line"], finding["end_line"]) == expected, extra


def test_excerpt_window_at_file_start_and_middle(tmp_path: Path) -> None:
    _write_lines(tmp_path / "a.py", 30)
    start = _one({"title": "x", "file": "a.py", "line": 1}, tmp_path)
    assert start["excerpt"] == {"start": 1, "lines": ["line 1", "line 2"]}

    middle = _one({"title": "x", "file": "a.py", "line": 10, "end_line": 20}, tmp_path)
    assert middle["excerpt"] == {
        "start": 9,
        "lines": ["line 9", "line 10", "line 11", "line 12", "line 13"],
    }

    last = _one({"title": "x", "file": "a.py", "line": 30}, tmp_path)
    assert last["excerpt"] == {"start": 29, "lines": ["line 29", "line 30"]}


def test_excerpt_strips_crlf_caps_width_and_replaces_bad_utf8(tmp_path: Path) -> None:
    (tmp_path / "w.txt").write_bytes(b"one\r\n" + b"x" * 300 + b"\r\n\xff\xfebad\r\n")
    finding = _one({"title": "x", "file": "w.txt", "line": 2}, tmp_path)
    assert finding["excerpt"] == {
        "start": 1,
        "lines": ["one", "x" * 240, "��bad"],
    }


def test_excerpt_null_for_missing_binary_directory_or_out_of_range(tmp_path: Path) -> None:
    _write_lines(tmp_path / "a.py", 3)
    (tmp_path / "bin.dat").write_bytes(b"abc\x00def\nmore\n")
    (tmp_path / "dir").mkdir()
    for raw, line in (("missing.py", 2), ("bin.dat", 1), ("dir", 1), ("a.py", 4), ("a.py", 0)):
        finding = _one({"title": "x", "file": raw, "line": line}, tmp_path)
        assert finding["excerpt"] is None, raw
    assert _one({"title": "x", "file": "missing.py", "line": 2}, tmp_path)["file"] == "missing.py"


def test_excerpt_null_for_file_over_two_megabytes(tmp_path: Path) -> None:
    (tmp_path / "big.txt").write_bytes(b"a\n" * (1024 * 1024 + 1))
    assert _one({"title": "x", "file": "big.txt", "line": 1}, tmp_path)["excerpt"] is None


def test_no_file_means_no_line(tmp_path: Path) -> None:
    finding = _one({"title": "x", "line": 5, "end_line": 6}, tmp_path)
    assert (finding["file"], finding["line"], finding["end_line"]) == ("", 0, 0)
    assert finding["excerpt"] is None


def test_more_than_thirty_findings_are_capped_and_counted(tmp_path: Path) -> None:
    findings = [{"severity": "low", "title": f"t{n}"} for n in range(35)]
    payload = _run({"findings": findings}, tmp_path)
    assert len(payload["findings"]) == MAX_FINDINGS == 30
    assert payload["dropped"] == 5
    assert payload["findings"][-1]["title"] == "t29"
    assert [finding["index"] for finding in payload["findings"]] == list(range(1, 31))


def test_sort_is_by_severity_and_stable(tmp_path: Path) -> None:
    payload = _run(
        {
            "findings": [
                {"severity": "nit", "title": "low-1"},
                {"severity": "medium", "title": "med-1"},
                {"severity": "p0", "title": "high-1"},
                {"severity": "low", "title": "low-2"},
                {"severity": "critical", "title": "high-2"},
                {"title": "med-2"},
            ]
        },
        tmp_path,
    )
    assert [finding["title"] for finding in payload["findings"]] == [
        "high-1",
        "high-2",
        "med-1",
        "med-2",
        "low-1",
        "low-2",
    ]
    assert [finding["index"] for finding in payload["findings"]] == [1, 2, 3, 4, 5, 6]
    assert payload["counts"] == {"high": 2, "medium": 2, "low": 2}


@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"findings": None},
        {"findings": "one bug"},
        {"findings": {"title": "x"}},
        {"findings": []},
        {"findings": [{"title": "  "}, {"severity": "high"}, 7]},
    ],
)
def test_missing_or_empty_findings_fail(tmp_path: Path, arguments: dict[str, object]) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        report_findings_tool(arguments, WorkspaceGuard(str(tmp_path)))
    assert excinfo.value.code == CMP_TOOL_REVIEW_FINDINGS_INVALID
    assert "findings" in excinfo.value.message
    assert "title" in excinfo.value.message


def test_private_jenny_arguments_are_ignored(tmp_path: Path) -> None:
    payload = _run(
        {
            "findings": [{"severity": "high", "title": "x"}],
            "_jenny_session_id": "session-1",
            "_jenny_read_only": True,
        },
        tmp_path,
    )
    assert "_jenny_session_id" not in json.dumps(payload)
    assert payload["counts"] == {"high": 1, "medium": 0, "low": 0}


def test_scope_and_summary_are_capped_and_non_strings_ignored(tmp_path: Path) -> None:
    payload = _run(
        {"findings": [{"title": "x"}], "scope": "s" * 500, "summary": "m" * 900}, tmp_path
    )
    assert payload["scope"] == "s" * 120
    assert payload["summary"] == "m" * 600
    payload = _run({"findings": [{"title": "x"}], "scope": 5, "summary": ["x"]}, tmp_path)
    assert (payload["scope"], payload["summary"]) == ("", "")


def test_works_without_a_workspace_root() -> None:
    result = report_findings_tool(
        {"findings": [{"title": "x", "file": "a.py", "line": 2}]}, WorkspaceGuard(None)
    )
    assert isinstance(result, ToolHandlerResult)
    finding = json.loads(result.output)["findings"][0]
    assert (finding["file"], finding["line"], finding["excerpt"]) == ("", 0, None)


def test_large_reports_fit_the_router_output_bound(tmp_path: Path) -> None:
    for n in range(30):
        _write_lines(tmp_path / f"f{n}.py", 20)
    findings = [
        {
            "severity": "high" if n < 10 else "low",
            "title": f"{n} " + "t" * 150,
            "body": "b" * 2000,
            "file": f"f{n}.py",
            "line": 10,
            "end_line": 20,
        }
        for n in range(30)
    ]
    result = report_findings_tool({"findings": findings}, WorkspaceGuard(str(tmp_path)))
    assert isinstance(result, ToolHandlerResult)
    assert len(result.output) <= MAX_OUTPUT_CHARS
    payload = json.loads(result.output)
    assert len(payload["findings"]) == 30
    assert payload["dropped"] == 0
    assert all(
        finding["title"].startswith(f"{n} ") for n, finding in enumerate(payload["findings"])
    )
    assert payload["findings"][0]["body"]


@pytest.mark.parametrize(
    ("content", "extra"),
    [
        ('x = 1\nAPI_KEY = "sk-abcdefghijklmnop0123"\npassword = "hunter2hunter2"\n', {}),
        (
            "a = 1\n",
            {"body": 'token="test-abcdef123456abcdef12" and api_key: "AKIAIOSFODNN7EXAMPLE"'},
        ),
        ("a = 1\n", {"title": 'Hardcoded password="s3cretValue123" in config'}),
        ("a = 1\n", {"body": 'Authorization: Bearer "eyJhbGciOiJIUzI1NiJ9.abc.def"'}),
        ("a = 1\n", {"title": "Path ends in a backslash C:\\temp\\", "body": 'say "hi"\\'}),
    ],
)
def test_results_stay_valid_json_through_the_router_filters(
    tmp_path: Path, content: str, extra: dict[str, object]
) -> None:
    # Regression: the router's secret redaction ate the backslash of an escaped quote
    # (`token=\"…`), leaving invalid JSON, so the findings list silently did not render.
    from sidecar.ai.routing.tool_execution_results import bounded_tool_output

    (tmp_path / "a.py").write_text(content, encoding="utf-8")
    finding = {"severity": "high", "title": "Hardcoded key", "file": "a.py", "line": 2, **extra}
    output = report_findings_tool({"findings": [finding]}, WorkspaceGuard(str(tmp_path))).output
    delivered, truncated = bounded_tool_output(output, tool_name="report_findings")
    assert truncated is False
    parsed = json.loads(delivered)["findings"][0]
    assert "hunter2" not in delivered and "s3cretValue" not in delivered
    assert "abcdef123456" not in delivered
    if "backslash" in str(extra.get("title", "")):
        assert parsed["title"] == "Path ends in a backslash C:\\temp\\"
        assert parsed["body"] == 'say "hi"\\'


def test_non_ascii_text_and_paths_survive_the_router_filters_unchanged(tmp_path: Path) -> None:
    # Regression: the router's NFKC pass turned a fullwidth quote or backslash into a bare one
    # (invalid JSON) and stripped a zero-width joiner from a path, so Show in diff missed the file.
    from sidecar.ai.routing.tool_execution_results import bounded_tool_output

    odd_name = "a" + chr(0x200D) + "b caf" + chr(0xE9) + ".py"
    (tmp_path / odd_name).write_text("x = 1\ny = 2\n", encoding="utf-8")
    finding = {
        "severity": "high",
        "title": "Bad " + chr(0xFF02) + "quote" + chr(0xFF02) + " ends " + chr(0xFF3C),
        "body": "".join(map(chr, (0x65E5, 0x672C, 0x8A9E))),
        "file": odd_name,
        "line": 2,
    }
    output = report_findings_tool({"findings": [finding]}, WorkspaceGuard(str(tmp_path))).output
    assert output.isascii()
    delivered, _ = bounded_tool_output(output, tool_name="report_findings")
    parsed = json.loads(delivered)["findings"][0]
    assert {key: parsed[key] for key in ("title", "body", "file", "line")} == {
        key: finding[key] for key in ("title", "body", "file", "line")
    }
    assert parsed["excerpt"] == {"start": 1, "lines": ["x = 1", "y = 2"]}
