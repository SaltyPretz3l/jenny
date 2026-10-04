"""Inner turn-retry helpers for semantic chat.send retry handling."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

T = TypeVar("T")

MAX_INNER_TURN_RETRIES = 2
# Per-process proof that a system row was appended by this module: a caller
# can put any ``jenny_retry_*`` key in its own history, but not this value, so
# a forged row can never be stripped out of the approval drift hash.
_RETRY_ROW_NONCE_KEY = "jenny_retry_nonce"
_RETRY_ROW_NONCE = secrets.token_hex(16)
_RETRY_MESSAGE_TEMPLATE = (
    "[System: your previous output could not be accepted. "
    "Please retry and follow this guidance exactly: {retry_prompt}]"
)


# ``eq=False`` -- NOT ``frozen=True``, and not a bare ``@dataclass`` either.
# The interpreter assigns ``__traceback__`` (and ``__cause__``/``__context__``)
# onto a propagating exception; ``contextlib._GeneratorContextManager.__exit__``
# does it explicitly. A frozen dataclass rejects those assignments, so crossing
# any ``@contextmanager`` -- ``scoped_chat_request_context`` wraps the retry
# loop in ``chat_resume`` -- would replace this error with a
# ``FrozenInstanceError`` and mask the real failure. A bare ``@dataclass`` would
# generate ``__eq__`` and null out ``__hash__``; ``eq=False`` keeps
# ``BaseException``'s identity equality and hashability.
@dataclass(eq=False)
class InnerRetryableTurnError(Exception):
    """Marks a turn-local semantic failure that can be retried once or twice."""

    reason: str
    retry_prompt: str
    terminal_subcode: str | None = None
    diagnostic_components: tuple[str, ...] = ()
    # False when another attempt cannot change the outcome (for example an
    # approval plan validated against a live context that drifted for good):
    # the loop settles through ``exhausted_factory`` on this attempt.
    retryable: bool = True

    def __str__(self) -> str:
        return self.reason


def _clone_turn_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _clone_turn_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_clone_turn_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_clone_turn_value(item) for item in value)
    return value


def clone_turn_retry_params(params: dict[str, Any]) -> dict[str, Any]:
    return _clone_turn_value(params)


def append_retry_system_message(
    params: dict[str, Any],
    *,
    error: InnerRetryableTurnError,
    retry_index: int,
) -> dict[str, Any]:
    cloned = clone_turn_retry_params(params)
    messages = cloned.get("messages")
    if not isinstance(messages, list):
        messages = []
    else:
        messages = list(messages)
    messages.append(
        {
            "role": "system",
            "content": _RETRY_MESSAGE_TEMPLATE.format(retry_prompt=error.retry_prompt),
            "metadata": {
                "jenny_retry_reason": error.reason,
                "jenny_retry_index": retry_index,
                "jenny_terminal_subcode": error.terminal_subcode,
                _RETRY_ROW_NONCE_KEY: _RETRY_ROW_NONCE,
            },
        }
    )
    cloned["messages"] = messages
    return cloned


def is_retry_system_message(message: Any) -> bool:
    """True for a system row appended by ``append_retry_system_message``.

    Identified by this process's retry nonce in its metadata, never by its
    text or by a ``jenny_retry_*`` key alone (a caller could forge those).
    """

    if not isinstance(message, dict) or message.get("role") != "system":
        return False
    metadata = message.get("metadata")
    return isinstance(metadata, dict) and secrets.compare_digest(
        str(metadata.get(_RETRY_ROW_NONCE_KEY) or ""), _RETRY_ROW_NONCE
    )


def strip_retry_system_messages(messages: list[Any]) -> list[Any]:
    return [message for message in messages if not is_retry_system_message(message)]


def execute_with_inner_turn_retry(
    *,
    params: dict[str, Any],
    execute_attempt: Callable[[dict[str, Any]], T],
    max_inner_retries: int = MAX_INNER_TURN_RETRIES,
    exhausted_factory: Callable[[InnerRetryableTurnError, int], T] | None = None,
) -> T:
    current_params = clone_turn_retry_params(params)
    attempt = 1
    while True:
        try:
            return execute_attempt(current_params)
        except InnerRetryableTurnError as error:
            if not error.retryable or attempt > max(int(max_inner_retries), 0):
                if exhausted_factory is not None:
                    return exhausted_factory(error, attempt)
                raise
            current_params = append_retry_system_message(
                current_params,
                error=error,
                retry_index=attempt,
            )
            attempt += 1
