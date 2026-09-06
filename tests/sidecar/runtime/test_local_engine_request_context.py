from __future__ import annotations

import threading
from types import SimpleNamespace

from sidecar.runtime.local_engine.request_context import (
    build_app_profile_behavior,
    clear_request_context,
    current_app_profile_behavior,
    current_diagnostics_store,
    current_request_context,
    install_request_context,
    scoped_chat_request_context,
)


class _StubEngine:
    pass


class _BindableEngine:
    def begin_request_context(self, **kwargs) -> None:
        install_request_context(self, **kwargs)

    def clear_request_context(self, *, request_id: str | None = None) -> None:
        clear_request_context(self, request_id=request_id)


def test_install_request_context_copies_debug_options() -> None:
    engine = _StubEngine()
    debug_options = {"disable_thinking": True}

    install_request_context(
        engine,
        request_id="req_local_ctx",
        debug_options=debug_options,
    )
    debug_options["disable_thinking"] = False
    debug_options["disable_plain_chat"] = True

    context = current_request_context(engine)

    assert context is not None
    assert context["request_id"] == "req_local_ctx"
    assert context["debug_options"] == {"disable_thinking": True}


def test_install_request_context_carries_agent_id() -> None:
    engine = _StubEngine()

    install_request_context(
        engine,
        request_id="req_local_ctx_agent",
        agent_id="planner@req_local_ctx_agent",
    )

    context = current_request_context(engine)

    assert context is not None
    assert context["agent_id"] == "planner@req_local_ctx_agent"


def test_concurrent_request_contexts_and_diagnostics_are_worker_local() -> None:
    engine = _StubEngine()
    barrier = threading.Barrier(2)
    results: dict[str, tuple[str, str, float, bool]] = {}

    def _worker(request_id: str, diagnostics: str, temperature: float) -> None:
        install_request_context(
            engine,
            request_id=request_id,
            trace_id=f"trace-{request_id}",
            diagnostics_store=diagnostics,
            app_profile_behavior={"temperature": temperature},
            tracked_flags=("first_chunk_logged",),
        )
        barrier.wait(timeout=2.0)
        context = current_request_context(engine)
        assert context is not None
        context["first_chunk_logged"] = True
        results[request_id] = (
            str(context["request_id"]),
            str(current_diagnostics_store(engine)),
            float(current_app_profile_behavior(engine)["temperature"]),
            bool(context["first_chunk_logged"]),
        )
        barrier.wait(timeout=2.0)
        clear_request_context(engine, request_id=request_id)
        assert current_request_context(engine) is None

    first = threading.Thread(target=_worker, args=("req-a", "diag-a", 0.1))
    second = threading.Thread(target=_worker, args=("req-b", "diag-b", 0.9))
    first.start()
    second.start()
    first.join(timeout=3.0)
    second.join(timeout=3.0)

    assert not first.is_alive()
    assert not second.is_alive()
    assert results == {
        "req-a": ("req-a", "diag-a", 0.1, True),
        "req-b": ("req-b", "diag-b", 0.9, True),
    }
    assert current_request_context(engine) is None


def test_scoped_request_context_restores_primary_binding() -> None:
    primary = _BindableEngine()
    fallback = _BindableEngine()
    install_request_context(primary, request_id="req-primary", trace_id="trace-primary")
    request_context = SimpleNamespace(
        request_id="req-fallback",
        trace_id="trace-fallback",
        debug_options={},
        mode="assist",
        agent_id=None,
    )

    with scoped_chat_request_context(
        fallback,
        request_context=request_context,
        runtime_config=SimpleNamespace(),
        diagnostics_store="diag-fallback",
    ):
        assert current_request_context(primary) is None
        assert current_request_context(fallback)["request_id"] == "req-fallback"

    assert current_request_context(fallback) is None
    assert current_request_context(primary)["request_id"] == "req-primary"
    clear_request_context(primary, request_id="req-primary")
