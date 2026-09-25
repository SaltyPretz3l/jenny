"""Workspace-driven context builder for declarative bootstrap and skill files."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sidecar.ai.context.builder_render import _BuilderRenderMixin
from sidecar.ai.context.builder_shared import (
    _UNSET_ROOT as _UNSET_ROOT,
)
from sidecar.ai.context.builder_shared import (
    BOOTSTRAP_DIRNAME as BOOTSTRAP_DIRNAME,
)
from sidecar.ai.context.builder_shared import (
    BOOTSTRAP_FILES as BOOTSTRAP_FILES,
)
from sidecar.ai.context.builder_shared import (
    LOGGER as LOGGER,
)
from sidecar.ai.context.builder_shared import (
    MAX_WORKSPACE_CONTEXT_PROMPT_BYTES,
    REASONING_STATUS_BLOCK_LEGACY,
    REASONING_STATUS_BLOCK_V2,
)
from sidecar.ai.context.builder_shared import (
    MAX_WORKSPACE_INSTRUCTION_BYTES as MAX_WORKSPACE_INSTRUCTION_BYTES,
)
from sidecar.ai.context.builder_shared import (
    REASONING_STATUS_MAX_WORDS as REASONING_STATUS_MAX_WORDS,
)
from sidecar.ai.context.builder_shared import (
    REASONING_STATUS_MIN_WORDS as REASONING_STATUS_MIN_WORDS,
)
from sidecar.ai.context.builder_shared import (
    RUNTIME_SYSTEM_MESSAGE_HEADINGS as RUNTIME_SYSTEM_MESSAGE_HEADINGS,
)
from sidecar.ai.context.builder_shared import (
    WORKSPACE_INSTRUCTION_FILENAME as WORKSPACE_INSTRUCTION_FILENAME,
)
from sidecar.ai.context.builder_shared import (
    LearnedLesson as LearnedLesson,
)
from sidecar.ai.context.builder_shared import (
    RecalledMemory as RecalledMemory,
)
from sidecar.ai.context.builder_shared import (
    RuntimeToolStatus as RuntimeToolStatus,
)
from sidecar.ai.context.builder_shared import (
    SkillScope as SkillScope,
)
from sidecar.ai.context.builder_shared import (
    WorkspaceStatus as WorkspaceStatus,
)
from sidecar.ai.context.builder_shared import (
    _sanitize_bootstrap_content as _sanitize_bootstrap_content,
)
from sidecar.ai.context.builder_shared import (
    looks_like_current_info_request as looks_like_current_info_request,
)
from sidecar.ai.context.builder_shared import (
    looks_like_source_architecture_request as looks_like_source_architecture_request,
)
from sidecar.ai.context.builder_skills import _BuilderSkillsMixin
from sidecar.ai.context.builder_workspace_files import _BuilderWorkspaceFilesMixin
from sidecar.ai.context.context_io import (
    bound_workspace_context_sources,
)
from sidecar.ai.host_policy import host_policy_is_enforced
from sidecar.runtime.diagnostics import log_event  # noqa: F401

if TYPE_CHECKING:
    from sidecar.ai.context.prompt_cache import StructuredSystemPrompt

def request_workspace_root_kwargs(config: Any, execution_context: Any | None) -> dict[str, Any]:
    """Prompt-build kwargs carrying the request authority's root.

    Shared by every prompt-build call site so the precedence has one owner:
    a captured ``ExecutionContext`` supplies ``request_workspace_root`` (its
    ``root_path``, ``None`` when the project is unbound); a request without
    that carrier passes nothing and keeps the builder root. Hosted policy is
    the deliberate exception -- the container already hides the builder root
    there, and the request root must not become prompt/bootstrap context
    either -- so an enforced host policy also passes nothing.
    """
    if execution_context is None or host_policy_is_enforced(config):
        return {}
    return {"request_workspace_root": getattr(execution_context, "root_path", None)}


class ContextBuilder(_BuilderSkillsMixin, _BuilderWorkspaceFilesMixin, _BuilderRenderMixin):
    def __init__(
        self,
        workspace_root: Path | None,
        *,
        skill_scopes: tuple[SkillScope, ...] = (),
        disabled_skill_ids: tuple[str, ...] = (),
        skills_system_enabled: bool = False,
        strict_skill_loading: bool = False,
        runtime_overlay_provider: Callable[[], Sequence[str]] | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._skill_scopes = skill_scopes
        self._disabled_skill_ids = frozenset(disabled_skill_ids)
        self._skills_system_enabled = skills_system_enabled is True
        self._strict_skill_loading = strict_skill_loading is True
        # Generic injected seam. The default path has no plugin import and no
        # package/user-data access; Stage 4 wires a lazy provider explicitly.
        self._runtime_overlay_provider = runtime_overlay_provider
        self._cached_bootstrap_blocks: list[str] | None = None
        self._cached_bootstrap_mtime: str | None = None
        self._cached_skill_entries = None
        self._cached_skill_dir_mtime: str | None = None
        self._cached_skill_file_mtimes: dict[str, int] | None = None
        self._cached_skill_at_monotonic: float | None = None
        self._cached_workspace_instruction_block: str | None = None
        self._cached_workspace_instruction_mtime: str | None = None
        self._cache_lock = threading.RLock()

    @property
    def workspace_root(self) -> Path | None:
        return self._workspace_root

    def _effective_workspace_root(self, request_workspace_root: Any) -> Path | None:
        """Resolve the root every workspace-derived prompt block reads from.

        The captured request authority wins when the caller supplies one --
        including an explicitly unbound (``None``) root, which renders no
        bootstrap, ``agentj.md``, manifest, or task-capsule block at all. Only
        a caller that passes nothing falls back to the process-wide root, so
        the global ``tools_workspace_root`` can never leak into a session whose
        project has no folder bound.
        """
        if request_workspace_root is _UNSET_ROOT:
            return self._workspace_root
        if request_workspace_root is None:
            return None
        return Path(str(request_workspace_root)).expanduser()

    def workspace_status(self) -> WorkspaceStatus:
        root = self._workspace_root
        if root is None:
            return WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        bootstrap_loaded = len(self._load_bootstrap_blocks())
        skills_loaded = len(self._load_skills())
        workspace_instruction_block = self._load_workspace_instruction_block()
        return WorkspaceStatus(
            root=str(root),
            exists=root.exists(),
            skills_loaded=skills_loaded,
            bootstrap_loaded=bootstrap_loaded,
            instruction_file_name=WORKSPACE_INSTRUCTION_FILENAME,
            instruction_file_present=bool(workspace_instruction_block),
        )

    def build_system_prompt(
        self,
        runtime_system_prompt: str,
        learned_lessons: list[LearnedLesson] | None = None,
        include_reasoning_status_markers: bool = False,
        *,
        reasoning_status_v2: bool = False,
        cache_aware: bool = False,
        session_start_date: str | None = None,
        current_date: str | None = None,
        tool_statuses: list[RuntimeToolStatus] | tuple[RuntimeToolStatus, ...] | None = None,
        latest_user_content: str = "",
        engine_type: str = "",
        include_skills: bool = True,
        include_bootstrap: bool = True,
        workspace_manifest_enabled: bool = False,
        task_capsule_enabled: bool = False,
        request_workspace_root: Any = _UNSET_ROOT,
    ) -> str | "StructuredSystemPrompt":
        """Build the system prompt from workspace content.

        When *cache_aware* is ``True`` returns a
        :class:`StructuredSystemPrompt` with cacheable/non-cacheable
        section metadata.  Otherwise returns a plain ``str`` (backward
        compatible default).

        *request_workspace_root* is the request authority's root
        (``ExecutionContext.root_path``); ``None`` means explicitly unbound.
        See :meth:`_effective_workspace_root`.
        """
        workspace_root = self._effective_workspace_root(request_workspace_root)
        bootstrap_blocks = (
            self._load_bootstrap_blocks(workspace_root) if include_bootstrap else []
        )
        current_date_block = self._render_pinned_current_date_block(current_date)
        skills_block = self._render_skills(tool_statuses=tool_statuses) if include_skills else ""
        workspace_instruction_block = self._load_workspace_instruction_block(workspace_root)
        bounded_context = bound_workspace_context_sources(
            bootstrap_blocks,
            skills_block,
            workspace_instruction_block,
            max_bytes=MAX_WORKSPACE_CONTEXT_PROMPT_BYTES,
        )
        bootstrap_blocks = list(bounded_context.bootstrap_blocks)
        skills_block = bounded_context.skills_block
        workspace_instruction_block = bounded_context.instruction_block
        for source_kind in bounded_context.truncated_sources:
            self._log_partial_context(
                source_kind=source_kind,
                source_name="aggregate",
                reason="aggregate_workspace_context_budget",
            )
        prompt_blocks = [runtime_system_prompt.strip()]
        prompt_blocks.extend(bootstrap_blocks)
        if current_date_block:
            prompt_blocks.append(current_date_block)
        executable_tools_block = self._render_executable_tools(tool_statuses)
        if executable_tools_block:
            prompt_blocks.append(executable_tools_block)
        requested_tool_block = self._render_requested_tool_availability(
            tool_statuses=tool_statuses,
            latest_user_content=latest_user_content,
        )
        if requested_tool_block:
            prompt_blocks.append(requested_tool_block)
        tool_format_hint = self._render_tool_calling_format_hint(engine_type, tool_statuses)
        if tool_format_hint:
            prompt_blocks.append(tool_format_hint)
        tool_loop_guidance_block = self._render_tool_loop_guidance(tool_statuses)
        if tool_loop_guidance_block:
            prompt_blocks.append(tool_loop_guidance_block)
        subagent_guidance_block = self._render_subagent_selection_guidance(tool_statuses)
        if subagent_guidance_block:
            prompt_blocks.append(subagent_guidance_block)
        if skills_block:
            prompt_blocks.append(skills_block)
        if workspace_instruction_block:
            prompt_blocks.append(workspace_instruction_block)
        workspace_manifest_block = self._render_workspace_manifest_block(
            enabled=workspace_manifest_enabled,
            workspace_root=workspace_root,
        )
        if workspace_manifest_block:
            prompt_blocks.append(workspace_manifest_block)
        task_capsule_block = self._render_task_capsule_block(
            enabled=task_capsule_enabled,
            workspace_root=workspace_root,
            latest_user_content=latest_user_content,
            tool_statuses=tool_statuses,
        )
        if task_capsule_block:
            prompt_blocks.append(task_capsule_block)
        current_info_block = self._render_current_info_guidance(
            tool_statuses=tool_statuses,
            latest_user_content=latest_user_content,
        )
        if current_info_block:
            prompt_blocks.append(current_info_block)
        workspace_source_block = self._render_workspace_source_guidance(
            tool_statuses=tool_statuses,
            latest_user_content=latest_user_content,
            workspace_root=workspace_root,
        )
        if workspace_source_block:
            prompt_blocks.append(workspace_source_block)
        if include_reasoning_status_markers:
            prompt_blocks.append(
                self._reasoning_status_block(reasoning_status_v2=reasoning_status_v2)
            )
        learned_lessons_block = self._render_learned_lessons(learned_lessons or [])
        if learned_lessons_block:
            prompt_blocks.append(learned_lessons_block)

        if not cache_aware:
            return "\n\n".join(block for block in prompt_blocks if block)

        from sidecar.ai.context.prompt_cache import (
            CacheSection,
            build_structured_system_prompt,
        )

        sections: list[CacheSection] = []
        static_blocks = [
            runtime_system_prompt.strip(),
            *bootstrap_blocks,
        ]
        if current_date_block:
            static_blocks.append(current_date_block)
        for block in static_blocks:
            if block:
                sections.append(CacheSection(name="static", content=block, cacheable=True))
        if executable_tools_block:
            sections.append(
                CacheSection(
                    name="executable_tools",
                    content=executable_tools_block,
                    cacheable=False,
                )
            )
        if requested_tool_block:
            sections.append(
                CacheSection(
                    name="requested_tool_availability",
                    content=requested_tool_block,
                    cacheable=False,
                )
            )
        if tool_format_hint:
            sections.append(
                CacheSection(
                    name="tool_calling_format_hint",
                    content=tool_format_hint,
                    cacheable=False,
                )
            )
        if tool_loop_guidance_block:
            sections.append(
                CacheSection(
                    name="tool_loop_guidance",
                    content=tool_loop_guidance_block,
                    cacheable=False,
                )
            )
        if subagent_guidance_block:
            sections.append(
                CacheSection(
                    name="subagent_selection_guidance",
                    content=subagent_guidance_block,
                    cacheable=False,
                )
            )
        if skills_block:
            sections.append(
                CacheSection(
                    name="skills",
                    content=skills_block,
                    cacheable=tool_statuses is None,
                )
            )
        if workspace_instruction_block:
            sections.append(
                CacheSection(
                    name="workspace_instructions",
                    content=workspace_instruction_block,
                    cacheable=False,
                )
            )
        if workspace_manifest_block:
            sections.append(
                CacheSection(
                    name="workspace_manifest",
                    content=workspace_manifest_block,
                    cacheable=False,
                )
            )
        if task_capsule_block:
            sections.append(
                CacheSection(
                    name="task_capsule",
                    content=task_capsule_block,
                    cacheable=False,
                )
            )
        if current_info_block:
            sections.append(
                CacheSection(
                    name="current_info_guidance",
                    content=current_info_block,
                    cacheable=False,
                )
            )
        if workspace_source_block:
            sections.append(
                CacheSection(
                    name="workspace_source_guidance",
                    content=workspace_source_block,
                    cacheable=False,
                )
            )
        if include_reasoning_status_markers:
            sections.append(
                CacheSection(
                    name="reasoning_status",
                    content=self._reasoning_status_block(
                        reasoning_status_v2=reasoning_status_v2
                    ),
                    cacheable=True,
                )
            )
        if learned_lessons_block:
            sections.append(
                CacheSection(
                    name="learned_lessons",
                    content=learned_lessons_block,
                    cacheable=False,
                )
            )
        return build_structured_system_prompt(
            sections,
            session_start_date=session_start_date or "",
            current_date=current_date or "",
        )

    @staticmethod
    def _reasoning_status_block(*, reasoning_status_v2: bool = False) -> str:
        if reasoning_status_v2:
            return REASONING_STATUS_BLOCK_V2
        return REASONING_STATUS_BLOCK_LEGACY

    @staticmethod
    def is_skills_system_message(content: Any) -> bool:
        return str(content or "").startswith("## Runtime Skills Overlay")

    @staticmethod
    def is_runtime_system_message(content: Any) -> bool:
        return str(content or "").startswith(RUNTIME_SYSTEM_MESSAGE_HEADINGS)

    def insert_runtime_system_messages(
        self,
        working_messages: list[dict[str, object]],
        runtime_messages: list[str] | tuple[str, ...],
    ) -> list[dict[str, object]]:
        overlay_messages: list[dict[str, object]] = [
            {"role": "system", "content": content.strip()}
            for content in runtime_messages
            if isinstance(content, str) and content.strip()
        ]
        filtered_messages = [
            dict(message)
            for message in working_messages
            if not (
                str(message.get("role") or "").strip().lower() == "system"
                and self.is_runtime_system_message(message.get("content"))
            )
        ]
        if not overlay_messages:
            return filtered_messages

        insertion_index = len(filtered_messages)
        for index, message in enumerate(filtered_messages):
            if str(message.get("role") or "").strip().lower() != "system":
                insertion_index = index
                break
        return [
            *filtered_messages[:insertion_index],
            *overlay_messages,
            *filtered_messages[insertion_index:],
        ]

    def build_delegated_runtime_system_messages(self) -> tuple[str, ...]:
        provider = self._runtime_overlay_provider
        if provider is None:
            return ()
        # Do not turn an admitted plugin turn into core-only after authority was
        # accepted. A provider failure must abort that turn before output.
        values = provider()
        return tuple(value for value in values if isinstance(value, str) and value.strip())

    @staticmethod
    def _log_partial_context(*, source_kind: str, source_name: str, reason: str) -> None:
        log_event(
            LOGGER,
            logging.WARNING,
            component="ai.context.builder",
            event="ai.context.workspace_context_partial",
            message="Workspace prompt context was partially loaded.",
            status="degraded",
            data={
                "source_kind": source_kind,
                "source_name": source_name,
                "reason": reason,
            },
        )

def normalize_learned_lessons(value: Any) -> list[LearnedLesson]:
    if not isinstance(value, dict):
        return []
    raw_lessons = value.get("lessons")
    if not isinstance(raw_lessons, list):
        return []

    lessons: list[LearnedLesson] = []
    for candidate in raw_lessons:
        if not isinstance(candidate, dict):
            continue
        raw_title = candidate.get("title")
        raw_lesson_text = candidate.get("lesson_text")
        if not isinstance(raw_title, str) or not raw_title.strip():
            continue
        if not isinstance(raw_lesson_text, str) or not raw_lesson_text.strip():
            continue
        raw_confidence = candidate.get("confidence", 0.0)
        confidence = float(raw_confidence) if isinstance(raw_confidence, (int, float)) else 0.0
        raw_lesson_kind = candidate.get("lesson_kind")
        lesson_kind = (
            raw_lesson_kind.strip()
            if isinstance(raw_lesson_kind, str) and raw_lesson_kind.strip()
            else "unknown"
        )
        lessons.append(
            LearnedLesson(
                title=raw_title.strip(),
                lesson_text=raw_lesson_text.strip(),
                confidence=confidence,
                lesson_kind=lesson_kind,
            )
        )
    return lessons
