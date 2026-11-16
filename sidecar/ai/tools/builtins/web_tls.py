"""The verified TLS context web fetches use: the OS store plus certifi's roots."""

from __future__ import annotations

import ssl
import threading

_TLS_CONTEXTS: dict[str, ssl.SSLContext] = {}
_TLS_CONTEXT_LOCK = threading.Lock()


def default_tls_context() -> ssl.SSLContext:
    """Built once and shared.

    On Windows the default context holds only the roots already cached in the machine store;
    Python never fetches a missing root the way Windows does on demand, so a site whose root
    is not cached failed verification (gate sitting 2026-11-14, G3). certifi is the bundle the
    engine clients already trust (httpx). Built once: a context costs ~100 ms on Windows.
    """
    with _TLS_CONTEXT_LOCK:
        context = _TLS_CONTEXTS.get("default")
        if context is None:
            context = ssl.create_default_context()
            try:
                import certifi

                context.load_verify_locations(cafile=certifi.where())
            except (ImportError, OSError, ssl.SSLError):
                pass  # the OS store alone, as before
            _TLS_CONTEXTS["default"] = context
        return context
