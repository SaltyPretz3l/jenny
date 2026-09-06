"""Process-global reference counting for shared Ollama daemon residency.

Ollama daemon residency is shared and reference-counted by
``(endpoint, model, num_ctx)``. INSTANCE CLOSE is not PROVIDER EVICTION:
the daemon owns the weights and the runner is shared by every engine
instance pointed at it, so a disposing engine must never POST
``keep_alive: 0`` unless it holds the LAST reference -- otherwise it throws
away a successor engine's warm weights and the next turn pays a cold load.

``num_ctx`` is part of the key because Ollama runs distinct runners for
different context lengths.

The process-global state is:

* explicit -- claims and releases are always paired by the engine that owns them;
* bounded -- entries are popped at zero, and the map refuses to grow past
  ``_MAX_TRACKED_RESIDENCIES`` distinct triples (further claims degrade to
  "untracked", which evicts eagerly, i.e. today's behavior);
* observable -- every retain/degradation emits a structured log event.
"""

from __future__ import annotations

import logging
import threading

from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

# A single daemon realistically hosts a handful of (model, n_ctx) runners. The
# cap only exists so a pathological caller cannot grow the map without bound;
# overflow degrades to the pre-refcount behavior (evict on every close) rather
# than to silent retention.
_MAX_TRACKED_RESIDENCIES = 64

ResidencyKey = tuple[str, str, int]


def residency_key(host: object, model: object, num_ctx: object) -> ResidencyKey | None:
    """Normalize a residency triple, or ``None`` when it cannot be keyed.

    A blank model tag is unkeyable: there is no runner to refcount, so the
    caller must fall back to unconditional eviction.
    """
    normalized_model = str(model or "").strip()
    if not normalized_model:
        return None
    normalized_host = str(host or "").strip()
    # str() first: num_ctx is typed `object` because callers pass whatever
    # get_configured_context_length() returned, which a test double may set to
    # any value. int(object) is not a valid overload, and a float would silently
    # truncate to a different runner key.
    try:
        normalized_ctx = int(str(num_ctx).strip()) if num_ctx is not None else 0
    except (TypeError, ValueError):
        normalized_ctx = 0
    return (normalized_host, normalized_model, max(normalized_ctx, 0))


class OllamaResidencyRegistry:
    """Reference counts for shared Ollama daemon residency triples."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: dict[ResidencyKey, int] = {}

    def claim(self, key: ResidencyKey) -> int:
        """Record one holder of ``key``; returns the resulting count.

        Returns ``0`` when the registry refused to track the key (cap reached).
        An untracked key releases as "last holder", preserving the eager-evict
        behavior that predates refcounting.
        """
        with self._lock:
            existing = self._counts.get(key)
            if existing is None and len(self._counts) >= _MAX_TRACKED_RESIDENCIES:
                tracked = len(self._counts)
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.engines.ollama_residency",
                    event="ai.engines.ollama.residency_untracked",
                    message="Ollama residency registry is full; claim not tracked.",
                    status="degraded",
                    data={
                        "model": key[1],
                        "num_ctx": key[2],
                        "tracked_residencies": tracked,
                        "max_tracked_residencies": _MAX_TRACKED_RESIDENCIES,
                    },
                )
                return 0
            count = (existing or 0) + 1
            self._counts[key] = count
            return count

    def release(self, key: ResidencyKey) -> bool:
        """Drop one holder of ``key``; True when the caller was the LAST one.

        An unknown key returns True: nothing is holding the runner as far as
        this process knows, so the caller should evict.
        """
        with self._lock:
            count = self._counts.get(key)
            if count is None:
                return True
            if count <= 1:
                # Pop at zero so the map stays bounded across model churn.
                self._counts.pop(key, None)
                return True
            self._counts[key] = count - 1
            return False

    def forget(self, key: ResidencyKey) -> None:
        """Drop every tracked claim on ``key`` after an intentional eviction.

        An explicit operator/shutdown unload really does evict the runner, so
        leaving a non-zero count would let a later release skip an eviction the
        daemon still needs. Other holders degrade to eager eviction, which is
        idempotent against an already-unloaded model.
        """
        with self._lock:
            self._counts.pop(key, None)

    def count(self, key: ResidencyKey) -> int:
        with self._lock:
            return self._counts.get(key, 0)

    def snapshot(self) -> dict[ResidencyKey, int]:
        with self._lock:
            return dict(self._counts)

    def reset(self) -> None:
        """Clear all counts. Test-support only; never called in production."""
        with self._lock:
            self._counts.clear()


_REGISTRY = OllamaResidencyRegistry()


def residency_registry() -> OllamaResidencyRegistry:
    """Return the process-global registry singleton."""
    return _REGISTRY


def claim_residency(host: object, model: object, num_ctx: object) -> ResidencyKey | None:
    """Claim shared residency for a triple; returns the key to release later."""
    key = residency_key(host, model, num_ctx)
    if key is None:
        return None
    _REGISTRY.claim(key)
    return key


def release_residency(key: ResidencyKey | None) -> bool:
    """Release a claim; True when the caller must issue ``keep_alive: 0``."""
    if key is None:
        return True
    last_holder = _REGISTRY.release(key)
    if not last_holder:
        log_event(
            logger,
            logging.INFO,
            component="ai.engines.ollama_residency",
            event="ai.engines.ollama.residency_retained",
            message="Skipped Ollama eviction: another generation still holds the model.",
            status="skipped",
            data={
                "model": key[1],
                "num_ctx": key[2],
                "remaining_claims": _REGISTRY.count(key),
            },
        )
    return last_holder


def forget_residency(key: ResidencyKey | None) -> None:
    """Forget every claim on a triple after an intentional eviction."""
    if key is not None:
        _REGISTRY.forget(key)


__all__ = [
    "OllamaResidencyRegistry",
    "ResidencyKey",
    "claim_residency",
    "forget_residency",
    "release_residency",
    "residency_key",
    "residency_registry",
]
