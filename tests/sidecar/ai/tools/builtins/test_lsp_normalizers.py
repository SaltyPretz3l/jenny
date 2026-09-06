from __future__ import annotations

from pathlib import Path

from sidecar.ai.tools.builtins.lsp.normalizers import (
    normalize_definitions,
    normalize_diagnostics,
    normalize_references,
    normalize_symbols,
)
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_normalize_diagnostics_caps_and_maps_severity() -> None:
    payload = normalize_diagnostics(
        {
            "items": [
                {
                    "severity": 1,
                    "source": "pyright",
                    "code": "reportGeneralTypeIssues",
                    "message": "x" * 700,
                    "range": {
                        "start": {"line": 2, "character": 4},
                        "end": {"line": 2, "character": 9},
                    },
                },
                {
                    "severity": 2,
                    "message": "second",
                    "range": {
                        "start": {"line": 3, "character": 0},
                        "end": {"line": 3, "character": 1},
                    },
                },
            ]
        },
        file_path="pkg/module.py",
        max_diagnostics=1,
    )

    assert payload["file"] == "pkg/module.py"
    assert payload["total_count"] == 2
    assert payload["truncated"] is True
    assert payload["diagnostics"] == [
        {
            "severity": "error",
            "source": "pyright",
            "code": "reportGeneralTypeIssues",
            "message": "x" * 500 + "...[truncated]",
            "range": {
                "start": {"line": 2, "character": 4},
                "end": {"line": 2, "character": 9},
            },
        }
    ]


def test_normalize_symbols_flattens_document_symbols_with_container_names() -> None:
    payload = normalize_symbols(
        [
            {
                "name": "Outer",
                "kind": 5,
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 10, "character": 0},
                },
                "selectionRange": {
                    "start": {"line": 0, "character": 6},
                    "end": {"line": 0, "character": 11},
                },
                "children": [
                    {
                        "name": "method",
                        "kind": 6,
                        "range": {
                            "start": {"line": 1, "character": 2},
                            "end": {"line": 3, "character": 2},
                        },
                        "selectionRange": {
                            "start": {"line": 1, "character": 6},
                            "end": {"line": 1, "character": 12},
                        },
                    }
                ],
            }
        ],
        file_path="pkg/module.py",
        max_symbols=10,
    )

    assert payload["file"] == "pkg/module.py"
    assert payload["total_count"] == 2
    assert payload["truncated"] is False
    assert payload["symbols"] == [
        {
            "name": "Outer",
            "kind": "class",
            "container_name": "",
            "file": "pkg/module.py",
            "range": {
                "start": {"line": 0, "character": 0},
                "end": {"line": 10, "character": 0},
            },
            "selection_range": {
                "start": {"line": 0, "character": 6},
                "end": {"line": 0, "character": 11},
            },
        },
        {
            "name": "method",
            "kind": "method",
            "container_name": "Outer",
            "file": "pkg/module.py",
            "range": {
                "start": {"line": 1, "character": 2},
                "end": {"line": 3, "character": 2},
            },
            "selection_range": {
                "start": {"line": 1, "character": 6},
                "end": {"line": 1, "character": 12},
            },
        },
    ]


def test_normalize_symbols_counts_truncated_symbols_without_retaining_all() -> None:
    payload = normalize_symbols(
        [
            {
                "name": "first",
                "kind": 12,
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 5},
                },
            },
            {
                "name": "second",
                "kind": 12,
                "range": {
                    "start": {"line": 1, "character": 0},
                    "end": {"line": 1, "character": 6},
                },
            },
            {
                "name": "third",
                "kind": 12,
                "range": {
                    "start": {"line": 2, "character": 0},
                    "end": {"line": 2, "character": 5},
                },
            },
        ],
        file_path="pkg/module.py",
        max_symbols=2,
    )

    assert payload["total_count"] == 3
    assert payload["truncated"] is True
    assert [symbol["name"] for symbol in payload["symbols"]] == ["first", "second"]


def test_normalize_definitions_handles_location_and_location_link(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    sibling = workspace_root / "other.py"
    outside = tmp_path / "outside.py"
    for path in (target, sibling, outside):
        path.write_text("x = 1\n", encoding="utf-8")

    payload = normalize_definitions(
        [
            {
                "uri": sibling.as_uri(),
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 1},
                },
            },
            {
                "targetUri": target.as_uri(),
                "targetRange": {
                    "start": {"line": 0, "character": 2},
                    "end": {"line": 0, "character": 3},
                },
                "targetSelectionRange": {
                    "start": {"line": 0, "character": 2},
                    "end": {"line": 0, "character": 3},
                },
            },
            {
                "uri": outside.as_uri(),
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 1},
                },
            },
            {
                "uri": "file:relative.py",
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 1},
                },
            },
            {
                "uri": "file://localhost",
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 1},
                },
            },
            {
                "uri": workspace_root.as_uri(),
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 1},
                },
            },
            {"uri": sibling.as_uri(), "range": "bad"},
            None,
        ],
        workspace=WorkspaceGuard(str(workspace_root)),
        max_locations=10,
    )

    assert payload == {
        "definitions": [
            {
                "file": "other.py",
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 1},
                },
            },
            {
                "file": "module.py",
                "range": {
                    "start": {"line": 0, "character": 2},
                    "end": {"line": 0, "character": 3},
                },
                "selection_range": {
                    "start": {"line": 0, "character": 2},
                    "end": {"line": 0, "character": 3},
                },
            },
        ],
        "total_count": 2,
        "omitted_external_count": 4,
        "malformed_count": 2,
        "truncated": False,
    }


def test_normalize_references_groups_by_file_after_truncation(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    sibling = workspace_root / "other.py"
    target.write_text("first\nsecond\n", encoding="utf-8")
    sibling.write_text("third\n", encoding="utf-8")

    payload = normalize_references(
        [
            {
                "uri": target.as_uri(),
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 5},
                },
            },
            {
                "uri": target.as_uri(),
                "range": {
                    "start": {"line": 1, "character": 0},
                    "end": {"line": 1, "character": 6},
                },
            },
            {
                "uri": sibling.as_uri(),
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 5},
                },
            },
        ],
        workspace=WorkspaceGuard(str(workspace_root)),
        max_references=2,
    )

    assert payload == {
        "references_by_file": [
            {
                "file": "module.py",
                "references": [
                    {
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 0, "character": 5},
                        }
                    },
                    {
                        "range": {
                            "start": {"line": 1, "character": 0},
                            "end": {"line": 1, "character": 6},
                        }
                    },
                ],
            }
        ],
        "total_count": 3,
        "omitted_external_count": 0,
        "malformed_count": 0,
        "truncated": True,
    }


def test_location_normalizers_treat_null_and_empty_results_as_empty(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    workspace = WorkspaceGuard(str(workspace_root))

    assert normalize_definitions(None, workspace=workspace, max_locations=10) == {
        "definitions": [],
        "total_count": 0,
        "omitted_external_count": 0,
        "malformed_count": 0,
        "truncated": False,
    }
    assert normalize_references([], workspace=workspace, max_references=10) == {
        "references_by_file": [],
        "total_count": 0,
        "omitted_external_count": 0,
        "malformed_count": 0,
        "truncated": False,
    }
