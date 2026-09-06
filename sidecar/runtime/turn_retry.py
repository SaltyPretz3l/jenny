"""Inner turn-retry helpers for semantic chat.send retry handling."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, TypeVar

T = TypeVar("T")

MAX_INNER_TURN_RETRIES = 2
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
            },
        }
    )
    cloned["messages"] = messages
    return cloned


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
            if attempt > max(int(max_inner_retries), 0):
                if exhausted_factory is not None:
                    return exhausted_factory(error, attempt)
                raise
            current_params = append_retry_system_message(
                current_params,
                error=error,
                retry_index=attempt,
            )
            attempt += 1
