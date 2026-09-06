"""Runtime-only system message helpers for prompt assembly."""

from __future__ import annotations

import logging
import os
import sys
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai import config_models, personality
from sidecar.ai.context import (
    ContextBuilder,
    request_fingerprint,
    runtime_message_markers,
)
from sidecar.ai.memory.service import MemoryService
from sidecar.runtime.diagnostics import log_event

PROMPT_MEMORY_RECALL_LIMIT = 5


@dataclass(frozen=True)
class RuntimeOverlayLogContext:
    logger: logging.Logger
    component: str
    event: str
    request_id: str
    session_id: str | None


# Engine types that run local inference; the skill index is opt-in there.
_LOCAL_INFERENCE_ENGINE_TYPES = frozenset({"ollama", "vllm", "openai-compatible"})

def build_dynamic_system_messages(
    *,
    context_builder: ContextBuilder,
    config: Any,
    tool_statuses: Iterable[Any] | None = None,
    personality_rendered: bool = False,
    skill_invocation: dict[str, str] | None = None,
) -> list[dict[str, object]]:
    """Build cache-unstable personality and skill overlays for a request.

    Exactly one ``## Personality`` system message rides a non-minimal turn.
    When Electron sent a personality context block the caller renders it there
    (with the compiled Voice/About/Notes sections) and passes
    ``personality_rendered=True``; this builder then stays silent. With no
    block — no workspace, or a turn that omitted it — the bare heading plus
    name/precedence line is emitted here so the model always knows its name.
    The ChatGPT minimal profile emits neither.
    """
    messages: list[dict[str, object]] = []
    if not personality_rendered and not config_models.uses_minimal_system_prompt(config):
        messages.append(
            {
                "role": "system",
                "content": personality.build_personality_system_message(
                    getattr(config, "assistant_name", None),
                    "",
                ),
            }
        )

    statuses = list(tool_statuses) if tool_statuses is not None else None
    # Missing attribute = legacy caller without a policy: keep rendering.
    raw_policy = getattr(config, "skills_auto_index", None)
    policy = "on" if raw_policy is None else raw_policy
    if policy not in {"auto", "on", "off"}:
        policy = "auto"
    engine_type = str(getattr(config, "engine_type", "") or "").strip().lower()
    auto_index_enabled = policy == "on" or (
        policy == "auto" and engine_type not in _LOCAL_INFERENCE_ENGINE_TYPES
    )
    skills_message = (
        context_builder.build_skills_system_message(tool_statuses=statuses)
        if auto_index_enabled
        else ""
    )
    if skills_message:
        messages.append({"role": "system", "content": skills_message})
    invoked_builder = getattr(context_builder, "build_invoked_skill_system_message", None)
    invoked_skill_message = invoked_builder(skill_invocation) if callable(invoked_builder) else ""
    if invoked_skill_message:
        messages.append({"role": "system", "content": invoked_skill_message})
    delegated_overlay_builder = getattr(
        context_builder,
        "build_delegated_runtime_system_messages",
        None,
    )
    if callable(delegated_overlay_builder):
        for content in delegated_overlay_builder():
            messages.append({"role": "system", "content": content})
    return messages


def build_prompt_memory_recall_system_message(
    *,
    context_builder: ContextBuilder,
    memory_store: Any,
    latest_user_content: str,
    memory_policy: Any = None,
    log_context: RuntimeOverlayLogContext,
) -> str:
    """Recall and render approved memories as a runtime-only system overlay."""
    if memory_policy is not None and not bool(getattr(memory_policy, "enabled", True)):
        return ""
    normalized_query = str(
        getattr(memory_policy, "recall_query", "") or latest_user_content or ""
    ).strip()
    if not normalized_query:
        return ""

    if memory_store is None:
        return ""
    try:
        service = (
            memory_store
            if isinstance(memory_store, MemoryService)
            else MemoryService(memory_store)
        )
        memories = service.recall_for_prompt(
            normalized_query,
            policy=memory_policy,
            limit=PROMPT_MEMORY_RECALL_LIMIT,
        )
    except Exception as error:  # noqa: BLE001
        log_event(
            log_context.logger,
            logging.WARNING,
            component=log_context.component,
            event=log_context.event,
            message="Memory prompt recall failed closed.",
            status="error",
            request_id=log_context.request_id,
            session_id=log_context.session_id,
            data={"error_type": type(error).__name__},
        )
        return ""

    return context_builder.build_memory_recall_system_message(memories)


