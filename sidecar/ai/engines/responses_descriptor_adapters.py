"""The two Jenny-owned non-declarative adapters permitted at Stage 7."""

CORE_ADAPTERS = frozenset({
    "citation_marker_normalizer",
    "reasoning_item_replay_cache",
})

__all__ = ["CORE_ADAPTERS"]
