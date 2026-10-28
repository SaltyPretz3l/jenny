"""Extension-to-language mapping split out of ``lsp.manager``."""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.lsp import manager, paths
from sidecar.ai.tools.builtins.lsp.languages import (
    SUPPORTED_EXTENSIONS,
    language_id_for_path,
    resolve_language_for_path,
)


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("src/App.TSX", "typescript"),
        ("lib/util.cjs", "javascript"),
        ("pkg/stubs.pyi", "python"),
        ("README.md", None),
    ],
)
def test_resolve_language_for_path(path: str, expected: str | None) -> None:
    assert resolve_language_for_path(path) == expected


def test_jsx_dialects_get_their_own_language_id() -> None:
    assert language_id_for_path(Path("view.tsx"), "typescript") == "typescriptreact"
    assert language_id_for_path(Path("view.jsx"), "javascript") == "javascriptreact"
    assert language_id_for_path(Path("main.py"), "python") == "python"


def test_manager_keeps_its_public_names_and_no_private_reexport() -> None:
    assert manager.resolve_language_for_path is resolve_language_for_path
    # paths reads the supported list from its owner, not a manager re-export.
    assert not hasattr(manager, "_EXTENSION_LANGUAGE_MAP")
    assert not hasattr(paths, "_EXTENSION_LANGUAGE_MAP")


def test_supported_extensions_cover_every_mapped_suffix() -> None:
    assert ".py" in SUPPORTED_EXTENSIONS and ".tsx" in SUPPORTED_EXTENSIONS
    assert all(resolve_language_for_path(f"a{ext}") for ext in SUPPORTED_EXTENSIONS)