def append_repository_delta_runtime_system_message(
    runtime_system_messages: list[str],
    *,
    config: Any,
    context_builder: ContextBuilder,
    session_id: str | None,
    log_context: RuntimeOverlayLogContext,
) -> None:
    """Append the one-shot ``<repository-delta>`` overlay when the repo moved.

    Flag-gated (``config.repo_delta_resume_enabled``) and fail-closed: the
    underlying service already swallows every error, but any import or
    attribute failure here also degrades to a no-op so a resume-orientation
    signal can never break a turn. The service is imported lazily so this
    module's static import fan-out (and the flag-off hot path) stays unchanged.
    """
    if not getattr(config, "repo_delta_resume_enabled", False):
        return
    try:
        from sidecar.ai.repo_delta.service import build_repository_delta_block

        block = build_repository_delta_block(
            config=config,
            session_id=session_id,
            workspace_root=context_builder.workspace_root,
        )
    except Exception as error:  # noqa: BLE001
        log_event(
            log_context.logger,
            logging.WARNING,
            component=log_context.component,
            event=log_context.event,
            message="Repository delta overlay failed closed.",
            status="error",
            request_id=log_context.request_id,
            session_id=log_context.session_id,
            data={"error_type": error.__class__.__name__},
        )
        return
    if block:
        runtime_system_messages.append(block)


_MODEL_IDENTITY_FIELD_MAX_CHARS = 120


def _render_model_identity_block(*, provider: str, model: str) -> str:
    """Render the ``## Runtime Model Identity`` block, or ``""`` when nothing is known.

    Reuses the same config fields ``build_model_identity_fingerprint``
    (``sidecar/runtime/approval_plan.py``) hashes -- ``provider``, ``model`` --
    so the prompt-visible identity always matches the fingerprinted one.
    Renders nothing when both ``provider`` and ``model`` are blank, since an
    identity with neither is not worth asserting. Each field is
    whitespace-collapsed and length-capped (``_MODEL_IDENTITY_FIELD_MAX_CHARS``)
    before rendering, since these are config-sourced strings and AGENTS.md 4/9
    still require this render to survive an oversized or newline-bearing value
    without bloating or corrupting the prompt.
    """
    provider = " ".join(str(provider or "").split())[:_MODEL_IDENTITY_FIELD_MAX_CHARS]
    model = " ".join(str(model or "").split())[:_MODEL_IDENTITY_FIELD_MAX_CHARS]
    if not provider and not model:
        return ""
    facts = [f"provider: {provider or 'unknown'}", f"model: {model or 'unknown'}"]
    return (
        f"{runtime_message_markers.MODEL_IDENTITY_HEADING}\n"
        f"{' | '.join(facts)}\n"
        "This is the authoritative identity of the model and engine currently serving "
        "this request; rely on it instead of guessing your own version or provider details."
    )


def append_model_identity_runtime_system_message(
    runtime_system_messages: list[str],
    *,
    config: Any,
    log_context: RuntimeOverlayLogContext,
) -> None:
    """Append the authoritative ``## Runtime Model Identity`` overlay for this request.

    Flag-gated (``config.model_identity_overlay_enabled``, default on) and
    fail-closed: any attribute-access failure degrades to a no-op so a
    self-identity signal can never break a turn. Built per-request (not cached
    at boot) so the block always reflects the engine/model actually serving the
    CURRENT request, which can change between turns.
    """
    if not getattr(config, "model_identity_overlay_enabled", True):
        return
    try:
        block = _render_model_identity_block(
            provider=str(getattr(config, "engine_type", "") or ""),
            model=str(getattr(config, "model", "") or ""),
        )
    except Exception as error:  # noqa: BLE001
        log_event(
            log_context.logger,
            logging.WARNING,
            component=log_context.component,
            event=log_context.event,
            message="Model identity overlay failed closed.",
            status="error",
            request_id=log_context.request_id,
            session_id=log_context.session_id,
            data={"error_type": error.__class__.__name__},
        )
        return
    if block:
        runtime_system_messages.append(block)


_SESSION_ENVIRONMENT_HASH_CAP = 64
# Per-process FIFO of each session's last prompt-visible capability hash. The
# hard cap prevents long-lived sidecars from retaining unbounded session state.
_SESSION_ENVIRONMENT_LAST_HASHES: dict[str, str] = {}
_SESSION_ENVIRONMENT_LAST_HASHES_LOCK = threading.Lock()


def _display_workspace_path(path: Path) -> str:
    """Render a workspace path with a ``~`` prefix when it is under home."""
    try:
        relative = path.relative_to(Path.home())
    except ValueError:
        return str(path)
    return "~" if not relative.parts else str(Path("~") / relative)


def _session_capability_changed(session_id: str | None, capability_hash: str) -> bool:
    """Record a session hash and report whether its previous value differed."""
    normalized_session_id = str(session_id or "").strip()
    if not normalized_session_id:
        return False
    with _SESSION_ENVIRONMENT_LAST_HASHES_LOCK:
        previous_hash = _SESSION_ENVIRONMENT_LAST_HASHES.get(normalized_session_id)
        if (
            previous_hash is None
            and len(_SESSION_ENVIRONMENT_LAST_HASHES) >= _SESSION_ENVIRONMENT_HASH_CAP
        ):
            oldest_session_id = next(iter(_SESSION_ENVIRONMENT_LAST_HASHES))
            _SESSION_ENVIRONMENT_LAST_HASHES.pop(oldest_session_id)
        _SESSION_ENVIRONMENT_LAST_HASHES[normalized_session_id] = capability_hash
    return previous_hash is not None and previous_hash != capability_hash


