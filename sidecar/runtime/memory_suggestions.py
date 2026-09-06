"""Memory suggestion pattern matching and candidate generation.

Extracted from ``memory.py`` to stay under the 1000-line hard max.
Public entry point is :func:`suggest_memories`; shared text-normalization
helpers are imported from :mod:`sidecar.runtime.memory`.
"""

from __future__ import annotations

import re
from typing import Any

from sidecar.ai.memory.service import (
    MemoryService,
    approved_memory_api,
    pending_memory_api,
)
from sidecar.ai.memory.store import MemoryStore, PendingMemoryCandidate

# ── Shared helpers (canonical home: memory_text.py) ────────────────────────
from sidecar.runtime.memory_text import (
    _build_fingerprint,
    _normalize_lesson_text,
    _normalize_spaces,
    _normalize_title,
    _sanitize_source_excerpt,
)

# ── Capture-length constraints ────��───────────────────────────────────
MAX_CAPTURE_LENGTH = 80
MIN_CAPTURE_LENGTH = 3
GENERIC_CAPTURE_VALUES = {
    "it",
    "that",
    "this",
    "them",
    "things",
    "stuff",
    "something",
}


def _is_memory_suppressed(
    memory_store: MemoryStore | MemoryService, fingerprint: str
) -> bool:
    pending = pending_memory_api(memory_store)
    checker = getattr(pending, "is_memory_suppressed", None)
    return bool(checker(fingerprint)) if callable(checker) else False

# ── Regex building blocks ─────────���───────────────────────────────────
_PERSON_NAME_TOKEN_PATTERN = (
    r"(?!and\b|or\b|is\b|are\b|was\b|were\b|am\b|has\b|have\b|had\b|will\b|would\b|could\b|should\b|can\b|"
    r"did\b|do\b|does\b|from\b|with\b|for\b)[a-z][a-z0-9'\-]*"
)
_PERSON_NAME_PATTERN = rf"{_PERSON_NAME_TOKEN_PATTERN}(?:\s+{_PERSON_NAME_TOKEN_PATTERN}){{0,2}}"
_PERSON_NAME_AFTER_RELATION_PATTERN = (
    rf"{_PERSON_NAME_TOKEN_PATTERN}(?:\s+{_PERSON_NAME_TOKEN_PATTERN}){{0,2}}"
)
_CAPITALIZED_PERSON_NAME_PATTERN = r"[A-Z][a-z0-9'\-]*(?:\s+[A-Z][a-z0-9'\-]*){0,2}"
_IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN = r"(?:friend|partner|mom|dad|sister|brother)"
_IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN = r"[a-z]+(?:\s+(?!is\b)[a-z]+)?"
_IMPORTANT_PERSON_RELATIONSHIP_PATTERN = rf"(?:{_IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN}|{_IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN})"

