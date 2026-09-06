from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.unavailable import (
    UnavailableMemoryStore,
    memory_store_status_payload,
)
from sidecar.ai.routing import iteration_limits as _iteration_limits
from sidecar.ai.routing.tool_observation import ToolObservationStore
from sidecar.ai.tools.builtins.lsp.manager import (
    LSPLanguage,
    LSPServerCommand,
    LSPUnavailableResult,
    detect_language_servers,
)
from sidecar.ai.tools.workspace_manifest import (
    get_workspace_manifest_cache,
    summarize_workspace_manifest,
)
from sidecar.runtime.local_engine.snapshot import (
    active_app_profile_payload as _shared_active_app_profile_payload,
)
from sidecar.runtime.local_engine.snapshot import (
    active_model_capabilities_payload as _shared_active_model_capabilities_payload,
)
from sidecar.runtime.local_engine.snapshot import (
    build_local_runtime_payload,
    derive_legacy_runtime_aliases,
)
from sidecar.runtime.memory import serialize_approved_memory, serialize_pending_memory_candidate
from sidecar.runtime.provider_capabilities import (
    build_provider_capabilities,
    provider_capabilities_payload,
)
from sidecar.runtime.provider_capability_profile import (
    ProviderCapabilityProfileStore,
    provider_capability_profiles_payload,
)
from sidecar.runtime.resource_monitor import sample_resource_monitor_snapshot
from sidecar.runtime.schema_versions import get_all_schema_versions
from sidecar.runtime.system_pressure import build_system_pressure_snapshot
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore

DEFAULT_TOOL_POLICIES = {
    "read_file": "auto",
    "glob_files": "auto",
    "grep_search": "auto",
    "write_file": "ask",
    "edit_file": "ask",
    "run_command": "ask",
    "create_artifact": "ask",
    "jenny_status": "auto",
}
TOOL_NAME_ALIASES = {
    "Read": "read_file",
    "Write": "write_file",
    "Edit": "edit_file",
    "Glob": "glob_files",
    "Grep": "grep_search",
    "Bash": "run_command",
    "CreateArtifact": "create_artifact",
}
DEFAULT_SECTIONS = ("tools", "memories", "skills", "runtime", "workspace", "shell")
VALID_SECTIONS = frozenset(DEFAULT_SECTIONS)
DEFAULT_RECENT_HISTORY_LIMIT = 5
VALID_MEMORY_PROVENANCE = frozenset(
    {"user_approved", "automatic", "source_removed", "unknown_legacy"}
)
LSP_STATUS_LANGUAGES: tuple[LSPLanguage, ...] = ("python", "typescript")
_WINDOWS_PATH_RE = re.compile(
    r"(?<![\w\\])(?:[A-Za-z]:\\|\\\\)[^\\:\r\n<>|?*]+(?:\\[^\\:\r\n<>|?*]+)*"
)
_POSIX_PATH_RE = re.compile(r"(?<!\w)/(?:[^/\r\n:]+/)+[^/\r\n:]+")
_MAX_LSP_REASON_CHARS = 200
_LEGACY_TOOL_RUN_POSITION_WINDOW = 32


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _section_error_payload(error: BaseException) -> dict[str, Any]:
    return {
        "error": str(error)[:500],
        "error_type": type(error).__name__,
    }


