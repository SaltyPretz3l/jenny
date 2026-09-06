"""Stable family-key definitions for gated approved-memory recall."""

from __future__ import annotations

import re

GATED_MEMORY_KINDS = frozenset({"tool_strategy", "working_preference", "project_context"})

TOOL_STRATEGY_FAMILY_BY_FINGERPRINT: dict[str, str] = {
    "tool_strategy:for-repository-text-search-tasks-prefer-rg-ripgrep-when-it-is-available": "ripgrep",
    "tool_strategy:prefer-apply-patch-for-small-manual-file-edits-when-practical": "apply_patch",
    "tool_strategy:do-not-run-tests-unless-the-user-explicitly-asks-for-them": "skip_tests",
    "tool_strategy:keep-changes-small-and-reviewable": "small_diffs",
    "tool_strategy:plan-the-approach-before-implementing-non-trivial-work": "plan_first",
}
TOOL_STRATEGY_FAMILY_BY_LESSON_TEXT: dict[str, str] = {
    "for repository text search tasks, prefer rg/ripgrep when it is available.": "ripgrep",
    "prefer apply_patch for small manual file edits when practical.": "apply_patch",
    "do not run tests unless the user explicitly asks for them.": "skip_tests",
    "keep changes small and reviewable.": "small_diffs",
    "plan the approach before implementing non-trivial work.": "plan_first",
}

TOOL_STRATEGY_QUERY_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    "ripgrep": (
        re.compile(r"\b(?:rg|ripgrep)\b", re.IGNORECASE),
        re.compile(
            r"\b(?:search|find|grep|look(?:ing)?\s+for|scan)\b.*\b(?:repo|repository|code|codebase|text|file|files|source)\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:repo|repository|code|codebase|text|file|files|source)\b.*\b(?:search|find|grep|scan)\b",
            re.IGNORECASE,
        ),
    ),
    "apply_patch": (
        re.compile(r"\bapply_patch\b", re.IGNORECASE),
        re.compile(
            r"\b(?:edit|patch|modify|update|change|rewrite)\b.*\b(?:file|files|text|line|lines)\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:file|files|text|line|lines)\b.*\b(?:edit|patch|modify|update|change|rewrite)\b",
            re.IGNORECASE,
        ),
    ),
    "skip_tests": (
        re.compile(
            r"\b(?:run|skip|execute|write|add|fix|update|create)\b.*\b(?:test|tests|testing|pytest|vitest|jest)\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:test|tests|testing|pytest|vitest|jest)\b.*\b(?:run|skip|execute|write|add|fix|update|create)\b",
            re.IGNORECASE,
        ),
    ),
    "small_diffs": (
        re.compile(
            r"\b(?:small|minimal|reviewable)\b.*\b(?:diff|diffs|change|changes|patch|patches|pr|pull\s+request)\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:diff|diffs|change|changes|patch|patches|pr|pull\s+request)\b.*\b(?:small|minimal|reviewable)\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:scope|size)\s+(?:of|for)\s+(?:the\s+)?(?:diff|change|pr|patch)\b", re.IGNORECASE
        ),
    ),
    "plan_first": (
        re.compile(r"\bplan\s+before\s+implementation\b", re.IGNORECASE),
        re.compile(r"\bdefine\s+architecture\s+first\b", re.IGNORECASE),
        re.compile(
            r"\b(?:should|how\s+(?:do|should|would))\s+(?:i|we)\s+(?:plan|approach|design)\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:plan|design|architect)\s+(?:this|the)\s+(?:feature|task|work|change)\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?:let'?s|need\s+to|want\s+to|going\s+to)\s+(?:plan|design|architect)\b",
            re.IGNORECASE,
        ),
    ),
}

WORKING_PREFERENCE_FAMILY_BY_LESSON_TEXT: dict[str, str] = {
    "diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.": "diagnose_root_cause_first",
    "keep external api calls behind a service layer so retries, caching, and provider swaps stay localized.": "service_layer_external_apis",
    "treat schema changes as migrations with explicit upgrade intent.": "schema_changes_are_migrations",
    "prioritize observability with structured logs, request ids, and appropriate log levels.": "prioritize_observability",
    "clarify ambiguous scope before implementation; ask clarifying questions only when the answer materially changes the outcome.": "clarify_scope_first",
    "when following a plan document, update it after the task or batch is completed.": "update_plan_docs_after_completion",
}

