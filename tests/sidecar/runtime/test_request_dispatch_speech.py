"""``speech.prepare`` / ``speech.transcribe`` through the request dispatcher."""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

import sidecar.runtime.request_dispatch as rd
from sidecar.ai.error_codes import (
    CMP_SPEECH_ENGINE_FAILED,
    CMP_SPEECH_INVALID_AUDIO,
    CMP_SPEECH_MODEL_INVALID,
    CMP_SPEECH_PACKAGE_UNAVAILABLE,
)
from sidecar.ai.host_policy import HOST_ALLOWED_RPC_METHODS
from sidecar.ai.speech.audio import REQUIRED_MODEL_FILES, SAMPLE_RATE
from sidecar.ai.speech.engine import SpeechEngine, reset_speech_engine
from sidecar.protocol import (
    API_VERSION,
    INBOUND_VERSIONED_REQUEST_METHODS,
    SPEECH_PREPARE_METHOD,
    SPEECH_TRANSCRIBE_METHOD,
)
from sidecar.runtime.diagnostics import sanitize_diagnostic_value
from sidecar.runtime.server_auxiliary_workers import (
    AUXILIARY_FAMILY_BY_METHOD,
    DEFAULT_MAX_WORKERS_BY_FAMILY,
)

LOGGER = logging.getLogger("test.request_dispatch_speech")


def _brain() -> SimpleNamespace:
    config = SimpleNamespace(
        tools_workspace_root=None, agent_workspace_root=None, tools_enabled=True, feature_flags={}
    )
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=config, engine=SimpleNamespace(model_name="dummy-model"), tool_observations=None
        )
    )


def _send(method: str, params: dict[str, Any], message_id: Any = 7) -> Any:
    return rd.process_message(
        {"method": method, "id": message_id, "params": params},
        True,
        brain_container=_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )


def _audio_b64(seconds: float) -> str:
    return base64.b64encode(
        np.full(int(seconds * SAMPLE_RATE), 900, dtype="<i2").tobytes()
    ).decode()


@pytest.fixture
def model_dir(tmp_path: Path) -> str:
    root = tmp_path / "model"
    for subdir, names in REQUIRED_MODEL_FILES.items():
        (root / subdir).mkdir(parents=True)
        for name in names:
            (root / subdir / name).write_bytes(b"x")
    return str(root)


class _Adapter:
    def recognize(self, samples: Any, *, sample_rate: int) -> str:
        return f" heard {len(samples) / sample_rate:.1f}s "


@pytest.fixture
def fake_engine() -> Any:
    loads: list[Path] = []

    def loader(asr_dir: Path, _vad_dir: Path, **_kwargs: Any) -> tuple[Any, Any]:
        loads.append(asr_dir)
        return _Adapter(), object()

    engine = SpeechEngine(loader=loader)
    reset_speech_engine(engine)
    engine.loads = loads  # type: ignore[attr-defined]
    yield engine
    reset_speech_engine(None)


def _params(default_dir: str, **overrides: Any) -> dict[str, Any]:
    params = {
        "accept_version": API_VERSION,
        "model_dir": default_dir,
        "audio_b64": _audio_b64(1.5),
        "sample_rate": 16000,
        "format": "pcm_s16le",
    }
    params.update(overrides)
    return params


def test_methods_are_versioned_worker_routed_and_desktop_only() -> None:
    for method in (SPEECH_PREPARE_METHOD, SPEECH_TRANSCRIBE_METHOD):
        assert method in INBOUND_VERSIONED_REQUEST_METHODS
        assert AUXILIARY_FAMILY_BY_METHOD[method] == "speech"
        assert method not in HOST_ALLOWED_RPC_METHODS
    # Two: a short clip's transcribe queues behind its press's prepare on the engine lock.
    assert DEFAULT_MAX_WORKERS_BY_FAMILY["speech"] == 3


def test_prepare_returns_ready_and_load_ms(model_dir: str, fake_engine: Any) -> None:
    outcome = _send(SPEECH_PREPARE_METHOD, {"accept_version": API_VERSION, "model_dir": model_dir})
    result = outcome.response["result"]
    assert result["ready"] is True
    assert isinstance(result["load_ms"], int)
    assert result["api_version"] == API_VERSION
    assert len(fake_engine.loads) == 1


def test_transcribe_returns_text_duration_and_engine_ms(model_dir: str, fake_engine: Any) -> None:
    outcome = _send(SPEECH_TRANSCRIBE_METHOD, _params(model_dir))
    result = outcome.response["result"]
    assert result["text"] == "heard 1.5s"
    assert result["duration_ms"] == 1500
    assert isinstance(result["engine_ms"], int)
    assert set(result) == {"text", "duration_ms", "engine_ms", "api_version"}


def test_version_mismatch_is_refused_before_any_work(model_dir: str, fake_engine: Any) -> None:
    outcome = _send(SPEECH_TRANSCRIBE_METHOD, _params(model_dir, accept_version="1999-01-01"))
    assert "error" in outcome.response
    assert fake_engine.loads == []


def test_notification_form_returns_no_response(model_dir: str, fake_engine: Any) -> None:
    outcome = _send(
        SPEECH_PREPARE_METHOD, {"accept_version": API_VERSION, "model_dir": model_dir}, None
    )
    assert outcome.response is None
    assert fake_engine.loads == []


