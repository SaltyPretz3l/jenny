"""Generation leases for atomically published sidecar runtime stacks."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Iterator


@dataclass
class _GenerationState:
    stack: Any
    generation: int
    leases: int = 0
    retired: bool = False
    close_claimed: bool = False


class StackGenerationOwner:
    """Publish stacks transactionally and defer retirement until leases drain."""

    def __init__(self, close_stack: Callable[[Any], None]) -> None:
        self._close_stack = close_stack
        self._lock = threading.RLock()
        self._states: dict[int, _GenerationState] = {}
        self._current: _GenerationState | None = None
        self._next_generation = 1
        self._leased_stack: ContextVar[Any | None] = ContextVar(
            f"sidecar_stack_lease_{id(self)}",
            default=None,
        )

    @property
    def current_stack(self) -> Any | None:
        leased = self._leased_stack.get()
        if leased is not None:
            return leased
        with self._lock:
            return self._current.stack if self._current is not None else None

    def publish(self, stack: Any) -> int:
        to_close: Any | None = None
        with self._lock:
            previous = self._current
            state = _GenerationState(stack=stack, generation=self._next_generation)
            self._next_generation += 1
            self._states[id(stack)] = state
            self._current = state
            if previous is not None:
                previous.retired = True
                to_close = self._claim_close_if_ready(previous)
        if to_close is not None:
            self._close_stack(to_close)
        return state.generation

    @contextmanager
    def lease(self) -> Iterator[Any]:
        nested = self._leased_stack.get()
        if nested is not None:
            yield nested
            return
        with self._lock:
            state = self._current
            if state is None:
                raise RuntimeError("sidecar runtime stack is not configured")
            state.leases += 1
        token = self._leased_stack.set(state.stack)
        try:
            yield state.stack
        finally:
            self._leased_stack.reset(token)
            to_close: Any | None = None
            with self._lock:
                state.leases = max(state.leases - 1, 0)
                to_close = self._claim_close_if_ready(state)
            if to_close is not None:
                self._close_stack(to_close)

    def retire_all(self) -> None:
        to_close: list[Any] = []
        with self._lock:
            self._current = None
            for state in tuple(self._states.values()):
                state.retired = True
                claimed = self._claim_close_if_ready(state)
                if claimed is not None:
                    to_close.append(claimed)
        for stack in to_close:
            self._close_stack(stack)

    def _claim_close_if_ready(self, state: _GenerationState) -> Any | None:
        if not state.retired or state.leases or state.close_claimed:
            return None
        state.close_claimed = True
        self._states.pop(id(state.stack), None)
        return state.stack
