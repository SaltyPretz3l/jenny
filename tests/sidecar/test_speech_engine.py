"""Dictation speech package: audio decoding, model-dir validation and the engine."""

from __future__ import annotations

import base64
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from sidecar.ai.error_codes import (
    CMP_SPEECH_ENGINE_FAILED,
    CMP_SPEECH_INVALID_AUDIO,
    CMP_SPEECH_MODEL_INVALID,
    CMP_SPEECH_PACKAGE_UNAVAILABLE,
)
from sidecar.ai.speech import engine as engine_module
from sidecar.ai.speech.audio import (
    MAX_AUDIO_B64_CHARS,
    REQUIRED_MODEL_FILES,
    SAMPLE_RATE,
    decode_pcm16,
    validate_model_dir,
)
from sidecar.ai.speech.engine import (
    CPU_PROVIDERS,
    MAX_PLAIN_SECONDS,
    VAD_OPTIONS,
    SpeechEngine,
    intra_op_threads,
)
from sidecar.ai.speech.errors import SpeechError

FMT = "pcm_s16le"


def _b64(seconds: float, value: int = 1000) -> str:
    samples = np.full(int(seconds * SAMPLE_RATE), value, dtype="<i2")
    return base64.b64encode(samples.tobytes()).decode("ascii")


def _make_model_dir(root: Path) -> Path:
    for subdir, names in REQUIRED_MODEL_FILES.items():
        (root / subdir).mkdir(parents=True)
        for name in names:
            (root / subdir / name).write_bytes(b"x")
    return root


@pytest.fixture
def model_dir(tmp_path: Path) -> str:
    return str(_make_model_dir(tmp_path / "model"))


def _code(info: pytest.ExceptionInfo[SpeechError]) -> str:
    return info.value.code


# ---------------------------------------------------------------- decode_pcm16


def test_decode_returns_float32_in_unit_range() -> None:
    samples = decode_pcm16(_b64(0.5, 16384), SAMPLE_RATE, FMT)
    assert samples.dtype == np.float32
    assert len(samples) == SAMPLE_RATE // 2
    assert float(samples[0]) == pytest.approx(0.5)


def test_decode_handles_negative_full_scale() -> None:
    raw = np.full(SAMPLE_RATE, -32768, dtype="<i2").tobytes()
    samples = decode_pcm16(base64.b64encode(raw).decode(), SAMPLE_RATE, FMT)
    assert float(samples.min()) == -1.0


@pytest.mark.parametrize(
    ("audio", "rate", "fmt"),
    [
        pytest.param("", SAMPLE_RATE, FMT, id="empty"),
        pytest.param(None, SAMPLE_RATE, FMT, id="none"),
        pytest.param(b"AAAA", SAMPLE_RATE, FMT, id="bytes"),
        pytest.param("not base64 !!", SAMPLE_RATE, FMT, id="bad-base64"),
        pytest.param(_b64(1.0), 48_000, FMT, id="rate-48k"),
        pytest.param(_b64(1.0), "16000", FMT, id="rate-string"),
        pytest.param(_b64(1.0), True, FMT, id="rate-bool"),
        pytest.param(_b64(1.0), SAMPLE_RATE, "pcm_f32le", id="format-f32"),
        pytest.param(_b64(1.0), SAMPLE_RATE, None, id="format-none"),
    ],
)
def test_decode_rejects_bad_inputs(audio: Any, rate: Any, fmt: Any) -> None:
    with pytest.raises(SpeechError) as info:
        decode_pcm16(audio, rate, fmt)
    assert _code(info) == CMP_SPEECH_INVALID_AUDIO


def test_decode_rejects_odd_byte_length() -> None:
    odd = base64.b64encode(b"\x01" * (SAMPLE_RATE * 2 + 1)).decode()
    with pytest.raises(SpeechError) as info:
        decode_pcm16(odd, SAMPLE_RATE, FMT)
    assert info.value.reason == "odd_length"


def test_decode_enforces_duration_bounds() -> None:
    with pytest.raises(SpeechError) as short:
        decode_pcm16(_b64(0.19), SAMPLE_RATE, FMT)
    assert short.value.reason == "too_short"
    assert len(decode_pcm16(_b64(0.2), SAMPLE_RATE, FMT)) == int(0.2 * SAMPLE_RATE)
    assert len(decode_pcm16(_b64(120.0), SAMPLE_RATE, FMT)) == 120 * SAMPLE_RATE
    with pytest.raises(SpeechError) as long:
        decode_pcm16(_b64(120.1), SAMPLE_RATE, FMT)
    assert long.value.reason == "too_long"


