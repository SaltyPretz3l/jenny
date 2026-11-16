"""The optional per-request ``model_profile`` of ``chat.send``.

A caller may bound one request's context length and name the model the
openai-compatible engine detects its chat contract from. The bound is never above
the engine's loaded value, a malformed member is dropped on its own, concurrent
requests through one engine each see only their own profile, and the engine's
loaded state never changes.
"""

from __future__ import annotations

import contextlib
import threading
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.token_budget import (
    apply_budget_check,
    check_budget,
    resolve_context_window_hint,
    resolve_effective_context_window,
)
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.request_model_profile import (
    ModelProfile,
    bind_model_profile,
    current_model_profile,
    parse_model_profile,
)
from tests.sidecar.ai.engines import openai_compatible_stub as stub_harness

LOADED = 131_072
ALIAS = "pool-alias"
QWEN = "Qwen3.8-27B-Instruct-Q4_K_M"


@pytest.fixture
def engine() -> Any:
    built = OpenAICompatibleEngine(
        host="http://127.0.0.1:8033/v1", configured_context_length=LOADED
    )
    built.model_name = ALIAS
    built._context_length = LOADED
    yield built
    with contextlib.suppress(Exception):
        built.close()


# -- the holder ---------------------------------------------------------------


def test_bind_sets_resets_and_restores_the_outer_profile() -> None:
    assert current_model_profile() is None
    with bind_model_profile({"context_length": 32_768, "name": QWEN}):
        assert current_model_profile() == ModelProfile(32_768, QWEN)
        with bind_model_profile({"context_length": 8_192}):
            assert current_model_profile() == ModelProfile(8_192, None)
        assert current_model_profile() == ModelProfile(32_768, QWEN)
    assert current_model_profile() is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        ("32768", None),
        (["context_length", 32_768], None),
        ({}, None),
        ({"context_length": "32768"}, None),
        ({"context_length": 0}, None),
        ({"context_length": -4_096}, None),
        ({"context_length": 2_047}, None),
        ({"context_length": 1_048_577}, None),
        ({"context_length": True}, None),
        ({"context_length": 32_768.0}, None),
        ({"name": "bad\x07name"}, None),
        ({"name": "m" * 129}, None),
        ({"name": " padded"}, None),
        ({"name": ""}, None),
        ({"name": 42}, None),
        ({"context_length": 2_048}, ModelProfile(2_048, None)),
        ({"context_length": 1_048_576}, ModelProfile(1_048_576, None)),
        ({"name": "m" * 128}, ModelProfile(None, "m" * 128)),
        # Member by member: a bad length keeps a good name and the reverse.
        ({"context_length": "x", "name": QWEN}, ModelProfile(None, QWEN)),
        ({"context_length": 16_384, "name": "bad\nname"}, ModelProfile(16_384, None)),
        ({"context_length": 16_384, "extra": 1}, ModelProfile(16_384, None)),
    ],
)
def test_malformed_members_are_dropped_one_by_one(value: Any, expected: Any) -> None:
    assert parse_model_profile(value) == expected


# -- the bound ----------------------------------------------------------------


def test_the_bound_lowers_every_getter_and_never_raises_them(engine: Any) -> None:
    assert resolve_context_window_hint(engine) == LOADED
    with bind_model_profile({"context_length": 32_768}):
        assert engine.get_model_context_length() == 32_768
        assert engine.get_configured_context_length() == 32_768
        assert resolve_context_window_hint(engine) == 32_768
    with bind_model_profile({"context_length": 262_144}):
        assert resolve_context_window_hint(engine) == LOADED
        assert engine.get_configured_context_length() == LOADED
    assert engine.get_model_context_length() == LOADED
    assert engine._context_length == LOADED and engine._configured_context_length == LOADED


def test_with_no_loaded_length_the_bound_alone_is_used() -> None:
    bare = OpenAICompatibleEngine(host="http://127.0.0.1:8033/v1")
    try:
        assert resolve_context_window_hint(bare) is None
        with bind_model_profile({"context_length": 65_536}):
            assert resolve_context_window_hint(bare) == 65_536
    finally:
        bare.close()


