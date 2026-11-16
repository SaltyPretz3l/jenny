"""Process-owned, pinned-root IO for the hosted builtin tool worker (the facade).

Process state, the request `ContextVar`, the public functions and backend
selection; no OS calls. The worker configures one approved root at startup and a
backend turns it into an opaque pin, replaced/closed on reconfiguration. It is
not a permission grant supplied by model arguments. `select_backend` imports a
backend only when picked: POSIX hosts get `hosted_file_io_posix`; `win32` gets
`hosted_file_io_win32` only when its switch is on and its library is usable; any
other platform fails closed. The switch is a process setting the worker sets from
its arguments (`--hosted-win32-files`), off by default; nothing here reads the
environment. On `win32` the process-level configure pins nothing: the backend
refuses a root without an identity, which only a per-request scope carries.
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import AbstractContextManager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Iterator, Protocol, cast

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure

_POSIX_PLATFORMS = frozenset({"linux", "darwin"})
_WIN32_BACKEND = "sidecar.ai.tools.hosted_file_io_win32"
# Start reasons this module answers itself; the Windows client owns the rest.
PLATFORM_UNSUPPORTED = "file_access_platform_unsupported"
SWITCH_OFF = "file_access_switch_off"
COMPONENT_MISSING = "file_access_component_missing"

_win32_files = False
_enabled = False
_root: Path | None = None
_pin: HostedPin | None = None
_backend: HostedBackend | None = None
_operation_io: ContextVar["HostedFileIOOperation | None"] = ContextVar(
    "hosted_file_io_operation", default=None
)


def path_failure() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message="Hosted file access requires a regular single-link file in the approved workspace.",
        retryable=False,
    )


class HostedPin(Protocol):
    """A backend's opaque handle on the pinned root. The facade only closes it."""

    def close(self) -> None: ...


class HostedEntry(Protocol):
    """What `list_dir` reads from an entry (`os.DirEntry` satisfies it)."""

    @property
    def name(self) -> str: ...
    def is_dir(self, *, follow_symlinks: bool = True) -> bool: ...
    def stat(self, *, follow_symlinks: bool = True) -> Any: ...  # has `st_size`


class HostedDirectory(Protocol):
    """A directory reached through the pin. Entries are valid inside its scope.

    One `scan` call per directory scope; a second call raises the path failure.
    """

    def scan(self, limit: int) -> list[HostedEntry]: ...


class HostedBackend(Protocol):
    """One call per operation; `unavailable_reason` never raises."""

    def unavailable_reason(self, root: Path | None = None, expected_device_id: str | None = None,
                           expected_inode: str | None = None) -> str | None: ...
    def open_root(self, root: Path, expected_device_id: str | None,
                  expected_inode: str | None) -> HostedPin: ...
    def open_file(self, pin: HostedPin, root: Path, path: Path, mode: str,
                  **kwargs: Any) -> AbstractContextManager[Any]: ...
    def open_directory(self, pin: HostedPin, root: Path,
                       path: Path) -> AbstractContextManager[HostedDirectory]: ...
    def write_atomic(  # noqa: PLR0913
        self, pin: HostedPin, root: Path, path: Path, content: bytes,
        expected: bytes | None | object, no_expectation: object, mode: int | None,
    ) -> bool: ...
    def remove(self, pin: HostedPin, root: Path, path: Path) -> bool: ...


@dataclass(frozen=True)
class HostedFileIOOperation:
    enabled: bool
    root: Path | None
    pin: HostedPin | None
    backend: HostedBackend | None = None
    expected_device_id: str | None = None
    expected_inode: str | None = None


def _platform() -> str:
    return sys.platform


def set_hosted_win32_files(on: bool) -> None:
    """The Windows file tools switch for this process (W14, E9: off by default)."""
    global _win32_files  # noqa: PLW0603 - one process setting, set at worker start.
    _win32_files = on is True


