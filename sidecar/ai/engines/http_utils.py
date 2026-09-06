"""Shared HTTP response helpers for urllib-based engines."""

import json
from collections.abc import Callable
from typing import Any, Dict, Optional

from sidecar.runtime.bounded_io import BoundedIOError, read_bounded_bytes

MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024


def raise_if_cancelled(
    cancel_handle: Any,
    *,
    make_error: Callable[[], BaseException],
) -> None:
    if cancel_handle is None:
        return
    raise_method = getattr(cancel_handle, "raise_if_cancelled", None)
    if callable(raise_method):
        raise_method()
        return
    if getattr(cancel_handle, "cancelled", False):
        raise make_error()


def register_cancel_callback(
    cancel_handle: Any,
    on_cancel: Callable[[], None],
) -> Callable[[], None]:
    register = getattr(cancel_handle, "register_cancel_callback", None)
    if not callable(register):
        return lambda: None

    def invoke_on_cancel(_reason: str) -> None:
        on_cancel()

    unregister = register(invoke_on_cancel)
    return unregister if callable(unregister) else lambda: None


def decode_bytes(raw: bytes, charset: Optional[str] = None) -> str:
    """Decode HTTP payload bytes with charset fallback to UTF-8."""
    encoding = charset if isinstance(charset, str) else "utf-8"
    encoding = encoding.strip() or "utf-8"
    try:
        return raw.decode(encoding)
    except (LookupError, UnicodeDecodeError, TypeError):
        return raw.decode("utf-8", errors="replace")


def read_json_response(resp: Any) -> Dict:
    """Read and parse JSON from a urllib response with charset support."""
    headers = getattr(resp, "headers", None)

    content_length = (
        str(headers.get("content-length", "") or "").strip()
        if headers is not None
        else ""
    )
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError:
            declared_length = -1
        if declared_length > MAX_JSON_RESPONSE_BYTES:
            raise BoundedIOError("JSON response exceeds declared byte limit")
    raw = read_bounded_bytes(resp, max_bytes=MAX_JSON_RESPONSE_BYTES)

    charset = None
    if headers is not None:
        get_charset = getattr(headers, "get_content_charset", None)
        if callable(get_charset):
            try:
                charset = get_charset()
            except Exception:
                charset = None

    text = decode_bytes(raw, charset=charset)
    return json.loads(text)
