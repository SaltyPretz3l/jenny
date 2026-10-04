"""Validate the host's bounded metadata overlay without changing signed descriptors."""

from __future__ import annotations

import re
from typing import Any

_MAX_MODELS = 128
_MAX_LABEL_CHARS = 256
_CONTEXT_CEILING = 272_000
_UNSAFE_LABEL = re.compile(r"[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]")
_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_FIELDS = frozenset({"id", "label", "context_length", "reasoning_efforts",
                     "default_reasoning_effort", "vision"})
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def normalize_chatgpt_model_catalog(value: Any) -> tuple[dict[str, Any], ...]:
    """Invalid overlays fall back as a whole; never publish a partial catalog."""
    if not isinstance(value, (list, tuple)) or len(value) > _MAX_MODELS:
        return ()
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in value:
        if not isinstance(row, dict) or set(row) != _FIELDS:
            return ()
        model_id, label = row["id"], row["label"]
        context, efforts = row["context_length"], row["reasoning_efforts"]
        if (
            not isinstance(model_id, str) or not _ID.fullmatch(model_id) or model_id in seen
            or not isinstance(label, str) or not label.strip() or len(label) > _MAX_LABEL_CHARS
            or _UNSAFE_LABEL.search(label)
            or not isinstance(context, int) or isinstance(context, bool)
            or not 0 < context <= _CONTEXT_CEILING
            or not isinstance(efforts, list) or not 0 < len(efforts) <= len(_EFFORTS)
            or any(not isinstance(effort, str) or effort not in _EFFORTS for effort in efforts)
            or len(set(efforts)) != len(efforts)
            or row["default_reasoning_effort"] not in efforts
            or not isinstance(row["vision"], bool)
        ):
            return ()
        seen.add(model_id)
        models.append({**row, "reasoning_efforts": list(efforts)})
    return tuple(models)