def hosted_win32_files_enabled() -> bool:
    return _win32_files


def _win32_client() -> ModuleType | None:
    """The Windows client module; a failed import is no backend. Importing it
    loads no library. A plain import, so the reachability check follows it."""
    try:
        from sidecar.ai.tools import hosted_file_io_win32
    except ImportError:
        logging.getLogger(__name__).warning("hosted_file.windows_backend_import_failed")
        return None
    return hosted_file_io_win32


def _import_backend(name: str) -> ModuleType | None:
    """The Windows client, only when it imports and its library passes its checks."""
    if name != _WIN32_BACKEND:
        return None
    module = _win32_client()
    if module is None or module.unavailable_reason() is not None:
        return None
    return module


def select_backend(platform: str) -> HostedBackend | None:
    """The backend for `platform`, or None when there is none (fail closed)."""
    if platform in _POSIX_PLATFORMS:
        from sidecar.ai.tools import hosted_file_io_posix

        return cast("HostedBackend", hosted_file_io_posix)
    if platform == "win32" and hosted_win32_files_enabled():
        module = _import_backend(_WIN32_BACKEND)
        return cast("HostedBackend", module) if module is not None else None
    return None


def hosted_file_io_unavailable_reason(workspace_root: str) -> str | None:
    """W11 at a hosted worker's start, never raising: None when the file tools may
    be registered, else a reason word from the failure table (never a path).

    On `win32`: the switch first (with it off the library is never looked for),
    then one probe pin of the root (which loads and checks the library first),
    opened with the identity Python reads for it now and closed again. The
    probe grants nothing: every operation still runs in a request scope with
    the pair Node recorded. `configure_hosted_file_io` then asks the library
    once more without a root, when it selects the backend.
    """
    platform = _platform()
    if platform in _POSIX_PLATFORMS:
        backend = select_backend(platform)
        if backend is None:
            return PLATFORM_UNSUPPORTED
        return backend.unavailable_reason(Path(workspace_root))
    if platform != "win32":
        return PLATFORM_UNSUPPORTED
    if not hosted_win32_files_enabled():
        return SWITCH_OFF
    module = _win32_client()
    return COMPONENT_MISSING if module is None else _win32_start_reason(module, workspace_root)


def _win32_start_reason(module: ModuleType, workspace_root: str) -> str | None:
    try:
        status = os.stat(workspace_root)
    except (OSError, ValueError):
        reason = module.unavailable_reason()  # the library's reason outranks the root's
        return str(module.ROOT_INVALID if reason is None else reason)
    found = module.unavailable_reason(Path(workspace_root), str(status.st_dev), str(status.st_ino))
    return None if found is None else str(found)


def _install_hosted_store() -> None:
    """R12-F01: loading the hosted store makes the `.jenny` workspace store go
    through the pin whenever hosted IO is on; a lazy import (it imports the store)."""
    from sidecar.ai.tools import hosted_file_io_store  # noqa: F401 - installs on import


def _pin_root(
    backend: HostedBackend | None, workspace_root: str, expected_device_id: str | None,
    expected_inode: str | None,
) -> tuple[Path, HostedPin, HostedBackend]:
    """The backend is selected once, where the pin is made; the operation carries it."""
    if backend is None:
        raise path_failure()
    root = Path(workspace_root)
    return root, backend.open_root(root, expected_device_id, expected_inode), backend


