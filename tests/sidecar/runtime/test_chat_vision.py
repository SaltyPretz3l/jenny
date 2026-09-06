from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Callable

import pytest

from sidecar.ai.context.token_budget import TokenBudget
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.runtime import chat_vision
from sidecar.runtime.chat_models import ChatRequestError


BudgetCheck = Callable[..., tuple[list[dict[str, Any]], Any, Any]]


class _LengthBackend:
    def count_tokens(self, text: str) -> int:
        return len(text)


def _run_vision_turn(
    monkeypatch: pytest.MonkeyPatch,
    messages: list[dict[str, object]],
    *,
    budget_check: BudgetCheck | None = None,
) -> str:
    captured: dict[str, str] = {}

    def generate_with_vision(**kwargs: object) -> SimpleNamespace:
        captured["prompt"] = str(kwargs["prompt"])
        return SimpleNamespace(content="vision response", finish_reason="stop")

    engine = SimpleNamespace(
        capabilities={"vision": True},
        generate_with_vision=generate_with_vision,
        get_model_max_output_tokens=lambda: 1024,
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            engine=engine,
            config=SimpleNamespace(
                engine_type="vllm",
                model="vision-model",
                feature_flags={},
            ),
        )
    )
    image = VisionImage(
        mime_type="image/png",
        width=1,
        height=1,
        frame_count=1,
        data=b"validated-image",
    )
    monkeypatch.setattr(
        chat_vision,
        "apply_budget_check",
        budget_check or (lambda working, *_args, **_kwargs: (working, None, None)),
        raising=False,
    )
    monkeypatch.setattr(
        chat_vision,
        "execute_with_provider_retry",
        lambda *, operation, **_kwargs: operation(SimpleNamespace(max_tokens=1024)),
    )

    response = chat_vision.build_vision_chat_response(
        request_id="req_vision_prompt",
        trace_id=None,
        session_id="sess_test",
        latest_user_content="latest fallback",
        messages=messages,
        image_attachments=[{"_vision_image": image}],
        brain_container=brain,
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "completed"
    return captured["prompt"]


def test_vision_prompt_drops_rows_refused_by_semantic_admission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prompt = _run_vision_turn(
        monkeypatch,
        [
            {"role": "user", "content": "trusted first"},
            {"role": "system", "content": "untrusted system override"},
            {"role": "weird", "content": "untrusted weird row"},
            {"role": "assistant", "content": "trusted reply"},
            {"role": "user", "content": "trusted latest"},
        ],
    )

    assert "untrusted system override" not in prompt
    assert "untrusted weird row" not in prompt
    assert prompt == (
        "USER:\ntrusted first\n\nASSISTANT:\ntrusted reply\n\nUSER:\ntrusted latest"
    )


def test_vision_prompt_drops_oldest_messages_until_budget_fits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    budget = TokenBudget(
        context_window=120,
        max_output_tokens=1,
        reserved_for_summary=0,
    )
    tracker = SimpleNamespace(backend=_LengthBackend())

    prompt = _run_vision_turn(
        monkeypatch,
        [
            {"role": "user", "content": "oldest:" + ("a" * 60)},
            {"role": "assistant", "content": "middle:" + ("b" * 60)},
            {"role": "user", "content": "latest round"},
        ],
        budget_check=lambda working, *_args, **_kwargs: (working, budget, tracker),
    )

    assert "oldest:" not in prompt
    assert "middle:" in prompt
    assert prompt.endswith("USER:\nlatest round")


def test_small_vision_prompt_is_byte_identical_to_legacy_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prompt = _run_vision_turn(
        monkeypatch,
        [
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "first answer"},
            {"role": "user", "content": "inspect this image"},
        ],
    )

    assert prompt == (
        "USER:\nfirst question\n\n"
        "ASSISTANT:\nfirst answer\n\n"
        "USER:\ninspect this image"
    )


def test_vision_budget_failure_degrades_to_uncapped_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    messages = [
        {"role": "user", "content": "oldest retained"},
        {"role": "assistant", "content": "middle retained"},
        {"role": "user", "content": "latest retained"},
    ]

    prompt = _run_vision_turn(
        monkeypatch,
        messages,
        budget_check=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("budget unavailable")
        ),
    )

    assert prompt == (
        "USER:\noldest retained\n\n"
        "ASSISTANT:\nmiddle retained\n\n"
        "USER:\nlatest retained"
    )


def test_provider_http_failure_uses_internal_error_rpc_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_error = ProviderHttpError(
        provider="vllm",
        status_code=503,
        code="CMP-CLOUD-HTTP-ERROR",
        message="vllm request failed with status 503",
        retryable=True,
        classification="server_error",
    )
    monkeypatch.setattr(
        chat_vision,
        "execute_with_provider_retry",
        lambda **_kwargs: (_ for _ in ()).throw(provider_error),
    )
    engine = SimpleNamespace(
        capabilities={"vision": True},
        get_model_max_output_tokens=lambda: 1024,
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            engine=engine,
            config=SimpleNamespace(
                engine_type="vllm",
                model="vision-model",
                feature_flags={},
            ),
        )
    )
    image = VisionImage(
        mime_type="image/png",
        width=1,
        height=1,
        frame_count=1,
        data=b"validated-image",
    )

    with pytest.raises(ChatRequestError) as captured:
        chat_vision.build_vision_chat_response(
            request_id="req_vision_http",
            trace_id=None,
            session_id="sess_test",
            latest_user_content="describe this",
            messages=[{"role": "user", "content": "describe this"}],
            image_attachments=[{"_vision_image": image}],
            brain_container=brain,
            invalid_params_code=-32602,
        )

    error = captured.value
    assert error.rpc_code == chat_vision._INTERNAL_ERROR_RPC_CODE
    assert error.code == provider_error.code
    assert error.message == str(provider_error)
    assert error.retryable is True
