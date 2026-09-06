"""Fail-soft coercers and structured parsers for sidecar runtime config.

Imports ``config_models`` one-way and must never import ``config``.
"""

from __future__ import annotations

import logging
import math
from itertools import islice
from typing import Any

from sidecar.ai.config_models import (
    FallbackModelConfig,
    MCPServerAuth,
    MCPServerConfig,
    RuntimeConfig,
    ToolPolicyRule,
    ToolPolicyRuleMatch,
    ToolPolicySnapshot,
)
from sidecar.ai.error_codes import CMP_MCP_CONFIG_INVALID, CMP_MCP_SSE_DISABLED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.tool_search import DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE, DeferralMode

logger = logging.getLogger(__name__)

MCP_TRANSPORT_STDIO = "stdio"
MCP_TRANSPORT_SSE = "sse"
VALID_MCP_TRANSPORTS = frozenset({MCP_TRANSPORT_STDIO, MCP_TRANSPORT_SSE})
MCP_AUTH_KIND_BEARER = "bearer"
MCP_AUTH_KIND_OAUTH_CLIENT_CREDENTIALS = "oauth_client_credentials"
VALID_MCP_AUTH_KINDS = frozenset(
    {MCP_AUTH_KIND_BEARER, MCP_AUTH_KIND_OAUTH_CLIENT_CREDENTIALS}
)
VALID_REASONING_EFFORTS = frozenset({"", "low", "medium", "high", "xhigh"})
VALID_SAFETY_MODES = frozenset({"normal", "strict", "paranoid"})
LOCAL_FIRST_FALLBACK_ENGINES = frozenset(
    {"ollama", "vllm", "openai-compatible", "codex-cli", "mock"}
)
SESSION_START_DATE_LENGTH = 10
SHA256_HEX_LENGTH = 64
MAX_GENERATION_PROFILE_MODEL_ID_CHARS = 240
SESSION_START_DATE_MONTH_SEPARATOR_INDEX = 4
SESSION_START_DATE_DAY_SEPARATOR_INDEX = 7


def _as_non_empty_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized if normalized else None


def _as_nullable_string(value: Any) -> str | None:
    if value is None:
        return None
    return _as_non_empty_string(value)


def _as_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    return default


def _as_string_mapping(value: Any) -> dict[str, str] | None:
    """Coerce a raw mapping into non-empty str -> str pairs (else ``None``).

    Never raises on malformed input; non-string keys/values and blank entries
    are dropped. Used for secret-bearing maps, so values must never be echoed
    into logs or error messages by callers.
    """
    if not isinstance(value, dict):
        return None
    normalized: dict[str, str] = {}
    for key, entry in value.items():
        name = str(key or "").strip() if isinstance(key, str) else ""
        secret = str(entry or "").strip() if isinstance(entry, str) else ""
        if name and secret:
            normalized[name] = secret
    return normalized or None


def _as_bounded_float(value: Any, *, default: float, min_value: float, max_value: float) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        candidate = float(value)
        if math.isfinite(candidate) and min_value <= candidate <= max_value:
            return candidate
    return default


def _as_optional_bounded_float(
    value: Any,
    *,
    min_value: float,
    max_value: float,
) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        candidate = float(value)
        if math.isfinite(candidate) and min_value <= candidate <= max_value:
            return candidate
    return None


def _as_optional_bounded_float_map(
    value: Any,
    *,
    min_value: float,
    max_value: float,
) -> dict[str, float] | None:
    """Key-wise ``{str: bounded float}`` coercion; invalid entries are dropped.

    Returns ``None`` when the input is not a dict or no valid entries remain,
    mirroring the fail-soft posture of ``_as_optional_bounded_float``.
    """
    if not isinstance(value, dict):
        return None
    normalized: dict[str, float] = {}
    for raw_key, raw_entry in value.items():
        key = _as_non_empty_string(raw_key) if isinstance(raw_key, str) else None
        if key is None:
            continue
        entry = _as_optional_bounded_float(raw_entry, min_value=min_value, max_value=max_value)
        if entry is None:
            continue
        normalized[key] = entry
    return normalized or None


