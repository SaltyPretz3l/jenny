"""Context assembly helpers for the sidecar kernel."""

from .builder import ContextBuilder, WorkspaceStatus
from .messages import (
    compact_semantic_messages,
    compact_semantic_messages_with_budget,
    sanitize_semantic_message,
)
from .prompt_cache import CacheSection, StructuredSystemPrompt

__all__ = [
    "CacheSection",
    "ContextBuilder",
    "StructuredSystemPrompt",
    "WorkspaceStatus",
    "compact_semantic_messages",
    "compact_semantic_messages_with_budget",
    "sanitize_semantic_message",
]
