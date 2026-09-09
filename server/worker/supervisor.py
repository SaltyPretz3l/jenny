"""PID-1 supervisor for one offline command worker incarnation."""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import stat
import struct
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows unit tests
    fcntl = None

from .job import _set_no_new_privs, run_command
from .protocol import (
    CONTROLLER_KEY_BYTES,
    ERROR_RE,
    MAX_REQUEST_BYTES,
    PROTOCOL_VERSION,
    UUID_RE,
    ProtocolError,
    decode_envelope,
    encode_envelope,
    response,
    validate_request,
)
from .security import validate_runtime

READY_DELAY_SECONDS = 10.0
METADATA_LIMIT = 3 * 1024 * 1024
CONTROL_DIR = "/run/jenny-worker"
INPUTS_DIR = "/inputs"
WORKSPACE_DIR = "/workspace"
TMP_DIR = "/tmp"
APP_UID = 10001
WORKER_GID = 10003
JOB_UID = 10001
JOB_GID = 10001
PRIVATE_FILE_MODE = 0o640
NULL_REQUEST_ID = "00000000-0000-0000-0000-000000000000"


class StartupError(RuntimeError):
    """The worker cannot safely establish a fresh incarnation."""


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    if len(encoded) > METADATA_LIMIT:
        raise StartupError("worker metadata exceeds 3 MiB")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o640)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
        if os.name == "posix" and os.geteuid() == 0:
            os.chown(path, 0, WORKER_GID)
        if os.name == "posix":
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _strict_dir(path: Path, mode: int, *, gid: int | None = None) -> None:
    if gid is None:  # Unit-test directory; production mount is baked into image.
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, mode)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or (
        gid is not None
        and (info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode)
    ):
        raise StartupError("control_permissions_invalid")


