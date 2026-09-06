"""Prompt cache boundary markers for cache stability."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date

logger = logging.getLogger(__name__)

SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "<!-- CACHE_BOUNDARY -->"


@dataclass(frozen=True)
class CacheSection:
    """A named section of the system prompt with cacheability metadata."""

    name: str
    content: str
    cacheable: bool = True


@dataclass(frozen=True)
class StructuredSystemPrompt:
    """System prompt decomposed into cacheable and non-cacheable sections.

    Provides ``to_text()`` for the full prompt string and ``__str__``
    for seamless backward compatibility with code that expects a plain
    ``str``.
    """

    sections: tuple[CacheSection, ...]
    session_start_date: str = ""
    current_date: str = ""

    def to_text(self, *, insert_boundary: bool = True) -> str:
        """Join sections, optionally inserting the cache boundary marker."""
        if not self.sections:
            return ""
        if not insert_boundary:
            return "\n\n".join(s.content for s in self.sections if s.content)

        cacheable: list[str] = []
        non_cacheable: list[str] = []
        found_non_cacheable = False
        for section in self.sections:
            if not section.content:
                continue
            if found_non_cacheable or not section.cacheable:
                found_non_cacheable = True
                non_cacheable.append(section.content)
            else:
                cacheable.append(section.content)

        if not non_cacheable:
            return "\n\n".join(cacheable)
        if not cacheable:
            return "\n\n".join(non_cacheable)
        return "\n\n".join([*cacheable, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, *non_cacheable])

    def __str__(self) -> str:  # noqa: D105
        return self.to_text()


# ── Section caching helpers ─────────────────────────────────────────


def resolve_current_date(*, today: date | None = None) -> str:
    """Return the machine-local calendar date for one request.

    Callers resolve this once at request ingress and reuse the returned string
    for every prompt rebuild. Unlike session metadata, this value intentionally
    changes once per local day so relative-date requests remain correct.
    """
    return (today or date.today()).isoformat()


# ── Structured-prompt assembly ──────────────────────────────────────


def build_structured_system_prompt(
    sections: list[CacheSection],
    *,
    session_start_date: str = "",
    current_date: str = "",
) -> StructuredSystemPrompt:
    """Assemble a ``StructuredSystemPrompt`` from ordered sections."""
    return StructuredSystemPrompt(
        sections=tuple(sections),
        session_start_date=session_start_date,
        current_date=current_date,
    )
