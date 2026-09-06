"""Shared local-engine chat-message normalization helpers.

These helpers smooth over quirks shared by template-based local runtimes
(Ollama, vLLM, llama.cpp's ``llama-server`` and other OpenAI-compatible
servers) that render the request through the model's own chat template and,
in the tool-calling path, build a native tool-call parser from it.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.context.compaction import is_compaction_summary_content


def merge_consecutive_system_messages(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Collapse runs of adjacent ``system`` messages into a single message.

    Template-based local runtimes render the request through the model's chat
    template; in the tool-calling path they also *execute* that template to
    build a native tool-call parser. Some community GGUF templates (e.g. the
    mradermacher Qwen3.6-35B-A3B build) only render a single leading system
    message; given two or more they raise during template execution. Under
    Ollama this surfaces as an HTTP 400 "Unable to generate parser for this
    template. Automatic parser generation failed: ... While executing
    CallExpression ..." on *every* tool-calling request; the same templates
    served via llama.cpp's ``llama-server`` or vLLM are exposed the same way.

    Jenny composes several system messages (identity overlay, personality
    profile, runtime-skills overlay), so without this merge such a model's
    native tools are deterministically unusable. Concatenating consecutive
    system messages (joined by a blank line, order and content preserved)
    keeps the exact same prompt while staying within what these templates can
    render. The merge is a no-op for a single (or non-adjacent) system message
    and for well-behaved templates the effective prompt is unchanged. The
    input list is not mutated; merged messages are shallow copies.
    """
    merged: list[dict[str, Any]] = []
    for message in messages:
        if (
            message.get("role") == "system"
            and merged
            and merged[-1].get("role") == "system"
        ):
            previous = merged[-1]
            previous_text = str(previous.get("content") or "")
            addition = str(message.get("content") or "")
            joiner = "\n\n" if previous_text and addition else ""
            previous["content"] = f"{previous_text}{joiner}{addition}"
            continue
        merged.append(dict(message))
    return merged


def demote_non_leading_system_messages(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Relabel every ``system`` message that is not part of the leading run.

    Template-based local runtimes render the request through the model's own
    chat template. Some community GGUF templates (e.g. the ``ornith:9b-48k``
    build) hard-require that a ``system`` message appear *only* as the first
    message; given one anywhere else they raise during template execution --
    ``raise_exception('System message must be at the beginning')``. Under Ollama
    this surfaces as an HTTP 400 "Unable to generate parser for this template.
    Automatic parser generation failed: ... System message must be at the
    beginning" on the request, and the same templates served via vLLM or
    llama.cpp's ``llama-server`` fail identically.

    Jenny's tool loop appends short ``system`` nudges *after* the conversation
    history (tool-failure context, cycle hints, current-info context, iteration
    wind-down) so they land right before the model's next turn for recency.
    Those stranded system
    messages are non-adjacent to the leading block, so
    ``merge_consecutive_system_messages`` cannot fold them away and they reach
    the template as-is. This helper relabels every ``system`` message after the
    leading system run to ``user``, preserving position and content -- the
    templates accept a ``user`` turn there; only a stray ``system`` is rejected.
    The leading system run (the identity/personality/skills block at the front)
    is left as ``system``, which is exactly what the template requires.

    Run this *before* ``merge_consecutive_system_messages`` so a non-leading
    system that sits right after the leading block is demoted in place rather
    than merged into the leading block (which would move the nudge and lose its
    intended recency). The input list is not mutated; returned messages are
    shallow copies. It is a no-op when every system message is already in the
    leading run. Demoting to ``user`` may leave two adjacent ``user`` turns
    (e.g. the current-info nudge follows the latest user message); that is
    intentional and template-safe -- these templates concatenate consecutive
    user turns and only reject a stray ``system``.

    This is the required last-mile normalizer for template-based local engines:
    every builder that renders through a model chat template (Ollama, vLLM, and
    the OpenAI-compatible subclass today) MUST call it before
    ``merge_consecutive_system_messages``. A new builder that skips it silently
    reintroduces the system-first HTTP 400.

    TRUST BOUNDARY: a compaction-summary row (``is_compaction_summary_content``)
    ENDS the leading run and is itself relabelled to ``user`` in place. Its body
    is arbitrary model-generated text summarised from a conversation that
    includes tool-result rows, so a poisoned tool result can steer it; merging it
    into the leading system block would hand that text the primary prompt's
    authority. Position and content are preserved, so the model still sees the
    summary exactly where the router put it -- just in the untrusted tier. This
    is deliberately done HERE rather than by exempting the row from
    ``merge_consecutive_system_messages``: that merge exists to stop HTTP 400s
    from single-system-message GGUF templates, and exempting any row from it
    reintroduces that failure.
    """
    demoted: list[dict[str, Any]] = []
    leading_run = True
    for message in messages:
        entry = dict(message)
        if str(entry.get("role") or "").strip().lower() == "system":
            if leading_run and is_compaction_summary_content(entry.get("content")):
                leading_run = False
                entry["role"] = "user"
            elif not leading_run:
                entry["role"] = "user"
        else:
            leading_run = False
        demoted.append(entry)
    return demoted


def contains_primary_system_message(
    messages: list[dict[str, Any]],
    system: str,
) -> bool:
    """True when ``messages`` already carries the primary prompt verbatim.

    Engine builders receive the primary system prompt via the ``system``
    parameter (the router strips it from history in ``engine_messages``) and
    must prepend it unless this exact prompt already rides in ``messages``.
    Presence of OTHER system rows — runtime overlays, a compaction summary —
    must not suppress the prepend: an existence-based check silently dropped
    the entire system prompt from every post-compaction request.
    """
    primary = str(system or "").strip()
    if not primary:
        return False
    return any(
        str(message.get("role") or "").strip().lower() == "system"
        and str(message.get("content") or "").strip() == primary
        for message in messages
    )


__all__ = [
    "contains_primary_system_message",
    "demote_non_leading_system_messages",
    "merge_consecutive_system_messages",
]