def _safe_section(builder: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return builder()
    except Exception as error:  # noqa: BLE001
        return _section_error_payload(error)


def _normalize_tool_name(value: Any) -> str:
    token = str(value or "").strip()
    if not token:
        return ""
    return TOOL_NAME_ALIASES.get(token, token)


def _tool_history_run_key(
    *,
    runs_by_id: dict[tuple[str, str, str], dict[str, Any]],
    run_keys_by_call_id: dict[str, list[tuple[str, str, str]]],
    metadata: dict[str, Any],
    call_id: str,
    tool_name: str,
    message_position: int,
    event_marker: str,
) -> tuple[str, str, str]:
    parent_stream_id = str(metadata.get("parent_stream_id") or "").strip()
    if parent_stream_id:
        run_key = ("stream", parent_stream_id, call_id)
        keys = run_keys_by_call_id.setdefault(call_id, [])
        if run_key not in runs_by_id:
            keys.append(run_key)
        return run_key

    for run_key in reversed(run_keys_by_call_id.get(call_id, [])):
        run = runs_by_id.get(run_key)
        if run is None:
            continue
        last_position = run.get("_last_message_position")
        if not isinstance(last_position, int):
            continue
        if message_position - last_position > _LEGACY_TOOL_RUN_POSITION_WINDOW:
            break
        if run.get("tool_name") == tool_name and run.get(event_marker) is not True:
            return run_key

    run_key = ("legacy", call_id, str(message_position))
    run_keys_by_call_id.setdefault(call_id, []).append(run_key)
    return run_key


def _active_model_capabilities_payload(engine: Any) -> dict[str, bool]:
    return _shared_active_model_capabilities_payload(engine)


def _active_app_profile_payload(runtime_config: RuntimeConfig) -> dict[str, Any] | None:
    return _shared_active_app_profile_payload(runtime_config)


def _config_string(config: RuntimeConfig, key: str) -> str | None:
    value = getattr(config, key, None)
    if not isinstance(value, str):
        return None
    token = value.strip()
    return token if token else None


def _build_lsp_status_payload(config: RuntimeConfig) -> dict[str, Any]:
    detected = detect_language_servers(
        configured_typescript_command=_config_string(config, "tools_lsp_command_typescript"),
        configured_python_command=_config_string(config, "tools_lsp_command_python"),
    )
    languages = []
    for language in LSP_STATUS_LANGUAGES:
        result = detected.get(language)
        languages.append(_lsp_language_status(language=language, result=result))
    return {
        "enabled": config.tools_lsp_enabled is True,
        "languages": languages,
    }


def _lsp_language_status(
    *,
    language: str,
    result: LSPServerCommand | LSPUnavailableResult | None,
) -> dict[str, Any]:
    if isinstance(result, LSPServerCommand):
        return {
            "language": language,
            "status": "ready",
            "command_present": True,
            "configured_command_present": result.source == "configured",
            "source": result.source,
            "reason": None,
        }
    if isinstance(result, LSPUnavailableResult):
        return {
            "language": language,
            "status": "unavailable",
            "command_present": False,
            "configured_command_present": bool(result.configured_command),
            "source": None,
            "reason": _sanitize_lsp_unavailable_reason(result),
        }
    return {
        "language": language,
        "status": "unavailable",
        "command_present": False,
        "configured_command_present": False,
        "source": None,
        "reason": "No language server is available for this language",
    }


def _sanitize_lsp_unavailable_reason(result: LSPUnavailableResult) -> str:
    if result.configured_command:
        return "configured language-server command was not found"
    reason = str(result.reason or "").strip()
    if not reason:
        return "No language server is available for this language"
    redacted = _WINDOWS_PATH_RE.sub("<path>", reason)
    redacted = _POSIX_PATH_RE.sub("<path>", redacted)
    if len(redacted) > _MAX_LSP_REASON_CHARS:
        return f"{redacted[:_MAX_LSP_REASON_CHARS].rstrip()}..."
    return redacted


class HarnessSnapshotBuilder:
    def __init__(
        self,
        *,
        config: RuntimeConfig,
        router: Any,
        engine: Any,
        mcp_client: Any,
        memory_store: MemoryStore | UnavailableMemoryStore,
        context_builder: ContextBuilder,
        turn_diagnostics: TurnDiagnosticsStore | None = None,
        provider_capability_profiles: ProviderCapabilityProfileStore | None = None,
        tool_observations: ToolObservationStore | None = None,
    ) -> None:
        self._config = config
        self._router = router
        self._engine = engine
        self._mcp_client = mcp_client
        self._memory_store = memory_store
        self._context_builder = context_builder
        self._turn_diagnostics = turn_diagnostics
        self._provider_capability_profiles = provider_capability_profiles
        self._tool_observations = tool_observations

    def inspect(
        self,
        *,
        sections: Any = None,
        include_recent_history: Any = True,
        recent_history_limit: Any = DEFAULT_RECENT_HISTORY_LIMIT,
        include_disabled: Any = True,
    ) -> dict[str, Any]:
        selected_sections = self._normalize_sections(sections)
        include_recent = include_recent_history is not False
        history_limit = self._normalize_history_limit(recent_history_limit)
        include_disabled_tools = include_disabled is not False

        snapshot: dict[str, Any] = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "sections": list(selected_sections),
            "filters": {
                "include_recent_history": include_recent,
                "recent_history_limit": history_limit,
                "include_disabled": include_disabled_tools,
            },
            "state_paths": self._state_paths_payload(),
        }

        if "tools" in selected_sections and include_recent:
            try:
                history = self._load_tool_history(history_limit=history_limit)
            except Exception as error:  # noqa: BLE001
                history = {}
                snapshot["tool_history_error"] = _section_error_payload(error)
        else:
            history = {}
        shell_config = self._read_json_file(
            self._resolve_state_path("electron_shell_config_path", "shell-config.json")
        )

        if "tools" in selected_sections:
            snapshot["tools"] = _safe_section(
                lambda: self._build_tools_section(
                    history=history,
                    include_recent_history=include_recent,
                    include_disabled=include_disabled_tools,
                )
            )
        if "memories" in selected_sections:
            snapshot["memories"] = _safe_section(self._build_memories_section)
        if "skills" in selected_sections:
            snapshot["skills"] = _safe_section(self._build_skills_section)
        if "runtime" in selected_sections:
            snapshot["runtime"] = _safe_section(self._build_runtime_section)
        if "workspace" in selected_sections:
            snapshot["workspace"] = _safe_section(self._build_workspace_section)
        if "shell" in selected_sections:
            snapshot["shell"] = _safe_section(
                lambda: self._build_shell_section(shell_config=shell_config)
            )
        return snapshot

    def _normalize_sections(self, sections: Any) -> tuple[str, ...]:
        if not isinstance(sections, list):
            return DEFAULT_SECTIONS
        selected: list[str] = []
        for item in sections:
            token = str(item or "").strip().lower()
            if token in VALID_SECTIONS and token not in selected:
                selected.append(token)
        return tuple(selected) or DEFAULT_SECTIONS

    @staticmethod
    def _normalize_history_limit(value: Any) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return DEFAULT_RECENT_HISTORY_LIMIT
        return max(1, min(parsed, 20))

    def _state_paths_payload(self) -> dict[str, str | None]:
        return {
            "electron_state_root": self._normalize_path(self._config.electron_state_root),
            "shell_config": self._normalize_path(
                self._resolve_state_path("electron_shell_config_path", "shell-config.json")
            ),
            "sessions": self._normalize_path(
                self._resolve_state_path("electron_sessions_path", "sessions.json")
            ),
            "tool_permissions": self._normalize_path(
                self._resolve_state_path("electron_tool_permissions_path", "tool-permissions.json")
            ),
            "memory_db": self._normalize_path(self._memory_store.db_path),
        }

    @staticmethod
    def _normalize_path(value: Any) -> str | None:
        if value is None:
            return None
        token = str(value).strip()
        return token or None

    def _resolve_state_path(self, explicit_attr: str, filename: str) -> Path | None:
        explicit = getattr(self._config, explicit_attr, None)
        if explicit:
            return Path(explicit).expanduser()
        state_root = str(self._config.electron_state_root or "").strip()
        if not state_root:
            return None
        return Path(state_root).expanduser() / filename

    @staticmethod
    def _read_json_file(path: Path | None) -> dict[str, Any]:
        if path is None or not path.exists() or not path.is_file():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _build_tools_section(
        self,
        *,
        history: dict[str, Any],
        include_recent_history: bool,
        include_disabled: bool,
    ) -> dict[str, Any]:
        tools_status = (
            self._router.tools_status if isinstance(self._router.tools_status, dict) else {}
        )
        schema_map = {
            str(schema.get("name") or "").strip(): schema
            for schema in (
                self._router.tool_schemas if isinstance(self._router.tool_schemas, list) else []
            )
            if isinstance(schema, dict) and str(schema.get("name") or "").strip()
        }
        permission_policies = self._load_tool_permission_policies()
        tool_names = sorted(
            {
                *tools_status.keys(),
                *schema_map.keys(),
                *history.keys(),
                *permission_policies.keys(),
            }
        )
        items: list[dict[str, Any]] = []
        for tool_name in tool_names:
            status = _as_dict(tools_status.get(tool_name))
            enabled = status.get("available") is True
            if not enabled and not include_disabled:
                continue
            schema = _as_dict(schema_map.get(tool_name))
            stats = _as_dict(history.get(tool_name))
            read_only = schema.get("side_effecting") is False
            item = {
                "name": tool_name,
                "display_name": str(status.get("display_name") or tool_name).strip() or tool_name,
                "description": str(schema.get("description") or "").strip(),
                "enabled": enabled,
                "blocker": str(status.get("reason") or "").strip() or None,
                "source_kind": str(status.get("source_kind") or "").strip() or None,
                "tool_family": str(status.get("tool_family") or "").strip() or None,
                "permission_policy": self._resolve_tool_permission_policy(
                    tool_name=tool_name,
                    read_only=read_only,
                    policies=permission_policies,
                ),
                "read_only": read_only,
                "use_count": int(stats.get("use_count") or 0),
                "success_count": int(stats.get("success_count") or 0),
                "error_count": int(stats.get("error_count") or 0),
                "approval_breakdown": stats.get("approval_breakdown")
                or {
                    "auto": 0,
                    "ask": 0,
                    "approved": 0,
                    "denied": 0,
                    "unknown": 0,
                },
                "last_used_at": stats.get("last_used_at"),
                "recent_runs": stats.get("recent_runs") if include_recent_history else [],
            }
            items.append(item)
        enabled_count = sum(1 for item in items if item["enabled"] is True)
        return {
            "items": items,
            "counts": {
                "total": len(items),
                "enabled": enabled_count,
                "disabled": max(len(items) - enabled_count, 0),
            },
        }

    def _load_tool_permission_policies(self) -> dict[str, str]:
        payload = self._read_json_file(
            self._resolve_state_path("electron_tool_permissions_path", "tool-permissions.json")
        )
        policies = {**DEFAULT_TOOL_POLICIES}
        for tool_name, policy in payload.items():
            normalized_name = _normalize_tool_name(tool_name)
            normalized_policy = str(policy or "").strip().lower()
            if not normalized_name or normalized_policy not in {"auto", "ask", "deny"}:
                continue
            policies[normalized_name] = normalized_policy
        return policies

    @staticmethod
    def _resolve_tool_permission_policy(
        *,
        tool_name: str,
        read_only: bool,
        policies: dict[str, str],
    ) -> str:
        if tool_name in policies:
            return policies[tool_name]
        return "auto" if read_only else "ask"

    def _load_sessions_with_messages(self) -> dict[str, Any]:
        """Return {session_id: session} across both on-disk session layouts.

        The Electron store used to keep every session inline in a monolithic
        ``sessions.json``. It now migrates to a split layout -- a ``sessions/``
        directory holding ``_index.json`` (summaries only, no messages) plus one
        file per session -- and does NOT leave a ``sessions.json`` behind.
        Reading only the monolithic file therefore reported an EMPTY tool
        history on every migrated install, which is to say on every real one.
        """
        monolithic = self._read_json_file(
            self._resolve_state_path("electron_sessions_path", "sessions.json")
        )
        sessions = _as_dict(monolithic.get("sessions"))
        if sessions:
            return sessions

        sessions_path = self._resolve_state_path("electron_sessions_path", "sessions.json")
        if sessions_path is None:
            return {}
        split_root = sessions_path.parent / "sessions"
        index = self._read_json_file(split_root / "_index.json")
        summaries = _as_dict(index.get("sessions"))
        if not summaries:
            return {}

        resolved: dict[str, Any] = {}
        for session_id, summary in summaries.items():
            record = self._read_json_file(split_root / f"{session_id}.json")
            # Per-session files nest the record under "session". Fall back to the
            # index summary so an unreadable file still contributes its title
            # rather than dropping the session outright.
            session = _as_dict(record.get("session")) or _as_dict(summary)
            if session:
                resolved[str(session_id)] = session
        return resolved

    def _load_tool_history(self, *, history_limit: int) -> dict[str, Any]:
        sessions = self._load_sessions_with_messages()
        runs_by_tool: dict[str, list[dict[str, Any]]] = {}
        for session_id, raw_session in sessions.items():
            if not isinstance(raw_session, dict):
                continue
            session_title = (
                str(raw_session.get("title") or "Untitled Session").strip() or "Untitled Session"
            )
            messages = _as_list(raw_session.get("messages"))
            runs_by_id: dict[tuple[str, str, str], dict[str, Any]] = {}
            run_keys_by_call_id: dict[str, list[tuple[str, str, str]]] = {}
            for message_position, message in enumerate(messages):
                if not isinstance(message, dict):
                    continue
                kind = str(message.get("kind") or "").strip()
                timestamp = str(message.get("timestamp") or "").strip() or None
                if kind == "tool_use":
                    metadata = _as_dict(message.get("tool_call"))
                    call_id = str(metadata.get("call_id") or "").strip()
                    tool_name = str(metadata.get("tool_name") or "").strip()
                    if not call_id or not tool_name:
                        continue
                    run_key = _tool_history_run_key(
                        runs_by_id=runs_by_id,
                        run_keys_by_call_id=run_keys_by_call_id,
                        metadata=metadata,
                        call_id=call_id,
                        tool_name=tool_name,
                        message_position=message_position,
                        event_marker="_has_tool_use",
                    )
                    run = runs_by_id.get(run_key) or {
                        "call_id": call_id,
                        "tool_name": tool_name,
                        "session_id": str(session_id),
                        "session_title": session_title,
                        "timestamp": timestamp,
                        "approval_state": str(metadata.get("approval_state") or "unknown").strip()
                        or "unknown",
                        "outcome": "pending",
                    }
                    run["_has_tool_use"] = True
                    run["_last_message_position"] = message_position
                    if timestamp and not run.get("timestamp"):
                        run["timestamp"] = timestamp
                    if not run.get("approval_state") or run["approval_state"] == "unknown":
                        run["approval_state"] = (
                            str(metadata.get("approval_state") or "unknown").strip() or "unknown"
                        )
                    summary = str(metadata.get("summary") or "").strip()
                    if summary:
                        run["summary"] = summary
                    runs_by_id[run_key] = run
                elif kind == "tool_result":
                    metadata = _as_dict(message.get("tool_result"))
                    call_id = str(metadata.get("call_id") or "").strip()
                    tool_name = str(metadata.get("tool_name") or "").strip()
                    if not call_id or not tool_name:
                        continue
                    run_key = _tool_history_run_key(
                        runs_by_id=runs_by_id,
                        run_keys_by_call_id=run_keys_by_call_id,
                        metadata=metadata,
                        call_id=call_id,
                        tool_name=tool_name,
                        message_position=message_position,
                        event_marker="_has_tool_result",
                    )
                    run = runs_by_id.get(run_key) or {
                        "call_id": call_id,
                        "tool_name": tool_name,
                        "session_id": str(session_id),
                        "session_title": session_title,
                        "timestamp": timestamp,
                        "approval_state": "unknown",
                        "outcome": "pending",
                    }
                    run["_has_tool_result"] = True
                    run["_last_message_position"] = message_position
                    run["timestamp"] = timestamp or run.get("timestamp")
                    run["outcome"] = "error" if metadata.get("is_error") is True else "success"
                    summary = str(
                        metadata.get("summary") or metadata.get("error_code") or ""
                    ).strip()
                    if summary:
                        run["summary"] = summary
                    runs_by_id[run_key] = run
            for run in runs_by_id.values():
                tool_name = str(run.get("tool_name") or "").strip()
                if not tool_name:
                    continue
                runs_by_tool.setdefault(tool_name, []).append(run)

        history: dict[str, Any] = {}
        for tool_name, runs in runs_by_tool.items():
            sorted_runs = sorted(
                runs,
                key=lambda item: (str(item.get("timestamp") or ""), str(item.get("call_id") or "")),
                reverse=True,
            )
            approval_breakdown = {
                "auto": 0,
                "ask": 0,
                "approved": 0,
                "denied": 0,
                "unknown": 0,
            }
            success_count = 0
            error_count = 0
            for run in sorted_runs:
                approval_state = (
                    str(run.get("approval_state") or "unknown").strip().lower() or "unknown"
                )
                if approval_state not in approval_breakdown:
                    approval_state = "unknown"
                approval_breakdown[approval_state] += 1
                if run.get("outcome") == "success":
                    success_count += 1
                elif run.get("outcome") == "error":
                    error_count += 1
            history[tool_name] = {
                "use_count": len(sorted_runs),
                "success_count": success_count,
                "error_count": error_count,
                "approval_breakdown": approval_breakdown,
                "last_used_at": sorted_runs[0].get("timestamp") if sorted_runs else None,
                "recent_runs": [
                    {
                        "call_id": str(run.get("call_id") or "").strip(),
                        "session_id": str(run.get("session_id") or "").strip(),
                        "session_title": str(run.get("session_title") or "").strip()
                        or "Untitled Session",
                        "timestamp": run.get("timestamp"),
                        "approval_state": str(run.get("approval_state") or "unknown").strip()
                        or "unknown",
                        "outcome": str(run.get("outcome") or "pending").strip() or "pending",
                        "summary": str(run.get("summary") or "").strip() or None,
                    }
                    for run in sorted_runs[:history_limit]
                ],
            }
        return history

    def _build_memories_section(self) -> dict[str, Any]:
        if isinstance(self._memory_store, UnavailableMemoryStore):
            return {
                "approved": [],
                "pending": [],
                "counts": {
                    "approved": 0,
                    "pending": 0,
                    "provenance": {
                        "user_approved": 0,
                        "automatic": 0,
                        "source_removed": 0,
                        "unknown_legacy": 0,
                    },
                },
                "status": memory_store_status_payload(self._memory_store),
            }
        approved = [
            self._normalize_approved_memory(serialize_approved_memory(memory))
            for memory in self._memory_store.get_all_memories()
        ]
        pending = [
            self._normalize_pending_memory(serialize_pending_memory_candidate(candidate))
            for candidate in self._pending_candidates()
        ]
        provenance_counts = {
            "user_approved": 0,
            "automatic": 0,
            "source_removed": 0,
            "unknown_legacy": 0,
        }
        for memory in approved:
            provenance = str(memory.get("provenance") or "unknown_legacy")
            if provenance not in provenance_counts:
                provenance = "unknown_legacy"
            provenance_counts[provenance] += 1
        return {
            "approved": approved,
            "pending": pending,
            "counts": {
                "approved": len(approved),
                "pending": len(pending),
                "provenance": provenance_counts,
            },
            "status": memory_store_status_payload(self._memory_store),
        }

    def _pending_candidates(self) -> list[Any]:
        try:
            return self._memory_store.get_pending_candidates_for_harness(limit=80)
        except Exception:  # noqa: BLE001
            return []

    def _normalize_approved_memory(self, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(payload)
        provenance = (
            str(normalized.get("provenance") or "unknown_legacy").strip().lower()
            or "unknown_legacy"
        )
        if provenance not in VALID_MEMORY_PROVENANCE:
            provenance = "unknown_legacy"
        normalized["provenance"] = provenance
        normalized["state"] = "approved"
        normalized["acquired_at"] = normalized.get("created_at")
        return normalized

    @staticmethod
    def _normalize_pending_memory(payload: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(payload)
        normalized["provenance"] = "automatic"
        normalized["state"] = "pending"
        normalized["acquired_at"] = normalized.get("created_at")
        return normalized

    def _build_skills_section(self) -> dict[str, Any]:
        scope_entries = []
        skill_counts = {"bundled": 0, "user": 0, "project": 0}
        scopes = getattr(self._context_builder, "_skill_scopes", ())
        loaded_skills: list[Any] = _as_list(
            getattr(self._context_builder, "_load_skills", lambda: [])()
        )
        for scope in loaded_skills:
            scope_name = str(getattr(scope, "scope", "") or "").strip().lower()
            if scope_name in skill_counts:
                skill_counts[scope_name] += 1
        for scope in scopes:
            scope_name = str(getattr(scope, "scope", "") or "").strip().lower() or "unknown"
            root = getattr(scope, "root", None)
            enabled = getattr(scope, "enabled", False) is True
            exists = bool(root and Path(root).exists())
            status = "ready" if enabled and exists else "blocked" if enabled else "disabled"
            if scope_name == "project" and not str(self._config.tools_workspace_root or "").strip():
                status = "blocked"
            scope_entries.append(
                {
                    "scope": scope_name,
                    "path": self._normalize_path(root),
                    "enabled": enabled,
                    "exists": exists,
                    "status": status,
                    "loaded_count": skill_counts.get(scope_name, 0),
                }
            )
        skills = []
        for skill in loaded_skills:
            skills.append(
                {
                    "scope": str(getattr(skill, "scope", "") or "").strip(),
                    "name": str(getattr(skill, "name", "") or "").strip(),
                    "description": str(getattr(skill, "description", "") or "").strip(),
                    "when_to_use": str(getattr(skill, "when_to_use", "") or "").strip(),
                    "allowed_tools": list(getattr(skill, "allowed_tools", ()) or ()),
                    "always": getattr(skill, "always", False) is True,
                    "rel_path": str(getattr(skill, "rel_path", "") or "").strip(),
                }
            )
        return {
            "counts": {
                "total": len(skills),
                "bundled": skill_counts["bundled"],
                "user": skill_counts["user"],
                "project": skill_counts["project"],
            },
            "scopes": scope_entries,
            "items": skills,
        }

    def _build_runtime_section(self) -> dict[str, Any]:
        provider_capabilities = build_provider_capabilities(self._config)
        diagnostics = self._mcp_client.diagnostics()
        active_model_capabilities = _active_model_capabilities_payload(self._engine)
        active_app_profile = _active_app_profile_payload(self._config)
        local_runtime = build_local_runtime_payload(
            runtime_config=self._config,
            engine=self._engine,
        )
        compatibility_aliases = derive_legacy_runtime_aliases(
            local_runtime=local_runtime,
            active_app_profile=active_app_profile,
            active_model_capabilities=active_model_capabilities,
        )
        runtime = {
            "local_runtime": local_runtime,
            **compatibility_aliases,
            "active_mode": self._config.mode,
            "safety_mode": self._config.safety_mode,
            "provider_capabilities": provider_capabilities_payload(provider_capabilities),
            "feature_flags": self._config.feature_flags or {},
            "mcp": {
                "connected": list(diagnostics.connected),
                "failures": [
                    {
                        "name": failure.name,
                        "code": failure.code,
                        "message": failure.message,
                    }
                    for failure in diagnostics.failures
                ],
            },
            "memory": {
                "db_path": str(self._memory_store.db_path),
                **memory_store_status_payload(self._memory_store),
            },
            "schema_versions": get_all_schema_versions(),
            "system_pressure": build_system_pressure_snapshot(
                root=(
                    self._config.tools_workspace_root
                    or self._config.electron_state_root
                    or self._memory_store.db_path
                ),
            ).to_payload(),
            "resource_monitor": sample_resource_monitor_snapshot(),
            "lsp": _build_lsp_status_payload(self._config),
        }
        latest_turn = (
            self._turn_diagnostics.snapshot() if self._turn_diagnostics is not None else None
        )
        runtime["orchestration"] = {
            "mode": (
                str(latest_turn.get("mode") or "").strip() if isinstance(latest_turn, dict) else ""
            )
            or self._config.mode,
            "agent_id": (
                str(latest_turn.get("agent_id") or "").strip() or None
                if isinstance(latest_turn, dict)
                else None
            ),
            "sub_agent_iteration_budget": self._config.max_sub_agent_loop_iterations,
            "sub_agent_concurrency_budget": (
                _iteration_limits.effective_sub_agent_concurrency_budget(self._config)
            ),
        }
        runtime["loop_profile"] = {
            "profile": _iteration_limits.loop_profile_name(self._config),
            "max_iterations_chat": _iteration_limits.max_iterations_for_mode(
                self._config, mode="chat"
            ),
            "max_iterations_task": _iteration_limits.max_iterations_for_mode(
                self._config, mode="task"
            ),
            "max_loop_wall_seconds": _iteration_limits.effective_max_loop_wall_seconds(
                self._config
            ),
            "max_tools_per_turn": _iteration_limits.effective_max_tools_per_turn(self._config),
            "tools_execution_timeout_seconds": (
                _iteration_limits.effective_tools_execution_timeout_seconds(self._config)
            ),
            "chunk_inactivity_seconds": _iteration_limits.effective_chunk_inactivity_seconds(
                self._config
            ),
        }
        if latest_turn:
            runtime["latest_turn_diagnostics"] = latest_turn
        if self._provider_capability_profiles is not None:
            runtime["provider_capability_profiles"] = provider_capability_profiles_payload(
                self._provider_capability_profiles,
            )
        if self._tool_observations is not None:
            runtime["tool_observation_retention"] = self._tool_observations.retention_snapshot()
            latest_request_id, recent_events = (
                self._tool_observations.recent_events_for_latest_turn(limit=50)
            )
            if latest_request_id:
                runtime["recent_tool_observations"] = [
                    event.to_payload() for event in recent_events
                ]
        return runtime

    def _build_workspace_section(self) -> dict[str, Any]:
        workspace_status = self._context_builder.workspace_status()
        blockers = []
        if not str(self._config.tools_workspace_root or "").strip():
            blockers.append("Workspace root is not configured.")
        elif not workspace_status.exists:
            blockers.append("Configured workspace root does not exist.")
        tool_blockers = []
        for tool_name, status in (self._router.tools_status or {}).items():
            if not isinstance(status, dict):
                continue
            if status.get("available") is True:
                continue
            reason = str(status.get("reason") or "").strip()
            if reason == "workspace requirement missing":
                tool_blockers.append(tool_name)
        payload: dict[str, Any] = {
            "root": workspace_status.root,
            "exists": workspace_status.exists,
            "skills_loaded": workspace_status.skills_loaded,
            "bootstrap_loaded": workspace_status.bootstrap_loaded,
            "instruction_file_name": workspace_status.instruction_file_name,
            "instruction_file_present": workspace_status.instruction_file_present,
            "blockers": blockers,
            "workspace_blocked_tools": sorted(tool_blockers),
        }
        if self._config.tools_workspace_manifest_enabled and workspace_status.root:
            manifest = get_workspace_manifest_cache().read(workspace_status.root)
            payload["manifest"] = summarize_workspace_manifest(manifest)
        return payload

    def _build_shell_section(
        self,
        *,
        shell_config: dict[str, Any],
    ) -> dict[str, Any]:
        tools = _as_dict(shell_config.get("tools"))
        companion = _as_dict(shell_config.get("companion"))
        offline = _as_dict(shell_config.get("offlineIntelligence"))
        follow_ups = _as_list(shell_config.get("followUps"))
        return {
            "tools_preferences": {
                "web_enabled": tools.get("web") is True,
                "image_read_enabled": tools.get("imageRead") is True,
                "python_runtime_enabled": tools.get("pythonRuntime") is True,
                "todo_enabled": tools.get("todo") is True,
            },
            "companion": {
                "mode": str(companion.get("mode") or "").strip() or "planner",
                "follow_up_count": len(follow_ups),
                "summary": f"{len(follow_ups)} follow-up{'s' if len(follow_ups) != 1 else ''} queued.",
            },
            "offline": {
                "mode": str(offline.get("mode") or "").strip() or "disabled",
                "preferred_local_model": str(offline.get("preferredLocalModel") or "").strip(),
                "summary": str(offline.get("summary") or "").strip()
                or "Offline intelligence settings are available in the shell.",
            },
        }