@pytest.mark.parametrize(
    ("overrides", "code", "rpc_code"),
    [
        ({"audio_b64": ""}, CMP_SPEECH_INVALID_AUDIO, -32602),
        ({"sample_rate": 44100}, CMP_SPEECH_INVALID_AUDIO, -32602),
        ({"format": "wav"}, CMP_SPEECH_INVALID_AUDIO, -32602),
        ({"audio_b64": _audio_b64(0.1)}, CMP_SPEECH_INVALID_AUDIO, -32602),
        ({"model_dir": "relative"}, CMP_SPEECH_MODEL_INVALID, -32602),
        ({"model_dir": None}, CMP_SPEECH_MODEL_INVALID, -32602),
    ],
)
def test_invalid_requests_carry_the_speech_code(
    model_dir: str, fake_engine: Any, overrides: dict[str, Any], code: str, rpc_code: int
) -> None:
    error = _send(SPEECH_TRANSCRIBE_METHOD, _params(model_dir, **overrides)).response["error"]
    assert error["code"] == rpc_code
    assert error["data"]["error_code"] == code


def test_missing_model_files_report_0001(tmp_path: Path, fake_engine: Any) -> None:
    error = _send(
        SPEECH_PREPARE_METHOD, {"accept_version": API_VERSION, "model_dir": str(tmp_path)}
    ).response["error"]
    assert error["data"]["error_code"] == CMP_SPEECH_MODEL_INVALID
    assert str(tmp_path) not in json.dumps(error)


def test_load_failure_reports_0003_without_the_cause_text(model_dir: str) -> None:
    def loader(*_args: Any, **_kwargs: Any) -> tuple[Any, Any]:
        raise RuntimeError(f"boom reading {model_dir}")

    reset_speech_engine(SpeechEngine(loader=loader))
    try:
        error = _send(SPEECH_TRANSCRIBE_METHOD, _params(model_dir)).response["error"]
    finally:
        reset_speech_engine(None)
    assert error["code"] == -32000
    assert error["data"]["error_code"] == CMP_SPEECH_ENGINE_FAILED
    assert "boom" not in json.dumps(error)


def test_missing_package_reports_0004(model_dir: str) -> None:
    def loader(*_args: Any, **_kwargs: Any) -> tuple[Any, Any]:
        raise ImportError("No module named onnx_asr")

    reset_speech_engine(SpeechEngine(loader=loader))
    try:
        error = _send(
            SPEECH_PREPARE_METHOD, {"accept_version": API_VERSION, "model_dir": model_dir}
        ).response["error"]
    finally:
        reset_speech_engine(None)
    assert error["data"]["error_code"] == CMP_SPEECH_PACKAGE_UNAVAILABLE


def test_real_onnx_asr_rejecting_a_bogus_model_is_0003(model_dir: str) -> None:
    pytest.importorskip("onnx_asr")
    pytest.importorskip("onnxruntime")
    reset_speech_engine(SpeechEngine())
    try:
        error = _send(
            SPEECH_PREPARE_METHOD, {"accept_version": API_VERSION, "model_dir": model_dir}
        ).response["error"]
    finally:
        reset_speech_engine(None)
    assert error["data"]["error_code"] == CMP_SPEECH_ENGINE_FAILED
    assert model_dir not in json.dumps(error)


def test_unexpected_bug_becomes_0003_and_leaks_nothing(
    model_dir: str, fake_engine: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _bug(*_args: Any, **_kwargs: Any) -> Any:
        raise KeyError("audio payload fragment")

    monkeypatch.setattr(fake_engine, "transcribe", _bug)
    error = _send(SPEECH_TRANSCRIBE_METHOD, _params(model_dir)).response["error"]
    assert error["data"]["error_code"] == CMP_SPEECH_ENGINE_FAILED
    assert "fragment" not in json.dumps(error)


@pytest.mark.parametrize("scenario", ["ok", "invalid_rate", "engine_bug", "load_failure"])
def test_audio_never_reaches_logs_or_error_payloads(
    model_dir: str, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch, scenario: str
) -> None:
    def loader(*_args: Any, **_kwargs: Any) -> tuple[Any, Any]:
        if scenario == "load_failure":
            raise RuntimeError("fail")
        return _Adapter(), object()

    engine = SpeechEngine(loader=loader)
    if scenario == "engine_bug":
        monkeypatch.setattr(
            engine, "transcribe", lambda *_a, **_k: (_ for _ in ()).throw(KeyError("x"))
        )
    reset_speech_engine(engine)
    audio = _audio_b64(1.0)
    overrides: dict[str, Any] = {"audio_b64": audio}
    if scenario == "invalid_rate":
        overrides["sample_rate"] = 8000
    with caplog.at_level(logging.DEBUG):
        try:
            outcome = _send(SPEECH_TRANSCRIBE_METHOD, _params(model_dir, **overrides))
        finally:
            reset_speech_engine(None)
    captured = "\n".join(
        [
            record.getMessage() + json.dumps(record.__dict__, default=str)
            for record in caplog.records
        ]
        + [json.dumps(outcome.response, default=str)]
    )
    assert audio not in captured
    assert audio[:64] not in captured


def test_diagnostic_sanitizer_redacts_the_audio_key_anywhere() -> None:
    payload = {
        "audio_b64": "QUJD" * 100,
        "params": {"audioB64": "QUJD", "audio-b64": "QUJD"},
        "audio_ms": 1500,
    }
    redacted = sanitize_diagnostic_value(payload)
    assert redacted["audio_b64"] == "[redacted]"
    assert redacted["params"] == {"audioB64": "[redacted]", "audio-b64": "[redacted]"}
    assert redacted["audio_ms"] == 1500
