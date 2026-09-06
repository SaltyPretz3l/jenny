"""Language-server detection, session caching, and document sync."""

from __future__ import annotations

import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Protocol, Sequence

from sidecar.ai.tools.builtins.lsp.protocol import LSPProcessSession, LSPProtocolError

LSPLanguage = Literal["typescript", "javascript", "python"]
LSPSessionStatus = Literal["ready", "degraded", "unavailable"]

_TYPESCRIPT_DEFAULT_COMMANDS = ("typescript-language-server",)
_PYTHON_DEFAULT_COMMANDS = ("pyright-langserver", "pylsp")
_MAX_PUBLISHED_DIAGNOSTIC_DOCUMENTS = 256
_MAX_PUBLISHED_DIAGNOSTICS_PER_DOCUMENT = 500

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


class _SessionLike(Protocol):
    @property
    def is_running(self) -> bool: ...

    def start(self) -> None: ...

    def close(self) -> None: ...

    def request(self, method: str, params: dict[str, object] | None = None) -> object: ...

    def notify(self, method: str, params: dict[str, object]) -> None: ...


SessionFactory = Callable[[tuple[str, ...], Path], _SessionLike]


@dataclass
class _ManagedSession:
    language: LSPLanguage
    workspace_key: str
    session: _SessionLike
    last_used: float


@dataclass(frozen=True)
class LSPDocumentSyncResult:
    uri: str
    version: int
    stale_content: bool = False
    reason: str = ""