def test_decode_rejects_oversized_string_before_decoding(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*_args: Any, **_kwargs: Any) -> bytes:
        raise AssertionError("an oversized payload must not be base64-decoded")

    monkeypatch.setattr(base64, "b64decode", _boom)
    with pytest.raises(SpeechError) as info:
        decode_pcm16("A" * (MAX_AUDIO_B64_CHARS + 1), SAMPLE_RATE, FMT)
    assert info.value.reason == "too_long"


# ----------------------------------------------------------- validate_model_dir


def test_validate_model_dir_returns_resolved_asr_and_vad(model_dir: str) -> None:
    asr_dir, vad_dir = validate_model_dir(model_dir)
    assert asr_dir == Path(os.path.realpath(model_dir)) / "asr"
    assert vad_dir == Path(os.path.realpath(model_dir)) / "vad"


@pytest.mark.parametrize("bad", [None, "", 7, "relative/model", "bad\x00dir"])
def test_validate_model_dir_rejects_non_absolute(bad: Any) -> None:
    with pytest.raises(SpeechError) as info:
        validate_model_dir(bad)
    assert _code(info) == CMP_SPEECH_MODEL_INVALID


def test_validate_model_dir_rejects_missing_directory(tmp_path: Path) -> None:
    with pytest.raises(SpeechError) as info:
        validate_model_dir(str(tmp_path / "nope"))
    assert _code(info) == CMP_SPEECH_MODEL_INVALID


@pytest.mark.parametrize(
    "missing",
    ["asr/encoder-model.int8.onnx", "asr/vocab.txt", "vad/silero_vad.onnx", "vad/config.json"],
)
def test_validate_model_dir_requires_every_file(tmp_path: Path, missing: str) -> None:
    root = _make_model_dir(tmp_path / "model")
    (root / missing).unlink()
    with pytest.raises(SpeechError) as info:
        validate_model_dir(str(root))
    assert _code(info) == CMP_SPEECH_MODEL_INVALID
    assert str(tmp_path) not in info.value.message


def test_validate_model_dir_rejects_a_file_that_is_a_directory(tmp_path: Path) -> None:
    root = _make_model_dir(tmp_path / "model")
    (root / "asr" / "vocab.txt").unlink()
    (root / "asr" / "vocab.txt").mkdir()
    with pytest.raises(SpeechError):
        validate_model_dir(str(root))


def test_validate_model_dir_refuses_a_subdir_that_resolves_elsewhere(tmp_path: Path) -> None:
    outside = _make_model_dir(tmp_path / "other")
    root = tmp_path / "model"
    root.mkdir()
    link = root / "asr"
    try:
        if os.name == "nt":
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(outside / "asr")],
                check=True,
                capture_output=True,
            )
        else:
            link.symlink_to(outside / "asr", target_is_directory=True)
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("this host cannot create a directory link")
    (root / "vad").mkdir()
    for name in REQUIRED_MODEL_FILES["vad"]:
        (root / "vad" / name).write_bytes(b"x")
    with pytest.raises(SpeechError) as info:
        validate_model_dir(str(root))
    assert _code(info) == CMP_SPEECH_MODEL_INVALID


# ----------------------------------------------------------------------- engine


class FakeAdapter:
    def __init__(self, text: str = "  hello   world \n") -> None:
        self.text = text
        self.recognized: list[int] = []
        self.vad_used_with: list[Any] = []
        self.vad_options: list[dict[str, Any]] = []

    def recognize(self, samples: Any, *, sample_rate: int) -> str:
        assert sample_rate == SAMPLE_RATE
        self.recognized.append(len(samples))
        return self.text

    def with_vad(self, vad: Any, **options: Any) -> Any:
        adapter = self
        self.vad_options.append(options)

        class _Vad:
            def recognize(self, samples: Any, *, sample_rate: int) -> Any:
                adapter.vad_used_with.append(vad)
                assert sample_rate == SAMPLE_RATE
                return iter(
                    [
                        type("Seg", (), {"text": " first  part"})(),
                        type("Seg", (), {"text": "second\tpart "})(),
                    ]
                )

        return _Vad()


