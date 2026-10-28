"""Exact-value redaction for user API-provider keys (row 78).

The diagnostics redactors match secret *shapes* (``sk-...``, bearer values,
JWTs). A provider key need not have a known shape, so the engine factory
registers each key it is handed and every redactor also replaces that exact
value. The registry is process-global by design and bounded: a key stays
registered for the life of the process (a replaced key may still sit in a
buffered log line), at most ``MAX_EXACT_SECRETS`` are kept, oldest first out.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

MAX_EXACT_SECRETS = 32
# Shorter values would redact ordinary words; a real key is far longer.
MIN_EXACT_SECRET_CHARS = 12
REDACTED_EXACT_SECRET = "[redacted:api-key]"

_SECRETS: OrderedDict[str, None] = OrderedDict()
_LOCK = threading.Lock()


def register_exact_secret(value: object) -> bool:
    """Remember ``value`` for exact redaction; returns whether it was registered."""
    token = str(value or "").strip() if isinstance(value, str) else ""
    if len(token) < MIN_EXACT_SECRET_CHARS:
        return False
    with _LOCK:
        _SECRETS.pop(token, None)
        _SECRETS[token] = None
        while len(_SECRETS) > MAX_EXACT_SECRETS:
            _SECRETS.popitem(last=False)
    return True


def redact_exact_secrets(text: str) -> str:
    if not text:
        return text
    with _LOCK:
        secrets = tuple(_SECRETS)
    # Longest first, so a key that contains another registered key is
    # replaced whole.
    for secret in sorted(secrets, key=len, reverse=True):
        if secret in text:
            text = text.replace(secret, REDACTED_EXACT_SECRET)
    return text


def registered_exact_secret_count() -> int:
    with _LOCK:
        return len(_SECRETS)


def clear_exact_secrets_for_tests() -> None:
    with _LOCK:
        _SECRETS.clear()


__all__ = [
    "MAX_EXACT_SECRETS",
    "MIN_EXACT_SECRET_CHARS",
    "REDACTED_EXACT_SECRET",
    "clear_exact_secrets_for_tests",
    "redact_exact_secrets",
    "register_exact_secret",
    "registered_exact_secret_count",
]