def _read_private(path: Path, limit: int, *, strict: bool = True) -> bytes | None:
    try:
        fd = os.open(
            path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        )
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_size > limit
            or (
                strict
                and os.name == "posix"
                and (
                    info.st_uid != 0
                    or info.st_gid != WORKER_GID
                    or stat.S_IMODE(info.st_mode) != PRIVATE_FILE_MODE
                )
            )
        ):
            raise StartupError("private_metadata_invalid")
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if (
            len(data) != info.st_size
            or after.st_nlink != 1
            or (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            != (info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        ):
            raise StartupError("private_metadata_changed")
        return bytes(data)
    finally:
        os.close(fd)


def _load_key(path: Path, directory: Path, *, strict: bool = True) -> bytes:
    key = _read_private(path, CONTROLLER_KEY_BYTES, strict=strict)
    if key is None:
        key = secrets.token_bytes(CONTROLLER_KEY_BYTES)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        try:
            os.write(fd, key)
            os.fsync(fd)
        finally:
            os.close(fd)
        if os.name == "posix":
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    if len(key) != CONTROLLER_KEY_BYTES:
        raise StartupError("controller_key_invalid")
    return key


def _record_valid(record: Any) -> bool:
    if record is None:
        return True
    if not isinstance(record, dict) or set(record) != {
        "schema_version",
        "incarnation",
        "job_id",
        "status",
        "exit_code",
        "stdout",
        "stderr",
        "output_truncated",
        "reason",
    }:
        return False
    if type(record["schema_version"]) is not int or record["schema_version"] != PROTOCOL_VERSION:
        return False
    if record["status"] not in {
        "completed",
        "cancelled",
        "timed_out",
        "output_limit",
        "interrupted",
        "failed",
    }:
        return False
    if not all(
        isinstance(record[key], str) and UUID_RE.fullmatch(record[key])
        for key in ("incarnation", "job_id")
    ):
        return False
    return (
        (record["exit_code"] is None or type(record["exit_code"]) is int)
        and isinstance(record["stdout"], str)
        and isinstance(record["stderr"], str)
        and len(record["stdout"].encode()) + len(record["stderr"].encode()) <= 256 * 1024
        and isinstance(record["output_truncated"], bool)
        and (
            record["reason"] is None
            or (
                isinstance(record["reason"], str)
                and ERROR_RE.fullmatch(record["reason"]) is not None
            )
        )
    )


class Supervisor:
    """Own one socket, one incarnation and at most one admitted job."""

    def __init__(  # noqa: PLR0913 - explicit container mount and test seam configuration
        self,
        control_dir: str = CONTROL_DIR,
        inputs_dir: str = INPUTS_DIR,
        workspace_dir: str = WORKSPACE_DIR,
        tmp_dir: str = TMP_DIR,
        *,
        ready_delay: float = READY_DELAY_SECONDS,
        exit_func: Callable[[int], None] | None = None,
        enforce_identity: bool = True,
    ) -> None:
        self.control_dir = Path(control_dir)
        self.inputs_dir = Path(inputs_dir)
        self.workspace_dir = Path(workspace_dir)
        self.tmp_dir = Path(tmp_dir)
        self.metadata_path = self.control_dir / "worker-state.json"
        self.key_path = self.control_dir / "controller.key"
        self.socket_path = self.control_dir / "control.sock"
        self.incarnation = str(uuid.uuid4())
        self.ready_at = time.monotonic() + max(0.0, ready_delay)
        self.phase = "starting"
        self.current: dict[str, Any] | None = None
        self.previous_result: dict[str, Any] | None = None
        self._cancel = threading.Event()
        self._lock = threading.RLock()
        self._exit_func = exit_func or os._exit
        self._socket: socket.socket | None = None
        self._lock_fd: int | None = None
        self.enforce_identity = enforce_identity
        if enforce_identity and os.name == "posix":
            if os.getpid() != 1 or os.geteuid() != 0 or os.getegid() != WORKER_GID:
                raise StartupError("worker must run as root:GID10003")
        _strict_dir(self.control_dir, 0o770, gid=WORKER_GID if enforce_identity else None)
        self._acquire_lock()
        self.key = _load_key(self.key_path, self.control_dir, strict=enforce_identity)
        self._load_metadata()
        _set_no_new_privs()

    def _acquire_lock(self) -> None:
        try:
            fd = os.open(
                self.control_dir / "worker.lock",
                os.O_RDWR
                | os.O_CREAT
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_NONBLOCK", 0),
                0o640,
            )
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                os.close(fd)
                raise StartupError("worker_lock_invalid")
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._lock_fd = fd
        except OSError as exc:
            raise StartupError("worker_lock_unavailable") from exc

    def close(self) -> None:
        """Release test/host resources; PID-1 normally exits after recycling."""
        if self._socket is not None:
            self._socket.close()
            self._socket = None
        if self._lock_fd is not None:
            os.close(self._lock_fd)
            self._lock_fd = None

    def __del__(self) -> None:
        try:
            self.close()
        except OSError:
            pass

    def _prepare_snapshot(self) -> None:
        """Compatibility hook; snapshots are created by each job entrypoint."""

    def _load_metadata(self) -> None:
        data = _read_private(self.metadata_path, METADATA_LIMIT, strict=self.enforce_identity)
        if data is None:
            return
        try:
            raw = json.loads(data.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise StartupError("corrupt_worker_metadata") from exc
        if (
            not isinstance(raw, dict)
            or set(raw) != {"schema_version", "admission", "result"}
            or type(raw["schema_version"]) is not int
            or raw["schema_version"] != PROTOCOL_VERSION
        ):
            raise StartupError("unsupported or corrupt worker metadata")
        admission, result = raw["admission"], raw["result"]
        if admission is not None and (
            not isinstance(admission, dict)
            or set(admission) != {"incarnation", "job_id", "command", "cwd", "timeout_seconds"}
        ):
            raise StartupError("corrupt worker admission")
        if (admission is not None and result is not None) or not _record_valid(result):
            raise StartupError("corrupt worker result")
        if admission is not None:
            try:
                uuid.UUID(admission["incarnation"])
                uuid.UUID(admission["job_id"])
            except (ValueError, TypeError, AttributeError) as exc:
                raise StartupError("corrupt worker admission") from exc
            try:
                validate_request(
                    {
                        "schema_version": 1,
                        "request_id": str(uuid.uuid4()),
                        "operation": "submit",
                        **admission,
                    }
                )
            except ProtocolError as exc:
                raise StartupError("corrupt worker admission") from exc
            interrupted = {
                "schema_version": 1,
                "incarnation": admission["incarnation"],
                "job_id": admission["job_id"],
                "status": "interrupted",
                "exit_code": None,
                "stdout": "",
                "stderr": "",
                "output_truncated": False,
                "reason": "namespace_restarted",
            }
            self.previous_result = interrupted
            self._persist(None, interrupted)
        else:
            self.previous_result = result

    def _persist(self, admission: dict[str, Any] | None, result: dict[str, Any] | None) -> None:
        try:
            _atomic_json(
                self.metadata_path, {"schema_version": 1, "admission": admission, "result": result}
            )
        except (OSError, StartupError) as exc:
            # Disk/fsync faults are not socket faults. Never leave an admitted
            # but unstarted job looking healthy after durability becomes unknown.
            self.phase = "recycling"
            self._exit_func(1)
            raise StartupError("worker_persistence_failed") from exc

    def _refresh_phase(self) -> str:
        with self._lock:
            if self.phase == "starting" and time.monotonic() >= self.ready_at:
                self.phase = "ready"
            return self.phase

    def _status(self, request_id: str) -> dict[str, Any]:
        return response(
            request_id,
            ok=True,
            incarnation=self.incarnation,
            phase=self._refresh_phase(),
            job_id=self.current["job_id"] if self.phase == "running" and self.current else None,
            previous_result=self.previous_result,
        )

    def handle_request(  # noqa: PLR0911 - each protocol rejection is an explicit fence
        self, request: dict[str, Any], *, peer_uid: int = APP_UID
    ) -> dict[str, Any]:
        request = validate_request(request)
        request_id = request["request_id"]
        if peer_uid not in (0, APP_UID):
            return response(request_id, ok=False, error="unauthorized_peer")
        op = request["operation"]
        if op == "status":
            with self._lock:
                return self._status(request_id)
        with self._lock:
            self._refresh_phase()
            if request["incarnation"] != self.incarnation:
                return response(request_id, ok=False, error="stale_incarnation")
            if op == "submit":
                args = {
                    key: request[key]
                    for key in ("incarnation", "job_id", "command", "cwd", "timeout_seconds")
                }
                if self.current is not None:
                    if all(self.current[key] == args[key] for key in args):
                        return response(request_id, ok=True, accepted=True)
                    return response(request_id, ok=False, error="job_already_admitted")
                if self.phase != "ready":
                    return response(request_id, ok=False, error="worker_not_ready")
                self.current = args
                self.phase = "running"
                self._cancel.clear()
                self._persist(args, None)
                threading.Thread(target=self._run_current, args=(args,), daemon=True).start()
                return response(request_id, ok=True, accepted=True)
            # A cancel of a ready incarnation with no job consumes that job id,
            # fencing a delayed submit after an ambiguous transport response.
            if self.current is None:
                if self.phase != "ready":
                    return response(request_id, ok=False, error="worker_not_ready")
                result = {
                    "schema_version": 1,
                    "incarnation": self.incarnation,
                    "job_id": request["job_id"],
                    "status": "cancelled",
                    "exit_code": None,
                    "stdout": "",
                    "stderr": "",
                    "output_truncated": False,
                    "reason": "cancelled_before_admission",
                }
                self._persist(None, result)
                self.phase = "recycling"
                timer = threading.Timer(0.05, self._exit_after_commit)
                timer.daemon = True
                timer.start()
                return response(request_id, ok=True, accepted=True)
            if request["job_id"] != self.current["job_id"]:
                return response(request_id, ok=False, error="job_mismatch")
            self._cancel.set()
            return response(request_id, ok=True, accepted=True)

    def _run_current(self, args: dict[str, Any]) -> None:
        try:
            result = run_command(
                args["command"],
                args["cwd"],
                timeout_seconds=float(args["timeout_seconds"]),
                workspace_root=str(self.workspace_dir),
                cancel_event=self._cancel,
                uid=JOB_UID,
                gid=JOB_GID,
            )
            record = result.record(args["incarnation"], args["job_id"])
            with self._lock:
                self._persist(None, record)
                self.phase = "recycling"
                self._exit_after_commit()
        except BaseException:
            # A failed result commit must still tear down the namespace. The
            # durable admission becomes interrupted on the next startup.
            self._exit_func(1)

    def _exit_after_commit(self) -> None:
        self._exit_func(0)

    def serve_forever(  # noqa: C901, PLR0912 - socket framing and auth remain one bounded loop
        self,
    ) -> None:
        if os.name != "posix":
            raise StartupError("worker control socket requires Unix")
        self.control_dir.mkdir(parents=True, exist_ok=True)
        try:
            socket_info = os.lstat(self.socket_path)
            if not stat.S_ISSOCK(socket_info.st_mode):
                raise StartupError("stale worker control path is not a socket")
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._socket = sock
        sock.bind(str(self.socket_path))
        os.chmod(self.socket_path, 0o660)
        if os.name == "posix" and os.geteuid() == 0:
            os.chown(self.socket_path, 0, WORKER_GID)
        sock.listen(4)
        while True:
            conn, _ = sock.accept()
            with conn:
                conn.settimeout(5.0)
                if not self._authorized_peer(conn):
                    continue
                data = bytearray()
                try:
                    while len(data) <= MAX_REQUEST_BYTES:
                        chunk = conn.recv(min(65536, MAX_REQUEST_BYTES + 1 - len(data)))
                        if not chunk:
                            break
                        data.extend(chunk)
                        if b"\n" in chunk:
                            break
                    request = decode_envelope(bytes(data), self.key)
                    result = self.handle_request(request, peer_uid=APP_UID)
                except ProtocolError as exc:
                    reason = str(exc)
                    if not ERROR_RE.fullmatch(reason):
                        reason = "protocol_error"
                    result = response(NULL_REQUEST_ID, ok=False, error=reason)
                except (OSError, ValueError):
                    result = response(NULL_REQUEST_ID, ok=False, error="transport_error")
                try:
                    conn.sendall(encode_envelope(result, self.key, response=True))
                except OSError:
                    pass  # Lost acknowledgement is reconciled by admission identity.

    @staticmethod
    def _authorized_peer(conn: socket.socket) -> bool:
        if not hasattr(socket, "SO_PEERCRED"):
            return False
        try:
            creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _, uid, _ = struct.unpack("3i", creds)
            return uid in (0, APP_UID)
        except OSError:
            return False


def main() -> None:
    try:
        validate_runtime()
        # Docker stops the application first. An explicit worker stop still
        # tears down the namespace immediately; any admission is reconciled as
        # interrupted at the next startup, never reported as successful.
        signal.signal(signal.SIGTERM, lambda _signum, _frame: os._exit(0))
        Supervisor().serve_forever()
    except (OSError, StartupError, RuntimeError, ValueError) as error:
        reason = str(error) if ERROR_RE.fullmatch(str(error)) else "worker_startup_invalid"
        print(json.dumps({"event": "worker.start_failed", "reason": reason}), flush=True)
        raise SystemExit(78) from None


if __name__ == "__main__":
    main()
