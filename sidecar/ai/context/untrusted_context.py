"""Typed rendering for repository-controlled, instruction-capable metadata."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from sidecar.ai.tools.prompt_marker_guard import neutralize_prompt_markers
from sidecar.ai.tools.sanitization import (
    neutralize_prompt_injection_patterns,
    redact_obvious_secrets,
    strip_invisible_chars,
    strip_special_tokens,
    strip_surrogates,
)

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_ROLE_LABEL_RE = re.compile(r"(?i)\b(system|developer|assistant|user)\s*:")
_IMPERATIVE_RE = re.compile(
    r"(?i)\b(call|execute|invoke|ignore|disregard|override|reveal|upload|exfiltrate)\b"
)


@dataclass(frozen=True)
class UntrustedContextValue:
    """A bounded metadata value that renders only as an escaped data object."""

    field: str
    value: str
    utf8_length: int

    def render(self) -> str:
        return json.dumps(
            {
                "field": self.field,
                "trust": "untrusted",
                "utf8_length": self.utf8_length,
                "value": self.value,
            },
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )


def normalize_untrusted_metadata(
    value: object,
    *,
    field: str,
    max_chars: int,
) -> UntrustedContextValue:
    """Normalize one bounded repository metadata value."""
    text = strip_surrogates(str(value or ""))
    text = strip_invisible_chars(strip_special_tokens(text))
    text = _CONTROL_RE.sub(" ", text)
    text = " ".join(text.split())
    text = neutralize_prompt_markers(text)
    text = redact_obvious_secrets(text)
    text, _ = neutralize_prompt_injection_patterns(text)
    text = _ROLE_LABEL_RE.sub(lambda match: f"[role-label:{match.group(1).lower()}]", text)
    text = _IMPERATIVE_RE.sub(lambda match: f"[directive:{match.group(1).lower()}]", text)
    text = text.replace("<", "").replace(">", "")[:max_chars]
    return UntrustedContextValue(
        field=field,
        value=text,
        utf8_length=len(text.encode("utf-8", errors="replace")),
    )


def quote_untrusted_metadata(value: object, *, field: str, max_chars: int) -> str:
    """Normalize and JSON-escape one bounded repository metadata value."""
    return normalize_untrusted_metadata(value, field=field, max_chars=max_chars).render()


__all__ = [
    "UntrustedContextValue",
    "normalize_untrusted_metadata",
    "quote_untrusted_metadata",
]
