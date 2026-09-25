"""Focused contracts for off-transcript inference admission."""

from __future__ import annotations

import json
import logging
import queue
import threading
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar import server
from sidecar.ai.engines.admitted import (
    InferenceAdmissionRefused,
    InferenceAttemptContext,
    InferenceAttemptOutcome,
)
from sidecar.protocol import API_VERSION, INLINE_COMPLETE_METHOD, RUNTIME_OPERATION_METHOD
from sidecar.runtime import (
    inline_completion,
    request_dispatch_commit,
    request_dispatch_inline,
    request_dispatch_suggestions,
    server_auxiliary_workers,
)
from sidecar.runtime.commit_message import generate_commit_message
from sidecar.runtime.inference_admission import (
    build_auxiliary_inference_admission_callback,
    inference_context_from_params,
)
from sidecar.runtime.multiplexer import StdioTransportMultiplexer
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.suggestions import generate_suggestions

LOG = logging.getLogger("test")


def _context(*, engine_type: str = "ollama") -> dict[str, Any]:
    return {
        "schema_version": 1,
        "request_id": "request_aux_1",
        "session_id": None,
        "authority_revision": "authority_aux_1",
        "engine_type": engine_type,
    }


def _attempt(*, provider: str = "ollama") -> InferenceAttemptContext:
    return InferenceAttemptContext(
        request_id="request_aux_1",
        session_id="",
        provider=provider,
        model="trusted-model",
        request_source="background_classifier",
        attempt=1,
        streaming=False,
    )


def _bridge(statuses: list[str]) -> tuple[list[dict[str, Any]], Any]:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any):  # noqa: ANN202
        status = statuses.pop(0)

        def reader(_timeout: float) -> dict[str, Any]:
            return {
                "id": rpc_id,
                "result": {
                    "schema_version": 1,
                    "operation_id": sent[-1]["params"]["operation_id"],
                    "status": status,
                },
            }

        return reader

    return sent, factory


def test_auxiliary_context_is_exact_and_null_session_only() -> None:
    parsed = inference_context_from_params({"inference_context": _context()})

    assert parsed is not None
    assert parsed.request_id == "request_aux_1"
    assert parsed.session_id is None
    assert parsed.engine_type == "ollama"
    assert inference_context_from_params({}) is None

    invalid_contexts = [
        {**_context(), "extra": True},
        {**_context(), "session_id": 7},
        {**_context(), "schema_version": True},
        {**_context(), "request_id": " request_aux_1"},
        {**_context(), "engine_type": ""},
    ]
    for invalid in invalid_contexts:
        with pytest.raises(ValueError, match="inference_context"):
            inference_context_from_params({"inference_context": invalid})

    session_context = inference_context_from_params({
        "inference_context": {**_context(), "session_id": "session_compact_1"}
    })
    assert session_context is not None
    assert session_context.session_id == "session_compact_1"


def test_auxiliary_callback_uses_null_session_and_settles_once() -> None:
    sent, factory = _bridge(["granted", "settled"])
    context = inference_context_from_params({"inference_context": _context()})
    callback = build_auxiliary_inference_admission_callback(
        context=context,
        write_message=sent.append,
        response_reader_factory=factory,
    )
    assert callback is not None

    lease = callback(_attempt())
    outcome = InferenceAttemptOutcome(status="succeeded", cleanup="confirmed")
    lease.settle(outcome)
    lease.settle(outcome)

    assert len(sent) == 2
    operation_id = sent[0]["params"]["operation_id"]
    assert sent[0]["params"] == {
        "api_version": API_VERSION,
        "schema_version": 1,
        "kind": "inference",
        "request_id": "request_aux_1",
        "session_id": None,
        "authority_revision": "authority_aux_1",
        "operation_id": operation_id,
        "phase": "admit",
        "engine_type": "ollama",
    }
    assert sent[1]["params"]["session_id"] is None
    assert sent[1]["params"]["phase"] == "settle"
    assert sent[1]["params"]["consumption"] == "unknown"
    assert sent[1]["params"]["charge_consumption"] is True


