"""Shared-daemon residency refcounting for the Ollama engine (F5 / F5a).

``OllamaEngine`` is a stateless REST client. The Ollama DAEMON owns the loaded
weights, and the ``(endpoint, model, num_ctx)`` runner is SHARED by every engine
instance pointed at that daemon. Before this change, all three dispose paths --
``_close_replaced_stack``, ``_close_candidate_engine`` and the router's
``_close_fallback_engine`` -- posted ``keep_alive: 0`` UNCONDITIONALLY, so a
stack reconfigure that rebound the SAME model threw away the weights the
successor generation had just warmed. The next turn paid a full cold load with
no diagnostic, which reads as a hang.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.ollama_residency import (
    claim_residency,
    release_residency,
    residency_key,
    residency_registry,
)


@pytest.fixture(autouse=True)
def _clean_registry():
    residency_registry().reset()
    yield
    residency_registry().reset()


def _engine(*, model: str = "qwen3.5:9b", num_ctx: int | None = 32768) -> OllamaEngine:
    engine = OllamaEngine(host="http://localhost:11434")
    engine.model_name = model
    engine.set_configured_context_length(num_ctx)
    engine._claim_residency()  # noqa: SLF001 -- load_model's claim point.
    return engine


def _record_posts(engine: OllamaEngine, sink: list[dict[str, Any]]) -> None:
    def _post(endpoint: str, data: dict[str, Any], timeout: float = 0) -> dict[str, Any]:
        sink.append({"endpoint": endpoint, "data": data})
        return {"done": True}

    engine._post = _post  # type: ignore[method-assign]  # noqa: SLF001


# ---------------------------------------------------------------------------
# Registry primitives
# ---------------------------------------------------------------------------


class TestRegistryPrimitives:
    def test_key_includes_num_ctx_so_a_context_change_is_a_different_runner(self) -> None:
        # Ollama spins a distinct runner per n_ctx, so a (host, model) pair key
        # would over-retain across a context-length change.
        assert residency_key("h", "m", 8192) != residency_key("h", "m", 16384)

    def test_blank_model_is_unkeyable(self) -> None:
        assert residency_key("h", "  ", 4096) is None

    def test_release_of_last_claim_reports_true_and_pops_the_entry(self) -> None:
        key = claim_residency("h", "m", 4096)
        assert key is not None
        assert release_residency(key) is True
        assert residency_registry().snapshot() == {}, "entries must pop at zero"

    def test_release_of_a_non_last_claim_reports_false(self) -> None:
        key = claim_residency("h", "m", 4096)
        claim_residency("h", "m", 4096)
        assert release_residency(key) is False
        assert residency_registry().count(key) == 1  # type: ignore[arg-type]

    def test_release_of_an_untracked_key_reports_true(self) -> None:
        # Unknown -> evict, so an engine that never claimed keeps the exact
        # pre-refcount behavior.
        assert release_residency(residency_key("h", "never-claimed", 0)) is True

    def test_release_of_none_reports_true(self) -> None:
        assert release_residency(None) is True


# ---------------------------------------------------------------------------
# Engine dispose semantics
# ---------------------------------------------------------------------------


class TestEngineDispose:
    def test_two_generations_on_the_same_model_do_not_evict_on_the_first_close(
        self,
    ) -> None:
        """The regression: reconfigure to the SAME model, then retire the old stack.

        Before the fix, the retiring engine's ``unload_model()`` posted
        ``keep_alive: 0`` and evicted the runner the successor had just warmed.
        """
        previous = _engine()
        successor = _engine()
        previous_posts: list[dict[str, Any]] = []
        successor_posts: list[dict[str, Any]] = []
        _record_posts(previous, previous_posts)
        _record_posts(successor, successor_posts)

        previous.unload_model()

        assert previous_posts == [], "the successor still holds this runner"
        assert previous.model_name is None, "instance state is still torn down"
        assert previous._ready is False  # noqa: SLF001

        successor.unload_model()

        assert len(successor_posts) == 1
        assert successor_posts[0]["endpoint"] == "/api/generate"
        assert successor_posts[0]["data"]["keep_alive"] == 0

    def test_a_different_model_still_evicts_on_close(self) -> None:
        previous = _engine(model="qwen3.5:9b")
        _engine(model="gemma3:12b")
        posts: list[dict[str, Any]] = []
        _record_posts(previous, posts)

        previous.unload_model()

        assert len(posts) == 1
        assert posts[0]["data"]["model"] == "qwen3.5:9b"

    def test_a_different_context_length_still_evicts_on_close(self) -> None:
        # Same model tag, different n_ctx -> different Ollama runner, so the
        # sibling's claim must NOT suppress this eviction.
        previous = _engine(num_ctx=8192)
        _engine(num_ctx=32768)
        posts: list[dict[str, Any]] = []
        _record_posts(previous, posts)

        previous.unload_model()

        assert len(posts) == 1

    def test_reconfiguring_the_context_length_rekeys_a_live_claim(self) -> None:
        engine = _engine(num_ctx=8192)
        engine.set_configured_context_length(32768)
        posts: list[dict[str, Any]] = []
        _record_posts(engine, posts)

        engine.unload_model()

        assert len(posts) == 1, "the re-keyed claim must still release cleanly"
        assert residency_registry().snapshot() == {}

    def test_explicit_tag_bypasses_the_refcount(self) -> None:
        """F5a: an operator/shutdown unload is an INTENTIONAL eviction.

        ``models.unload`` passes the tag explicitly so a sibling generation's
        claim can never suppress a user-visible eviction.
        """
        engine = _engine()
        _engine()  # a second holder of the same triple
        posts: list[dict[str, Any]] = []
        _record_posts(engine, posts)

        engine.unload_model("qwen3.5:9b")

        assert len(posts) == 1
        assert posts[0]["data"]["keep_alive"] == 0
        assert residency_registry().snapshot() == {}, (
            "the runner really went away, so no stale count may survive"
        )

    def test_engine_that_never_claimed_still_evicts(self) -> None:
        engine = OllamaEngine(host="http://localhost:11434")
        engine.model_name = "unclaimed:latest"
        posts: list[dict[str, Any]] = []
        _record_posts(engine, posts)

        engine.unload_model()

        assert len(posts) == 1

    def test_a_foreign_tag_still_evicts_without_touching_this_engine_state(self) -> None:
        engine = _engine()
        posts: list[dict[str, Any]] = []
        _record_posts(engine, posts)

        engine.unload_model("qwen2.5-coder:1.5b-base")

        assert posts[0]["data"]["model"] == "qwen2.5-coder:1.5b-base"
        assert engine.model_name == "qwen3.5:9b", "a foreign tag is not this engine's state"
