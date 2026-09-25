"""Request-local admission and settlement around one provider attempt.

The callback and lease are intentionally duck typed so the AI layer does not
depend on the application runtime.  Admission belongs above provider engine
methods because those methods may call one another internally.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Literal, TypeVar, cast

T = TypeVar("T")
logger = logging.getLogger(__name__)


def bind_fallback_inference(admission: Any, provider: str) -> Any:
    """Rebind configured fallback while retaining its application admission owner."""
    bind_provider = getattr(admission, "bind_provider", None)
    return bind_provider(provider) if callable(bind_provider) else admission

AttemptStatus = Literal["succeeded", "failed", "cancelled"]
CleanupStatus = Literal["confirmed", "uncertain"]


@dataclass(frozen=True, slots=True)
class InferenceAttemptContext:
    """Trusted routing/configuration facts for a single provider attempt."""

    request_id: str
    session_id: str
    provider: str
    model: str
    request_source: str
    attempt: int
    streaming: bool
    input_token_ceiling: int | None = None
    output_token_ceiling: int | None = None


@dataclass(frozen=True, slots=True)
class InferenceAttemptOutcome:
    """Conservative settlement when provider usage is not authoritatively known."""

    status: AttemptStatus
    cleanup: CleanupStatus
    consumption: Literal["unknown"] = "unknown"
    charge_consumption: bool = True


class InferenceAdmissionError(RuntimeError):
    """Base class for typed refusal at the safe pre-provider boundary."""

    def __init__(self, reason: str) -> None:
        self.reason = str(reason or "inference_admission_unavailable")[:200]
        super().__init__(self.reason)


class InferenceAdmissionDeferred(InferenceAdmissionError):
    """The attempt must be checkpointed/deferred without retaining a worker."""


class InferenceAdmissionRefused(InferenceAdmissionError):
    """The attempt was rejected and must not invoke the provider."""


class _Settlement:
    def __init__(self, lease: Any, *, budget_required: bool = False) -> None:
        self.budget_required = budget_required
        settle = getattr(lease, "settle", None)
        if not callable(settle):
            settle = getattr(lease, "release", None)
        if not callable(settle):
            raise InferenceAdmissionRefused("inference_lease_invalid")
        self._settle: Callable[[InferenceAttemptOutcome], Any] = settle
        self._done = False
        self._cleanup_uncertain = False

    def mark_cleanup_uncertain(self) -> None:
        self._cleanup_uncertain = True

    def finish(self, status: AttemptStatus, cleanup: CleanupStatus) -> None:
        if self._done:
            return
        self._done = True
        if self._cleanup_uncertain:
            cleanup = "uncertain"
        self._settle(InferenceAttemptOutcome(status=status, cleanup=cleanup))


def _finish_preserving(
    settlement: _Settlement,
    status: AttemptStatus,
    cleanup: CleanupStatus,
    pending: BaseException | None,
) -> None:
    try:
        settlement.finish(status, cleanup)
    except BaseException as settle_error:
        if pending is None:
            raise
        pending.add_note(
            f"inference settlement failed: {type(settle_error).__name__}: {settle_error}"
        )
        logger.warning(
            "inference settlement failed while preserving %s",
            type(pending).__name__,
            exc_info=True,
        )


_ACTIVE_SETTLEMENT: ContextVar[_Settlement | None] = ContextVar(
    "active_inference_attempt_settlement",
    default=None,
)


def refuse_unadmitted_provider_retry() -> None:
    """Budgeted retries need a fresh outer admission, even after HTTP rejection."""
    settlement = _ACTIVE_SETTLEMENT.get()
    if settlement is not None and settlement.budget_required:
        raise InferenceAdmissionRefused("inference_budget_requires_fresh_retry")


def mark_provider_cleanup_uncertain() -> None:
    """Downgrade the current attempt when its provider producer remains live."""

    settlement = _ACTIVE_SETTLEMENT.get()
    if settlement is not None:
        settlement.mark_cleanup_uncertain()


def _field(value: Any, name: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(name)
    return getattr(value, name, None)


def _reason(value: Any, fallback: str) -> str:
    reason = _field(value, "reason")
    return str(reason or fallback)[:200]


def _acquire(
    callback: Callable[[InferenceAttemptContext], Any],
    context: InferenceAttemptContext,
) -> _Settlement:
    try:
        admission = callback(context)
    except (InferenceAdmissionDeferred, InferenceAdmissionRefused):
        raise
    except Exception as error:
        raise InferenceAdmissionRefused("inference_admission_failed") from error

    if callable(getattr(admission, "settle", None)) or callable(
        getattr(admission, "release", None)
    ):
        return _Settlement(
            admission, budget_required=getattr(callback, "requires_budget", False) is True)
    status = str(_field(admission, "status") or "").strip().lower()
    if status in {"waiting", "deferred"}:
        raise InferenceAdmissionDeferred(_reason(admission, "inference_capacity_waiting"))
    if status in {"rejected", "refused"}:
        raise InferenceAdmissionRefused(_reason(admission, "inference_capacity_rejected"))
    if status and status != "granted":
        raise InferenceAdmissionRefused("inference_admission_malformed")
    lease = _field(admission, "lease") if status == "granted" else admission
    return _Settlement(lease, budget_required=getattr(callback, "requires_budget", False) is True)


def _close_iterator(source: Iterator[Any]) -> bool:
    close = getattr(source, "close", None)
    if not callable(close):
        return False
    try:
        close()
    except BaseException:
        return False
    return True


async def _close_async_iterator(source: AsyncIterator[Any]) -> bool:
    close = getattr(source, "aclose", None)
    if not callable(close):
        return False
    try:
        await close()
    except BaseException:
        return False
    return True


def _guard_iterator(source: Iterator[Any], settlement: _Settlement) -> Iterator[Any]:
    completed = False
    pending: BaseException | None = None
    status: AttemptStatus = "cancelled"
    try:
        while True:
            token = _ACTIVE_SETTLEMENT.set(settlement)
            try:
                item = next(source)
            except StopIteration:
                completed = True
                status = "succeeded"
                break
            finally:
                _ACTIVE_SETTLEMENT.reset(token)
            yield item
    except GeneratorExit as error:
        pending = error
        status = "cancelled"
        raise
    except BaseException as error:
        pending = error
        status = "failed"
        raise
    finally:
        token = _ACTIVE_SETTLEMENT.set(settlement)
        try:
            cleanup: CleanupStatus = "confirmed" if completed else (
                "confirmed" if _close_iterator(source) else "uncertain"
            )
            _finish_preserving(settlement, status, cleanup, pending)
        finally:
            _ACTIVE_SETTLEMENT.reset(token)


async def _guard_async_iterator(
    source: AsyncIterator[Any], settlement: _Settlement
) -> AsyncIterator[Any]:
    completed = False
    pending: BaseException | None = None
    status: AttemptStatus = "cancelled"
    try:
        while True:
            token = _ACTIVE_SETTLEMENT.set(settlement)
            try:
                item = await anext(source)
            except StopAsyncIteration:
                completed = True
                status = "succeeded"
                break
            finally:
                _ACTIVE_SETTLEMENT.reset(token)
            yield item
    except (asyncio.CancelledError, GeneratorExit) as error:
        pending = error
        status = "cancelled"
        raise
    except BaseException as error:
        pending = error
        status = "failed"
        raise
    finally:
        token = _ACTIVE_SETTLEMENT.set(settlement)
        try:
            cleanup: CleanupStatus = "confirmed" if completed else (
                "confirmed" if await _close_async_iterator(source) else "uncertain"
            )
            _finish_preserving(settlement, status, cleanup, pending)
        finally:
            _ACTIVE_SETTLEMENT.reset(token)


async def _guard_awaitable(source: Awaitable[Any], settlement: _Settlement) -> Any:
    token = _ACTIVE_SETTLEMENT.set(settlement)
    try:
        result = await source
    except asyncio.CancelledError as error:
        _finish_preserving(settlement, "cancelled", "uncertain", error)
        raise
    except BaseException as error:
        _finish_preserving(settlement, "failed", "confirmed", error)
        raise
    finally:
        _ACTIVE_SETTLEMENT.reset(token)
    return _protect_result(result, settlement)


def _protect_result(result: T, settlement: _Settlement) -> T:
    if isinstance(result, AsyncIterator):
        return cast(T, _guard_async_iterator(result, settlement))
    if isinstance(result, Iterator):
        return cast(T, _guard_iterator(result, settlement))
    if inspect.isawaitable(result):
        return cast(T, _guard_awaitable(cast(Awaitable[Any], result), settlement))
    settlement.finish("succeeded", "confirmed")
    return result


def execute_admitted_provider_attempt(
    *,
    admission: Callable[[InferenceAttemptContext], Any] | None,
    context: InferenceAttemptContext,
    operation: Callable[[], T],
) -> T:
    """Execute one actual attempt, preserving legacy behavior without a callback."""

    if admission is None:
        return operation()
    settlement = _acquire(admission, context)
    token = _ACTIVE_SETTLEMENT.set(settlement)
    try:
        result = operation()
    except asyncio.CancelledError as error:
        _finish_preserving(settlement, "cancelled", "uncertain", error)
        raise
    except BaseException as error:
        _finish_preserving(settlement, "failed", "confirmed", error)
        raise
    finally:
        _ACTIVE_SETTLEMENT.reset(token)
    return _protect_result(result, settlement)


__all__ = [
    "InferenceAdmissionDeferred",
    "InferenceAdmissionError",
    "InferenceAdmissionRefused",
    "InferenceAttemptContext",
    "InferenceAttemptOutcome",
    "execute_admitted_provider_attempt",
    "mark_provider_cleanup_uncertain",
]
