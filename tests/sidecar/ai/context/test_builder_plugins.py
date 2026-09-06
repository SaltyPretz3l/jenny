from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.builder_plugins import (
    DEFAULT_GLOBAL_BYTE_CAP,
    MAX_ITEM_CONTENT_SAFETY_BYTES,
    PluginContextItem,
    assemble_plugin_context_budget,
    build_plugin_system_overlays,
    truncate_utf8_to_budget,
)
from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages


def _item(
    contribution_id: str,
    content: str,
    *,
    publisher_id: str = "jenny-official",
    plugin_id: str = "starter",
    kind: str = "skill",
) -> PluginContextItem:
    return PluginContextItem(
        publisher_id=publisher_id,
        plugin_id=plugin_id,
        contribution_id=contribution_id,
        kind=kind,
        content_digest="a" * 64,
        content=content,
    )


def test_budget_matches_frozen_item_plugin_global_and_unicode_semantics() -> None:
    items = (_item("one", "01234567"), _item("two", "01234567"))
    assembly = assemble_plugin_context_budget(
        items,
        per_plugin_byte_cap=10,
        global_byte_cap=100,
    )
    assert [item.content for item in assembly.surviving_items] == ["01234567", "01"]
    assert [item.outcome for item in assembly.diagnostics] == ["included", "truncated"]
    assert truncate_utf8_to_budget("a€", 2) == "a"

    oversized = _item("large", "x" * (MAX_ITEM_CONTENT_SAFETY_BYTES + 1))
    excluded = assemble_plugin_context_budget((oversized,))
    assert excluded.diagnostics[0].outcome == "excluded_content_too_large"

    many = tuple(
        _item(str(index), "x" * MAX_ITEM_CONTENT_SAFETY_BYTES, plugin_id=f"p-{index}")
        for index in range(5)
    )
    bounded = assemble_plugin_context_budget(
        many,
        per_plugin_byte_cap=10**9,
        global_byte_cap=10**9,
    )
    assert bounded.total_bytes_included == DEFAULT_GLOBAL_BYTE_CAP


def test_multibyte_truncation_charges_only_retained_bytes() -> None:
    assembly = assemble_plugin_context_budget(
        (_item("one", "\u20ac"), _item("two", "a")),
        per_plugin_byte_cap=1,
        global_byte_cap=1,
    )

    assert [item.content for item in assembly.surviving_items] == ["a"]
    assert [item.bytes_included for item in assembly.surviving_items] == [1]
    assert [
        (diagnostic.contribution_id, diagnostic.outcome, diagnostic.bytes_included)
        for diagnostic in assembly.diagnostics
    ] == [("one", "truncated", 0), ("two", "included", 1)]
    assert assembly.total_bytes_included == 1


def test_overlays_preserve_verbatim_content_and_diagnostics_are_redacted() -> None:
    authored = "  retain leading\n${not_interpolated}\nretain trailing  "
    overlays, diagnostics = build_plugin_system_overlays((_item("main", authored),))
    assert authored in overlays[0]
    assert "<plugin-content>\n" + authored + "\n</plugin-content>" in overlays[0]
    assert diagnostics[0].content_digest == "a" * 64
    assert not hasattr(diagnostics[0], "content")


def test_context_builder_delegation_is_lazy_and_failure_aborts_instead_of_omitting() -> None:
    calls: list[str] = []
    default_builder = ContextBuilder(None)
    assert default_builder.build_delegated_runtime_system_messages() == ()

    builder = ContextBuilder(
        None,
        runtime_overlay_provider=lambda: calls.append("called") or ("plugin overlay",),
    )
    assert calls == []
    assert builder.build_delegated_runtime_system_messages() == ("plugin overlay",)
    assert calls == ["called"]

    failed = ContextBuilder(
        None,
        runtime_overlay_provider=lambda: (_ for _ in ()).throw(RuntimeError("secret")),
    )
    try:
        failed.build_delegated_runtime_system_messages()
    except RuntimeError as error:
        assert str(error) == "secret"
    else:
        raise AssertionError("provider failure was silently omitted")


def test_dynamic_overlays_accept_legacy_builder_without_plugin_delegation() -> None:
    class LegacyContextBuilder:
        @staticmethod
        def build_skills_system_message(*, tool_statuses=None) -> str:
            del tool_statuses
            return "legacy skills"

    messages = build_dynamic_system_messages(
        context_builder=LegacyContextBuilder(),  # type: ignore[arg-type]
        config=SimpleNamespace(assistant_name=None),
    )

    assert {"role": "system", "content": "legacy skills"} in messages
    assert messages[0]["content"].startswith("## Personality\nYour name is Jenny.")


def test_chatgpt_minimal_profile_skips_personality_but_keeps_skills_overlay() -> None:
    class LegacyContextBuilder:
        @staticmethod
        def build_skills_system_message(*, tool_statuses=None) -> str:
            del tool_statuses
            return "minimal-profile skills"

    messages = build_dynamic_system_messages(
        context_builder=LegacyContextBuilder(),  # type: ignore[arg-type]
        config=SimpleNamespace(engine_type="chatgpt", assistant_name="Jenny"),
    )

    assert messages == [{"role": "system", "content": "minimal-profile skills"}]