WORKING_PREFERENCE_FAMILY_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    "diagnose_root_cause_first": (
        re.compile(r"\b(?:root\s+cause|diagnos(?:e|ing)|debug)\b", re.IGNORECASE),
        re.compile(r"\b(?:fix|bug|issue|problem|regression|failure)\b", re.IGNORECASE),
    ),
    "service_layer_external_apis": (
        re.compile(r"\b(?:service\s+layer|service)\b", re.IGNORECASE),
        re.compile(r"\b(?:external\s+api|provider|retry|cache|caching)\b", re.IGNORECASE),
    ),
    "schema_changes_are_migrations": (
        re.compile(r"\b(?:schema|database|migration|migrate)\b", re.IGNORECASE),
    ),
    "prioritize_observability": (
        re.compile(
            r"\b(?:observability|structured\s+logs?|request\s+ids?|diagnostics?|telemetry|logging)\b",
            re.IGNORECASE,
        ),
    ),
    "clarify_scope_first": (
        re.compile(r"\b(?:scope|requirements?|clarify|clarifying)\b", re.IGNORECASE),
    ),
    "update_plan_docs_after_completion": (
        re.compile(
            r"\b(?:plan\s+document|next[_\s-]?steps|handoff|rebuild\s+plan|batch)\b", re.IGNORECASE
        ),
        re.compile(r"\b(?:update|updated|refresh|record|document)\b", re.IGNORECASE),
    ),
}

PROJECT_CONTEXT_FAMILY_BY_LESSON_TEXT: dict[str, str] = {
    "this workspace has no .git metadata, so branch and status information are unavailable.": "workspace_has_no_git_metadata",
    "electron owns canonical conversation history and persistence.": "electron_owns_canonical_history",
    "the sidecar is stateless per request.": "sidecar_stateless_per_request",
    "approved memories are stored canonically in the sidecar sqlite database only.": "approved_memories_sidecar_sqlite_only",
    "do not introduce a vector database for memory; keep recall deterministic and cheap.": "no_vector_db",
    "tools remain blocked until a workspace root is explicitly configured.": "tools_require_workspace_root",
    "do not reopen feature f unless it is required for the current task.": "do_not_reopen_feature_f",
}

PROJECT_CONTEXT_FAMILY_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    "workspace_has_no_git_metadata": (
        re.compile(r"\b(?:git|branch|status|\.git)\b", re.IGNORECASE),
    ),
    "electron_owns_canonical_history": (
        re.compile(r"\b(?:history|session|conversation|persistence)\b", re.IGNORECASE),
        re.compile(r"\belectron\b", re.IGNORECASE),
    ),
    "sidecar_stateless_per_request": (
        re.compile(r"\b(?:sidecar|request|stateless)\b", re.IGNORECASE),
    ),
    "approved_memories_sidecar_sqlite_only": (
        re.compile(r"\b(?:memory|memories|sqlite|sidecar)\b", re.IGNORECASE),
        re.compile(r"\b(?:canonical|approved|store|storage)\b", re.IGNORECASE),
    ),
    "no_vector_db": (
        re.compile(r"\b(?:vector|embedding|semantic|recall|search)\b", re.IGNORECASE),
    ),
    "tools_require_workspace_root": (
        re.compile(r"\b(?:tool|tools|workspace\s+root|tools_workspace_root)\b", re.IGNORECASE),
    ),
    "do_not_reopen_feature_f": (
        re.compile(r"\bfeature\s+f\b", re.IGNORECASE),
        re.compile(r"\b(?:reopen|required|scope)\b", re.IGNORECASE),
    ),
}


def resolve_gated_family_key(
    *,
    lesson_kind: str,
    lesson_text: str,
    content_fingerprint: str,
) -> str:
    normalized_kind = str(lesson_kind or "").strip().lower()
    normalized_lesson_text = str(lesson_text or "").strip().lower()
    normalized_fingerprint = str(content_fingerprint or "").strip().lower()

    if normalized_kind == "tool_strategy":
        return TOOL_STRATEGY_FAMILY_BY_LESSON_TEXT.get(
            normalized_lesson_text,
            TOOL_STRATEGY_FAMILY_BY_FINGERPRINT.get(normalized_fingerprint, ""),
        )
    if normalized_kind == "working_preference":
        return WORKING_PREFERENCE_FAMILY_BY_LESSON_TEXT.get(normalized_lesson_text, "")
    if normalized_kind == "project_context":
        return PROJECT_CONTEXT_FAMILY_BY_LESSON_TEXT.get(normalized_lesson_text, "")
    return ""
