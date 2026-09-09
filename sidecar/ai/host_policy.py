"""Bounded execution policy for the hosted sidecar profile.

The desktop profile remains the default.  A hosted profile is deliberately
closed: the host may expose only the small set of typed tools that do not turn
the sidecar into a general command, script, network, plugin, or MCP runner.
This module is the single policy decision point used by tool assembly and the
first-party MCP dispatch seam.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

HOST_MODE_DESKTOP = "desktop"
HOST_MODE_SERVER = "server"
HOST_EXECUTION_POLICY_VERSION = 2
SUPPORTED_HOST_EXECUTION_POLICY_VERSIONS = frozenset({1, HOST_EXECUTION_POLICY_VERSION})

# Keep this list explicit.  A new tool is denied in hosted mode until its
# contract is reviewed and added here deliberately.
HOST_ALLOWED_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "read_file",
        "list_dir",
        "glob_files",
        "grep_search",
        "write_file",
        "edit_file",
        "create_artifact",
        "mermaid_generate",
        "ask_user",
        "exit_plan_mode",
    }
)
HOST_ALLOWED_TOOL_NAMES_V2: frozenset[str] = HOST_ALLOWED_TOOL_NAMES | frozenset({"run_command"})

HOST_FILESYSTEM_MUTATION_TOOL_NAMES: frozenset[str] = frozenset(
    {"write_file", "edit_file", "create_artifact"}
)

# The hosted JSON-RPC process is a chat/model endpoint, not a general-purpose
# desktop controller.  Keep this list deliberately explicit so newly added
# request handlers remain unavailable until their server contract is reviewed.
HOST_ALLOWED_RPC_METHODS: frozenset[str] = frozenset(
    {
        "initialize",
        "shutdown",
        "chat.send",
        "chat.cancel",
        "models.list",
        "models.resident",
        "models.ollama_blob",
        "memory.status",
        "memory.list",
        "memory.recall",
        "memory.recall_recent",
    }
)

HOST_POLICY_INVALID_REASON = "host execution policy is invalid"
HOST_POLICY_DENIED_REASON = "tool is not allowed by the hosted execution policy"


class HostPolicyError(ValueError):
    """Raised when a host profile declares an unsupported policy."""


@dataclass(frozen=True)
class HostExecutionPolicy:
    mode: str
    version: int | None

    @property
    def enforced(self) -> bool:
        return (
            self.mode == HOST_MODE_SERVER
            and self.version in SUPPORTED_HOST_EXECUTION_POLICY_VERSIONS
        )

    @property
    def worker_enabled(self) -> bool:
        return self.enforced and self.version == HOST_EXECUTION_POLICY_VERSION


def _value(config: Any, key: str, default: Any) -> Any:
    if isinstance(config, Mapping):
        return config.get(key, default)
    return getattr(config, key, default)


def validate_host_policy(mode: Any = HOST_MODE_DESKTOP, version: Any = None) -> HostExecutionPolicy:
    """Validate the host declaration without coercing untrusted values."""

    if not isinstance(mode, str) or mode not in {HOST_MODE_DESKTOP, HOST_MODE_SERVER}:
        raise HostPolicyError("unsupported host_mode")
    if version is None:
        if mode == HOST_MODE_SERVER:
            raise HostPolicyError("server host_mode requires policy version 1 or 2")
        return HostExecutionPolicy(mode=mode, version=None)
    if isinstance(version, bool) or not isinstance(version, int):
        raise HostPolicyError("host_execution_policy_version must be an integer")
    if version not in SUPPORTED_HOST_EXECUTION_POLICY_VERSIONS:
        raise HostPolicyError("unsupported host_execution_policy_version")
    return HostExecutionPolicy(mode=mode, version=version)


def host_policy_from_config(config: Any = None) -> HostExecutionPolicy:
    """Validate the host declaration carried by a RuntimeConfig or mapping."""

    return validate_host_policy(
        _value(config, "host_mode", HOST_MODE_DESKTOP),
        _value(config, "host_execution_policy_version", None),
    )


def host_policy_from_cli(mode: Any, version: Any) -> HostExecutionPolicy:
    """Parse the string-valued builtin-server CLI declaration strictly."""

    normalized_version: int | None
    if version is None or version == "":
        normalized_version = None
    elif isinstance(version, int) and not isinstance(version, bool):
        normalized_version = version
    elif isinstance(version, str) and version.isdecimal():
        normalized_version = int(version)
    else:
        raise HostPolicyError("host_execution_policy_version must be an integer")
    return validate_host_policy(mode, normalized_version)


def host_policy_is_enforced(config: Any = None) -> bool:
    """Return true only for the exact supported hosted declaration."""

    try:
        return host_policy_from_config(config).enforced
    except HostPolicyError:
        return False


def host_execution_worker_enabled(config: Any = None) -> bool:
    """Return true only for the broker-backed v2 command capability."""

    try:
        policy = host_policy_from_config(config)
    except HostPolicyError:
        return False
    return bool(
        policy.worker_enabled
        and _value(config, "host_execution_worker_enabled", False) is True
        and _value(config, "electron_tool_bridge_enabled", False) is True
        and _value(config, "tools_shell_enabled", False) is True
        and isinstance(_value(config, "tools_workspace_root", None), str)
        and bool(_value(config, "tools_workspace_root", "").strip())
    )


def container_host_policy_is_enforced(container: Any) -> bool:
    """Read the stable container latch and deny indeterminate adapter state."""

    explicit = getattr(container, "host_policy_enforced", None)
    if isinstance(explicit, bool):
        return explicit
    state = getattr(container, "__dict__", {})
    if not isinstance(state, dict):
        return True
    stack = state.get("_stack") or getattr(
        state.get("_stack_generations"), "current_stack", None
    ) or state.get("stack")
    sentinel = object()
    config = getattr(stack, "config", sentinel)
    if config is sentinel:
        config = state.get("config", sentinel)
    if config is sentinel or config is None:
        return True
    try:
        return host_policy_from_config(config).enforced
    except HostPolicyError:
        return True


def host_tool_decision(tool: Any, config: Any = None) -> tuple[bool, str | None]:
    """Return the canonical offer/dispatch decision for one descriptor/tool."""

    try:
        policy = host_policy_from_config(config)
    except HostPolicyError:
        return False, HOST_POLICY_INVALID_REASON
    if not policy.enforced:
        return True, None
    name = tool if isinstance(tool, str) else getattr(tool, "name", "")
    normalized_name = str(name or "").strip()
    source_kind = getattr(tool, "source_kind", "builtin")
    allowed_names = HOST_ALLOWED_TOOL_NAMES_V2 if policy.worker_enabled else HOST_ALLOWED_TOOL_NAMES
    if normalized_name not in allowed_names or source_kind != "builtin":
        return False, HOST_POLICY_DENIED_REASON
    if normalized_name == "run_command" and not host_execution_worker_enabled(config):
        return False, "host execution worker is unavailable"
    return True, None


def filter_host_tool_bindings(bindings: Mapping[str, Any], config: Any = None) -> dict[str, Any]:
    """Drop tools outside the hosted allowlist before they can be registered."""

    if not host_policy_is_enforced(config):
        try:
            host_policy_from_config(config)
        except HostPolicyError:
            return {}
        return dict(bindings)
    return {
        name: handler
        for name, handler in bindings.items()
        if host_tool_decision(name, config)[0]
    }


def host_tool_requires_one_off_approval(tool: Any) -> bool:
    """Hosted filesystem mutations may not inherit persistent auto-approval."""

    name = tool if isinstance(tool, str) else getattr(tool, "name", "")
    return str(name or "").strip() in (
        HOST_FILESYSTEM_MUTATION_TOOL_NAMES | frozenset({"run_command"})
    )


def host_run_command_schema() -> dict[str, Any]:
    # The hosted prompt/approval contract is deliberately narrower than the
    # desktop command tool. The broker still validates exact UTF-8 budgets.
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["command"],
        "properties": {
            "command": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384,
                "pattern": r"^(?!\s*$)[^\x00]+$",
                "description": "Foreground POSIX shell command in an offline disposable copy.",
            },
            "cwd": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1024,
                "pattern": (
                    r"^(?!.*(?:^|/)\.\.?(?:/|$))"
                    r"(?:[^/\\:\x00]+/){0,31}[^/\\:\x00]+$|^\.$"
                ),
                "description": "Relative directory within the workspace copy; default is .",
            },
            "timeout_seconds": {"type": "number", "minimum": 0.1, "maximum": 120},
            "expected_exit_codes": {
                "type": "array",
                "minItems": 1,
                "maxItems": 16,
                "uniqueItems": True,
                "items": {"type": "integer", "minimum": 0, "maximum": 255},
            },
            "purpose": {"type": "string", "maxLength": 1000},
        },
    }


__all__ = [
    "HOST_ALLOWED_TOOL_NAMES",
    "HOST_EXECUTION_POLICY_VERSION",
    "HOST_ALLOWED_TOOL_NAMES_V2",
    "HOST_FILESYSTEM_MUTATION_TOOL_NAMES",
    "HOST_ALLOWED_RPC_METHODS",
    "HOST_MODE_DESKTOP",
    "HOST_MODE_SERVER",
    "HOST_POLICY_DENIED_REASON",
    "HOST_POLICY_INVALID_REASON",
    "HostExecutionPolicy",
    "HostPolicyError",
    "container_host_policy_is_enforced",
    "filter_host_tool_bindings",
    "host_policy_from_cli",
    "host_policy_from_config",
    "host_policy_is_enforced",
    "host_execution_worker_enabled",
    "host_run_command_schema",
    "host_tool_decision",
    "host_tool_requires_one_off_approval",
    "validate_host_policy",
]