@contextmanager
def scoped_hosted_file_io(
    workspace_root: str | None,
    *,
    enabled: bool,
    expected_device_id: str | None = None,
    expected_inode: str | None = None,
) -> Iterator[None]:
    """Own a pinned root for exactly one trusted tool operation.

    With no backend for this platform or switch state the scope still enters,
    hosted and with no root: every file operation fails closed with the path
    failure, nothing falls back to a plain `open`, and a tool that touches no
    file runs. A backend that refuses the root or the pair raises here."""

    if enabled:
        _install_hosted_store()
    operation = HostedFileIOOperation(enabled=enabled, root=None, pin=None)
    selected = select_backend(_platform()) if enabled and workspace_root is not None else None
    if workspace_root is not None and selected is not None:
        root, pin, backend = _pin_root(selected, workspace_root, expected_device_id, expected_inode)
        operation = HostedFileIOOperation(
            enabled=True, root=root, pin=pin, backend=backend,
            expected_device_id=expected_device_id, expected_inode=expected_inode,
        )
    token = _operation_io.set(operation)
    try:
        yield
    finally:
        _operation_io.reset(token)
        if operation.pin is not None:
            operation.pin.close()


def _active() -> HostedFileIOOperation:
    operation = _operation_io.get()
    if operation is not None:
        return operation
    return HostedFileIOOperation(enabled=_enabled, root=_root, pin=_pin, backend=_backend)


def configure_hosted_file_io(workspace_root: str | None, *, enabled: bool) -> None:
    global _enabled, _root, _pin, _backend  # noqa: PLW0603 - documented process-owned root.
    if _pin is not None:
        _pin.close()
    _pin = None
    _root = None
    _backend = None
    _enabled = enabled
    if enabled:
        _install_hosted_store()
    if not enabled or workspace_root is None:
        return
    if _platform() == "win32":
        # No identity reaches the process level and the backend refuses a root
        # without one: check the backend only and pin nothing. Operations run in
        # a request scope, which carries the pair; outside one, the path failure.
        backend = select_backend("win32")
        if backend is None:
            raise path_failure()
        _root, _backend = Path(workspace_root), backend
        return
    _root, _pin, _backend = _pin_root(select_backend(_platform()), workspace_root, None, None)


def hosted_file_io_root() -> str | None:
    operation = _active()
    return str(operation.root) if operation.enabled and operation.root is not None else None


def hosted_file_io_enabled() -> bool:
    return _active().enabled


def hosted_file_io_identity() -> tuple[str | None, str | None]:
    """The expected root identity of the active request scope, else (None, None)."""
    operation = _active()
    return operation.expected_device_id, operation.expected_inode


def _pinned() -> tuple[HostedBackend, HostedPin, Path]:
    """The backend, pin and root of the active operation, or the path failure."""
    operation = _active()
    if operation.pin is None or operation.root is None or operation.backend is None:
        raise path_failure()
    return operation.backend, operation.pin, operation.root


@contextmanager
def open_hosted_directory(path: Path) -> Iterator[HostedDirectory]:
    """Yield a directory reached by a no-follow, pin-relative traversal."""
    backend, pin, root = _pinned()
    with backend.open_directory(pin, root, path) as directory:
        yield directory


@contextmanager
def open_regular_file(path: Path, mode: str = "rb", **kwargs: Any) -> Iterator[Any]:
    if not hosted_file_io_enabled():
        with open(path, mode, **kwargs) as handle:
            yield handle
        return
    if mode not in {"r", "rb"}:
        raise path_failure()
    backend, pin, root = _pinned()
    with backend.open_file(pin, root, path, mode, **kwargs) as handle:
        yield handle


def write_hosted_bytes_atomic(
    path: Path, content: bytes, *, expected: bytes | None | object,
    no_expectation: object, mode: int | None,
) -> bool:
    try:
        backend, pin, root = _pinned()
        return backend.write_atomic(pin, root, path, content, expected, no_expectation, mode)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED, message="Hosted file IO failed before replacement.",
            retryable=True, error_details={"effects": "none"},
        ) from error


def remove_hosted_file(path: Path) -> bool:
    """Remove one non-directory leaf through the pin; False when it is absent.
    A backend without a confined remove answers the path failure (fail closed)."""
    try:
        backend, pin, root = _pinned()
        return backend.remove(pin, root, path)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED, message="Hosted file IO failed before removal.",
            retryable=True,
        ) from error