def test_auxiliary_callback_rejects_a_different_actual_provider() -> None:
    sent, factory = _bridge(["granted"])
    context = inference_context_from_params({"inference_context": _context()})
    callback = build_auxiliary_inference_admission_callback(
        context=context,
        write_message=sent.append,
        response_reader_factory=factory,
    )
    assert callback is not None

    with pytest.raises(InferenceAdmissionRefused, match="route_context_mismatch"):
        callback(_attempt(provider="openai"))
    assert sent == []


class _RecordingLease:
    def __init__(self, outcomes: list[InferenceAttemptOutcome]) -> None:
        self._outcomes = outcomes

    def settle(self, outcome: InferenceAttemptOutcome) -> None:
        self._outcomes.append(outcome)


def _recording_admission(
    attempts: list[InferenceAttemptContext],
    outcomes: list[InferenceAttemptOutcome],
):
    def admit(context: InferenceAttemptContext) -> _RecordingLease:
        attempts.append(context)
        return _RecordingLease(outcomes)

    return admit


@pytest.mark.parametrize("generator", ["suggestions", "commit"])
def test_background_generators_admit_each_actual_attempt(generator: str) -> None:
    engine = MagicMock()
    engine.generate.return_value = (
        json.dumps(["Hello there", "How can I help?", "What next?", "Tell me more"])
        if generator == "suggestions"
        else "feat: add admission"
    )
    container = SimpleNamespace(stack=SimpleNamespace(
        engine=engine,
        config=SimpleNamespace(
            engine_type="openai",
            model="trusted-model",
            feature_flags={},
        ),
    ))
    attempts: list[InferenceAttemptContext] = []
    outcomes: list[InferenceAttemptOutcome] = []
    admission = _recording_admission(attempts, outcomes)

    if generator == "suggestions":
        result = generate_suggestions(
            container,
            {},
            LOG,
            request_id="request_aux_1",
            inference_admission=admission,
        )
        assert len(result) == 4
    else:
        assert generate_commit_message(
            container,
            "diff --git a/a b/a",
            LOG,
            request_id="request_aux_1",
            inference_admission=admission,
        ) == "feat: add admission"

    assert len(attempts) == 1
    assert attempts[0].request_id == "request_aux_1"
    assert attempts[0].session_id == ""
    assert attempts[0].provider == "openai"
    assert outcomes == [InferenceAttemptOutcome(status="succeeded", cleanup="confirmed")]


@pytest.mark.parametrize("generator", ["suggestions", "commit"])
def test_background_generator_uses_stack_captured_before_admission(
    generator: str,
) -> None:
    original_engine = MagicMock()
    original_engine.generate.return_value = (
        json.dumps(["Hello there", "How can I help?", "What next?", "Tell me more"])
        if generator == "suggestions"
        else "feat: preserve leased route"
    )
    original_stack = SimpleNamespace(
        engine=original_engine,
        config=SimpleNamespace(
            engine_type="openai",
            model="trusted-model",
            feature_flags={},
        ),
    )
    replacement_engine = MagicMock()
    replacement_stack = SimpleNamespace(
        engine=replacement_engine,
        config=SimpleNamespace(
            engine_type="ollama",
            model="replacement-model",
            feature_flags={},
        ),
    )
    container = SimpleNamespace(stack=original_stack)
    outcomes: list[InferenceAttemptOutcome] = []

    def replace_after_grant(context: InferenceAttemptContext) -> _RecordingLease:
        assert context.provider == "openai"
        assert context.model == "trusted-model"
        container.stack = replacement_stack
        return _RecordingLease(outcomes)

    if generator == "suggestions":
        generate_suggestions(
            container,
            {},
            LOG,
            request_id="request_aux_1",
            inference_admission=replace_after_grant,
        )
    else:
        generate_commit_message(
            container,
            "diff --git a/a b/a",
            LOG,
            request_id="request_aux_1",
            inference_admission=replace_after_grant,
        )

    original_engine.generate.assert_called_once()
    replacement_engine.generate.assert_not_called()
    assert outcomes == [InferenceAttemptOutcome(status="succeeded", cleanup="confirmed")]


