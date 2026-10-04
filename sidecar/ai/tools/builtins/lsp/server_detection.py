"""Language-server command detection and the pinned TypeScript server lookup."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

LSPLanguage = Literal["typescript", "javascript", "python"]

_TYPESCRIPT_DEFAULT_COMMANDS = ("typescript-language-server",)
_PYTHON_DEFAULT_COMMANDS = ("pyright-langserver", "pylsp")


@dataclass(frozen=True)
class LSPUnavailableResult:
    """Structured unavailable-server detection result surfaced by the LSP tool handlers."""

    language: LSPLanguage
    reason: str
    install_hint: str | None = None
    configured_command: str | None = None


@dataclass(frozen=True)
class LSPServerCommand:
    """A resolved command that can launch a language server."""

    language: LSPLanguage
    executable: str
    source: Literal["configured", "path"]


def _resolve_pinned_tsserver(executable: str) -> Path | None:
    launcher_path = Path(executable)
    try:
        launcher_real = launcher_path.resolve(strict=True)
    except OSError:
        return None

    candidates: list[tuple[Path, Path]] = []
    seen: set[str] = set()

    def add_candidate(candidate: Path, anchor: Path) -> None:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            candidates.append((candidate, anchor))

    for launcher_dir in (launcher_path.parent, launcher_real.parent):
        add_candidate(
            launcher_dir / "node_modules" / "typescript" / "lib" / "tsserver.js",
            launcher_dir,
        )

    for parent in (launcher_real.parent, *launcher_real.parents):
        if (parent / "package.json").is_file():
            add_candidate(
                parent / "node_modules" / "typescript" / "lib" / "tsserver.js",
                parent,
            )
            if parent.parent.name.lower() == "node_modules":
                add_candidate(
                    parent.parent / "typescript" / "lib" / "tsserver.js",
                    parent.parent,
                )
            break
        if parent.name.lower() == "typescript-language-server":
            add_candidate(
                parent / "node_modules" / "typescript" / "lib" / "tsserver.js",
                parent,
            )
            add_candidate(
                parent.parent / "typescript" / "lib" / "tsserver.js",
                parent.parent,
            )
            break

    for candidate, anchor in candidates:
        try:
            resolved_anchor = anchor.resolve(strict=True)
            resolved_candidate = candidate.resolve(strict=True)
            resolved_candidate.relative_to(resolved_anchor)
        except (OSError, ValueError):
            continue
        if resolved_candidate.is_file():
            return resolved_candidate
    return None


def detect_language_servers(
    *,
    configured_typescript_command: str | None = None,
    configured_python_command: str | None = None,
) -> dict[LSPLanguage, LSPServerCommand | LSPUnavailableResult]:
    """Detect available language-server commands per supported language.

    Detection precedence per language:
    1. Configured command (``RuntimeConfig.tools_lsp_command_<lang>``) — if
       set, must resolve through ``shutil.which`` or be an absolute path
       to an existing file.
    2. Built-in default candidates on PATH.

    The result map always carries an entry for every supported language so
    callers can show "available" / "unavailable" rows without re-checking.
    """

    return {
        "typescript": _resolve_for_language(
            language="typescript",
            configured=configured_typescript_command,
            defaults=_TYPESCRIPT_DEFAULT_COMMANDS,
            install_hint=(
                "npm install -g typescript-language-server typescript "
                "or configure tools_lsp_command_typescript"
            ),
        ),
        "python": _resolve_for_language(
            language="python",
            configured=configured_python_command,
            defaults=_PYTHON_DEFAULT_COMMANDS,
            install_hint=(
                "npm install -g pyright "
                "or configure tools_lsp_command_python"
            ),
        ),
    }


def _resolve_for_language(
    *,
    language: LSPLanguage,
    configured: str | None,
    defaults: tuple[str, ...],
    install_hint: str,
) -> LSPServerCommand | LSPUnavailableResult:
    if configured:
        resolved = _resolve_executable(configured)
        if resolved:
            return LSPServerCommand(
                language=language,
                executable=resolved,
                source="configured",
            )
        return LSPUnavailableResult(
            language=language,
            reason="configured command not found",
            install_hint=install_hint,
            configured_command=configured,
        )
    for candidate in defaults:
        resolved = shutil.which(candidate)
        if resolved:
            return LSPServerCommand(
                language=language,
                executable=resolved,
                source="path",
            )
    return LSPUnavailableResult(
        language=language,
        reason=f"no language server found on PATH for {language}",
        install_hint=install_hint,
        configured_command=None,
    )


def _resolve_executable(command: str) -> str | None:
    """Resolve a configured command to an absolute path if possible."""

    candidate = command.strip()
    if not candidate:
        return None
    # If the configured value already points to an existing file, use it.
    candidate_path = Path(candidate)
    if candidate_path.is_absolute() and candidate_path.is_file():
        return str(candidate_path)
    # Otherwise treat as a PATH lookup.
    resolved = shutil.which(candidate)
    return resolved
