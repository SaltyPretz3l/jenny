"""Desktop execution-policy boundary.

The desktop command sandbox is independent from ``host_mode``.  Desktop keeps
the historical open tool surface when the policy version is absent, while the
exact supported version turns the sidecar into a narrow admission layer for
Electron-owned command execution.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

DESKTOP_EXECUTION_POLICY_VERSION = 1
DESKTOP_EXECUTION_POLICY_KEY = "desktop_execution_policy_version"
ELECTRON_TOOL_BRIDGE_SERVER_NAME = "electron_tool_bridge"
BUILTIN_MCP_SERVER_NAME = "jenny_local_tools"

DESKTOP_SANDBOX_TYPED_FILE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "read_file",
        "write_file",
        "edit_file",
        "glob_files",
        "grep_search",
        "list_dir",
        "create_artifact",
        "mermaid_generate",
    }
)
DESKTOP_SANDBOX_ELECTRON_TOOL_NAMES: frozenset[str] = frozenset(
    {"ask_user", "exit_plan_mode", "run_command"}
)
DESKTOP_SANDBOX_ALLOWED_TOOL_NAMES: frozenset[str] = (
    DESKTOP_SANDBOX_TYPED_FILE_TOOL_NAMES | DESKTOP_SANDBOX_ELECTRON_TOOL_NAMES
)

# These engines keep inference in the managed sidecar.  Provider-owned tool
# execution (Codex CLI, ChatGPT, and executable plugin engines) is unavailable
# while the Electron command policy is active.
DESKTOP_SANDBOX_MANAGED_ENGINE_TYPES: frozenset[str] = frozenset(
    {"mock", "replay", "ollama", "vllm", "openai-compatible"}
)

DESKTOP_POLICY_INVALID_REASON = "desktop execution policy is invalid"
DESKTOP_POLICY_DENIED_REASON = "tool is not allowed by the desktop execution policy"
DESKTOP_POLICY_BRIDGE_REQUIRED_REASON = "sandbox command execution requires the Electron bridge"
DESKTOP_POLICY_ENGINE_DENIED_REASON = "engine is not supported by the desktop execution policy"


class DesktopExecutionPolicyError(ValueError):
    """Raised when a declared desktop execution policy is unsupported."""


@dataclass(frozen=True)
class DesktopExecutionPolicy:
    version: int | None

    @property
    def enforced(self) -> bool:
        return self.version == DESKTOP_EXECUTION_POLICY_VERSION


_MISSING = object()


def _config_value(config: Any, key: str) -> Any:
    if isinstance(config, Mapping):
        return config.get(key, _MISSING)
    return getattr(config, key, _MISSING)


def validate_desktop_execution_policy(version: Any = None) -> DesktopExecutionPolicy:
    """Validate a desktop policy declaration without coercing untrusted input."""

    if version is None:
        return DesktopExecutionPolicy(version=None)
    if isinstance(version, bool) or not isinstance(version, int):
        raise DesktopExecutionPolicyError(
            f"{DESKTOP_EXECUTION_POLICY_KEY} must be an integer"
        )
    if version != DESKTOP_EXECUTION_POLICY_VERSION:
        raise DesktopExecutionPolicyError(
            f"unsupported {DESKTOP_EXECUTION_POLICY_KEY}"
        )
    return DesktopExecutionPolicy(version=version)


def desktop_policy_from_config(config: Any = None) -> DesktopExecutionPolicy:
    """Read and validate the policy from a mapping or RuntimeConfig.

    An absent key is the legacy desktop default.  Callers that need a strict
    initialization latch should use ``container_desktop_execution_policy_is_enforced``;
    an absent stack/config there is deliberately treated as closed.
    """

    if config is None:
        raise DesktopExecutionPolicyError("desktop execution policy declaration is missing")
    raw_version = _config_value(config, DESKTOP_EXECUTION_POLICY_KEY)
    if raw_version is _MISSING:
        return DesktopExecutionPolicy(version=None)
    return validate_desktop_execution_policy(raw_version)


def desktop_policy_from_cli(version: Any) -> DesktopExecutionPolicy:
    """Parse the string-valued builtin-server policy declaration strictly."""

    if version is None or version == "":
        return DesktopExecutionPolicy(version=None)
    if isinstance(version, int) and not isinstance(version, bool):
        return validate_desktop_execution_policy(version)
    if isinstance(version, str) and version.isdecimal():
        return validate_desktop_execution_policy(int(version))
    raise DesktopExecutionPolicyError(
        f"{DESKTOP_EXECUTION_POLICY_KEY} must be an integer"
    )


def desktop_policy_is_enforced(config: Any = None) -> bool:
    """Return true only for the exact supported sandbox declaration."""

    try:
        return desktop_policy_from_config(config).enforced
    except DesktopExecutionPolicyError:
        return False


def container_desktop_execution_policy_is_enforced(container: Any) -> bool:
    """Read the stable container latch and deny indeterminate state."""

    explicit = getattr(container, "desktop_execution_policy_enforced", _MISSING)
    if isinstance(explicit, bool):
        # A BrainContainer that has not acknowledged any config yet has no
        # trustworthy policy state.  Keep dispatch closed until its first
        # initialize/configure boundary is latched.
        latched = getattr(container, "_desktop_execution_policy_latched", False)
        return explicit if explicit or latched else True

    enforced = True
    state = getattr(container, "__dict__", {})
    if isinstance(state, dict) and state.get("_desktop_execution_policy_invalid") is not True:
        stack = state.get("_stack") or getattr(
            state.get("_stack_generations"), "current_stack", None
        ) or state.get("stack")
        sentinel = object()
        config = getattr(stack, "config", sentinel)
        if config is sentinel:
            config = state.get("config", sentinel)
        if config is not sentinel and config is not None:
            try:
                enforced = desktop_policy_from_config(config).enforced
            except DesktopExecutionPolicyError:
                pass
    return enforced


def desktop_tool_decision(tool: Any, config: Any = None) -> tuple[bool, str | None]:
    """Return the canonical offer/dispatch decision for one tool."""

    if config is None:
        return True, None
    decision: tuple[bool, str | None] = (True, None)
    try:
        policy = desktop_policy_from_config(config)
    except DesktopExecutionPolicyError:
        policy = None
        decision = (False, DESKTOP_POLICY_INVALID_REASON)
    if policy is not None and policy.enforced:
        name = tool if isinstance(tool, str) else getattr(tool, "name", "")
        normalized_name = str(name or "").strip()
        if normalized_name not in DESKTOP_SANDBOX_ALLOWED_TOOL_NAMES:
            decision = (False, DESKTOP_POLICY_DENIED_REASON)
        else:
            source_kind = str(getattr(tool, "source_kind", "builtin") or "builtin").strip()
            server_name = str(getattr(tool, "server_name", "") or "").strip()
            if source_kind != "builtin":
                decision = (False, DESKTOP_POLICY_DENIED_REASON)
            elif normalized_name in DESKTOP_SANDBOX_ELECTRON_TOOL_NAMES:
                if server_name != ELECTRON_TOOL_BRIDGE_SERVER_NAME:
                    decision = (False, DESKTOP_POLICY_BRIDGE_REQUIRED_REASON)
            elif server_name not in {"", BUILTIN_MCP_SERVER_NAME}:
                decision = (False, DESKTOP_POLICY_DENIED_REASON)
    return decision


def filter_desktop_tool_bindings(
    bindings: Mapping[str, Any], config: Any = None
) -> dict[str, Any]:
    """Drop tools outside the sandbox allowlist before registration."""

    if config is None:
        return dict(bindings)
    try:
        policy = desktop_policy_from_config(config)
    except DesktopExecutionPolicyError:
        return {}
    if not policy.enforced:
        return dict(bindings)
    return {
        name: handler
        for name, handler in bindings.items()
        if desktop_tool_decision(name, config)[0]
    }


def desktop_tool_uses_electron_bridge(tool_name: str, config: Any = None) -> bool:
    """Return true when sandbox execution must be delegated to Electron."""

    return desktop_policy_is_enforced(config) and str(tool_name or "").strip() in {
        "run_command",
        "ask_user",
        "exit_plan_mode",
    }


def desktop_sandbox_engine_supported(engine_type: Any) -> bool:
    """Return whether an engine keeps inference under sidecar ownership."""

    normalized = str(engine_type or "").strip().lower()
    return normalized in DESKTOP_SANDBOX_MANAGED_ENGINE_TYPES


def desktop_sandbox_engine_reason(engine_type: Any) -> str | None:
    if desktop_sandbox_engine_supported(engine_type):
        return None
    return DESKTOP_POLICY_ENGINE_DENIED_REASON


__all__ = [
    "BUILTIN_MCP_SERVER_NAME",
    "DESKTOP_EXECUTION_POLICY_KEY",
    "DESKTOP_EXECUTION_POLICY_VERSION",
    "DESKTOP_POLICY_BRIDGE_REQUIRED_REASON",
    "DESKTOP_POLICY_DENIED_REASON",
    "DESKTOP_POLICY_ENGINE_DENIED_REASON",
    "DESKTOP_POLICY_INVALID_REASON",
    "DESKTOP_SANDBOX_ALLOWED_TOOL_NAMES",
    "DESKTOP_SANDBOX_ELECTRON_TOOL_NAMES",
    "DESKTOP_SANDBOX_MANAGED_ENGINE_TYPES",
    "DESKTOP_SANDBOX_TYPED_FILE_TOOL_NAMES",
    "DesktopExecutionPolicy",
    "DesktopExecutionPolicyError",
    "ELECTRON_TOOL_BRIDGE_SERVER_NAME",
    "container_desktop_execution_policy_is_enforced",
    "desktop_policy_from_cli",
    "desktop_policy_from_config",
    "desktop_policy_is_enforced",
    "desktop_sandbox_engine_reason",
    "desktop_sandbox_engine_supported",
    "desktop_tool_decision",
    "desktop_tool_uses_electron_bridge",
    "filter_desktop_tool_bindings",
    "validate_desktop_execution_policy",
]


def latch_runtime_policies(container: Any, params: Any) -> None:
    """Latch both execution contracts before runtime initialization can dispatch."""
    raw_config = params.get("config") if isinstance(params, dict) else {}
    if raw_config is None:
        raw_config = {}
    for name in ("latch_host_policy", "latch_desktop_execution_policy"):
        latch = getattr(container, name, None)
        if callable(latch):
            latch(raw_config)


def desktop_command_descriptor_fields() -> dict[str, Any]:
    """The public foreground schema for the Linux disposable command backend."""
    return {
        "description": (
            "Run a foreground POSIX /bin/sh command in the offline Docker Linux sandbox. "
            "cwd is workspace-relative (default '.'). The workspace is a disposable copy: "
            "all command-created files are discarded. Use reviewed typed write/edit tools "
            "for durable workspace changes. No background execution; maximum 120 seconds."
        ),
        "input_schema": {
            "type": "object", "additionalProperties": False, "required": ["command"],
            "properties": {
                "command": {"type": "string", "minLength": 1, "maxLength": 16384},
                "cwd": {"type": "string",
                        "description": "Workspace-relative Linux path; default '.'"},
                "timeout_seconds": {"type": "number", "minimum": 0.1, "maximum": 120},
                "expected_exit_codes": {"type": "array", "minItems": 1, "maxItems": 16,
                    "uniqueItems": True,
                    "items": {"type": "integer", "minimum": 0, "maximum": 255}},
                "purpose": {"type": "string"},
            },
        },
    }
