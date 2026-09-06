"""Rich-file notebook inspect adapter tests."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from sidecar.ai.tools.workspace import WorkspaceGuard


def _notebook_tool():
    try:
        module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.notebook")
    except ModuleNotFoundError as exc:
        pytest.fail(f"notebook inspect adapter is not implemented: {exc}")
    return module.notebook_inspect_tool


def _write_notebook(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "nbformat": 4,
                "nbformat_minor": 5,
                "metadata": {
                    "kernelspec": {"name": "python3", "display_name": "Python 3"},
                    "language_info": {"name": "python"},
                    "widgets": {"application/vnd.jupyter.widget-state+json": {}},
                },
                "cells": [
                    {
                        "cell_type": "markdown",
                        "metadata": {},
                        "source": "# Visible Markdown\nA short note.",
                    },
                    {
                        "cell_type": "code",
                        "metadata": {},
                        "execution_count": 1,
                        "source": "print('visible source')\n",
                        "outputs": [
                            {
                                "output_type": "stream",
                                "name": "stdout",
                                "text": "OUTPUT_SECRET",
                            },
                            {
                                "output_type": "display_data",
                                "data": {
                                    "text/plain": "DISPLAY_SECRET",
                                    "image/png": "data:image/png;base64,SECRET",
                                },
                                "metadata": {},
                            },
                        ],
                    },
                    {
                        "cell_type": "code",
                        "metadata": {"jupyter": {"source_hidden": True, "outputs_hidden": True}},
                        "source": "HIDDEN_SOURCE_SECRET",
                        "outputs": [{"output_type": "execute_result", "data": {"text/plain": "42"}}],
                        "attachments": {
                            "hidden.png": {"image/png": "data:image/png;base64,ATTACHMENT"}
                        },
                    },
                ],
            }
        ),
        encoding="utf-8",
    )


def test_notebook_inspect_summarizes_ipynb_without_output_bodies(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_notebook(workspace_root / "analysis.ipynb")

    result = _notebook_tool()({"path": "analysis.ipynb"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["result_kind"] == "notebook_inspect"
    summary = result.metadata["summary"]
    assert summary["nbformat"] == 4
    assert summary["nbformat_minor"] == 5
    assert summary["kernel_name"] == "python3"
    assert summary["language"] == "python"
    assert summary["cell_count"] == 3
    assert summary["cell_type_counts"] == {"markdown": 1, "code": 2}
    assert summary["output_count"] == 3
    assert summary["output_type_counts"] == {"stream": 1, "display_data": 1, "execute_result": 1}
    assert summary["attachments_present"] is True
    assert summary["widgets_metadata_present"] is True
    assert summary["hidden_source_cell_count"] == 1
    assert summary["hidden_output_cell_count"] == 1
    assert "Visible Markdown" in result.output
    assert "visible source" in result.output
    assert "OUTPUT_SECRET" not in result.output
    assert "DISPLAY_SECRET" not in result.output
    assert "HIDDEN_SOURCE_SECRET" not in result.output
    assert "data:image/png" not in result.output
    assert str(workspace_root) not in result.output


def test_notebook_inspect_omits_untrusted_tokens_and_source_data_uris(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "hostile.ipynb").write_text(
        json.dumps(
            {
                "nbformat": 4,
                "nbformat_minor": 5,
                "metadata": {},
                "cells": [
                    {
                        "cell_type": "data:image/png;base64,CELLTYPESECRET",
                        "metadata": {},
                        "source": "![img](data:image/png;base64,SOURCESECRET)\n",
                        "outputs": [
                            {
                                "output_type": "data:image/png;base64,OUTPUTTYPESECRET",
                                "data": {"text/plain": "OUTPUT_BODY_SECRET"},
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    result = _notebook_tool()({"path": "hostile.ipynb"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    summary = result.metadata["summary"]
    assert summary["cell_type_counts"] == {"unknown": 1}
    assert summary["output_type_counts"] == {"unknown": 1}
    assert summary["cells"][0]["cell_type"] == "unknown"
    assert summary["cells"][0]["output_types"] == ["unknown"]
    assert "CELLTYPESECRET" not in result.output
    assert "OUTPUTTYPESECRET" not in result.output
    assert "SOURCESECRET" not in result.output
    assert "OUTPUT_BODY_SECRET" not in result.output
    assert "data:image/png" not in result.output


def test_notebook_inspect_caps_sampled_cells(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_notebook(workspace_root / "analysis.ipynb")

    result = _notebook_tool()(
        {"path": "analysis.ipynb", "max_cells": 1},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.metadata["summary"]["omitted_cell_count"] == 2
    assert len(result.metadata["summary"]["cells"]) == 1


def test_notebook_inspect_invalid_json_returns_unsupported(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "broken.ipynb").write_text("{not json", encoding="utf-8")

    result = _notebook_tool()({"path": "broken.ipynb"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "notebook_parse_failed"
