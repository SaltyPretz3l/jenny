"""Language-server session caching and document sync (detection: server_detection)."""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Literal, Protocol, Sequence

from sidecar.ai.tools.builtins.file_state import open_regular_file
from sidecar.ai.tools.builtins.lsp.limits import LSP_MAX_DOCUMENT_BYTES
from sidecar.ai.tools.builtins.lsp.protocol import (
    LSPProcessSession,
    LSPProtocolError,
    LSPRequestTimeout,
    LSPServerTerminated,
)
from sidecar.ai.tools.builtins.lsp.server_detection import (
    LSPLanguage,
    LSPServerCommand,
    LSPUnavailableResult,
    _resolve_pinned_tsserver,
    detect_language_servers,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure

LSPSessionStatus = Literal["ready", "degraded", "unavailable"]

# Detection moved to server_detection; these names stay importable from here.
__all__ = [
    "LSPDocumentSyncResult",
    "LSPLanguage",
    "LSPManager",
    "LSPServerCommand",
    "LSPSessionStatus",
    "LSPUnavailableResult",
    "detect_language_servers",
    "resolve_language_for_path",
]

_MAX_LIVE_SESSIONS = 4
_MAX_OPEN_DOCUMENTS_PER_SESSION = 256
_MAX_PUBLISHED_DIAGNOSTIC_DOCUMENTS = 256
_MAX_PUBLISHED_DIAGNOSTICS_PER_DOCUMENT = 500

logger = logging.getLogger(__name__)

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
    command: tuple[str, ...]
    session: _SessionLike
    last_used: float
    in_flight: int = 0


@dataclass(frozen=True)
class LSPDocumentSyncResult:
    uri: str
    version: int
    stale_content: bool = False
    reason: str = ""
    too_large: bool = False
    size: int | None = None
    cap: int | None = None


class lsp_server_not_pinned(LSPProtocolError):
    """A TypeScript launcher has no adjacent trusted TypeScript implementation."""


class LSPManager:
    """Runtime-local language-server session cache.

    Sessions are keyed by resolved workspace root and language. A lazy daemon
    sweeps idle sessions; request leases protect initialization, document sync,
    and language features from idle and capacity eviction.
    """

    def __init__(
        self,
        *,
        idle_timeout_seconds: float = 300.0,
        session_factory: SessionFactory | None = None,
        clock: Callable[[], float] = time.monotonic,
        sweep_interval_seconds: float = 60.0,
    ) -> None:
        self._idle_timeout_seconds = max(0.0, float(idle_timeout_seconds))
        self._session_factory = session_factory or self._default_session_factory
        self._clock = clock
        self._sweep_interval_seconds = max(0.001, float(sweep_interval_seconds))
        self._sweep_thread: threading.Thread | None = None
        self._sweep_stop = threading.Event()
        self._shutdown = False
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
        """Return a session without a lease; idle or capacity eviction may close it later."""
        managed = self._acquire_session(
            language=language, workspace_root=workspace_root, command=command, in_flight=False
        )
        return managed.session

    @contextmanager
    def session_for_request(
        self,
        *,
        language: LSPLanguage,
        workspace_root: Path | str,
        command: Sequence[str],
    ) -> Iterator[_SessionLike]:
        """Acquire and protect a session atomically until the tool request ends."""
        managed = self._acquire_session(
            language=language, workspace_root=workspace_root, command=command, in_flight=True
        )
        try:
            yield managed.session
        finally:
            with self._lock:
                managed.in_flight -= 1
                if managed.in_flight == 0:
                    managed.last_used = self._clock()

    def _acquire_session(
        self,
        *,
        language: LSPLanguage,
        workspace_root: Path | str,
        command: Sequence[str],
        in_flight: bool,
    ) -> _ManagedSession:
        workspace = Path(workspace_root).resolve(strict=False)
        key = (str(workspace), language)
        safe_command = tuple(str(part) for part in command)
        if not safe_command:
            raise ValueError("language-server command is required")
        retired: list[_ManagedSession] = []
        try:
            with self._lock:
                current = self._sessions.get(key)
                # A dead session is replaced even while leased; its holder keeps its own reference.
                if current is None or not current.session.is_running:
                    if current is not None:
                        retired.append(self._sessions.pop(key))
                        self._clear_document_state(current.session)
                    session = self._session_factory(safe_command, workspace)
                    if language != "typescript":
                        session.start()
                    current = _ManagedSession(
                        language=language,
                        workspace_key=str(workspace),
                        command=safe_command,
                        session=session,
                        last_used=self._clock(),
                    )
                    self._sessions[key] = current
                current.last_used = self._clock()
                # Protect the just-acquired session even when callers do not take a lease.
                retired.extend(self._trim_sessions_locked(protected=current))
                self._shutdown = False
                self._arm_cleanup_locked()
                # Last, so a failure above cannot strand a lease that no caller will release.
                current.in_flight += int(in_flight)
                return current
        finally:
            self._close_sessions(retired)

    def _trim_sessions_locked(
        self, *, protected: _ManagedSession | None = None
    ) -> list[_ManagedSession]:
        retired: list[_ManagedSession] = []
        candidates = sorted(
            (
                (key, entry)
                for key, entry in self._sessions.items()
                if entry.in_flight == 0 and entry is not protected
            ),
            key=lambda item: item[1].last_used,
        )
        for key, entry in candidates:
            if len(self._sessions) <= _MAX_LIVE_SESSIONS:
                break
            del self._sessions[key]
            self._clear_document_state(entry.session)
            retired.append(entry)
        return retired

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
        managed = next(
            (entry for entry in tuple(self._sessions.values()) if entry.session is session),
            None,
        )
        initialization_options: dict[str, object] = {"language": language}
        requires_typescript_pin = language in {"typescript", "javascript"} or (
            managed is not None and managed.language == "typescript"
        )
        if requires_typescript_pin:
            tsserver_path = (
                _resolve_pinned_tsserver(managed.command[0]) if managed is not None else None
            )
            if tsserver_path is None:
                raise lsp_server_not_pinned(
                    "lsp_server_not_pinned: trusted TypeScript implementation "
                    "was not found beside the language-server launcher"
                )
            initialization_options.update(
                {
                    "tsserver": {"path": str(tsserver_path)},
                    "disableAutomaticTypingAcquisition": True,
                }
            )
        session.start()
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
                "initializationOptions": initialization_options,
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
        managed = next(
            (entry for entry in tuple(self._sessions.values()) if entry.session is session), None
        )
        try:
            if managed is None:
                raise OSError("LSP session has no workspace authority")
            size = path.stat().st_size
            if size > LSP_MAX_DOCUMENT_BYTES:
                return _too_large_sync_result(uri=uri, size=size)
            with open_regular_file(
                path, "rb", authorized_root=Path(managed.workspace_key)
            ) as document:
                content = document.read(LSP_MAX_DOCUMENT_BYTES + 1)
        except (OSError, ToolExecutionFailure) as error:
            return LSPDocumentSyncResult(
                uri=uri,
                version=0,
                stale_content=True,
                reason=f"failed to read document before LSP sync: {type(error).__name__}",
            )
        if len(content) > LSP_MAX_DOCUMENT_BYTES:
            return _too_large_sync_result(uri=uri, size=len(content))
        try:
            text = content.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        except UnicodeDecodeError as error:
            return LSPDocumentSyncResult(
                uri=uri,
                version=0,
                stale_content=True,
                reason=f"document is not UTF-8 text: {type(error).__name__}",
            )

        doc_key = (id(session), uri)
        self._drain_session_notifications(session)
        self._published_diagnostics.pop(doc_key, None)
        previous_version = self._document_versions.get(doc_key, 0)
        version = previous_version + 1
        try:
            if previous_version <= 0:
                open_keys = [key for key in tuple(self._document_versions) if key[0] == id(session)]
                if len(open_keys) >= _MAX_OPEN_DOCUMENTS_PER_SESSION:
                    oldest = open_keys[0]
                    session.notify("textDocument/didClose", {"textDocument": {"uri": oldest[1]}})
                    del self._document_versions[oldest]
                    self._published_diagnostics.pop(oldest, None)
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
        self._document_versions.pop(doc_key, None)
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
        except (LSPRequestTimeout, LSPServerTerminated):
            self._drain_session_notifications(session)
            raise
        except LSPProtocolError:
            self._drain_session_notifications(session)
            cached = self._published_diagnostics.get((id(session), uri))
            if cached is not None:
                return {"diagnostics": list(cached), "source": "publishDiagnostics"}
            raise
        self._drain_session_notifications(session)
        return raw_result

    def evict_idle_sessions(self) -> int:
        return self._evict_idle_sessions()

    def _evict_idle_sessions(self, stop: threading.Event | None = None) -> int:
        retired: list[_ManagedSession] = []
        with self._lock:
            if stop is not None and stop.is_set():
                return 0
            now = self._clock()
            for key, managed in list(self._sessions.items()):
                if managed.in_flight or now - managed.last_used < self._idle_timeout_seconds:
                    continue
                del self._sessions[key]
                self._clear_document_state(managed.session)
                retired.append(managed)
            retired.extend(self._trim_sessions_locked())
            if not self._sessions:
                self._sweep_stop.set()
        self._close_sessions(retired)
        return len(retired)

    def _arm_cleanup_locked(self) -> None:
        if self._sweep_thread is not None or not self._sessions or self._shutdown:
            return
        self._sweep_stop = threading.Event()
        self._sweep_thread = threading.Thread(
            target=self._run_cleanup,
            args=(self._sweep_stop,),
            name="lsp-idle-cleanup",
            daemon=True,
        )
        try:
            self._sweep_thread.start()
        except BaseException:
            self._sweep_thread = None
            raise

    def _run_cleanup(self, stop: threading.Event) -> None:
        try:
            while not stop.wait(self._sweep_interval_seconds):
                self._evict_idle_sessions(stop)
        finally:
            with self._lock:
                self._sweep_thread = None
                # A request may arrive while an empty-cache worker is exiting.
                self._arm_cleanup_locked()

    def shutdown(self) -> None:
        with self._lock:
            self._shutdown = True
            self._sweep_stop.set()
            worker = self._sweep_thread
            sessions = list(self._sessions.values())
            self._sessions.clear()
            for managed in sessions:
                self._clear_document_state(managed.session)
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=1.0)
        self._close_sessions(sessions)

    @staticmethod
    def _close_sessions(sessions: Sequence[_ManagedSession]) -> None:
        for managed in sessions:
            try:
                managed.session.close()
            except Exception as error:  # noqa: BLE001 - one bad close must not skip the rest.
                logger.warning("LSP session close failed: %s", type(error).__name__)

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
        current_version = self._document_versions.get(key, 0)
        published_version = params.get("version")
        if published_version is None:
            if current_version > 1:
                return
        elif published_version != current_version:
            return
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


def _too_large_sync_result(*, uri: str, size: int) -> LSPDocumentSyncResult:
    return LSPDocumentSyncResult(
        uri=uri,
        version=0,
        stale_content=True,
        reason="document exceeds the LSP synchronization size limit",
        too_large=True,
        size=size,
        cap=LSP_MAX_DOCUMENT_BYTES,
    )
