"""File-extension to LSP language mapping for the language-server tools."""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.tools.builtins.lsp_settings import LSPLanguage

_EXTENSION_LANGUAGE_MAP: dict[str, LSPLanguage] = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyi": "python",
}

# The suffixes the LSP tools accept, for refusal messages.
SUPPORTED_EXTENSIONS: tuple[str, ...] = tuple(_EXTENSION_LANGUAGE_MAP)

# LSP languageId values that differ from the tool language (JSX dialects).
_EXTENSION_LANGUAGE_ID_MAP: dict[str, str] = {
    ".tsx": "typescriptreact",
    ".jsx": "javascriptreact",
}


def resolve_language_for_path(path: Path | str) -> LSPLanguage | None:
    """Return the LSP language for a workspace-relative or absolute path."""

    suffix = Path(str(path)).suffix.lower()
    return _EXTENSION_LANGUAGE_MAP.get(suffix)


def language_id_for_path(path: Path, language: LSPLanguage) -> str:
    return _EXTENSION_LANGUAGE_ID_MAP.get(path.suffix.lower(), language)


__all__ = ["SUPPORTED_EXTENSIONS", "language_id_for_path", "resolve_language_for_path"]
