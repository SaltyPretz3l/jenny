from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_path_identity import (
    resolve_workspace_leaf,
    revalidate_workspace_leaf,
)


def test_revalidate_workspace_leaf_allows_directory_child_churn(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "scripts"
    directory.mkdir()
    identity = resolve_workspace_leaf(tmp_path, "scripts")

    (directory / "new.js").write_text("new\n", encoding="utf-8")

    revalidate_workspace_leaf(identity)


def test_revalidate_workspace_leaf_rejects_file_content_change(tmp_path: Path) -> None:
    target = tmp_path / "source.txt"
    target.write_text("before\n", encoding="utf-8")
    identity = resolve_workspace_leaf(tmp_path, "source.txt")

    target.write_text("after with a different size\n", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure, match="leaf changed before use"):
        revalidate_workspace_leaf(identity)


@pytest.mark.parametrize("original_kind", ["file", "directory"])
def test_revalidate_workspace_leaf_rejects_leaf_type_change(
    tmp_path: Path,
    original_kind: str,
) -> None:
    target = tmp_path / "target"
    if original_kind == "directory":
        target.mkdir()
    else:
        target.write_text("file\n", encoding="utf-8")
    identity = resolve_workspace_leaf(tmp_path, "target")

    if original_kind == "directory":
        target.rmdir()
        target.write_text("replacement\n", encoding="utf-8")
    else:
        target.unlink()
        target.mkdir()

    with pytest.raises(ToolExecutionFailure, match="leaf changed before use"):
        revalidate_workspace_leaf(identity)