@pytest.mark.parametrize("active_fim", [True, False])
def test_inline_admits_active_or_ollama_fallback_attempt(
    monkeypatch: pytest.MonkeyPatch,
    active_fim: bool,
) -> None:
    fim = MagicMock(return_value="completed()")
    active_engine = SimpleNamespace(generate_inline_completion=fim) if active_fim else object()
    container = SimpleNamespace(stack=SimpleNamespace(
        engine=active_engine,
        config=SimpleNamespace(engine_type="ollama" if active_fim else "openai"),
    ))
    if not active_fim:
        monkeypatch.setattr(
            inline_completion,
            "_build_ollama_fallback_engine",
            lambda: SimpleNamespace(generate_inline_completion=fim),
        )
    attempts: list[InferenceAttemptContext] = []
    outcomes: list[InferenceAttemptOutcome] = []

    result = inline_completion.generate_inline_completion(
        container,
        prefix="def f(",
        suffix=")",
        model="trusted-model",
        max_tokens=64,
        logger=LOG,
        request_id="request_aux_1",
        inference_admission=_recording_admission(attempts, outcomes),
    )

    assert result == "completed()"
    assert len(attempts) == 1
    assert attempts[0].provider == "ollama"
    assert outcomes == [InferenceAttemptOutcome(status="succeeded", cleanup="confirmed")]


def _invoke_and_settle(admission: Any, request_id: str) -> None:
    assert request_id == "request_aux_1"
    lease = admission(_attempt())
    lease.settle(InferenceAttemptOutcome(status="succeeded", cleanup="confirmed"))


@pytest.mark.parametrize("dispatcher", ["suggestions", "commit", "inline"])
def test_dispatchers_build_callback_from_closed_context(
    monkeypatch: pytest.MonkeyPatch,
    dispatcher: str,
) -> None:
    sent, factory = _bridge(["granted", "settled"])
    params: dict[str, Any] = {
        "accept_version": API_VERSION,
        "inference_context": _context(),
    }
    if dispatcher == "suggestions":
        monkeypatch.setattr(
            request_dispatch_suggestions,
            "generate_suggestions",
            lambda *_args, **kwargs: _invoke_and_settle(
                kwargs["inference_admission"], kwargs["request_id"]
            ) or ["one", "two"],
        )
        outcome = request_dispatch_suggestions.process_suggestions_method(
            "suggestions.generate", 1, params, True, MagicMock(), LOG,
            write_message=sent.append, response_reader_factory=factory,
        )
    elif dispatcher == "commit":
        monkeypatch.setattr(
            request_dispatch_commit,
            "generate_commit_message",
            lambda *_args, **kwargs: _invoke_and_settle(
                kwargs["inference_admission"], kwargs["request_id"]
            ) or "feat: admitted",
        )
        params["diff"] = "diff"
        outcome = request_dispatch_commit.process_commit_method(
            "commit.generate_message", 1, params, True, MagicMock(), LOG,
            write_message=sent.append, response_reader_factory=factory,
        )
    else:
        monkeypatch.setattr(
            request_dispatch_inline,
            "generate_inline_completion",
            lambda *_args, **kwargs: _invoke_and_settle(
                kwargs["inference_admission"], kwargs["request_id"]
            ) or "completed()",
        )
        params["model"] = "trusted-model"
        outcome = request_dispatch_inline.process_inline_method(
            "inline.complete", 1, params, True, MagicMock(), LOG,
            write_message=sent.append, response_reader_factory=factory,
        )

    assert outcome is not None
    assert "result" in outcome.response
    assert [message["params"]["phase"] for message in sent] == ["admit", "settle"]