def _python_runtime_environment_status(config: Any) -> str:
    """Describe the managed Python runtime without triggering its build."""
    if not getattr(config, "tools_python_runtime_enabled", False):
        return "disabled"

    from sidecar.ai.tools.builtins.python_runtime.interpreter import (
        _ready_marker,
        _venv_dir,
    )

    if _ready_marker(_venv_dir(config)).exists():
        return "available"
    return "not built (first use may take minutes)"


def _render_session_environment_block(
    *,
    config: Any,
    context_builder: ContextBuilder,
    tool_schemas: Any,
    session_id: str | None,
) -> str:
    """Render authoritative machine, workspace, and tool-surface facts."""
    from sidecar.ai.tools.builtins import git_ops, shell

    workspace_root = context_builder.workspace_status().root
    root = Path(workspace_root) if workspace_root is not None else None
    if root is None:
        workspace_line = (
            "workspace_root: <not set — tools that need a workspace are blocked "
            "until one is configured>"
        )
    else:
        workspace_line = f"workspace_root: {_display_workspace_path(root)}"

    is_windows = os.name == "nt"
    lines = [
        runtime_message_markers.SESSION_ENVIRONMENT_HEADING,
        "Authoritative facts about the machine and workspace serving this request.",
        "Do not guess or infer any of them.",
        "",
        workspace_line,
        (
            f"path_style: {'windows_backslash' if is_windows else 'posix_slash'}   "
            f"path_separator: {os.sep}   "
            f"case_sensitive_paths: {'no' if is_windows else 'yes'}"
        ),
        f"platform: {sys.platform}   shell: {shell._shell_name()}",
    ]
    if root is not None:
        git_root = git_ops._find_git_root(root, root)
        if git_root is None:
            lines.append("git_repo: no   repo_root: none")
        else:
            rendered_repo_root = (
                "same as workspace_root"
                if git_root == root
                else _display_workspace_path(git_root)
            )
            lines.append(f"git_repo: yes   repo_root: {rendered_repo_root}")

    capability_hash = request_fingerprint.tool_schema_capability_hash(tool_schemas)
    lines.extend(
        [
            f"python_runtime: {_python_runtime_environment_status(config)}",
            f"capability_snapshot: {capability_hash}",
        ]
    )
    if _session_capability_changed(session_id, capability_hash):
        lines.append(
            "capability_snapshot changed since the previous turn; "
            "re-read Executable Tools."
        )
    lines.extend(
        [
            "",
            "Every relative path in tool arguments and output is relative to "
            "workspace_root.",
            "There is no /workspace, /repo, or /app on this machine.",
        ]
    )
    return "\n".join(lines)


def append_session_environment_runtime_system_message(  # noqa: PLR0913
    runtime_system_messages: list[str],
    *,
    config: Any,
    context_builder: ContextBuilder,
    tool_schemas: Any,
    session_id: str | None,
    log_context: RuntimeOverlayLogContext,
) -> None:
    """Append the authoritative ``## Session Environment`` request overlay.

    Flag-gated (``config.session_environment_overlay_enabled``, default on)
    and fail-closed: any source or render failure degrades to a no-op so this
    orientation signal can never break a turn. Built for every request so the
    workspace and post-budget tool surface cannot go stale between turns.
    """
    if not getattr(config, "session_environment_overlay_enabled", True):
        return
    try:
        block = _render_session_environment_block(
            config=config,
            context_builder=context_builder,
            tool_schemas=tool_schemas,
            session_id=session_id,
        )
    except Exception as error:  # noqa: BLE001
        log_event(
            log_context.logger,
            logging.WARNING,
            component=log_context.component,
            event=log_context.event,
            message="Session environment overlay failed closed.",
            status="error",
            request_id=log_context.request_id,
            session_id=log_context.session_id,
            data={"error_type": error.__class__.__name__},
        )
        return
    runtime_system_messages.append(block)


# Stable re-exports: the interruption overlay cluster (render, ledger merge,
# append) moved to interruption_overlay.py to keep this module under the
# 600-line ratchet (W8-S3); every consumer imports the names from here.
from sidecar.ai.context.interruption_overlay import (  # noqa: E402, F401
    INTERRUPTED_TURN_MAX_ENTRIES_PER_SECTION,
    _render_interrupted_turn_receipts_block,
    append_interrupted_turn_receipts_runtime_system_message,
    merge_ledger_interruptions,
)
