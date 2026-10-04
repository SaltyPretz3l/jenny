"""Skill loading and rendering mixin for the context builder."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
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
    _sanitize_bootstrap_content,
    _skill_dedupe_key,
    _split_frontmatter,
)
from sidecar.ai.context.context_io import (
    discover_skill_files,
    read_bounded_context_text,
    truncate_utf8,
)
from sidecar.ai.host_policy import host_policy_is_enforced

_MAX_CACHED_SKILL_AUTHORITIES = 8


@dataclass(frozen=True)
class SkillAuthority:
    """The skill sources one request is allowed to see (hashable cache identity)."""

    scopes: tuple[SkillScope, ...]
    disabled_ids: frozenset[str]
    auto_index: str | None
    legacy_root: Path | None


@dataclass
class _SkillCacheEntry:
    entries: list[SkillEntry]
    dir_mtime: str
    file_mtimes: dict[str, int]
    at_monotonic: float


def resolve_skill_scopes(config: Any) -> tuple[SkillScope, ...]:
    scopes: list[SkillScope] = []
    candidates = (
        ("bundled", "skills_bundled_root", "skills_bundled_enabled"),
        ("user", "skills_user_root", "skills_user_enabled"),
        ("project", "skills_project_root", "skills_project_enabled"),
    )
    for scope_name, root_key, enabled_key in candidates:
        raw_root = getattr(config, root_key, None)
        if raw_root is None:
            continue
        scopes.append(
            SkillScope(
                scope=scope_name,
                root=Path(raw_root).expanduser(),
                enabled=getattr(config, enabled_key, None) is True,
            )
        )
    return tuple(scopes)


def request_skill_config_fields(execution_context: Any) -> dict[str, Any]:
    """The ``skills_*`` config overrides a request's captured authority applies.

    The one owner of that precedence: ``tool_resolution._request_scoped_config``
    and :func:`request_skill_authority` both read it, so the prompt and the tool
    configuration cannot disagree. The project scope always follows the request;
    the remaining fields only when the carrier has a ``skills_config``.
    """
    skills = getattr(execution_context, "skills_config", None)
    fields: dict[str, Any] = {
        "skills_project_root": getattr(skills, "project_root", None),
        "skills_project_enabled": bool(getattr(skills, "project_enabled", False)),
    }
    if skills is not None:
        fields.update({
            "skills_bundled_root": skills.bundled_root,
            "skills_user_root": skills.user_root,
            "skills_bundled_enabled": skills.bundled_enabled,
            "skills_user_enabled": skills.user_enabled,
            "skills_disabled_ids": skills.disabled_ids,
            "skills_auto_index": skills.auto_index,
        })
    return fields


class _ConfigOverlay:
    """Attribute view of *config* with the request's field overrides on top."""

    def __init__(self, config: Any, fields: dict[str, Any]) -> None:
        self._config = config
        self._fields = fields

    def __getattr__(self, name: str) -> Any:
        if name in self._fields:
            return self._fields[name]
        return getattr(self._config, name, None)


def request_skill_authority(config: Any, execution_context: Any | None) -> SkillAuthority | None:
    """The request's skill authority; ``None`` (startup scopes) without a carrier.

    Hosted policy keeps the request root out of prompt context, so the legacy
    ``<root>/skills`` fallback has no root there (as the container's builder).
    """
    if execution_context is None:
        return None
    effective = _ConfigOverlay(config, request_skill_config_fields(execution_context))
    root_path = getattr(execution_context, "root_path", None)
    if host_policy_is_enforced(config):
        root_path = None
    return SkillAuthority(
        scopes=resolve_skill_scopes(effective),
        disabled_ids=frozenset(effective.skills_disabled_ids or ()),
        auto_index=effective.skills_auto_index,
        legacy_root=Path(str(root_path)) if root_path is not None else None,
    )