def _normalize_generation_profiles(value: Any) -> dict[str, dict[str, float | int]] | None:
    """Normalize bounded per-model sampler/output overrides entry by entry."""
    if not isinstance(value, dict):
        return None
    bounds: dict[str, tuple[float, float, bool]] = {
        "temperature": (0.0, 2.0, False),
        "topP": (0.0, 1.0, False),
        "topK": (0.0, 200.0, True),
        "minP": (0.0, 1.0, False),
        "presencePenalty": (-2.0, 2.0, False),
        "repetitionPenalty": (0.0, 2.0, False),
        "maxOutputTokens": (1.0, 200_000.0, True),
    }
    normalized: dict[str, dict[str, float | int]] = {}
    for raw_model, raw_profile in islice(value.items(), 128):
        model = _as_non_empty_string(raw_model) if isinstance(raw_model, str) else None
        if (
            model is None
            or len(model) > MAX_GENERATION_PROFILE_MODEL_ID_CHARS
            or not isinstance(raw_profile, dict)
        ):
            continue
        profile: dict[str, float | int] = {}
        for field, (minimum, maximum, integer) in bounds.items():
            raw_entry = raw_profile.get(field)
            if isinstance(raw_entry, bool) or not isinstance(raw_entry, (int, float)):
                continue
            candidate = float(raw_entry)
            if not math.isfinite(candidate) or not minimum <= candidate <= maximum:
                continue
            if integer and not candidate.is_integer():
                continue
            profile[field] = int(candidate) if integer else candidate
        if profile:
            normalized[model] = profile
    return normalized or None


def _as_optional_capped_text(value: Any, *, max_chars: int) -> str | None:
    token = _as_non_empty_string(value)
    if token is None:
        return None
    if len(token) > max_chars:
        return token[:max_chars]
    return token


