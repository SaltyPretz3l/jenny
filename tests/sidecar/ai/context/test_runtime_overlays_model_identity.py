"""Unit coverage for the ``## Runtime Model Identity`` overlay.

Mirrors the section A/B split used for the repository-delta overlay in
``tests/sidecar/runtime/test_chat_repo_delta.py``: heading registration first
(load-bearing -- it is what lets ``ContextBuilder.is_runtime_system_message``
recognize the block so it gets replaced instead of duplicated turn over
turn), then the ``append_model_identity_runtime_system_message`` behavior
itself (normal case, flag off, missing fields, exception fail-closed).

The block is built per-request (see ``sidecar/ai/routing/chat_decision.py``)
from the same config fields ``build_model_identity_fingerprint``
(``sidecar/runtime/approval_plan.py``) hashes, so it always reflects the
engine/model actually serving the CURRENT request rather than a boot-time
snapshot.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from sidecar.ai.context import runtime_message_markers
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    append_model_identity_runtime_system_message,
)

# ===========================================================================
# A. Heading registration (load-bearing)
# ===========================================================================


def test_model_identity_heading_constant_value() -> None:
    assert runtime_message_markers.MODEL_IDENTITY_HEADING == "## Runtime Model Identity"


def test_model_identity_heading_registered_in_runtime_message_markers() -> None:
    assert (
        runtime_message_markers.MODEL_IDENTITY_HEADING
        in runtime_message_markers.RUNTIME_SYSTEM_MESSAGE_HEADINGS
    )


def test_is_runtime_system_message_recognizes_model_identity_block() -> None:
    content = (
        "## Runtime Model Identity\n"
        "provider: ollama | model: qwen3.6-35b | tier: local\n"
        "This is the authoritative identity ..."
    )
    assert ContextBuilder.is_runtime_system_message(content) is True


# ===========================================================================
# B. append_model_identity_runtime_system_message
# ===========================================================================


def _log_context(*, request_id: str = "req-identity-test") -> RuntimeOverlayLogContext:
    return RuntimeOverlayLogContext(
        logger=logging.getLogger("sidecar.ai.context.model_identity_overlay_test"),
        component="ai.router",
        event="ai.router.model_identity_overlay_failed",
        request_id=request_id,
        session_id="session-identity-test",
    )


def test_append_model_identity_appends_block_with_configured_values() -> None:
    config = SimpleNamespace(
        model_identity_overlay_enabled=True,
        engine_type="ollama",
        model="qwen3.6-35b",
    )
    runtime_system_messages: list[str] = []

    append_model_identity_runtime_system_message(
        runtime_system_messages,
        config=config,
        log_context=_log_context(),
    )

    assert len(runtime_system_messages) == 1
    block = runtime_system_messages[0]
    assert block.startswith("## Runtime Model Identity")
    assert "provider: ollama" in block
    assert "model: qwen3.6-35b" in block


def test_append_model_identity_ignores_model_tier_attribute_if_present() -> None:
    # `model_tier` is not a RuntimeConfig field anywhere (config_models.py /
    # config.py); the overlay must not read it even when a stray config
    # stand-in happens to carry one -- the tier facet was removed entirely,
    # not merely hidden when absent.
    config = SimpleNamespace(
        model_identity_overlay_enabled=True,
        engine_type="ollama",
        model="qwen3.6-35b",
        model_tier="local",
    )
    runtime_system_messages: list[str] = []

    append_model_identity_runtime_system_message(
        runtime_system_messages,
        config=config,
        log_context=_log_context(),
    )

    assert len(runtime_system_messages) == 1
    assert "provider: ollama" in runtime_system_messages[0]
    assert "tier:" not in runtime_system_messages[0]
    assert "local" not in runtime_system_messages[0]


def test_append_model_identity_collapses_whitespace_and_caps_field_length() -> None:
    # Security hardening: config-sourced fields are stripped but were not
    # previously length-capped or whitespace-collapsed.
    oversized_model = ("qwen3.6-35b\nline2 " * 30).strip()
    assert len(oversized_model) > 120
    config = SimpleNamespace(
        model_identity_overlay_enabled=True,
        engine_type="oll\nama",
        model=oversized_model,
    )
    runtime_system_messages: list[str] = []

    append_model_identity_runtime_system_message(
        runtime_system_messages,
        config=config,
        log_context=_log_context(),
    )

    assert len(runtime_system_messages) == 1
    block = runtime_system_messages[0]
    facts_line = block.splitlines()[1]
    assert "\n" not in facts_line
    provider_field, model_field = (part.strip() for part in facts_line.split("|"))
    assert provider_field == "provider: oll ama"
    assert model_field.startswith("model: qwen3.6-35b line2 qwen3.6-35b")
    assert len(model_field) <= len("model: ") + 120


def test_append_model_identity_flag_off_appends_nothing() -> None:
    config = SimpleNamespace(
        model_identity_overlay_enabled=False,
        engine_type="ollama",
        model="qwen3.6-35b",
    )
    runtime_system_messages: list[str] = []

    append_model_identity_runtime_system_message(
        runtime_system_messages,
        config=config,
        log_context=_log_context(),
    )

    assert runtime_system_messages == []


def test_append_model_identity_flag_defaults_on_when_attribute_absent() -> None:
    """A config stand-in with no ``model_identity_overlay_enabled`` attribute at
    all (e.g. an older/partial fake) must still render -- fail-closed on the
    render, not on the flag lookup, matches the "default on" project
    convention."""
    config = SimpleNamespace(engine_type="ollama", model="qwen3.6-35b")
    runtime_system_messages: list[str] = []

    append_model_identity_runtime_system_message(
        runtime_system_messages,
        config=config,
        log_context=_log_context(),
    )

    assert len(runtime_system_messages) == 1


@pytest.mark.parametrize(
    "engine_type,model",
    [("", ""), (None, None)],
)
def test_append_model_identity_missing_provider_and_model_appends_nothing(
    engine_type: str | None, model: str | None
) -> None:
    """Fail-closed: nothing worth asserting when both provider and model are
    blank -- must not crash prompt assembly and must not emit an empty/
    near-empty block."""
    config = SimpleNamespace(
        model_identity_overlay_enabled=True,
        engine_type=engine_type,
        model=model,
    )
    runtime_system_messages: list[str] = []

    append_model_identity_runtime_system_message(
        runtime_system_messages,
        config=config,
        log_context=_log_context(),
    )

    assert runtime_system_messages == []


def test_append_model_identity_missing_config_object_is_fail_closed_and_logs_counts_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A config whose attribute access raises must degrade to a no-op, never
    crash prompt assembly, and log a counts-only warning (no raw values)."""

    class _BoomConfig:
        model_identity_overlay_enabled = True

        @property
        def engine_type(self) -> str:
            raise RuntimeError("config exploded")

    runtime_system_messages: list[str] = []
    log_ctx = _log_context(request_id="req-identity-boom")

    with caplog.at_level(
        logging.WARNING, logger="sidecar.ai.context.model_identity_overlay_test"
    ):
        append_model_identity_runtime_system_message(
            runtime_system_messages,
            config=_BoomConfig(),
            log_context=log_ctx,
        )

    assert runtime_system_messages == []
    matching = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.router.model_identity_overlay_failed"
    ]
    assert len(matching) == 1, "expected exactly one counts-only WARNING on overlay failure"
    assert matching[0].data == {"error_type": "RuntimeError"}  # type: ignore[attr-defined]