# ── Candidate tables ──────────────────────────────���──────────────────
RESPONSE_STYLE_CANDIDATES = (
    (
        "concise",
        0.93,
        re.compile(r"\b(?:be concise|keep it brief|short answers?)\b", re.IGNORECASE),
        "Response style: concise",
        "Use concise answers unless the user asks for more detail.",
    ),
    (
        "direct",
        0.92,
        re.compile(r"\b(?:be direct|straight to the point|no fluff)\b", re.IGNORECASE),
        "Response style: direct",
        "Be direct and avoid extra fluff unless the user asks for a softer tone.",
    ),
    (
        "step_by_step",
        0.91,
        re.compile(r"\b(?:step by step|walk me through|show me step by step)\b", re.IGNORECASE),
        "Response style: step-by-step",
        "Explain things step by step when helping the user.",
    ),
)
WORKING_PREFERENCE_CANDIDATES = (
    (
        0.94,
        re.compile(
            r"\b(?:diagnose|find|debug)\s+(?:the\s+)?root\s+cause(?:\s+first)?\b",
            re.IGNORECASE,
        ),
        "Working preference: diagnose root cause first",
        "Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
    ),
    (
        0.93,
        re.compile(
            r"\b(?:keep|put|route)\s+(?:all\s+)?external\s+api\s+calls?\s+behind\s+(?:a\s+)?service\s+layer\b",
            re.IGNORECASE,
        ),
        "Working preference: service-layer external APIs",
        "Keep external API calls behind a service layer so retries, caching, and provider swaps stay localized.",
    ),
    (
        0.92,
        re.compile(
            r"\b(?:treat|handle)\s+schema\s+changes?\s+as\s+migrations?\b",
            re.IGNORECASE,
        ),
        "Working preference: schema changes are migrations",
        "Treat schema changes as migrations with explicit upgrade intent.",
    ),
    (
        0.9,
        re.compile(
            r"\b(?:prioriti[sz]e\s+observability|structured\s+logs?|request\s+ids?)\b",
            re.IGNORECASE,
        ),
        "Working preference: prioritize observability",
        "Prioritize observability with structured logs, request IDs, and appropriate log levels.",
    ),
    (
        0.89,
        re.compile(
            r"\b(?:clarify\s+ambiguous\s+scope|clarify\s+scope\s+before\s+implementation|ask\s+clarifying\s+questions\s+only\s+when\s+it\s+changes\s+the\s+outcome)\b",
            re.IGNORECASE,
        ),
        "Working preference: clarify ambiguous scope first",
        "Clarify ambiguous scope before implementation; ask clarifying questions only when the answer materially changes the outcome.",
    ),
    (
        0.88,
        re.compile(
            r"\b(?:update\s+the\s+plan\s+document\s+when\s+(?:the\s+)?task\s+or\s+batch\s+is\s+completed|if\s+following\s+a\s+plan\s+document,\s*update\s+the\s+plan\s+document)\b",
            re.IGNORECASE,
        ),
        "Working preference: update plan docs after completion",
        "When following a plan document, update it after the task or batch is completed.",
    ),
)
TOOL_STRATEGY_CANDIDATES = (
    (
        0.9,
        re.compile(r"\b(?:use|prefer)\s+(?:rg|ripgrep)\b", re.IGNORECASE),
        "Tool strategy: prefer ripgrep",
        "For repository text search tasks, prefer rg/ripgrep when it is available.",
    ),
    (
        0.89,
        re.compile(r"\b(?:use|prefer)\s+apply_patch\b", re.IGNORECASE),
        "Tool strategy: use apply_patch",
        "Prefer apply_patch for small manual file edits when practical.",
    ),
    (
        0.91,
        re.compile(
            r"\b(?:(?:don't|do not|dont)\s+run\s+tests?\s+unless\s+i\s+ask(?:\s+you)?|skip\s+tests?\s+unless\s+requested)\b",
            re.IGNORECASE,
        ),
        "Tool strategy: avoid unrequested tests",
        "Do not run tests unless the user explicitly asks for them.",
    ),
    (
        0.88,
        re.compile(r"\b(?:keep\s+diffs?\s+small|small\s+reviewable\s+diffs?)\b", re.IGNORECASE),
        "Tool strategy: keep diffs small",
        "Keep changes small and reviewable.",
    ),
    (
        0.87,
        re.compile(
            r"\b(?:plan\s+first|define\s+architecture\s+first|plan\s+before\s+implementation)\b",
            re.IGNORECASE,
        ),
        "Tool strategy: plan before implementation",
        "Plan the approach before implementing non-trivial work.",
    ),
)
PROJECT_CONTEXT_CANDIDATES = (
    (
        0.95,
        re.compile(
            r"\b(?:workspace|repo|repository)\b[^.!?\n]{0,80}\bno\s+\.git\s+metadata\b",
            re.IGNORECASE,
        ),
        "Project context: workspace has no git metadata",
        "This workspace has no .git metadata, so branch and status information are unavailable.",
    ),
    (
        0.94,
        re.compile(
            r"\belectron\s+owns\s+(?:the\s+)?canonical\s+conversation\s+history\b",
            re.IGNORECASE,
        ),
        "Project context: Electron owns canonical history",
        "Electron owns canonical conversation history and persistence.",
    ),
    (
        0.94,
        re.compile(r"\bsidecar\s+is\s+stateless\s+per\s+request\b", re.IGNORECASE),
        "Project context: sidecar is stateless per request",
        "The sidecar is stateless per request.",
    ),
    (
        0.93,
        re.compile(
            r"\bapproved\s+memories?\b[^.!?\n]{0,80}\bsidecar\s+sqlite\b",
            re.IGNORECASE,
        ),
        "Project context: approved memories live in sidecar SQLite",
        "Approved memories are stored canonically in the sidecar SQLite database only.",
    ),
    (
        0.92,
        re.compile(
            r"\b(?:no\s+vector\s+db|do\s+not\s+use\s+(?:a\s+)?vector\s+db)\b",
            re.IGNORECASE,
        ),
        "Project context: no vector DB",
        "Do not introduce a vector database for memory; keep recall deterministic and cheap.",
    ),
    (
        0.91,
        re.compile(
            r"\btools?\b[^.!?\n]{0,80}\bblocked\s+until\b[^.!?\n]{0,80}\bworkspace\s+root\b",
            re.IGNORECASE,
        ),
        "Project context: tools require explicit workspace root",
        "Tools remain blocked until a workspace root is explicitly configured.",
    ),
)
ROUTINE_CANDIDATES = (
    (
        0.94,
        re.compile(r"\bmy\s+morning\s+routine\s+is\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Routine: morning routine",
        "The user's morning routine includes {value}.",
    ),
    (
        0.94,
        re.compile(r"\bevery\s+morning\s+i\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Routine: morning routine",
        "The user's morning routine includes {value}.",
    ),
    (
        0.93,
        re.compile(r"\bmy\s+daily\s+routine\s+includes\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Routine: daily routine",
        "The user's daily routine includes {value}.",
    ),
    (
        0.94,
        re.compile(r"\bmy\s+evening\s+routine\s+is\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Routine: evening routine",
        "The user's evening routine includes {value}.",
    ),
    (
        0.93,
        re.compile(r"\bbefore\s+bed\s+i\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Routine: evening routine",
        "The user's evening routine includes {value}.",
    ),
    (
        0.92,
        re.compile(r"\bevery\s+week\s+i\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Routine: weekly routine",
        "The user's weekly routine includes {value}.",
    ),
    (
        0.92,
        re.compile(
            r"\bon\s+(?P<day>mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\s+i\s+(?P<value>[^.!?\n]+)",
            re.IGNORECASE,
        ),
        "Routine: {day} routine",
        "The user's {day} routine includes {value}.",
    ),
)
GOAL_CANDIDATES = (
    (
        0.93,
        re.compile(r"\bmy\s+goal\s+is\s+to\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Goal: {value}",
        "The user's goal is to {value}.",
    ),
    (
        0.92,
        re.compile(r"\bmy\s+goal\s+is\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Goal: {value}",
        "The user's goal is {value}.",
    ),
    (
        0.92,
        re.compile(r"\bi['']m\s+trying\s+to\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Goal: {value}",
        "The user's goal is to {value}.",
    ),
    (
        0.92,
        re.compile(r"\bi\s+want\s+to\s+achieve\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Goal: {value}",
        "The user's goal is to achieve {value}.",
    ),
    (
        0.91,
        re.compile(r"\bi['']m\s+working\s+toward\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        "Goal: {value}",
        "The user's goal is {value}.",
    ),
    (
        0.91,
        re.compile(
            r"\bby\s+(?P<month>january|february|march|april|may|june|july|august|september|october|november|december)\s+i\s+want\s+to\s+(?P<value>[^.!?\n]+)",
            re.IGNORECASE,
        ),
        "Goal: {value}",
        "By {month}, the user's goal is to {value}.",
    ),
)
MEMORY_PATTERNS = (
    (
        "profile",
        0.99,
        re.compile(rf"\bmy name is\s+(?P<value>{_PERSON_NAME_PATTERN})\b", re.IGNORECASE),
        lambda value: (
            f"Preferred name: {value}",
            f"The user's name is {value}.",
        ),
    ),
    (
        "profile",
        0.98,
        re.compile(rf"\bcall me\s+(?P<value>{_PERSON_NAME_PATTERN})\b", re.IGNORECASE),
        lambda value: (
            f"Preferred address: {value}",
            f"Call the user {value}.",
        ),
    ),
    (
        "preference",
        0.95,
        re.compile(r"\bi prefer\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        lambda value: (
            f"Preference: {value}",
            f"The user prefers {value}.",
        ),
    ),
    (
        "preference",
        0.9,
        re.compile(r"\bi (?:like|love)\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        lambda value: (
            f"Likes: {value}",
            f"The user likes {value}.",
        ),
    ),
    (
        "preference",
        0.9,
        re.compile(r"\bi (?:dislike|hate)\s+(?P<value>[^.!?\n]+)", re.IGNORECASE),
        lambda value: (
            f"Dislikes: {value}",
            f"The user dislikes {value}.",
        ),
    ),
)
IMPORTANT_PERSON_CANDIDATES = (
    (
        "important_person",
        0.92,
        re.compile(
            rf"\bmy\s+(?P<value>{_IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN}\s+{_PERSON_NAME_AFTER_RELATION_PATTERN})\b",
            re.IGNORECASE,
        ),
        lambda value: _format_important_person(value),
    ),
    (
        "important_person",
        0.91,
        re.compile(
            rf"\b(?P<value>{_PERSON_NAME_PATTERN}\s+is\s+my\s+{_IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN})\b",
            re.IGNORECASE,
        ),
        lambda value: _format_important_person(value),
    ),
    (
        "important_person",
        0.9,
        re.compile(
            rf"\b(?:my|My)\s+(?P<value>{_IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN}\s+{_CAPITALIZED_PERSON_NAME_PATTERN})\b"
        ),
        lambda value: _format_important_person(value),
    ),
    (
        "important_person",
        0.9,
        re.compile(
            rf"\b(?P<value>{_CAPITALIZED_PERSON_NAME_PATTERN}\s+(?:is|Is)\s+my\s+{_IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN})\b"
        ),
        lambda value: _format_important_person(value),
    ),
)


# ── Suggestion-specific helpers ───────────���───────────────────────────


def _normalize_capture(value: str) -> str:
    cleaned = _normalize_spaces(value)
    cleaned = re.sub(r"\b(?:please|thanks|thank you)\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip(" \t\r\n.,!?;:-")
    cleaned = _normalize_spaces(cleaned)
    return cleaned


def _is_supported_message(candidate: Any) -> bool:
    return isinstance(candidate, dict) and str(candidate.get("role", "")).strip().lower() == "user"


def _validate_capture(value: str) -> bool:
    normalized = _normalize_capture(value)
    if len(normalized) < MIN_CAPTURE_LENGTH or len(normalized) > MAX_CAPTURE_LENGTH:
        return False
    if normalized.lower() in GENERIC_CAPTURE_VALUES:
        return False
    if normalized.count(" ") > 10:
        return False
    return True


def _title_case_words(value: str) -> str:
    return " ".join(part.capitalize() for part in value.split(" "))


def _render_candidate_template(template: str, captures: dict[str, str]) -> str:
    if not captures:
        return template
    return template.format(**captures)


def _normalized_match_captures(match: re.Match[str]) -> dict[str, str]:
    captures: dict[str, str] = {}
    for key, raw_value in match.groupdict().items():
        if raw_value is None:
            continue
        normalized = _normalize_capture(raw_value)
        if key in {"day", "month", "relationship"}:
            normalized = normalized.lower()
        captures[key] = normalized
    return captures


def _parse_important_person_value(value: str) -> tuple[str, str]:
    normalized_value = _normalize_capture(value)
    relationship_first_match = re.fullmatch(
        rf"(?P<relationship>{_IMPORTANT_PERSON_RELATIONSHIP_PATTERN})\s+(?P<name>{_PERSON_NAME_PATTERN})",
        normalized_value,
        re.IGNORECASE,
    )
    if relationship_first_match is not None:
        relationship = _normalize_spaces(relationship_first_match.group("relationship")).lower()
        name = _title_case_words(_normalize_spaces(relationship_first_match.group("name")))
        return name, relationship

    relationship_last_match = re.fullmatch(
        rf"(?P<name>{_PERSON_NAME_PATTERN})\s+is\s+my\s+(?P<relationship>{_IMPORTANT_PERSON_RELATIONSHIP_PATTERN})",
        normalized_value,
        re.IGNORECASE,
    )
    if relationship_last_match is not None:
        relationship = _normalize_spaces(relationship_last_match.group("relationship")).lower()
        name = _title_case_words(_normalize_spaces(relationship_last_match.group("name")))
        return name, relationship

    return _title_case_words(normalized_value), "important person"


def _format_important_person(value: str) -> tuple[str, str]:
    name, relationship = _parse_important_person_value(value)
    return (
        f"Important person: {name} ({relationship})",
        f"The user's {relationship} is {name}.",
    )


def _candidate_payload_for_fixed_lesson(
    *,
    lesson_kind: str,
    confidence: float,
    title: str,
    lesson_text: str,
    source_excerpt: str,
) -> dict[str, object]:
    normalized_title = _normalize_title(title)
    normalized_lesson_text = _normalize_lesson_text(lesson_text)
    return {
        "title": normalized_title,
        "lesson_text": normalized_lesson_text,
        "lesson_kind": lesson_kind,
        "confidence": max(0.0, min(float(confidence), 1.0)),
        "source_excerpt": _sanitize_source_excerpt(source_excerpt),
        "content_fingerprint": _build_fingerprint(lesson_kind, normalized_lesson_text),
    }


def _candidate_payload(
    *,
    lesson_kind: str,
    confidence: float,
    value: str,
    source_excerpt: str,
    formatter: Any,
) -> dict[str, object]:
    normalized_value = _normalize_capture(value)
    if lesson_kind == "profile":
        normalized_value = _title_case_words(normalized_value)
    title, lesson_text = formatter(normalized_value)
    normalized_title = _normalize_title(title)
    normalized_lesson_text = _normalize_lesson_text(lesson_text)
    return {
        "title": normalized_title,
        "lesson_text": normalized_lesson_text,
        "lesson_kind": lesson_kind,
        "confidence": max(0.0, min(float(confidence), 1.0)),
        "source_excerpt": _sanitize_source_excerpt(source_excerpt),
        "content_fingerprint": _build_fingerprint(lesson_kind, normalized_lesson_text),
    }


def _suggestion_sort_key(item: dict[str, object]) -> tuple[float, int]:
    raw_confidence = item.get("confidence")
    confidence = float(raw_confidence) if isinstance(raw_confidence, (int, float)) else 0.0
    return (
        confidence,
        len(str(item.get("lesson_text", ""))),
    )


def serialize_pending_memory_candidate(candidate: PendingMemoryCandidate) -> dict[str, object]:
    return {
        "id": candidate.id,
        "session_id": candidate.session_id,
        "source_request_id": candidate.source_request_id,
        "title": candidate.title,
        "lesson_text": candidate.lesson_text,
        "lesson_kind": candidate.lesson_kind,
        "confidence": candidate.confidence,
        "source_excerpt": _sanitize_source_excerpt(candidate.source_excerpt),
        "content_fingerprint": candidate.content_fingerprint,
        "family_key": candidate.family_key,
        "category": candidate.category,
        "created_at": candidate.created_at,
        "updated_at": candidate.updated_at,
    }


# ── Main entry point ───────────────��─────────────────────────────────


def suggest_memories(
    *,
    messages: Any,
    memory_store: MemoryStore | MemoryService,
    session_id: Any = None,
) -> list[dict[str, object]]:
    normalized_session_id = _normalize_spaces(str(session_id or ""))
    approved = approved_memory_api(memory_store)
    pending = pending_memory_api(memory_store)
    if normalized_session_id:
        pending_candidates = pending.get_pending_candidates(normalized_session_id)
        filtered_pending_candidates = []
        for candidate in pending_candidates:
            if (
                approved.has_memory_fingerprint(candidate.content_fingerprint)
                or _is_memory_suppressed(memory_store, candidate.content_fingerprint)
            ):
                pending.delete_pending_candidate(
                    session_id=normalized_session_id,
                    content_fingerprint=candidate.content_fingerprint,
                )
                continue
            filtered_pending_candidates.append(candidate)
        if filtered_pending_candidates:
            return [
                serialize_pending_memory_candidate(candidate)
                for candidate in filtered_pending_candidates[:1]
            ]

    if not isinstance(messages, list):
        raise ValueError("messages must be a list")

    suggestions: list[dict[str, object]] = []
    seen_fingerprints: set[str] = set()
    for message in messages:
        if not _is_supported_message(message):
            continue
        content = _normalize_spaces(message.get("content", ""))
        if not content:
            continue

        for lesson_kind, confidence, pattern, formatter in MEMORY_PATTERNS:
            match = pattern.search(content)
            if not match:
                continue
            captured = match.group("value")
            if not _validate_capture(captured):
                continue
            candidate_payload: dict[str, object] = _candidate_payload(
                lesson_kind=lesson_kind,
                confidence=confidence,
                value=captured,
                source_excerpt=match.group(0),
                formatter=formatter,
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

        for _style_key, confidence, pattern, title, lesson_text in RESPONSE_STYLE_CANDIDATES:
            match = pattern.search(content)
            if not match:
                continue
            candidate_payload = _candidate_payload_for_fixed_lesson(
                lesson_kind="response_style",
                confidence=confidence,
                title=title,
                lesson_text=lesson_text,
                source_excerpt=match.group(0),
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

        for confidence, pattern, title, lesson_text in WORKING_PREFERENCE_CANDIDATES:
            match = pattern.search(content)
            if not match:
                continue
            candidate_payload = _candidate_payload_for_fixed_lesson(
                lesson_kind="working_preference",
                confidence=confidence,
                title=title,
                lesson_text=lesson_text,
                source_excerpt=match.group(0),
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

        for confidence, pattern, title, lesson_text in TOOL_STRATEGY_CANDIDATES:
            match = pattern.search(content)
            if not match:
                continue
            candidate_payload = _candidate_payload_for_fixed_lesson(
                lesson_kind="tool_strategy",
                confidence=confidence,
                title=title,
                lesson_text=lesson_text,
                source_excerpt=match.group(0),
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

        for confidence, pattern, title, lesson_text in PROJECT_CONTEXT_CANDIDATES:
            match = pattern.search(content)
            if not match:
                continue
            candidate_payload = _candidate_payload_for_fixed_lesson(
                lesson_kind="project_context",
                confidence=confidence,
                title=title,
                lesson_text=lesson_text,
                source_excerpt=match.group(0),
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

        for confidence, pattern, title, lesson_text in ROUTINE_CANDIDATES:
            match = pattern.search(content)
            if not match:
                continue
            captures = _normalized_match_captures(match)
            captured = captures.get("value", "")
            if not _validate_capture(captured):
                continue
            candidate_payload = _candidate_payload_for_fixed_lesson(
                lesson_kind="routine",
                confidence=confidence,
                title=_render_candidate_template(title, captures),
                lesson_text=_render_candidate_template(lesson_text, captures),
                source_excerpt=match.group(0),
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

        for confidence, pattern, title, lesson_text in GOAL_CANDIDATES:
            match = pattern.search(content)
            if not match:
                continue
            captures = _normalized_match_captures(match)
            captured = captures.get("value", "")
            if not _validate_capture(captured):
                continue
            candidate_payload = _candidate_payload_for_fixed_lesson(
                lesson_kind="goal",
                confidence=confidence,
                title=_render_candidate_template(title, captures),
                lesson_text=_render_candidate_template(lesson_text, captures),
                source_excerpt=match.group(0),
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

        for lesson_kind, confidence, pattern, formatter in IMPORTANT_PERSON_CANDIDATES:
            match = pattern.search(content)
            if not match:
                continue
            captured = match.group("value")
            if not _validate_capture(captured):
                continue
            candidate_payload = _candidate_payload(
                lesson_kind=lesson_kind,
                confidence=confidence,
                value=captured,
                source_excerpt=match.group(0),
                formatter=formatter,
            )
            fingerprint = str(candidate_payload["content_fingerprint"])
            if fingerprint in seen_fingerprints:
                continue
            if approved.has_memory_fingerprint(
                fingerprint
            ) or _is_memory_suppressed(memory_store, fingerprint):
                continue
            suggestions.append(candidate_payload)
            seen_fingerprints.add(fingerprint)
            break

    suggestions.sort(key=_suggestion_sort_key, reverse=True)
    # Cap at one suggestion per request to avoid overwhelming the user with
    # multiple approval toasts after a single message.  If a message contains
    # several extractable facts (e.g. "call me Jen, I prefer Python"), the
    # highest-confidence candidate is surfaced first; the remaining candidates
    # will be offered on subsequent messages if they are still unseen.
    return suggestions[:1]
