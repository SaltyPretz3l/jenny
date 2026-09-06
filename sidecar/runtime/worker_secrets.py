"""Out-of-band secret handoff for detached background workers.

SECURITY CONTRACT
    A background worker is launched with a JSON payload file named on argv. That
    file is plaintext on disk and survives a crash, so no credential may ever
    reach it. This module owns both halves of the split that keeps them out:

      * ``split_config_secrets`` lifts every credential-bearing key out of a raw
        config dict -- returning NEW dicts, never mutating the input -- and
        ``merge_config_secrets`` puts them back for the single in-memory
        ``parse_runtime_config`` call that needs them.
      * ``encode_secrets_frame`` / ``read_secrets_frame`` move the lifted values
        over the child's stdin pipe instead, framed with a ``!I`` length header
        exactly like ``sidecar/_owned_process_bootstrap.py``. A pipe is not on
        disk, is not on argv, and dies with the process.

    ``guard_no_secret_keys`` is the fail-closed tripwire on the payload writer:
    a config key that lands in ``SECRET_CONFIG_KEYS`` and was not lifted raises
    before ``json.dumps`` instead of leaking.

    ``SECRET_CONFIG_KEYS`` is the scrub denylist and must stay a SUPERSET of the
    archived cloud secret keys that ``sidecar/runtime/capabilities.py`` used to
    strip on its own. ``BROKERED_SECRET_KEYS`` is the strictly smaller set the
    parent will forward onward to a worker; ``telemetry_dsn`` is deliberately
    absent from it because ``_apply_telemetry_config`` reads that value straight
    off ``params["secrets"]`` and it must never enter a config dict at all.
"""

from __future__ import annotations

import json
import logging
import struct
import threading
from typing import Any

from sidecar.runtime.bounded_io import BoundedBinaryReader, BoundedIOError

logger = logging.getLogger(__name__)

SECRET_CONFIG_KEYS: frozenset[str] = frozenset(
    {
        # Archived cloud providers (previously _ARCHIVED_CLOUD_SECRET_KEYS).
        "anthropic_api_key",
        "gemini_api_key",
        "openai_api_key",
        # Live credential-bearing config keys.
        "chatgpt_access_token",
        "openai_compatible_api_key",
        "telemetry_dsn",
        "tools_web_search_provider_keys",
    }
)

BROKERED_SECRET_KEYS: frozenset[str] = frozenset(
    {
        "chatgpt_access_token",
        "openai_compatible_api_key",
        "tools_web_search_provider_keys",
    }
)

MCP_AUTH_SECRET_FIELDS = ("token", "client_secret")
MCP_AUTH_SECRETS_KEY = "mcp_servers_auth"
MAX_SECRETS_FRAME_BYTES = 8 * 1024
SECRETS_FRAME_VERSION = 1
SECRET_HANDOFF_TIMEOUT_SECONDS = 2.0

_FRAME_HEADER = struct.Struct("!I")
_MAX_SECRET_KEY_DEPTH = 12
_STREAM_ERRORS = (BrokenPipeError, OSError, ValueError)


class SecretFrameError(ValueError):
    """Raised before a secret would cross a plaintext boundary or a byte cap."""


# ── config split / merge ────────────────────────────────────────────