class _BuilderSkillsMixin:
    # Hub-owned state (set in ContextBuilder.__init__); bare annotations tell mypy
    # the concrete types when this mixin is checked in isolation. No runtime effect.
    _workspace_root: Path | None
    _skill_scopes: tuple[SkillScope, ...]
    _disabled_skill_ids: frozenset[str]
    _skills_system_enabled: bool
    _strict_skill_loading: bool
    _skill_cache: dict[SkillAuthority | None, _SkillCacheEntry]
    _cache_lock: Any

    def build_skills_system_message(
        self,
        *,
        tool_statuses: list[RuntimeToolStatus] | tuple[RuntimeToolStatus, ...] | None = None,
        skill_authority: SkillAuthority | None = None,
    ) -> str:
        skills_block = self._render_skills(
            tool_statuses=tool_statuses, skill_authority=skill_authority
        )
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
        skill_authority: SkillAuthority | None = None,
    ) -> str:
        skill_id = skill_invocation.get("id") if isinstance(skill_invocation, dict) else None
        if not isinstance(skill_id, str) or not skill_id:
            return ""
        for entry in self._load_skills(skill_authority):
            if self._skill_id(entry) != skill_id:
                continue
            message = _sanitize_bootstrap_content(
                f"## Invoked Skill: {entry.name}\n{entry.body}", source_name="invoked_skill"
            )
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

    def _skill_files(self, root: Path | None) -> list[Path]:
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

    def _skill_scope_files(
        self, scopes: tuple[SkillScope, ...]
    ) -> list[tuple[SkillScope, Path]]:
        files: list[tuple[SkillScope, Path]] = []
        for scope in scopes:
            if scope.enabled is not True or not scope.root.exists():
                continue
            for skill_path in self._discover_skills(
                scope.root,
                scope_name=scope.scope,
                max_files=MAX_SKILL_FILES,
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

    def _skill_sources(
        self, authority: SkillAuthority | None
    ) -> tuple[tuple[SkillScope, ...], frozenset[str], Path | None]:
        """Scopes, disabled ids and legacy root: the request's, else the startup's."""
        if authority is None:
            return self._skill_scopes, self._disabled_skill_ids, self._workspace_root
        return authority.scopes, authority.disabled_ids, authority.legacy_root

    def _load_skills(self, authority: SkillAuthority | None = None) -> list[SkillEntry]:
        with self._cache_lock:
            return self._load_skills_locked(authority)

    def _load_skills_locked(self, authority: SkillAuthority | None) -> list[SkillEntry]:
        cached = self._skill_cache.get(authority)
        if cached is not None and self._skill_cache_valid(cached, authority):
            return cached.entries
        entries, file_paths = self._load_skills_uncached(authority)
        file_mtimes: dict[str, int] = {}
        for fp in file_paths:
            try:
                file_mtimes[str(fp)] = fp.stat().st_mtime_ns
            except OSError:
                pass
        # Re-insert so eviction drops the least recently loaded authority.
        self._skill_cache.pop(authority, None)
        self._skill_cache[authority] = _SkillCacheEntry(
            entries=entries,
            dir_mtime=self._skill_dir_mtime_key(authority),
            file_mtimes=file_mtimes,
            at_monotonic=time.monotonic(),
        )
        while len(self._skill_cache) > _MAX_CACHED_SKILL_AUTHORITIES:
            del self._skill_cache[next(iter(self._skill_cache))]
        return entries

    def _skill_cache_valid(
        self, cached: _SkillCacheEntry, authority: SkillAuthority | None
    ) -> bool:
        if time.monotonic() - cached.at_monotonic >= SKILL_CACHE_TTL_SECONDS:
            return False
        if cached.dir_mtime != self._skill_dir_mtime_key(authority):
            return False
        for path_str, expected_mtime in cached.file_mtimes.items():
            try:
                if Path(path_str).stat().st_mtime_ns != expected_mtime:
                    return False
            except OSError:
                return False
        return True

    def _skill_dir_mtime_key(self, authority: SkillAuthority | None = None) -> str:
        scopes, _disabled_ids, legacy_root = self._skill_sources(authority)
        parts: list[str] = []
        if self._skills_system_enabled and scopes:
            for scope in scopes:
                if scope.enabled is not True or not scope.root.exists():
                    continue
                try:
                    parts.append(str(scope.root.stat().st_mtime_ns))
                except OSError:
                    parts.append("0")
        elif legacy_root is not None:
            skills_dir = legacy_root / "skills"
            try:
                parts.append(str(skills_dir.stat().st_mtime_ns))
            except OSError:
                parts.append("0")
        return "|".join(parts)

    def _load_skills_uncached(
        self, authority: SkillAuthority | None = None
    ) -> tuple[list[SkillEntry], list[Path]]:
        import sidecar.ai.context.builder as _builder_hub

        scopes, disabled_ids, legacy_root = self._skill_sources(authority)
        skill_entries: list[SkillEntry] = []
        loaded_paths: list[Path] = []
        seen_realpaths: set[tuple[Any, ...]] = set()
        if self._skills_system_enabled and scopes:
            scoped_files = self._skill_scope_files(scopes)
        else:
            root = legacy_root
            if root is None:
                return [], []
            scoped_files = [
                (SkillScope(scope="workspace", root=root, enabled=True), skill_path)
                for skill_path in self._skill_files(root)
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
                if f"{scope.scope}/{skill_slug}" in disabled_ids:
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
        skill_authority: SkillAuthority | None = None,
    ) -> str:
        import sidecar.ai.context.builder as _builder_hub

        skill_entries = self._load_skills(skill_authority)
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
        rendered = _sanitize_bootstrap_content(
            "\n\n".join(blocks), source_name="skills_overlay"
        )
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