def test_dispatcher_rejects_malformed_context_before_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generate = MagicMock()
    monkeypatch.setattr(request_dispatch_suggestions, "generate_suggestions", generate)

    outcome = request_dispatch_suggestions.process_suggestions_method(
        "suggestions.generate",
        1,
        {"accept_version": API_VERSION, "inference_context": {"schema_version": 1}},
        True,
        MagicMock(),
        LOG,
    )

    assert outcome is not None
    assert outcome.response["error"]["code"] == -32602
    generate.assert_not_called()


def test_auxiliary_worker_passes_admission_transport_only_for_new_context() -> None:
    captured: dict[str, Any] = {}

    class Transport:
        approval_reader_factory = object()

        def send_control(self, _message: dict[str, Any]) -> None:
            return None

    transport = Transport()

    def request_runner(
        message: dict[str, Any], initialized: bool, **kwargs: Any
    ) -> ProcessOutcome:
        captured.update(message=message, initialized=initialized, kwargs=kwargs)
        return ProcessOutcome(True, False, {"id": 1, "result": {}}, [])

    worker = server_auxiliary_workers._make_auxiliary_worker(
        method_label="suggestions.generate",
        message={"id": 1, "params": {"inference_context": _context()}},
        transport=transport,
        request_runner=request_runner,
        outcome_sender=lambda *_args, **_kwargs: None,
        logger=LOG,
        shutdown_gate=server_auxiliary_workers.AuxiliaryWorkerGate(),
    )
    worker()

    assert captured["initialized"] is True
    assert captured["kwargs"] == {
        "write_frame": transport.send_control,
        "response_reader_factory": transport.approval_reader_factory,
    }


def test_auxiliary_worker_maps_typed_admission_failure_to_bounded_rpc_error() -> None:
    controls: list[dict[str, Any]] = []
    transport = SimpleNamespace(send_control=controls.append)

    def refuse(*_args: Any, **_kwargs: Any) -> ProcessOutcome:
        raise InferenceAdmissionRefused("provider_route_changed")

    worker = server_auxiliary_workers._make_auxiliary_worker(
        method_label="suggestions.generate",
        message={"id": 9, "params": {"inference_context": _context()}},
        transport=transport,
        request_runner=refuse,
        outcome_sender=lambda *_args, **_kwargs: None,
        logger=LOG,
        shutdown_gate=server_auxiliary_workers.AuxiliaryWorkerGate(),
    )
    worker()

    assert controls[0]["id"] == 9
    assert controls[0]["error"]["code"] == -32000
    assert controls[0]["error"]["data"]["reason"] == "provider_route_changed"


def test_server_wrapper_forwards_auxiliary_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    writer = MagicMock()
    reader_factory = MagicMock()

    def runtime_process(*_args: Any, **kwargs: Any) -> ProcessOutcome:
        captured.update(kwargs)
        return ProcessOutcome(True, False, {"id": 1, "result": {}}, [])

    monkeypatch.setattr(server, "runtime_process_message", runtime_process)
    server.process_message(
        {"id": 1},
        initialized=True,
        write_frame=writer,
        response_reader_factory=reader_factory,
    )

    assert captured["write_message"] is writer
    assert captured["response_reader_factory"] is reader_factory


def test_server_wrapper_maps_inline_admission_refusal_without_exiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> ProcessOutcome:
        raise InferenceAdmissionRefused("inline_route_busy")

    monkeypatch.setattr(server, "runtime_process_message", refuse)

    outcome = server.process_message({"id": 41}, initialized=True)

    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert outcome.response["error"]["code"] == -32000
    assert outcome.response["error"]["data"]["reason"] == "inline_route_busy"


