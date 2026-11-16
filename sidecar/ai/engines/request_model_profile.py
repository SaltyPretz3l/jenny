"""Optional per-request model profile: the caller's bound for this request.

A ``chat.send`` request may carry ``model_profile``, an object with two optional
members: ``context_length`` (a positive integer from 2,048 to 1,048,576) and
``name`` (a model name: printable ASCII, at most 128 characters, no surrounding
space). The dispatcher binds it for the duration of that one request. An engine
that opts in reads it through :func:`bounded_context_length` (never above the
length it loaded) and :func:`named_model` (the name its chat contract is
detected from). A malformed member is dropped on its own, silently; the request
never fails or changes because of it.

The value lives in a ``ContextVar``, so concurrent requests through one engine
instance each see their own profile, it follows ``copy_context()`` into the
worker threads a request starts, and the engine's loaded state never changes.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
from typing import Any, Callable, Iterator, TypeVar

_Result = TypeVar("_Result")

MIN_PROFILE_CONTEXT_LENGTH = 2_048
MAX_PROFILE_CONTEXT_LENGTH = 1_048_576
MAX_PROFILE_NAME_LENGTH = 128
_PRINTABLE_NAME_RE = re.compile(r"[\x21-\x7e][\x20-\x7e]*")


@dataclass(frozen=True)
class ModelProfile:
    context_length: int | None = None
    name: str | None = None


_MODEL_PROFILE: ContextVar[ModelProfile | None] = ContextVar("request_model_profile", default=None)


def _valid_context_length(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if MIN_PROFILE_CONTEXT_LENGTH <= value <= MAX_PROFILE_CONTEXT_LENGTH:
        return value
    return None


def _valid_name(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > MAX_PROFILE_NAME_LENGTH:
        return None
    if value.strip() != value or not _PRINTABLE_NAME_RE.fullmatch(value):
        return None
    return value


def parse_model_profile(value: Any) -> ModelProfile | None:
    """The valid members of ``value``, or ``None`` when none is valid."""
    if not isinstance(value, dict):
        return None
    profile = ModelProfile(
        context_length=_valid_context_length(value.get("context_length")),
        name=_valid_name(value.get("name")),
    )
    if profile.context_length is None and profile.name is None:
        return None
    return profile


@contextmanager
def bind_model_profile(value: Any) -> Iterator[None]:
    """Bind ``value`` for the body; nothing valid binds ``None`` (hiding any outer one)."""
    reset_token = _MODEL_PROFILE.set(parse_model_profile(value))
    try:
        yield
    finally:
        _MODEL_PROFILE.reset(reset_token)


def current_model_profile() -> ModelProfile | None:
    return _MODEL_PROFILE.get()


def bounded_context_length(loaded: int | None) -> int | None:
    """``loaded`` lowered to this request's bound; the bound alone when nothing is loaded."""
    profile = _MODEL_PROFILE.get()
    bound = profile.context_length if profile is not None else None
    if bound is None:
        return loaded
    return bound if loaded is None else min(loaded, bound)


def named_model() -> str | None:
    """The model this request names, or ``None`` when the caller named none."""
    profile = _MODEL_PROFILE.get()
    return profile.name if profile is not None else None


def with_model_profile(func: Callable[..., _Result]) -> Callable[..., _Result]:
    """Bind the request's optional ``model_profile`` (``params=`` keyword) for the call."""

    @wraps(func)
    def wrapped(*args: Any, **kwargs: Any) -> _Result:
        params = kwargs.get("params")
        value = params.get("model_profile") if isinstance(params, dict) else None
        with bind_model_profile(value):
            return func(*args, **kwargs)

    return wrapped


__all__ = [
    "ModelProfile",
    "bind_model_profile",
    "bounded_context_length",
    "current_model_profile",
    "named_model",
    "parse_model_profile",
    "with_model_profile",
]