def test_a_malformed_profile_runs_the_turn_as_with_none(engine: Any) -> None:
    for value in ({"context_length": "32768", "name": "a\x00b"}, "x", 7, [32_768]):
        with bind_model_profile(value):
            assert resolve_context_window_hint(engine) == LOADED
            payload = engine._build_payload(**_payload_args())
            assert "chat_template_kwargs" not in payload


def test_two_concurrent_conversations_are_each_sized_and_compacted_at_their_own_length(
    engine: Any,
) -> None:
    """The named 4f test: one engine instance, two models, two threads at once."""
    config = RuntimeConfig()
    # About 40k tokens of history: past the compact point of a 32k window, far
    # below a 128k one.
    messages = [{"role": "user", "content": "word " * 32_000}]
    barrier = threading.Barrier(2, timeout=10)
    results: dict[str, dict[str, Any]] = {}
    errors: list[BaseException] = []

    def conversation(label: str, length: int) -> None:
        try:
            with bind_model_profile({"context_length": length, "name": f"model-{label}"}):
                barrier.wait()  # both bound at once before either reads
                window = resolve_effective_context_window(engine, config)
                _, budget, tracker = apply_budget_check(messages, config, engine)
                assert budget is not None and tracker is not None
                status = check_budget(tracker.backend.count_tokens(messages[0]["content"]), budget)
                barrier.wait()  # both read before either unbinds
                fit_payload = {"messages": messages, "max_tokens": 200_000}
                fitted = engine._fit_output_to_window(fit_payload)
                results[label] = {
                    "window": window,
                    "raw": tracker.snapshot().get("raw_context_window", window),
                    "compact": status.should_compact,
                    "threshold": budget.auto_compact_threshold(),
                    "fitted": fitted,
                    "profile": current_model_profile(),
                }
        except BaseException as error:  # noqa: BLE001 - surfaced below
            errors.append(error)

    threads = [
        threading.Thread(target=conversation, args=("small", 32_768)),
        threading.Thread(target=conversation, args=("large", 131_072)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not errors, errors
    small, large = results["small"], results["large"]
    assert small["window"] == 32_768 and large["window"] == LOADED
    assert small["profile"] == ModelProfile(32_768, "model-small")
    assert large["profile"] == ModelProfile(131_072, "model-large")
    assert small["compact"] is True and large["compact"] is False
    assert small["threshold"] < 32_768 < large["threshold"]
    assert small["fitted"] < 32_768 <= large["fitted"]
    # After both finish, nothing of either stayed on the engine.
    assert current_model_profile() is None
    assert engine.get_model_context_length() == LOADED
    assert engine.get_configured_context_length() == LOADED
    assert engine.model_name == ALIAS


# -- the name -----------------------------------------------------------------


def _payload_args(**overrides: Any) -> dict[str, Any]:
    args: dict[str, Any] = {
        "prompt": "hi",
        "max_tokens": 1_024,
        "temperature": 0.7,
        "reasoning_effort": "high",
        "prompt_cache_enabled": False,
        "system": "",
        "messages": [{"role": "user", "content": "hi"}],
        "response_format": None,
    }
    args.update(overrides)
    return args


def test_a_named_qwen38_model_gets_its_contract_under_an_alias(engine: Any) -> None:
    engine.set_profile_output_limits(max_output_tokens=4_096, thinking_headroom=8_192)
    direct = OpenAICompatibleEngine(
        host="http://127.0.0.1:8033/v1", configured_context_length=LOADED
    )
    try:
        direct.model_name = QWEN
        direct.set_profile_output_limits(max_output_tokens=4_096, thinking_headroom=8_192)
        expected = direct._build_payload(**_payload_args())
        expected_reservation = direct.get_request_output_reservation("high")
        # A direct load detects thinking from the name (load_model sets _thinking).
        expected_thinking = direct._detect_thinking(QWEN)
    finally:
        direct.close()
    assert "chat_template_kwargs" not in engine._build_payload(**_payload_args())
    assert engine.get_request_output_reservation("high") == 4_096
    assert engine.capabilities["thinking"] is False
    with bind_model_profile({"name": QWEN}):
        payload = engine._build_payload(**_payload_args())
        assert engine.get_request_output_reservation("high") == expected_reservation == 12_288
        assert engine.capabilities["thinking"] is expected_thinking is True
        assert engine._reasoning_output_enabled() is True
    assert payload["chat_template_kwargs"] == expected["chat_template_kwargs"]
    assert payload["chat_template_kwargs"]["enable_thinking"] is True
    for key in ("reasoning_effort", "max_tokens", "temperature", "top_k", "top_p", "min_p"):
        assert payload.get(key) == expected.get(key), key
    # The upstream request still names the loaded alias.
    assert payload["model"] == ALIAS
    assert engine.model_name == ALIAS
    assert engine.capabilities["thinking"] is False


def test_an_engine_outside_the_openai_compatible_family_ignores_the_profile() -> None:
    ollama = OllamaEngine(host="http://127.0.0.1:11434")
    ollama._context_length = 65_536
    ollama.model_name = "llama3"
    before = (ollama.get_model_context_length(), resolve_context_window_hint(ollama))
    with bind_model_profile({"context_length": 4_096, "name": QWEN}):
        assert (ollama.get_model_context_length(), resolve_context_window_hint(ollama)) == before
        assert ollama.model_name == "llama3"


# -- the known limit, pinned --------------------------------------------------


def test_fixed_rows_past_a_small_bound_end_the_turn_with_the_overflow_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """4f known limit: context rows sized for a larger window, sent on a small bound.

    The real dispatch path with the budget flags on, against a loopback stub. A
    block that fits the loaded 8K window completes; under a 2K profile the same turn
    ends with the existing overflow refusal before any completion call, so nothing
    goes upstream past the window and nothing is replayed.
    """
    real_config = stub_harness.RuntimeConfig

    def with_budget(**kwargs: Any) -> RuntimeConfig:
        flags = {
            **kwargs.pop("feature_flags", {}),
            "token_budget": True,
            "context_compaction": True,
        }
        return real_config(**kwargs, feature_flags=flags)

    monkeypatch.setattr(stub_harness, "RuntimeConfig", with_budget)
    blocks = [{"kind": "active_file", "content": "word " * 1_600}]
    results: dict[str, tuple[dict[str, Any], int]] = {}
    for label, profile in (("loaded", None), ("small", {"context_length": 2_048})):
        with stub_harness.StubServer() as stub:
            built = OpenAICompatibleEngine(host=stub.base_url, configured_context_length=8_192)
            try:
                built.load_model(stub_harness.MODEL_ID)
                extra: dict[str, Any] = {"context_blocks": blocks}
                if profile is not None:
                    extra["model_profile"] = profile
                outcome, _messages = stub_harness.chat_send(built, extra)
                results[label] = (outcome.response["result"], len(stub.completion_headers()))
            finally:
                built.close()
    loaded, loaded_calls = results["loaded"]
    assert loaded["status"] == "completed" and loaded_calls == 1
    small, small_calls = results["small"]
    assert small["status"] == "runtime_error"
    assert small["completion_source"] == "context_budget_terminal"
    assert small_calls == 0, "nothing sent upstream past the window, and no replay"


def test_the_completion_call_reads_the_profile_on_its_own_worker_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real dispatch path streams on a reader thread started with copy_context()."""
    seen: list[tuple[str, Any, int | None]] = []
    real_fit = OpenAICompatibleEngine._fit_output_to_window

    def recording_fit(self: OpenAICompatibleEngine, payload: dict[str, Any]) -> int:
        seen.append(
            (
                threading.current_thread().name,
                current_model_profile(),
                self.get_configured_context_length(),
            )
        )
        return real_fit(self, payload)

    monkeypatch.setattr(OpenAICompatibleEngine, "_fit_output_to_window", recording_fit)
    with stub_harness.StubServer() as stub:
        built = OpenAICompatibleEngine(host=stub.base_url, configured_context_length=8_192)
        try:
            built.load_model(stub_harness.MODEL_ID)
            outcome, _messages = stub_harness.chat_send(
                built, {"model_profile": {"context_length": 4_096, "name": QWEN}}
            )
        finally:
            built.close()
    assert outcome.response["result"]["status"] == "completed"
    assert seen, "the completion call ran"
    for thread_name, profile, window in seen:
        assert thread_name != threading.main_thread().name
        assert profile == ModelProfile(4_096, QWEN)
        assert window == 4_096
    assert current_model_profile() is None