def split_config_secrets(raw_config: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ``(scrubbed_config, secrets)`` as NEW dicts; input is untouched."""

    if not isinstance(raw_config, dict):
        return {}, {}
    scrubbed: dict[str, Any] = {}
    secrets: dict[str, Any] = {}
    for key, value in raw_config.items():
        if isinstance(key, str) and key in SECRET_CONFIG_KEYS:
            secrets[key] = value
            continue
        scrubbed[key] = value
    rows = _split_mcp_auth_secrets(scrubbed)
    if rows:
        secrets[MCP_AUTH_SECRETS_KEY] = rows
    return scrubbed, secrets


def merge_config_secrets(config: Any, secrets: Any) -> dict[str, Any]:
    """Return a NEW config with ``secrets`` folded back in.

    ``merge_config_secrets(*split_config_secrets(config)) == config``. An empty
    or ``None`` ``secrets`` clears: the returned config carries no secret key,
    because a scrubbed config never had one.
    """

    merged = dict(config) if isinstance(config, dict) else {}
    if not isinstance(secrets, dict) or not secrets:
        return merged
    for key, value in secrets.items():
        if isinstance(key, str) and key in SECRET_CONFIG_KEYS:
            merged[key] = value
    rows = secrets.get(MCP_AUTH_SECRETS_KEY)
    if isinstance(rows, list) and rows:
        merged["mcp_servers"] = _merged_mcp_servers(merged.get("mcp_servers"), rows)
    return merged


def _split_mcp_auth_secrets(scrubbed: dict[str, Any]) -> list[dict[str, Any]]:
    raw_servers = scrubbed.get("mcp_servers")
    if not isinstance(raw_servers, list) or not raw_servers:
        return []
    servers = list(raw_servers)
    rows: list[dict[str, Any]] = []
    for index, server in enumerate(servers):
        if not isinstance(server, dict):
            continue
        auth = server.get("auth")
        if not isinstance(auth, dict):
            continue
        lifted = [(name, auth[name]) for name in MCP_AUTH_SECRET_FIELDS if name in auth]
        if not lifted:
            continue
        scrubbed_server = dict(server)
        scrubbed_server["auth"] = {
            key: value for key, value in auth.items() if key not in MCP_AUTH_SECRET_FIELDS
        }
        servers[index] = scrubbed_server
        server_name = str(server.get("name") or "")
        for field_name, value in lifted:
            rows.append(
                {
                    "server": server_name,
                    "index": index,
                    "field": field_name,
                    "value": value,
                }
            )
    if rows:
        scrubbed["mcp_servers"] = servers
    return rows


def _merged_mcp_servers(raw_servers: Any, rows: list[Any]) -> Any:
    if not isinstance(raw_servers, list):
        return raw_servers
    servers = list(raw_servers)
    for row in rows:
        if not isinstance(row, dict):
            continue
        field_name = str(row.get("field") or "")
        if field_name not in MCP_AUTH_SECRET_FIELDS:
            continue
        index = _resolve_server_index(servers, row)
        if index is None:
            continue
        server = servers[index]
        if not isinstance(server, dict):
            continue
        auth = server.get("auth")
        merged_auth = dict(auth) if isinstance(auth, dict) else {}
        merged_auth[field_name] = row.get("value")
        merged_server = dict(server)
        merged_server["auth"] = merged_auth
        servers[index] = merged_server
    return servers


def _resolve_server_index(servers: list[Any], row: dict[str, Any]) -> int | None:
    raw_index = row.get("index")
    if isinstance(raw_index, int) and not isinstance(raw_index, bool):
        if 0 <= raw_index < len(servers):
            return raw_index
    server_name = str(row.get("server") or "").strip()
    if not server_name:
        return None
    for index, server in enumerate(servers):
        if isinstance(server, dict) and str(server.get("name") or "").strip() == server_name:
            return index
    return None


# ── payload tripwire ────────────────────────────────────────────────


def secret_key_paths(payload: Any, *, max_depth: int = _MAX_SECRET_KEY_DEPTH) -> list[str]:
    """Return dotted paths of secret-bearing KEY NAMES; values are never read."""

    found: list[str] = []
    _walk_secret_keys(
        payload,
        prefix="",
        depth=0,
        max_depth=max(1, int(max_depth)),
        in_auth=False,
        found=found,
    )
    return found


def guard_no_secret_keys(payload: Any, *, context: str) -> None:
    """Raise :class:`SecretFrameError` naming the path of any secret key."""

    paths = secret_key_paths(payload)
    if paths:
        raise SecretFrameError(f"{context} carries secret key(s): {', '.join(sorted(paths))}")


def _walk_secret_keys(  # noqa: PLR0913 - a pure recursive walker, all state is explicit.
    node: Any,
    *,
    prefix: str,
    depth: int,
    max_depth: int,
    in_auth: bool,
    found: list[str],
) -> None:
    if depth > max_depth:
        if isinstance(node, (dict, list, tuple)):
            location = prefix or "<root>"
            raise SecretFrameError(
                f"secret-key inspection exceeded maximum depth at {location}"
            )
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if not isinstance(key, str):
                continue
            path = f"{prefix}.{key}" if prefix else key
            if key in SECRET_CONFIG_KEYS or (in_auth and key in MCP_AUTH_SECRET_FIELDS):
                found.append(path)
                continue
            _walk_secret_keys(
                value,
                prefix=path,
                depth=depth + 1,
                max_depth=max_depth,
                in_auth=key == "auth",
                found=found,
            )
        return
    if isinstance(node, (list, tuple)):
        for index, item in enumerate(node):
            _walk_secret_keys(
                item,
                prefix=f"{prefix}[{index}]",
                depth=depth + 1,
                max_depth=max_depth,
                in_auth=in_auth,
                found=found,
            )


# ── frame codec ─────────────────────────────────────────────────────


def encode_secrets_frame(secrets: Any) -> bytes:
    """Frame ``secrets`` for stdin delivery; ``b""`` when there is nothing to send."""

    config_secrets: dict[str, Any] = {}
    if isinstance(secrets, dict):
        for key, value in secrets.items():
            if isinstance(key, str) and key in SECRET_CONFIG_KEYS:
                config_secrets[key] = value
    raw_rows = secrets.get(MCP_AUTH_SECRETS_KEY) if isinstance(secrets, dict) else None
    mcp_auth = _normalized_mcp_auth_rows(raw_rows)
    if not config_secrets and not mcp_auth:
        return b""
    try:
        body = json.dumps(
            {
                "version": SECRETS_FRAME_VERSION,
                "config_secrets": config_secrets,
                "mcp_auth": mcp_auth,
            },
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        # Never echo the offending value into the message.
        raise SecretFrameError("worker secret frame is not JSON-encodable") from error
    if len(body) > MAX_SECRETS_FRAME_BYTES:
        raise SecretFrameError("worker secret frame exceeds its byte limit")
    return _FRAME_HEADER.pack(len(body)) + body


def read_secrets_frame(stream: Any) -> dict[str, Any]:
    """Read one bounded secret frame; ``{}`` on absence, truncation or oversize."""

    body = _read_frame_bytes(stream)
    if not body:
        return {}
    try:
        decoded = json.loads(body.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return {}
    return _decode_frame_body(decoded)


def _read_frame_bytes(stream: Any) -> bytes:
    if stream is None or _is_interactive_stream(stream):
        return b""
    try:
        reader = BoundedBinaryReader(stream)
        header = reader.read_exact(_FRAME_HEADER.size)
        if len(header) != _FRAME_HEADER.size:
            if header:
                _warn_truncated_frame(expected=_FRAME_HEADER.size, received=len(header))
            return b""
        body_size = int(_FRAME_HEADER.unpack(header)[0])
        if body_size <= 0 or body_size > MAX_SECRETS_FRAME_BYTES:
            # Reject on the header alone -- an oversize body is never read.
            return b""
        body = reader.read_exact(body_size)
    except (BoundedIOError, OSError, ValueError, struct.error):
        return b""
    if len(body) != body_size:
        _warn_truncated_frame(expected=body_size, received=len(body))
        return b""
    return body


def _is_interactive_stream(stream: Any) -> bool:
    """A tty is never a secret channel -- never block a hand-run worker on it."""

    isatty = getattr(stream, "isatty", None)
    if not callable(isatty):
        return False
    try:
        return bool(isatty())
    except (OSError, ValueError):
        return False


def _warn_truncated_frame(*, expected: int, received: int) -> None:
    logger.warning(
        "background worker secret frame was truncated",
        extra={
            "event": "sidecar.runtime.background_worker.secret_frame_truncated",
            "expected_bytes": int(expected),
            "received_bytes": int(received),
        },
    )


def _decode_frame_body(decoded: Any) -> dict[str, Any]:
    if not isinstance(decoded, dict) or decoded.get("version") != SECRETS_FRAME_VERSION:
        return {}
    secrets: dict[str, Any] = {}
    raw_config_secrets = decoded.get("config_secrets")
    if isinstance(raw_config_secrets, dict):
        for key, value in raw_config_secrets.items():
            if isinstance(key, str) and key in SECRET_CONFIG_KEYS:
                secrets[key] = value
    rows = _normalized_mcp_auth_rows(decoded.get("mcp_auth"))
    if rows:
        secrets[MCP_AUTH_SECRETS_KEY] = rows
    return secrets


def _normalized_mcp_auth_rows(raw_rows: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_rows, list):
        return []
    rows: list[dict[str, Any]] = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, dict):
            continue
        field_name = str(raw_row.get("field") or "")
        if field_name not in MCP_AUTH_SECRET_FIELDS:
            continue
        raw_index = raw_row.get("index")
        rows.append(
            {
                "server": str(raw_row.get("server") or ""),
                "index": raw_index if isinstance(raw_index, int) else -1,
                "field": field_name,
                "value": raw_row.get("value"),
            }
        )
    return rows


# ── stdin handoff ───────────────────────────────────────────────────


def close_worker_stdin(stdin: Any) -> None:
    """Release a worker control pipe; the child blocks on EOF until it closes."""

    if stdin is None:
        return
    try:
        stdin.close()
    except _STREAM_ERRORS:
        logger.debug("background worker control pipe close failed", exc_info=True)


def deliver_secrets_frame(stdin: Any, frame: bytes, *, task_key: str) -> bool:
    """Hand one frame to an already-contained child. Never raises, never blocks.

    The write runs on a short-lived daemon thread joined with a bounded timeout:
    the frame can approach 4 KiB (a ~2.5 KiB Codex JWT plus a provider-key map),
    Python cannot size the Windows anonymous-pipe buffer, and this call happens
    on the spawning thread while the manager lock is NOT held. An inline write
    could therefore block the sidecar's request loop on a wedged child.
    """

    if not frame:
        close_worker_stdin(stdin)
        return True
    if stdin is None:
        return False
    delivered: list[bool] = []

    def _write_frame() -> None:
        try:
            view = memoryview(frame)
            while view:
                written = stdin.write(view)
                if not written:
                    raise OSError("worker secret frame write made no progress")
                view = view[int(written):]
            flush = getattr(stdin, "flush", None)
            if callable(flush):
                flush()
            delivered.append(True)
        except _STREAM_ERRORS:
            delivered.append(False)
        finally:
            close_worker_stdin(stdin)

    thread = threading.Thread(
        target=_write_frame,
        daemon=True,
        name=f"background-secret-handoff:{task_key}",
    )
    try:
        thread.start()
        thread.join(SECRET_HANDOFF_TIMEOUT_SECONDS)
    except RuntimeError:
        delivered.clear()
    if delivered and delivered[0]:
        return True
    # No values, no frame bytes, no exception payload -- shape only.
    logger.warning(
        "background worker secret handoff did not complete task_key=%s",
        task_key,
    )
    return False


__all__ = [
    "BROKERED_SECRET_KEYS",
    "MAX_SECRETS_FRAME_BYTES",
    "MCP_AUTH_SECRETS_KEY",
    "MCP_AUTH_SECRET_FIELDS",
    "SECRET_CONFIG_KEYS",
    "SecretFrameError",
    "close_worker_stdin",
    "deliver_secrets_frame",
    "encode_secrets_frame",
    "guard_no_secret_keys",
    "merge_config_secrets",
    "read_secrets_frame",
    "secret_key_paths",
    "split_config_secrets",
]