def test_inline_worker_completes_real_multiplexer_admit_and_settle_roundtrip(  # noqa: PLR0915 -- one end-to-end transport lifecycle
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    incoming: queue.Queue[dict[str, Any] | BaseException] = queue.Queue()
    written: list[dict[str, Any]] = []
    written_lock = threading.Lock()
    admit_sent = threading.Event()
    settle_sent = threading.Event()
    provider_called = threading.Event()
    outcome_sent = threading.Event()

    def read_message() -> dict[str, Any]:
        item = incoming.get(timeout=2.0)
        if isinstance(item, BaseException):
            raise item
        return item

    def write_message(message: dict[str, Any]) -> None:
        with written_lock:
            written.append(message)
        if message.get("method") == RUNTIME_OPERATION_METHOD:
            phase = message["params"]["phase"]
            (admit_sent if phase == "admit" else settle_sent).set()
        elif message.get("id") == 501 and "result" in message:
            outcome_sent.set()

    def provider(*_args: Any, **_kwargs: Any) -> str:
        provider_called.set()
        return "completed()"

    engine = SimpleNamespace(generate_inline_completion=provider)
    monkeypatch.setattr(server, "_BRAIN_CONTAINER", SimpleNamespace(
        stack=SimpleNamespace(
            engine=engine,
            config=SimpleNamespace(engine_type="ollama"),
        )
    ))
    multiplexer = StdioTransportMultiplexer(
        reader=read_message,
        write_message=write_message,
        logger=LOG,
    )
    family_workers: dict[str, set[Any]] = {}
    try:
        message = {
            "jsonrpc": "2.0",
            "id": 501,
            "method": INLINE_COMPLETE_METHOD,
            "params": {
                "accept_version": API_VERSION,
                "prefix": "def f(",
                "suffix": ")",
                "model": "trusted-model",
                "inference_context": _context(),
            },
        }
        assert server_auxiliary_workers.route_auxiliary_request(
            method=INLINE_COMPLETE_METHOD,
            message=message,
            multiplexer=multiplexer,
            direct_transport=SimpleNamespace(send_control=lambda _message: None),
            hardware_worker_threads=set(),
            compact_worker_threads=set(),
            family_worker_threads=family_workers,
            request_runner=server.process_message,
            send_outcome=lambda outcome, **_kwargs: multiplexer.send_control(
                outcome.response
            ),
            write_outcome_direct=lambda _outcome: None,
            logger=LOG,
        )
        assert admit_sent.wait(1.0)
        assert not provider_called.is_set()

        incoming.put({"jsonrpc": "2.0", "id": 777, "method": "shutdown", "params": {}})
        assert multiplexer.read_request(timeout_seconds=1.0)["id"] == 777

        with written_lock:
            admit = next(
                item for item in written
                if item.get("method") == RUNTIME_OPERATION_METHOD
                and item["params"]["phase"] == "admit"
            )
        incoming.put({
            "jsonrpc": "2.0",
            "id": admit["id"],
            "result": {
                "schema_version": 1,
                "operation_id": admit["params"]["operation_id"],
                "status": "granted",
            },
        })
        incoming.put({"jsonrpc": "2.0", "id": 778, "method": "shutdown", "params": {}})
        assert multiplexer.read_request(timeout_seconds=1.0)["id"] == 778
        assert provider_called.wait(1.0), written
        assert settle_sent.wait(1.0)

        with written_lock:
            settle = next(
                item for item in written
                if item.get("method") == RUNTIME_OPERATION_METHOD
                and item["params"]["phase"] == "settle"
            )
        incoming.put({
            "jsonrpc": "2.0",
            "id": settle["id"],
            "result": {
                "schema_version": 1,
                "operation_id": settle["params"]["operation_id"],
                "status": "settled",
            },
        })
        incoming.put({"jsonrpc": "2.0", "id": 779, "method": "shutdown", "params": {}})
        assert multiplexer.read_request(timeout_seconds=1.0)["id"] == 779
        assert outcome_sent.wait(1.0)
        server_auxiliary_workers.join_auxiliary_workers(
            worker_threads=family_workers["inference"],
            timeout_seconds=1.0,
            logger=LOG,
        )

        with written_lock:
            response = next(item for item in written if item.get("id") == 501)
        assert response["result"]["completion"] == "completed()"
        assert admit["params"]["operation_id"] == settle["params"]["operation_id"]
    finally:
        multiplexer.close()
