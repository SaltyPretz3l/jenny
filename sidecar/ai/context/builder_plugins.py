"""Budgeted, provenance-tagged system overlays for declarative plugins."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Iterable

MAX_ITEM_CONTENT_SAFETY_BYTES: Final[int] = 16 * 1024
DEFAULT_PER_PLUGIN_BYTE_CAP: Final[int] = 32 * 1024
DEFAULT_GLOBAL_BYTE_CAP: Final[int] = 64 * 1024


@dataclass(frozen=True, slots=True)
class PluginContextItem:
    publisher_id: str
    plugin_id: str
    contribution_id: str
    kind: str
    content_digest: str
    content: str

    @property
    def authority_key(self) -> tuple[str, str]:
        return (self.publisher_id, self.plugin_id)


@dataclass(frozen=True, slots=True)
class PluginContextDiagnostic:
    publisher_id: str
    plugin_id: str
    contribution_id: str
    content_digest: str
    outcome: str
    bytes_requested: int
    bytes_included: int


@dataclass(frozen=True, slots=True)
class PluginContextSurvivor:
    item: PluginContextItem
    content: str
    bytes_included: int
    truncated: bool


@dataclass(frozen=True, slots=True)
class PluginContextAssembly:
    surviving_items: tuple[PluginContextSurvivor, ...]
    diagnostics: tuple[PluginContextDiagnostic, ...]
    total_bytes_included: int


def truncate_utf8_to_budget(value: str, max_bytes: int) -> str:
    """Match the JS helper: preserve whole Unicode code points only."""
    if max_bytes <= 0:
        return ""
    chunks: list[str] = []
    used = 0
    for character in value:
        character_bytes = len(character.encode("utf-8"))
        if used + character_bytes > max_bytes:
            break
        chunks.append(character)
        used += character_bytes
    return "".join(chunks)


def _bounded_cap(value: int | None, ceiling: int) -> int:
    if value is None:
        return ceiling
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return min(value, ceiling)


def _diagnostic(
    item: PluginContextItem,
    outcome: str,
    requested: int,
    included: int,
) -> PluginContextDiagnostic:
    return PluginContextDiagnostic(
        publisher_id=item.publisher_id,
        plugin_id=item.plugin_id,
        contribution_id=item.contribution_id,
        content_digest=item.content_digest,
        outcome=outcome,
        bytes_requested=requested,
        bytes_included=included,
    )


def assemble_plugin_context_budget(
    items: Iterable[PluginContextItem],
    *,
    per_plugin_byte_cap: int | None = None,
    global_byte_cap: int | None = None,
) -> PluginContextAssembly:
    per_plugin_cap = _bounded_cap(per_plugin_byte_cap, DEFAULT_PER_PLUGIN_BYTE_CAP)
    global_remaining = _bounded_cap(global_byte_cap, DEFAULT_GLOBAL_BYTE_CAP)
    plugin_remaining: dict[tuple[str, str], int] = {}
    survivors: list[PluginContextSurvivor] = []
    diagnostics: list[PluginContextDiagnostic] = []
    total = 0

    for item in items:
        requested = len(item.content.encode("utf-8"))
        if requested > MAX_ITEM_CONTENT_SAFETY_BYTES:
            diagnostics.append(_diagnostic(item, "excluded_content_too_large", requested, 0))
            continue
        remaining = plugin_remaining.setdefault(item.authority_key, per_plugin_cap)
        if remaining <= 0:
            diagnostics.append(_diagnostic(item, "excluded_per_plugin_budget", requested, 0))
            continue
        if global_remaining <= 0:
            diagnostics.append(_diagnostic(item, "excluded_global_budget", requested, 0))
            continue

        allowed_by_plugin = min(requested, remaining)
        budgeted = min(allowed_by_plugin, global_remaining)
        retained = (
            item.content
            if budgeted == requested
            else truncate_utf8_to_budget(item.content, budgeted)
        )
        included = len(retained.encode("utf-8"))
        plugin_remaining[item.authority_key] = remaining - included
        global_remaining -= included
        total += included
        if budgeted == requested:
            survivors.append(PluginContextSurvivor(item, item.content, included, False))
            diagnostics.append(_diagnostic(item, "included", requested, included))
        elif budgeted > 0:
            if retained:
                survivors.append(
                    PluginContextSurvivor(
                        item,
                        retained,
                        included,
                        True,
                    )
                )
            diagnostics.append(_diagnostic(item, "truncated", requested, included))
        else:
            outcome = (
                "excluded_global_budget"
                if allowed_by_plugin > 0
                else "excluded_per_plugin_budget"
            )
            diagnostics.append(_diagnostic(item, outcome, requested, 0))

    return PluginContextAssembly(tuple(survivors), tuple(diagnostics), total)


def build_plugin_system_overlays(
    items: Iterable[PluginContextItem],
    *,
    per_plugin_byte_cap: int | None = None,
    global_byte_cap: int | None = None,
) -> tuple[tuple[str, ...], tuple[PluginContextDiagnostic, ...]]:
    """Return dedicated overlays; package text remains verbatim between tags."""
    assembly = assemble_plugin_context_budget(
        items,
        per_plugin_byte_cap=per_plugin_byte_cap,
        global_byte_cap=global_byte_cap,
    )
    overlays: list[str] = []
    for survivor in assembly.surviving_items:
        item = survivor.item
        provenance = (
            f"publisher_id={item.publisher_id} plugin_id={item.plugin_id} "
            f"contribution_id={item.contribution_id} kind={item.kind} "
            f"content_digest={item.content_digest}"
        )
        overlays.append(
            "## Plugin Runtime Overlay\n"
            f"Provenance: {provenance}\n"
            "<plugin-content>\n"
            f"{survivor.content}\n"
            "</plugin-content>"
        )
    return tuple(overlays), assembly.diagnostics
