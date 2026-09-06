"""Unit tests for sidecar inline (fill-in-the-middle) completion.

Covers the OllamaEngine.generate_inline_completion payload shape (CPU-pin +
suffix forwarding), the sidecar.runtime.inline_completion helper (gating +
cleaning), and the request_dispatch_inline dispatcher.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.protocol import (
    API_VERSION,
    INLINE_LOADED_MODELS_METHOD,
    INLINE_UNLOAD_METHOD,
)
from sidecar.runtime import inline_completion as inline_mod
from sidecar.runtime.inline_completion import (
    _ENGINE_TIMEOUT_SECONDS,
    _clean_completion,
    generate_inline_completion,
    list_loaded_inline_models,
    unload_inline_model,
)
from sidecar.runtime import request_dispatch_inline as dispatch_mod
from sidecar.runtime.request_dispatch_inline import process_inline_method

LOG = logging.getLogger("test")


# ---------------------------------------------------------------------------
# OllamaEngine.generate_inline_completion (payload shape)
# ---------------------------------------------------------------------------


def _bare_engine(model_name: str = "chatmodel:latest") -> OllamaEngine:
    # Bypass __init__ (which would try to reach a live daemon); we only exercise
    # the pure payload-construction path with a stubbed _post.
    engine = OllamaEngine.__new__(OllamaEngine)
    engine.model_name = model_name
    return engine


def test_engine_inline_completion_cpu_pins_and_forwards_suffix() -> None:
    engine = _bare_engine()
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=None):  # noqa: ANN001
        captured["endpoint"] = endpoint
        captured["data"] = data
        captured["timeout"] = timeout
        return {"response": "  completed()"}

    engine._post = fake_post  # type: ignore[method-assign]
    out = engine.generate_inline_completion(
        "qwen2.5-coder:1.5b-base", "def f(", ")", use_gpu=False, max_tokens=64, timeout=20
    )

    assert out == "  completed()"
    assert captured["endpoint"] == "/api/generate"
    data = captured["data"]
    assert data["model"] == "qwen2.5-coder:1.5b-base"
    assert data["prompt"] == "def f("
    assert data["suffix"] == ")"
    assert data["stream"] is False
    assert data["options"]["num_gpu"] == 0  # CPU-pinned by default
    assert data["options"]["num_predict"] == 64
    assert captured["timeout"] == 20


def test_engine_inline_completion_gpu_mode_omits_num_gpu() -> None:
    engine = _bare_engine()
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=None):  # noqa: ANN001
        captured["data"] = data
        return {"response": "x"}

    engine._post = fake_post  # type: ignore[method-assign]
    engine.generate_inline_completion("m", "p", "s", use_gpu=True, max_tokens=32)
    assert "num_gpu" not in captured["data"]["options"]


def test_engine_inline_completion_empty_model_returns_empty() -> None:
    engine = _bare_engine(model_name="")

    def fake_post(*_args, **_kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("must not POST when no model is resolvable")

    engine._post = fake_post  # type: ignore[method-assign]
    assert engine.generate_inline_completion("", "p", "s") == ""


def test_engine_inline_completion_clamps_max_tokens() -> None:
    engine = _bare_engine()
    captured: dict[str, object] = {}
    engine._post = lambda endpoint, data, timeout=None: (  # type: ignore[method-assign]  # noqa: ANN001,E501
        captured.update(data=data) or {"response": "x"}
    )
    engine.generate_inline_completion("m", "p", "s", max_tokens=99_999)
    assert captured["data"]["options"]["num_predict"] == 512  # hard cap


def test_engine_unload_model_targets_explicit_tag_without_clearing_chat_state() -> None:
    engine = _bare_engine(model_name="chatmodel:latest")
    engine._reset_loaded_state = lambda: captured.update(reset=True)  # type: ignore[method-assign]
    captured: dict[str, object] = {}
    engine._post = lambda endpoint, data, timeout=None: captured.update(  # type: ignore[method-assign]  # noqa: ANN001,E501
        endpoint=endpoint, data=data
    ) or {}
    engine.unload_model("qwen2.5-coder:1.5b-base")
    assert captured["endpoint"] == "/api/generate"
    assert captured["data"]["model"] == "qwen2.5-coder:1.5b-base"
    assert captured["data"]["keep_alive"] == 0
    # Evicting a FOREIGN tag must not clear this engine's chat loaded-state.
    assert "reset" not in captured


def test_engine_list_loaded_models_parses_ps_payload() -> None:
    engine = _bare_engine()
    engine._get = lambda endpoint, timeout=None: (  # type: ignore[method-assign]  # noqa: ANN001
        {"models": [{"name": "qwen2.5-coder:1.5b-base", "expires_at": "soon"}, {"model": "x:y"}, {}]}
        if endpoint == "/api/ps" else {}
    )
    loaded = engine.list_loaded_models()
    assert loaded == [
        {"name": "qwen2.5-coder:1.5b-base", "expires_at": "soon"},
        {"name": "x:y", "expires_at": None},
    ]


# ---------------------------------------------------------------------------
# sidecar.runtime.inline_completion helper
# ---------------------------------------------------------------------------


def _container_with_engine(return_value: str = "done") -> MagicMock:
    container = MagicMock()
    container.stack.engine.generate_inline_completion.return_value = return_value
    return container


def test_runtime_empty_when_no_model_selected() -> None:
    container = _container_with_engine()
    out = generate_inline_completion(
        container, prefix="a", suffix="b", model="", max_tokens=96, logger=LOG
    )
    assert out == ""
    container.stack.engine.generate_inline_completion.assert_not_called()


def test_runtime_uses_ollama_fallback_when_no_chat_stack(monkeypatch) -> None:  # noqa: ANN001
    # No chat model loaded (stack is None) must NOT block FIM: it runs on its own
    # Ollama model (a separate pull), so the runtime serves it from a transient
    # Ollama engine against the app-managed daemon instead of skipping.
    container = MagicMock()
    container.stack = None
    captured: dict[str, object] = {}

    def fake_fim(model, prefix, suffix, *, use_gpu, max_tokens, timeout):  # noqa: ANN001, ANN202
        captured.update(model=model, prefix=prefix, suffix=suffix)
        return "nostack()"

    monkeypatch.setattr(
        "sidecar.runtime.inline_completion._build_ollama_fallback_engine",
        lambda: SimpleNamespace(generate_inline_completion=fake_fim),
    )
    out = generate_inline_completion(
        container, prefix="a", suffix="b", model="m", max_tokens=96, logger=LOG
    )
    assert out == "nostack()"
    assert captured["model"] == "m"


def test_runtime_empty_when_no_stack_and_no_ollama_fallback(monkeypatch) -> None:  # noqa: ANN001
    # With no chat stack AND no constructable Ollama fallback, degrade to silence.
    container = MagicMock()
    container.stack = None
    monkeypatch.setattr(
        "sidecar.runtime.inline_completion._build_ollama_fallback_engine",
        lambda: None,
    )
    out = generate_inline_completion(
        container, prefix="a", suffix="b", model="m", max_tokens=96, logger=LOG
    )
    assert out == ""


def test_runtime_falls_back_to_ollama_when_engine_lacks_fim_path(monkeypatch) -> None:  # noqa: ANN001
    # The active chat engine (e.g. openai-compatible) has no FIM attr. A FIM
    # model is a separate Ollama pull, so the runtime falls back to a transient
    # Ollama engine against the app-managed daemon instead of skipping.
    container = MagicMock()
    container.stack.engine = SimpleNamespace()  # no generate_inline_completion attr
    captured: dict[str, object] = {}

    def fake_fim(model, prefix, suffix, *, use_gpu, max_tokens, timeout):  # noqa: ANN001, ANN202
        captured.update(
            model=model, prefix=prefix, suffix=suffix, use_gpu=use_gpu, max_tokens=max_tokens
        )
        return "fallback()"

    fallback_engine = SimpleNamespace(generate_inline_completion=fake_fim)
    monkeypatch.setattr(
        "sidecar.runtime.inline_completion._build_ollama_fallback_engine",
        lambda: fallback_engine,
    )
    out = generate_inline_completion(
        container,
        prefix="def f(",
        suffix=")",
        model="qwen2.5-coder:1.5b-base",
        max_tokens=64,
        logger=LOG,
    )
    assert out == "fallback()"
    assert captured["model"] == "qwen2.5-coder:1.5b-base"
    assert captured["prefix"] == "def f("
    assert captured["suffix"] == ")"


def test_runtime_empty_when_engine_lacks_fim_and_ollama_fallback_unavailable(monkeypatch) -> None:  # noqa: ANN001, E501
    # If even the Ollama fallback cannot be constructed, degrade to no ghost text.
    container = MagicMock()
    container.stack.engine = SimpleNamespace()
    monkeypatch.setattr(
        "sidecar.runtime.inline_completion._build_ollama_fallback_engine",
        lambda: None,
    )
    out = generate_inline_completion(
        container, prefix="a", suffix="b", model="m", max_tokens=96, logger=LOG
    )
    assert out == ""


def test_runtime_ignores_legacy_compute_choice_and_cleans_markers() -> None:
    container = _container_with_engine("foo()<|file_separator|>garbage")
    out = generate_inline_completion(
        container,
        prefix="def f(",
        suffix=")",
        model="qwen2.5-coder:1.5b-base",
        max_tokens=64,
        logger=LOG,
    )
    assert out == "foo()"
    call = container.stack.engine.generate_inline_completion.call_args
    assert call.args[0] == "qwen2.5-coder:1.5b-base"
    assert call.args[1] == "def f("
    assert call.args[2] == ")"
    assert call.kwargs["use_gpu"] is True
    assert call.kwargs["max_tokens"] == 64
    # The serial sidecar forwards its own server-side cap, which must stay just
    # above the ~4s Electron client timeout so an abandoned round can't block the
    # loop for long (head-of-line blocking). Guards the bound against drift.
    assert call.kwargs["timeout"] == _ENGINE_TIMEOUT_SECONDS
    assert _ENGINE_TIMEOUT_SECONDS <= 6


def test_runtime_returns_empty_on_engine_error() -> None:
    container = _container_with_engine()
    container.stack.engine.generate_inline_completion.side_effect = RuntimeError("boom")
    out = generate_inline_completion(
        container, prefix="a", suffix="b", model="m", max_tokens=96, logger=LOG
    )
    assert out == ""


def test_clean_completion_truncates_at_first_marker() -> None:
    assert _clean_completion("x()<|endoftext|>y") == "x()"
    assert _clean_completion("a<|fim_middle|>b") == "a"
    assert _clean_completion("plain continuation") == "plain continuation"


# ---------------------------------------------------------------------------
# process_inline_method dispatcher
# ---------------------------------------------------------------------------


def test_process_inline_method_returns_none_for_wrong_method() -> None:
    assert process_inline_method("chat.send", 1, {}, True, MagicMock(), LOG) is None


def test_process_inline_method_errors_when_not_initialized() -> None:
    result = process_inline_method(
        "inline.complete", 1, {"accept_version": API_VERSION}, False, MagicMock(), LOG
    )
    assert result is not None
    assert result.initialized is False
    assert "error" in result.response


def test_process_inline_method_success_returns_completion() -> None:
    container = _container_with_engine("completed()")
    result = process_inline_method(
        "inline.complete",
        1,
        {
            "accept_version": API_VERSION,
            "prefix": "a",
            "suffix": "b",
            "model": "qwen2.5-coder:1.5b-base",
        },
        True,
        container,
        LOG,
    )
    assert result is not None
    assert result.response["result"]["completion"] == "completed()"
    assert result.response["result"]["compute_target"] == "automatic"
    assert result.response["result"]["compute_reason"] == "ollama_runtime_resource_policy"


def test_process_inline_method_no_model_yields_empty_completion() -> None:
    container = _container_with_engine("x")
    result = process_inline_method(
        "inline.complete",
        1,
        {"accept_version": API_VERSION, "prefix": "a"},
        True,
        container,
        LOG,
    )
    assert result.response["result"]["completion"] == ""


# ---------------------------------------------------------------------------
# loaded-model status + unload-by-tag (inline.loaded_models / inline.unload)
# ---------------------------------------------------------------------------


def test_list_loaded_inline_models_returns_names(monkeypatch) -> None:  # noqa: ANN001
    engine = SimpleNamespace(
        list_loaded_models=lambda: [
            {"name": "qwen2.5-coder:1.5b-base", "expires_at": "soon"},
            {"name": "gemma4:12b"},
        ]
    )
    monkeypatch.setattr(inline_mod, "_build_ollama_fallback_engine", lambda: engine)
    assert list_loaded_inline_models(LOG) == ["qwen2.5-coder:1.5b-base", "gemma4:12b"]


def test_list_loaded_inline_models_degrades_to_empty_on_failure(monkeypatch) -> None:  # noqa: ANN001
    def _raise():
        raise RuntimeError("daemon down")

    monkeypatch.setattr(
        inline_mod, "_build_ollama_fallback_engine",
        lambda: SimpleNamespace(list_loaded_models=_raise),
    )
    assert list_loaded_inline_models(LOG) == []


def test_unload_inline_model_calls_engine_with_tag(monkeypatch) -> None:  # noqa: ANN001
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        inline_mod, "_build_ollama_fallback_engine",
        lambda: SimpleNamespace(unload_model=lambda tag: captured.update(tag=tag)),
    )
    assert unload_inline_model("qwen2.5-coder:1.5b-base", LOG) is True
    assert captured["tag"] == "qwen2.5-coder:1.5b-base"


def test_unload_inline_model_empty_tag_is_noop(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(
        inline_mod, "_build_ollama_fallback_engine",
        lambda: SimpleNamespace(unload_model=lambda tag: None),
    )
    assert unload_inline_model("", LOG) is False


def test_process_inline_method_loaded_models(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(dispatch_mod, "list_loaded_inline_models", lambda logger: ["a:b"])
    result = process_inline_method(
        INLINE_LOADED_MODELS_METHOD, 1, {"accept_version": API_VERSION}, True, MagicMock(), LOG
    )
    assert result is not None
    assert result.response["result"]["loaded"] == ["a:b"]


def test_process_inline_method_unload(monkeypatch) -> None:  # noqa: ANN001
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        dispatch_mod, "unload_inline_model",
        lambda model, logger: captured.update(model=model) or True,
    )
    result = process_inline_method(
        INLINE_UNLOAD_METHOD,
        1,
        {"accept_version": API_VERSION, "model": "qwen2.5-coder:1.5b-base"},
        True,
        MagicMock(),
        LOG,
    )
    assert result is not None
    assert result.response["result"]["ok"] is True
    assert captured["model"] == "qwen2.5-coder:1.5b-base"