class LSPManager:
    """Runtime-local language-server session cache.

    Sessions are keyed by resolved workspace root and language. Phase 3 tool
    handlers will call ``ensure_session`` before issuing diagnostics/symbols
    requests, then ``evict_idle_sessions`` during bounded cleanup checkpoints.
    """

    def __init__(
        self,
        *,
        idle_timeout_seconds: float = 300.0,
        session_factory: SessionFactory | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._idle_timeout_seconds = max(0.0, float(idle_timeout_seconds))
        self._session_factory = session_factory or self._default_session_factory
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._sessions: dict[tuple[str, LSPLanguage], _ManagedSession] = {}
        self._document_versions: dict[tuple[int, str], int] = {}
        self._published_diagnostics: dict[tuple[int, str], list[object]] = {}
        self._initialized_sessions: set[int] = set()

    def ensure_session(
        self,
        *,
        language: LSPLanguage,
        workspace_root: Path | str,
        command: Sequence[str],
    ) -> _SessionLike:
        workspace = Path(workspace_root).resolve(strict=False)
        key = (str(workspace), language)
        now = self._clock()
        safe_command = tuple(str(part) for part in command)
        if not safe_command:
            raise ValueError("language-server command is required")
        with self._lock:
            current = self._sessions.get(key)
            if current is not None and current.session.is_running:
                current.last_used = now
                return current.session
            if current is not None:
                current.session.close()
                self._clear_document_state(current.session)
            session = self._session_factory(safe_command, workspace)
            session.start()
            self._sessions[key] = _ManagedSession(
                language=language,
                workspace_key=str(workspace),
                session=session,
                last_used=now,
            )
            return session

    def ensure_initialized(
        self,
        *,
        session: _SessionLike,
        language: LSPLanguage,
        workspace_root: Path | str,
    ) -> None:
        session_id = id(session)
        if session_id in self._initialized_sessions:
            return
        workspace = Path(workspace_root).resolve(strict=False)
        session.request(
            "initialize",
            {
                "processId": None,
                "rootUri": workspace.as_uri(),
                "capabilities": {
                    "textDocument": {
                        "documentSymbol": {
                            "hierarchicalDocumentSymbolSupport": True,
                        },
                        "definition": {"linkSupport": True},
                        "references": {},
                        "diagnostic": {},
                    }
                },
                "initializationOptions": {"language": language},
            },
        )
        session.notify("initialized", {})
        self._initialized_sessions.add(session_id)

    def sync_document(
        self,
        *,
        session: _SessionLike,
        language: LSPLanguage,
        file_path: Path | str,
    ) -> LSPDocumentSyncResult:
        path = Path(file_path).resolve(strict=False)
        uri = path.as_uri()
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            return LSPDocumentSyncResult(
                uri=uri,
                version=0,
                stale_content=True,
                reason=f"failed to read document before LSP sync: {type(error).__name__}",
            )
        except UnicodeDecodeError as error:
            return LSPDocumentSyncResult(
                uri=uri,
                version=0,
                stale_content=True,
                reason=f"document is not UTF-8 text: {type(error).__name__}",
            )

        doc_key = (id(session), uri)
        previous_version = self._document_versions.get(doc_key, 0)
        version = previous_version + 1
        try:
            if previous_version <= 0:
                session.notify(
                    "textDocument/didOpen",
                    {
                        "textDocument": {
                            "uri": uri,
                            "languageId": language,
                            "version": version,
                            "text": text,
                        }
                    },
                )
            else:
                session.notify(
                    "textDocument/didChange",
                    {
                        "textDocument": {"uri": uri, "version": version},
                        "contentChanges": [{"text": text}],
                    },
                )
        except LSPProtocolError as error:
            return LSPDocumentSyncResult(
                uri=uri,
                version=previous_version,
                stale_content=True,
                reason=f"failed to send document sync notification: {type(error).__name__}",
            )
        self._document_versions[doc_key] = version
        return LSPDocumentSyncResult(uri=uri, version=version)

    def request_document_diagnostics(
        self,
        *,
        session: _SessionLike,
        uri: str,
    ) -> object:
        try:
            raw_result = session.request(
                "textDocument/diagnostic",
                {"textDocument": {"uri": uri}},
            )
        except LSPProtocolError:
            self._drain_session_notifications(session)
            cached = self._published_diagnostics.get((id(session), uri))
            if cached is not None:
                return {"diagnostics": list(cached), "source": "publishDiagnostics"}
            raise
        self._drain_session_notifications(session)
        return raw_result

    def evict_idle_sessions(self) -> int:
        now = self._clock()
        evicted = 0
        with self._lock:
            for key, managed in list(self._sessions.items()):
                if now - managed.last_used < self._idle_timeout_seconds:
                    continue
                managed.session.close()
                del self._sessions[key]
                self._clear_document_state(managed.session)
                evicted += 1
        return evicted

    def shutdown(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for managed in sessions:
            managed.session.close()
            self._clear_document_state(managed.session)

    @staticmethod
    def _default_session_factory(command: tuple[str, ...], workspace_root: Path) -> _SessionLike:
        return LSPProcessSession(command=command, workspace_root=workspace_root)

    def _clear_document_state(self, session: _SessionLike) -> None:
        session_id = id(session)
        for key in list(self._document_versions):
            if key[0] == session_id:
                del self._document_versions[key]
        for key in list(self._published_diagnostics):
            if key[0] == session_id:
                del self._published_diagnostics[key]
        self._initialized_sessions.discard(session_id)

    def _drain_session_notifications(self, session: _SessionLike) -> None:
        drain_notifications = getattr(session, "drain_notifications", None)
        if not callable(drain_notifications):
            return
        for message in drain_notifications():
            self._record_notification(session, message)

    def _record_notification(self, session: _SessionLike, message: object) -> None:
        if not isinstance(message, dict):
            return
        if message.get("method") != "textDocument/publishDiagnostics":
            return
        params = message.get("params")
        if not isinstance(params, dict):
            return
        uri = params.get("uri")
        diagnostics = params.get("diagnostics")
        if not isinstance(uri, str) or not isinstance(diagnostics, list):
            return
        key = (id(session), uri)
        self._published_diagnostics[key] = list(
            diagnostics[:_MAX_PUBLISHED_DIAGNOSTICS_PER_DOCUMENT]
        )
        while len(self._published_diagnostics) > _MAX_PUBLISHED_DIAGNOSTIC_DOCUMENTS:
            oldest_key = next(iter(self._published_diagnostics))
            del self._published_diagnostics[oldest_key]


def resolve_language_for_path(path: Path | str) -> LSPLanguage | None:
    """Return the LSP language for a workspace-relative or absolute path."""

    suffix = Path(str(path)).suffix.lower()
    return _EXTENSION_LANGUAGE_MAP.get(suffix)


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