def _as_bounded_int(value: Any, *, default: int, min_value: int, max_value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return default
        candidate = int(value)
    else:
        candidate = value
    if min_value <= candidate <= max_value:
        return candidate
    return default


def _normalize_reasoning_effort(value: Any, *, default: str = "") -> str:
    token = _as_non_empty_string(value)
    if token is None:
        return default
    normalized = token.lower()
    aliases = {
        "med": "medium",
        "extra-high": "xhigh",
        "extra_high": "xhigh",
        "extra high": "xhigh",
    }
    resolved = aliases.get(normalized, normalized)
    if resolved in VALID_REASONING_EFFORTS:
        return resolved
    return default


def _normalize_session_start_date(value: Any) -> str:
    token = _as_non_empty_string(value)
    if token is None:
        return ""
    if (
        len(token) == SESSION_START_DATE_LENGTH
        and token[SESSION_START_DATE_MONTH_SEPARATOR_INDEX] == "-"
        and token[SESSION_START_DATE_DAY_SEPARATOR_INDEX] == "-"
    ):
        year, month, day = token[:4], token[5:7], token[8:10]
        if year.isdigit() and month.isdigit() and day.isdigit():
            return token
    return ""


def _normalize_safety_mode(value: Any, *, default: str = "normal") -> str:
    token = _as_non_empty_string(value)
    if token is None:
        return default
    normalized = token.lower()
    if normalized in VALID_SAFETY_MODES:
        return normalized
    return default


def _normalize_tool_search_mode(value: Any) -> str:
    token = _as_non_empty_string(value)
    if token is None:
        return DeferralMode.STANDARD.value
    normalized = token.lower()
    if normalized in {mode.value for mode in DeferralMode}:
        return normalized
    return DeferralMode.STANDARD.value


def _normalize_tool_search_threshold_pct(value: Any) -> int:
    return _as_bounded_int(
        value,
        default=DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE,
        min_value=0,
        max_value=100,
    )


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    return []


def _normalize_transport(value: Any) -> str:
    raw = _as_non_empty_string(value)
    if raw is None:
        return MCP_TRANSPORT_STDIO
    normalized = raw.lower()
    if normalized in VALID_MCP_TRANSPORTS:
        return normalized
    return MCP_TRANSPORT_STDIO


def _parse_mcp_server_auth(value: Any, *, server_name: str) -> "MCPServerAuth | None":
    if not isinstance(value, dict):
        return None
    raw_kind = _as_non_empty_string(value.get("kind"))
    kind = (raw_kind or MCP_AUTH_KIND_BEARER).lower()
    if kind not in VALID_MCP_AUTH_KINDS:
        raise ToolExecutionFailure(
            code=CMP_MCP_CONFIG_INVALID,
            message=(
                f"mcp server '{server_name}' has an unknown auth kind '{kind}'; "
                f"expected one of: {', '.join(sorted(VALID_MCP_AUTH_KINDS))}"
            ),
            retryable=False,
        )
    return MCPServerAuth(
        kind=kind,
        token=_as_non_empty_string(value.get("token")),
        token_url=_as_non_empty_string(value.get("token_url")),
        client_id=_as_non_empty_string(value.get("client_id")),
        client_secret=_as_non_empty_string(value.get("client_secret")),
        scope=_as_non_empty_string(value.get("scope")),
    )


def _parse_mcp_servers(
    raw_servers: Any,
    *,
    sse_enabled: bool,
) -> tuple[MCPServerConfig, ...]:
    normalized_servers: list[MCPServerConfig] = []
    for index, candidate in enumerate(_as_list(raw_servers)):
        if not isinstance(candidate, dict):
            continue
        raw_name = _as_non_empty_string(candidate.get("name"))
        name = raw_name or f"mcp_server_{index + 1}"
        transport = _normalize_transport(candidate.get("transport"))
        command = _as_non_empty_string(candidate.get("command"))
        args = tuple(
            str(item)
            for item in _as_list(candidate.get("args"))
            if isinstance(item, (str, int, float)) and str(item).strip()
        )
        url = _as_non_empty_string(candidate.get("url"))
        request_timeout_seconds = _as_bounded_float(
            candidate.get("request_timeout_seconds"),
            default=30.0,
            min_value=1.0,
            max_value=600.0,
        )
        memory_limit_mb = _as_bounded_int(
            candidate.get("memory_limit_mb"),
            default=512,
            min_value=64,
            max_value=4096,
        )
        max_processes = _as_bounded_int(
            candidate.get("max_processes"),
            default=5,
            min_value=1,
            max_value=64,
        )
        max_open_files = _as_bounded_int(
            candidate.get("max_open_files"),
            default=256,
            min_value=32,
            max_value=4096,
        )
        cpu_warning_seconds = _as_bounded_float(
            candidate.get("cpu_warning_seconds"),
            default=30.0,
            min_value=5.0,
            max_value=300.0,
        )
        init_timeout_seconds = _as_bounded_float(
            candidate.get("init_timeout_seconds"),
            default=30.0,
            min_value=1.0,
            max_value=600.0,
        )
        auth = _parse_mcp_server_auth(candidate.get("auth"), server_name=name)
        approved_tools_digest = _as_non_empty_string(candidate.get("approved_tools_digest"))
        if approved_tools_digest is not None and (
            len(approved_tools_digest) != SHA256_HEX_LENGTH
            or any(character not in "0123456789abcdef" for character in approved_tools_digest)
        ):
            raise ToolExecutionFailure(
                code=CMP_MCP_CONFIG_INVALID,
                message=f"mcp server '{name}' has an invalid approved tools digest",
                retryable=False,
            )

        if transport == MCP_TRANSPORT_STDIO:
            if command is None:
                raise ToolExecutionFailure(
                    code=CMP_MCP_CONFIG_INVALID,
                    message=f"mcp server '{name}' requires a non-empty command for stdio transport",
                    retryable=False,
                )
            normalized_servers.append(
                MCPServerConfig(
                    name=name,
                    transport=transport,
                    command=command,
                    args=args,
                    url=None,
                    request_timeout_seconds=request_timeout_seconds,
                    memory_limit_mb=memory_limit_mb,
                    max_processes=max_processes,
                    max_open_files=max_open_files,
                    cpu_warning_seconds=cpu_warning_seconds,
                    init_timeout_seconds=init_timeout_seconds,
                    auth=auth,
                    approved_tools_digest=approved_tools_digest,
                )
            )
            continue

        if not sse_enabled:
            raise ToolExecutionFailure(
                code=CMP_MCP_SSE_DISABLED,
                message=f"mcp server '{name}' requested sse transport but mcp_sse_enabled is false",
                retryable=False,
            )
        if url is None:
            raise ToolExecutionFailure(
                code=CMP_MCP_CONFIG_INVALID,
                message=f"mcp server '{name}' requires a non-empty url for sse transport",
                retryable=False,
            )
        normalized_servers.append(
            MCPServerConfig(
                name=name,
                transport=transport,
                command=None,
                args=(),
                url=url,
                request_timeout_seconds=request_timeout_seconds,
                memory_limit_mb=memory_limit_mb,
                max_processes=max_processes,
                max_open_files=max_open_files,
                cpu_warning_seconds=cpu_warning_seconds,
                init_timeout_seconds=init_timeout_seconds,
                auth=auth,
                approved_tools_digest=approved_tools_digest,
            )
        )
    return tuple(normalized_servers)


def _parse_fallback_models(raw_fallback_models: Any) -> tuple[FallbackModelConfig, ...]:
    result: list[FallbackModelConfig] = []
    for candidate in _as_list(raw_fallback_models):
        if not isinstance(candidate, dict):
            continue
        engine_type = _as_non_empty_string(candidate.get("engine_type"))
        model = _as_non_empty_string(candidate.get("model"))
        if not engine_type or not model:
            continue
        normalized_engine_type = engine_type.lower()
        if normalized_engine_type not in LOCAL_FIRST_FALLBACK_ENGINES:
            continue
        max_context_tokens = (
            _as_bounded_int(
                candidate.get("max_context_tokens"),
                default=0,
                min_value=1,
                max_value=10_000_000,
            )
            or None
        )
        result.append(
            FallbackModelConfig(
                engine_type=normalized_engine_type,
                model=model,
                max_context_tokens=max_context_tokens,
            )
        )
    return tuple(result)


def _normalize_knowledge_roots(value: Any) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for item in _as_list(value):
        token = _as_non_empty_string(item)
        if token is None:
            continue
        # Windows paths are case-insensitive; dedupe accordingly.
        dedupe_key = token.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        result.append(token)
    return tuple(result)


def _normalize_codex_cli_models(value: Any) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for item in _as_list(value):
        token = _as_non_empty_string(item)
        if token is None:
            continue
        if token.lower() == "codex-cli":
            continue
        if token.lower().startswith("codex-cli/"):
            token = token[len("codex-cli/") :].strip()
        if not token or token.lower() == "default":
            continue
        model_id = f"codex-cli/{token}"
        dedupe_key = model_id.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        result.append(model_id)
    return tuple(result)


def codex_cli_unavailable_reason(config: RuntimeConfig) -> str | None:
    if config.codex_cli_enabled is not True:
        return "Codex CLI integration is disabled."
    if not config.codex_cli_runtime_root:
        return "Codex CLI runtime root is not configured."
    if config.codex_cli_auth_ready is not True:
        return config.codex_cli_auth_reason or "Codex CLI ChatGPT auth is not ready."
    return None


def _as_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    return {}


_VALID_POLICY_DECISIONS = frozenset({"auto", "ask", "deny"})


def _normalize_tool_policy_snapshot(value: Any) -> ToolPolicySnapshot | None:
    """Convert the Electron-side snapshot payload into a frozen dataclass.

    The Electron caller emits the shape produced by
    ``ToolPermissionStore.getSnapshot()``: ``{ version, legacy_policies, rules }``.
    Returns ``None`` when the payload is absent or malformed; callers treat
    that as "no overrides — use built-in defaults".
    """

    if not isinstance(value, dict):
        return None

    version = _as_bounded_int(
        value.get("version"), default=1, min_value=1, max_value=(2**31) - 1
    )

    is_legacy_flat_map = "legacy_policies" not in value and "rules" not in value
    raw_legacy = value if is_legacy_flat_map else value.get("legacy_policies")
    legacy_entries: list[tuple[str, str]] = []
    if isinstance(raw_legacy, dict):
        for key, decision in raw_legacy.items():
            if not isinstance(key, str) or not key.strip():
                continue
            if decision not in _VALID_POLICY_DECISIONS:
                continue
            legacy_entries.append((key.strip(), decision))

    raw_rules = value.get("rules")
    rule_entries: list[ToolPolicyRule] = []
    if isinstance(raw_rules, list):
        for entry in raw_rules:
            rule = _normalize_tool_policy_rule(entry)
            if rule is not None:
                rule_entries.append(rule)

    return ToolPolicySnapshot(
        version=version,
        legacy_policies=tuple(legacy_entries),
        rules=tuple(rule_entries),
    )


def _optional_str(source: dict[str, Any], key: str) -> str | None:
    value = source.get(key)
    return value if isinstance(value, str) else None


def _normalize_tool_policy_rule(entry: Any) -> ToolPolicyRule | None:
    if not isinstance(entry, dict):
        return None
    decision = entry.get("decision")
    if decision not in _VALID_POLICY_DECISIONS:
        return None
    rule_id = entry.get("id")
    if not isinstance(rule_id, str) or not rule_id.strip():
        return None
    reason_raw = entry.get("reason")
    reason = (
        reason_raw.strip()
        if isinstance(reason_raw, str) and reason_raw.strip()
        else "Rule matched"
    )

    raw_match_value = entry.get("match")
    raw_match: dict[str, Any] = raw_match_value if isinstance(raw_match_value, dict) else {}
    modes_raw = raw_match.get("mode")
    modes: tuple[str, ...]
    if isinstance(modes_raw, list):
        modes = tuple(item for item in modes_raw if isinstance(item, str) and item)
    else:
        modes = ()

    action: str | None = None
    if "action" in raw_match:
        raw_action = raw_match.get("action")
        if not isinstance(raw_action, str) or not raw_action.strip():
            return None
        action = raw_action.strip()

    match = ToolPolicyRuleMatch(
        tool_id=_optional_str(raw_match, "tool_id"),
        action=action,
        tool_family=_optional_str(raw_match, "tool_family"),
        source_kind=_optional_str(raw_match, "source_kind"),
        mode=modes,
        path_prefix=_optional_str(raw_match, "path_prefix"),
        mcp_server=_optional_str(raw_match, "mcp_server"),
    )
    return ToolPolicyRule(
        id=rule_id.strip(),
        decision=decision,
        reason=reason,
        match=match,
    )


def _identity_value(identity: dict[str, Any], snake_key: str, camel_key: str) -> Any:
    if snake_key in identity:
        return identity.get(snake_key)
    if camel_key in identity:
        return identity.get(camel_key)
    return None
