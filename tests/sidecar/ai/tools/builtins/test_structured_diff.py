from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.tools.builtins import structured_diff as structured_diff_module
from sidecar.ai.tools.builtins.structured_diff import (
    MAX_DIFF_BYTES,
    MAX_DIFF_CONTEXT_LINES,
    MAX_DIFF_HUNKS,
    MAX_DIFF_LINE_CHARS,
    MAX_DIFF_LINES,
    build_failed_diff_metadata,
    compute_structured_diff,
)

FIXTURE_PATH = Path("tests/fixtures/diff/cases.json")


def _fixture_cases() -> list[dict[str, Any]]:
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert payload["version"] == 1
    return list(payload["cases"])


def test_constants_match_js_structured_diff_contract() -> None:
    assert MAX_DIFF_BYTES == 32 * 1024
    assert MAX_DIFF_HUNKS == 64
    assert MAX_DIFF_LINES == 200
    assert MAX_DIFF_LINE_CHARS == 2000
    assert MAX_DIFF_CONTEXT_LINES == 3


@pytest.mark.parametrize("case", _fixture_cases(), ids=lambda item: item["name"])
def test_compute_structured_diff_matches_shared_fixture(case: dict[str, Any]) -> None:
    diff = compute_structured_diff(
        case["file_path"],
        case["old_text"],
        case["new_text"],
        status=case.get("status"),
        **dict(case.get("options") or {}),
    )

    assert diff == case["expected"]


def test_failed_diff_metadata_is_bounded_and_review_failed() -> None:
    diff = build_failed_diff_metadata(
        "notes.txt",
        "alpha\n",
        "beta\n",
        status="modified",
    )

    assert diff["status"] == "modified"
    assert diff["review_state"] == "failed"
    assert diff["body_kind"] == "none"
    assert diff["additions"] == 1
    assert diff["deletions"] == 1
    assert diff["truncated"] is True
    assert diff["truncation_reason"] == "diff_generation_failed"
    assert diff["hunks"] == []
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", str(diff["before_hash"]))
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", str(diff["after_hash"]))


def test_compute_structured_diff_redacts_paths_from_failure_diagnostics(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class BadText:
        def __str__(self) -> str:
            raise RuntimeError("cannot stringify C:\\Users\\example\\secret\\notes.txt")

    logger = logging.getLogger("tests.structured_diff")
    caplog.set_level(logging.WARNING, logger=logger.name)

    result = compute_structured_diff(
        "C:\\Users\\example\\secret\\notes.txt",
        BadText(),
        "new text",
        logger=logger,
    )

    assert result is None
    records = [
        record for record in caplog.records if getattr(record, "event", "") == "tool.diff_generation_failed"
    ]
    assert len(records) == 1
    data = getattr(records[0], "data", {})
    assert data["file_name"] == "notes.txt"
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", data["path_hash"])
    serialized = json.dumps(
        {
            "message": records[0].getMessage(),
            "data": data,
        },
        sort_keys=True,
    )
    assert "secret" not in serialized
    assert "example" not in serialized


def test_compute_structured_diff_preflights_large_hunks_before_materializing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _unexpected_build_hunk(*_args: object, **_kwargs: object) -> dict[str, object]:
        raise AssertionError("oversized diff body should be summarized before hunk building")

    monkeypatch.setattr(structured_diff_module, "_build_hunk", _unexpected_build_hunk)

    diff = compute_structured_diff(
        "large.txt",
        "",
        "".join(f"line {index}\n" for index in range(MAX_DIFF_LINES + 1)),
        status="created",
    )

    assert diff is not None
    assert diff["status"] == "created"
    assert diff["additions"] == MAX_DIFF_LINES + 1
    assert diff["deletions"] == 0
    assert diff["review_state"] == "summary_only"
    assert diff["body_kind"] == "summary_only"
    assert diff["truncated"] is True
    assert diff["truncation_reason"] == "line_limit"
    assert diff["hunks"] == []


def test_diff_failure_logging_tolerates_unstringifiable_path(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class BadPath:
        def __str__(self) -> str:
            raise RuntimeError("path stringify failed")

    class BadText:
        def __str__(self) -> str:
            raise RuntimeError("text stringify failed")

    logger = logging.getLogger("tests.structured_diff.bad_path")
    caplog.set_level(logging.WARNING, logger=logger.name)

    result = compute_structured_diff(BadPath(), BadText(), "new text", logger=logger)

    assert result is None
    assert [
        record for record in caplog.records if getattr(record, "event", "") == "tool.diff_generation_failed"
    ]