class RecordingLoader:
    def __init__(self, adapter: FakeAdapter | None = None, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.adapter = adapter or FakeAdapter()
        self.error = error

    def __call__(self, asr_dir: Path, vad_dir: Path, *, intra_op_threads: int, providers: Any):
        self.calls.append(
            {
                "asr": asr_dir,
                "vad": vad_dir,
                "threads": intra_op_threads,
                "providers": tuple(providers),
            }
        )
        if self.error is not None:
            raise self.error
        return self.adapter, object()


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class FakeTimer:
    created: list[FakeTimer] = []

    def __init__(self, interval: float, function: Any) -> None:
        self.interval = interval
        self.function = function
        self.daemon = False
        self.started = False
        self.cancelled = False
        FakeTimer.created.append(self)

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True


@pytest.fixture(autouse=True)
def _reset_fake_timers() -> None:
    FakeTimer.created = []


def _engine(loader: RecordingLoader, clock: FakeClock | None = None, **kwargs: Any) -> SpeechEngine:
    return SpeechEngine(
        loader=loader, clock=clock or FakeClock(), timer_factory=FakeTimer, **kwargs
    )


def _samples(seconds: float) -> Any:
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


def test_prepare_loads_once_and_reuses_for_the_same_dir(model_dir: str) -> None:
    loader = RecordingLoader()
    engine = _engine(loader)
    engine.prepare(model_dir)
    engine.prepare(model_dir)
    engine.transcribe(model_dir, _samples(1))
    assert len(loader.calls) == 1


def test_prepare_reports_load_time_in_ms(model_dir: str) -> None:
    clock = FakeClock()

    def slow_loader(*_args: Any, **_kwargs: Any) -> tuple[Any, Any]:
        clock.now += 1.25
        return FakeAdapter(), object()

    engine = SpeechEngine(loader=slow_loader, clock=clock, timer_factory=FakeTimer)
    assert engine.prepare(model_dir) == 1250
    assert engine.prepare(model_dir) == 0


def test_a_different_model_dir_reloads(tmp_path: Path) -> None:
    first = str(_make_model_dir(tmp_path / "a"))
    second = str(_make_model_dir(tmp_path / "b"))
    loader = RecordingLoader()
    engine = _engine(loader)
    engine.prepare(first)
    engine.prepare(second)
    engine.prepare(second)
    assert [call["asr"].parent.name for call in loader.calls] == ["a", "b"]


def test_loader_gets_cpu_provider_and_capped_threads(
    model_dir: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    loader = RecordingLoader()
    monkeypatch.setattr(os, "cpu_count", lambda: 32)
    _engine(loader).prepare(model_dir)
    assert loader.calls[0]["providers"] == CPU_PROVIDERS == ("CPUExecutionProvider",)
    assert loader.calls[0]["threads"] == 4
    monkeypatch.setattr(os, "cpu_count", lambda: 2)
    assert intra_op_threads() == 2
    monkeypatch.setattr(os, "cpu_count", lambda: None)
    assert intra_op_threads() == 1


def test_short_clip_uses_plain_recognize_and_normalizes_whitespace(model_dir: str) -> None:
    adapter = FakeAdapter()
    engine = _engine(RecordingLoader(adapter))
    text, engine_ms = engine.transcribe(model_dir, _samples(MAX_PLAIN_SECONDS))
    assert text == "hello world"
    assert engine_ms == 0
    assert adapter.recognized == [int(MAX_PLAIN_SECONDS * SAMPLE_RATE)]
    assert adapter.vad_used_with == []


def test_long_clip_goes_through_vad_and_joins_segments(model_dir: str) -> None:
    adapter = FakeAdapter()
    engine = _engine(RecordingLoader(adapter))
    text, _ = engine.transcribe(model_dir, _samples(MAX_PLAIN_SECONDS + 0.5))
    assert text == "first part second part"
    assert len(adapter.vad_used_with) == 1
    assert adapter.vad_options == [VAD_OPTIONS], "short pauses merge so segments read as prose"
    assert adapter.recognized == []


def test_empty_recognition_returns_empty_text(model_dir: str) -> None:
    engine = _engine(RecordingLoader(FakeAdapter(text="   ")))
    assert engine.transcribe(model_dir, _samples(1))[0] == ""


def test_missing_package_is_remembered_as_0004(model_dir: str) -> None:
    loader = RecordingLoader(error=ImportError("No module named onnx_asr"))
    engine = _engine(loader)
    for _ in range(3):
        with pytest.raises(SpeechError) as info:
            engine.prepare(model_dir)
        assert _code(info) == CMP_SPEECH_PACKAGE_UNAVAILABLE
    assert len(loader.calls) == 1


def test_model_dir_is_still_validated_when_the_package_is_missing(tmp_path: Path) -> None:
    engine = _engine(RecordingLoader(error=ImportError("x")))
    with pytest.raises(SpeechError) as info:
        engine.prepare(str(tmp_path / "missing"))
    assert _code(info) == CMP_SPEECH_MODEL_INVALID


def test_load_failure_is_0003_and_not_remembered(model_dir: str) -> None:
    loader = RecordingLoader(error=RuntimeError(f"cannot open {model_dir}"))
    engine = _engine(loader)
    with pytest.raises(SpeechError) as info:
        engine.prepare(model_dir)
    assert _code(info) == CMP_SPEECH_ENGINE_FAILED
    assert model_dir not in info.value.message
    assert not engine.loaded
    loader.error = None
    engine.prepare(model_dir)
    assert engine.loaded
    assert len(loader.calls) == 2


def test_inference_failure_is_0003_without_the_exception_text(model_dir: str) -> None:
    adapter = FakeAdapter()

    def _explode(*_args: Any, **_kwargs: Any) -> str:
        raise ValueError("secret transcript fragment")

    adapter.recognize = _explode  # type: ignore[method-assign]
    engine = _engine(RecordingLoader(adapter))
    with pytest.raises(SpeechError) as info:
        engine.transcribe(model_dir, _samples(1))
    assert _code(info) == CMP_SPEECH_ENGINE_FAILED
    assert "secret" not in info.value.message


def test_idle_unload_after_the_window(model_dir: str) -> None:
    clock = FakeClock()
    engine = _engine(RecordingLoader(), clock, idle_seconds=600)
    engine.prepare(model_dir)
    timer = FakeTimer.created[-1]
    assert timer.interval == 600
    assert timer.daemon is True
    assert timer.started is True
    clock.now += 599
    assert engine.unload_if_idle() is False
    assert engine.loaded
    clock.now += 2
    assert engine.unload_if_idle() is True
    assert not engine.loaded


def test_an_early_timer_wake_rearms_for_the_rest_of_the_window(model_dir: str) -> None:
    clock = FakeClock()
    engine = _engine(RecordingLoader(), clock, idle_seconds=600)
    engine.prepare(model_dir)
    clock.now += 599.5
    FakeTimer.created[-1].function()
    assert engine.loaded
    assert FakeTimer.created[-1].interval == pytest.approx(0.5)
    clock.now += 0.5
    FakeTimer.created[-1].function()
    assert not engine.loaded


def test_use_restarts_the_idle_window(model_dir: str) -> None:
    clock = FakeClock()
    loader = RecordingLoader()
    engine = _engine(loader, clock, idle_seconds=600)
    engine.prepare(model_dir)
    first_timer = FakeTimer.created[-1]
    clock.now += 500
    engine.transcribe(model_dir, _samples(1))
    assert first_timer.cancelled is True
    assert FakeTimer.created[-1] is not first_timer
    clock.now += 500
    assert engine.unload_if_idle() is False
    clock.now += 101
    assert engine.unload_if_idle() is True


def test_next_request_after_unload_reloads(model_dir: str) -> None:
    clock = FakeClock()
    loader = RecordingLoader()
    engine = _engine(loader, clock, idle_seconds=10)
    engine.prepare(model_dir)
    clock.now += 11
    engine.unload_if_idle()
    engine.transcribe(model_dir, _samples(1))
    assert len(loader.calls) == 2


def test_real_timer_unloads_an_idle_engine(model_dir: str) -> None:
    engine = SpeechEngine(loader=RecordingLoader(), idle_seconds=0.05)
    engine.prepare(model_dir)
    deadline = threading.Event()
    for _ in range(100):
        if not engine.loaded:
            break
        deadline.wait(0.05)
    assert not engine.loaded


def test_singleton_is_shared_and_resettable() -> None:
    engine_module.reset_speech_engine(None)
    first = engine_module.get_speech_engine()
    assert engine_module.get_speech_engine() is first
    replacement = SpeechEngine(loader=RecordingLoader())
    engine_module.reset_speech_engine(replacement)
    assert engine_module.get_speech_engine() is replacement
    engine_module.reset_speech_engine(None)


# ------------------------------------------------------------- optional real model


@pytest.mark.skipif(
    not os.environ.get("JENNY_TEST_SPEECH_MODEL_DIR"),
    reason="set JENNY_TEST_SPEECH_MODEL_DIR to an installed asr/+vad/ model directory",
)
def test_real_model_transcribes_silence_without_error() -> None:
    engine = SpeechEngine()
    real_dir = os.environ["JENNY_TEST_SPEECH_MODEL_DIR"]
    assert engine.prepare(real_dir) >= 0
    text, engine_ms = engine.transcribe(real_dir, _samples(2))
    assert isinstance(text, str)
    assert engine_ms >= 0
    engine.unload()
