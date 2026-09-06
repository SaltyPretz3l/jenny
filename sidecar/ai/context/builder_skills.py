"""Skill loading and rendering mixin for the context builder."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from sidecar.ai.context.builder_shared import (
    CMP_CTX_SKILL_INVALID,
    LOGGER,
    MAX_SKILL_DEPTH,
    MAX_SKILL_DISCOVERY_ENTRIES,
    MAX_SKILL_DISCOVERY_SECONDS,
    MAX_SKILL_FILE_BYTES,
    MAX_SKILL_FILES,
    MAX_SKILL_PROMPT_BYTES,
    SKILL_CACHE_TTL_SECONDS,
    RuntimeToolStatus,
    SkillEntry,
    SkillScope,
    ToolExecutionFailure,
    _extract_frontmatter,
    _skill_dedupe_key,
    _split_frontmatter,
)
from sidecar.ai.context.context_io import (
    discover_skill_files,
    read_bounded_context_text,
    truncate_utf8,
)


class _BuilderSkillsMixin:
    # Hub-owned state (set in ContextBuilder.__init__); bare annotations tell mypy
    # the concrete types when this mixin is checked in isolation. No runtime effect.
    _workspace_root: Path | None
    _skill_scopes: tuple[SkillScope, ...]
    _disabled_skill_ids: frozenset[str]
    _skills_system_enabled: bool
    _strict_skill_loading: bool
    _cached_skill_entries: list[SkillEntry] | None
    _cached_skill_dir_mtime: str | None
    _cached_skill_file_mtimes: dict[str, int] | None
    _cached_skill_at_monotonic: float | None
    _cache_lock: Any

    def build_skills_system_message(
        self,
        *,
        tool_statuses: list[RuntimeToolStatus] | tuple[RuntimeToolStatus, ...] | None = None,
    ) -> str:
        skills_block = self._render_skills(tool_statuses=tool_statuses)
        if not skills_block:
            return ""
        return (
            "## Runtime Skills Overlay\n"
            "These bundled, user, and project skills are layered as request-time "
            "system guidance so the cache-stable base prompt is not rewritten.\n\n"
            f"{skills_block}"
        )

    def build_invoked_skill_system_message(
        self,
        skill_invocation: dict[str, str] | None,
    ) -> str:
        skill_id = skill_invocation.get("id") if isinstance(skill_invocation, dict) else None
        if not isinstance(skill_id, str) or not skill_id:
            return ""
        for entry in self._load_skills():
            if self._skill_id(entry) != skill_id:
                continue
            message = f"## Invoked Skill: {entry.name}\n{entry.body}"
            return truncate_utf8(message, MAX_SKILL_FILE_BYTES)[0]
        import sidecar.ai.context.builder as _builder_hub

        _builder_hub.log_event(
            LOGGER,
            logging.WARNING,
            component="ai.context.builder",
            event="ai.context.skill_invocation_unresolved",
            message="Invoked skill was not available in the enabled skill catalog.",
            status="skipped",
            data={"id": skill_id},
        )
        return ""

    @staticmethod
    def _skill_id(entry: SkillEntry) -> str:
        skill_slug = (
            entry.rel_path.removesuffix("/SKILL.md")
            if entry.rel_path.endswith("/SKILL.md")
            else entry.name
        )
        return f"{entry.scope}/{skill_slug}"

    def _skill_files(self) -> list[Path]:
        root = self._workspace_root
        if root is None:
            return []
        skills_root = root / "skills"
        if not skills_root.exists():
            return []
        discovery = self._discover_skills(
            skills_root,
            scope_name="workspace",
            max_files=MAX_SKILL_FILES,
        )
        return list(discovery)

    def _skill_scope_files(self) -> list[tuple[SkillScope, Path]]:
        files: list[tuple[SkillScope, Path]] = []
        for scope in self._skill_scopes:
            if scope.enabled is not True or not scope.root.exists():
                continue
            remaining = MAX_SKILL_FILES - len(files)
            if remaining <= 0:
                import sidecar.ai.context.builder as _builder_hub

                _builder_hub.log_event(
                    LOGGER,
                    logging.WARNING,
                    component="ai.context.builder",
                    event="ai.context.skill_discovery_partial",
                    message="Skill discovery reached its aggregate file budget.",
                    status="degraded",
                    data={"scope": scope.scope, "reason": "aggregate_file_budget"},
                )
                break
            for skill_path in self._discover_skills(
                scope.root,
                scope_name=scope.scope,
                max_files=remaining,
            ):
                files.append((scope, skill_path))
        return files

    @staticmethod
    def _discover_skills(
        root: Path,
        *,
        scope_name: str,
        max_files: int,
    ) -> tuple[Path, ...]:
        import sidecar.ai.context.builder as _builder_hub

        discovery = discover_skill_files(
            root,
            max_depth=MAX_SKILL_DEPTH,
            max_entries=MAX_SKILL_DISCOVERY_ENTRIES,
            max_files=max_files,
            max_seconds=MAX_SKILL_DISCOVERY_SECONDS,
        )
        for reason in discovery.truncation_reasons:
            _builder_hub.log_event(
                LOGGER,
                logging.WARNING,
                component="ai.context.builder",
                event="ai.context.skill_discovery_partial",
                message="Skill discovery completed with bounded omissions.",
                status="degraded",
                data={"scope": scope_name, "reason": reason},
            )
        return discovery.files

    def _load_skills(self) -> list[SkillEntry]:
        with self._cache_lock:
            return self._load_skills_locked()

    def _load_skills_locked(self) -> list[SkillEntry]:
        if self._cached_skill_entries is not None and self._skill_cache_valid():
            return self._cached_skill_entries
        entries, file_paths = self._load_skills_uncached()
        self._cached_skill_entries = entries
        self._cached_skill_dir_mtime = self._skill_dir_mtime_key()
        self._cached_skill_at_monotonic = time.monotonic()
        self._cached_skill_file_mtimes = {}
        for fp in file_paths:
            try:
                self._cached_skill_file_mtimes[str(fp)] = fp.stat().st_mtime_ns
            except OSError:
                pass
        return entries

    def _skill_cache_valid(self) -> bool:
        cached_at = self._cached_skill_at_monotonic
        if cached_at is None or time.monotonic() - cached_at >= SKILL_CACHE_TTL_SECONDS:
            return False
        if self._cached_skill_dir_mtime != self._skill_dir_mtime_key():
            return False
        if self._cached_skill_file_mtimes is None:
            return False
        for path_str, expected_mtime in self._cached_skill_file_mtimes.items():
            try:
                if Path(path_str).stat().st_mtime_ns != expected_mtime:
                    return False
            except OSError:
                return False
        return True

    def _skill_dir_mtime_key(self) -> str:
        parts: list[str] = []
        if self._skills_system_enabled and self._skill_scopes:
            for scope in self._skill_scopes:
                if scope.enabled is not True or not scope.root.exists():
                    continue
                try:
                    parts.append(str(scope.root.stat().st_mtime_ns))
                except OSError:
                    parts.append("0")
        else:
            root = self._workspace_root
            if root is not None:
                skills_dir = root / "skills"
                try:
                    parts.append(str(skills_dir.stat().st_mtime_ns))
                except OSError:
                    parts.append("0")
        return "|".join(parts)

    def _load_skills_uncached(self) -> tuple[list[SkillEntry], list[Path]]:
        import sidecar.ai.context.builder as _builder_hub

        skill_entries: list[SkillEntry] = []
        loaded_paths: list[Path] = []
        seen_realpaths: set[tuple[Any, ...]] = set()
        if self._skills_system_enabled and self._skill_scopes:
            scoped_files = self._skill_scope_files()
        else:
            root = self._workspace_root
            if root is None:
                return [], []
            scoped_files = [
                (SkillScope(scope="workspace", root=root, enabled=True), skill_path)
                for skill_path in self._skill_files()
            ]
        for scope, skill_path in scoped_files:
            try:
                rel_path = str(skill_path.relative_to(scope.root.resolve(strict=True))).replace(
                    "\\", "/"
                )
            except (OSError, ValueError):
                rel_path = "SKILL.md"
            display_path = Path(scope.scope) / rel_path
            try:
                dedupe_key = _skill_dedupe_key(skill_path)
            except OSError:
                dedupe_key = ("path", skill_path)
            if dedupe_key in seen_realpaths:
                continue
            seen_realpaths.add(dedupe_key)
            try:
                read_result = read_bounded_context_text(
                    skill_path,
                    authorized_root=scope.root,
                    max_bytes=MAX_SKILL_FILE_BYTES,
                    truncate=False,
                )
                if read_result.text is None:
                    raise ValueError(read_result.reason or "skill read failed")
                content = read_result.text
                frontmatter, body = _split_frontmatter(content)
                (
                    name,
                    description,
                    command,
                    when_to_use,
                    allowed_tools,
                    always,
                ) = _extract_frontmatter(frontmatter, skill_path=display_path)
                skill_slug = (
                    rel_path.removesuffix("/SKILL.md")
                    if rel_path.endswith("/SKILL.md")
                    else name
                )
                if f"{scope.scope}/{skill_slug}" in self._disabled_skill_ids:
                    continue
                skill_entries.append(
                    SkillEntry(
                        scope=scope.scope,
                        name=name,
                        description=description,
                        command=command,
                        when_to_use=when_to_use,
                        allowed_tools=allowed_tools,
                        always=always,
                        body=body.strip(),
                        rel_path=rel_path,
                    )
                )
                loaded_paths.append(skill_path)
            except (OSError, ToolExecutionFailure, ValueError) as error:
                if self._strict_skill_loading:
                    if isinstance(error, ToolExecutionFailure):
                        raise
                    raise ToolExecutionFailure(
                        code=CMP_CTX_SKILL_INVALID,
                        message=f"failed to load skill file '{display_path}': {error}",
                        retryable=False,
                    ) from error
                error_code = (
                    error.code if isinstance(error, ToolExecutionFailure) else CMP_CTX_SKILL_INVALID
                )
                _builder_hub.log_event(
                    LOGGER,
                    logging.WARNING,
                    component="ai.context.builder",
                    event="ai.context.skill_skipped",
                    message="Skipped invalid skill entry.",
                    status="skipped",
                    data={
                        "scope": scope.scope,
                        "skill_path": f"{scope.scope}/{rel_path}",
                        "error_code": error_code,
                        "error_kind": type(error).__name__,
                    },
                )
        return skill_entries, loaded_paths

    @staticmethod
    def _skill_index_instruction(
        tool_statuses: list[RuntimeToolStatus] | tuple[RuntimeToolStatus, ...] | None,
    ) -> str:
        # tool_statuses is the availability signal already threaded through this
        # render pass; when it is present, only advertise the tool call when
        # load_skill is actually bound and enabled. When absent (caller did not
        # supply status info), keep the instruction unconditional rather than
        # guessing.
        load_skill_available = tool_statuses is None or any(
            status.name == "load_skill" and status.available for status in (tool_statuses or ())
        )
        if load_skill_available:
            return (
                "Use a skill by calling the `load_skill` tool with the name and "
                "scope shown below before following its instructions."
            )
        return (
            "Full skill details are unavailable in this environment because the "
            "`load_skill` tool is not enabled."
        )

    def _render_skills(
        self,
        *,
        tool_statuses: list[RuntimeToolStatus] | tuple[RuntimeToolStatus, ...] | None = None,
    ) -> str:
        import sidecar.ai.context.builder as _builder_hub

        skill_entries = self._load_skills()
        if not skill_entries:
            return ""

        executable_tools = {
            status.name
            for status in (tool_statuses or ())
            if status.available is True and status.name
        }
        inline_blocks: list[str] = []
        indexed_blocks: list[str] = []
        for entry in skill_entries:
            # Legacy workspace-scoped skills have no corresponding load_skill
            # scope. Keep them usable by rendering them inline instead of
            # advertising an impossible tool call.
            if entry.always or entry.scope == "workspace":
                if entry.body:
                    inline_blocks.append(f"## Skill: {entry.name}\n{entry.body}")
                continue
            summary = entry.description or "No description provided."
            detail_parts: list[str] = []
            if entry.when_to_use:
                detail_parts.append(f"When to use: {entry.when_to_use}")
            allowed_tools = entry.allowed_tools
            if tool_statuses is not None:
                filtered_tools = tuple(
                    tool_name for tool_name in allowed_tools if tool_name in executable_tools
                )
                omitted_tools = tuple(
                    tool_name for tool_name in allowed_tools if tool_name not in executable_tools
                )
                if omitted_tools:
                    _builder_hub.log_event(
                        LOGGER,
                        logging.INFO,
                        component="ai.context.builder",
                        event="ai.context.skill_tools_filtered",
                        message=(f"Filtered non-executable tools from skill '{entry.name}'."),
                        status="filtered",
                        data={
                            "scope": entry.scope,
                            "skill": entry.name,
                            "skill_path": entry.rel_path,
                            "filtered_tools": list(omitted_tools),
                        },
                    )
                allowed_tools = filtered_tools
            if allowed_tools:
                detail_parts.append("Allowed tools: " + ", ".join(allowed_tools))
            details_suffix = f" [{' | '.join(detail_parts)}]" if detail_parts else ""
            # The loadable identifier is the complete relative skill directory,
            # not the human-readable frontmatter name. This preserves nested
            # catalog identities end to end.
            # Scope is always included so the call is unambiguous when the
            # same slug exists in more than one scope.
            skill_slug = self._skill_id(entry).removeprefix(f"{entry.scope}/")
            indexed_blocks.append(
                f"- {entry.name}: {summary}{details_suffix} "
                f'(load with load_skill(name="{skill_slug}", scope="{entry.scope}"))'
            )

        blocks: list[str] = []
        if inline_blocks:
            blocks.append("\n\n".join(inline_blocks))
        if indexed_blocks:
            instruction = self._skill_index_instruction(tool_statuses)
            blocks.append("## Available Skills\n" + instruction + "\n" + "\n".join(indexed_blocks))
        rendered = "\n\n".join(blocks)
        bounded, truncated = truncate_utf8(
            rendered,
            MAX_SKILL_PROMPT_BYTES,
            suffix="\n[additional skills omitted: prompt budget reached]",
        )
        if truncated:
            _builder_hub.log_event(
                LOGGER,
                logging.WARNING,
                component="ai.context.builder",
                event="ai.context.skills_prompt_truncated",
                message="Runtime skill guidance reached its aggregate prompt budget.",
                status="degraded",
                data={
                    "skill_count": len(skill_entries),
                    "max_bytes": MAX_SKILL_PROMPT_BYTES,
                },
            )
        return bounded
