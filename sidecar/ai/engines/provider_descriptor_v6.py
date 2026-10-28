"""Provider descriptor v6: the closed vocabulary for user API-key providers (row 78).

A v6 descriptor is data, never code. It names one of three Jenny-owned wire
transports and one of three key profiles; the transport bundle owns every
request, stream and error mapping. Electron builds the descriptor from a
preset or the user's custom endpoint and sends it on ``initialize``; this
module admits it before any network object exists, and the engine re-checks
the endpoint host at build time.

The ChatGPT subscription descriptor (v5) keeps its own pinned validator
(``responses_descriptor.validate_responses_descriptor``). Its auth profile is
not part of this vocabulary, so a v6 descriptor can never carry the ChatGPT
sign-in.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Callable, Mapping
from typing import Any, TypeGuard
from urllib.parse import urlsplit

DESCRIPTOR_SCHEMA_VERSION = 6
TRANSPORT_CHAT_COMPLETIONS = "openai_chat_completions_v1"
TRANSPORT_RESPONSES = "openai_responses_v1"
TRANSPORT_ANTHROPIC_MESSAGES = "anthropic_messages_v1"
TRANSPORTS = frozenset(
    {TRANSPORT_CHAT_COMPLETIONS, TRANSPORT_RESPONSES, TRANSPORT_ANTHROPIC_MESSAGES}
)
AUTH_NONE = "none"
AUTH_BEARER = "api_key_bearer"
AUTH_HEADER = "api_key_header"
AUTH_PROFILES = frozenset({AUTH_NONE, AUTH_BEARER, AUTH_HEADER})
TOKEN_LIMIT_FIELDS = frozenset({"max_tokens", "max_completion_tokens"})
# The legacy engine-type names and the built-in engines can never be a
# provider id: a provider is always reached through ``api-provider``.
RESERVED_PROVIDER_IDS = frozenset(
    {
        "anthropic", "openai", "gemini", "chatgpt", "codex-cli", "ollama", "vllm",
        "openai-compatible", "mock", "replay", "api-provider",
    }
)
# User-added headers: a closed allowlist (OpenRouter's attribution pair). The
# key header, cookies and hop-by-hop headers can never be set this way.
HEADER_ALLOWLIST = {"http-referer": "HTTP-Referer", "x-title": "X-Title"}
MAX_HEADERS = len(HEADER_ALLOWLIST)
MAX_HEADER_VALUE_CHARS = 256
MAX_LABEL_CHARS = 64
MAX_URL_CHARS = 2048
MAX_MODEL_ID_CHARS = 200
MAX_CATALOG_ROWS = 256
MAX_CONTEXT_TOKENS = 10_000_000
_PROVIDER_ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_FIELDS = frozenset(
    {
        "descriptor_schema_version", "provider_id", "label", "endpoint", "transport",
        "auth_profile", "headers", "model_catalog", "token_limit_field",
    }
)
_CATALOG_FIELDS = frozenset(
    {"id", "label", "context_length", "max_output_tokens", "tools", "vision", "reasoning"}
)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class ProviderDescriptorError(ValueError):
    """A v6 descriptor (or its endpoint) is not admissible.

    Messages never echo descriptor values: a caller bug could put a key there.
    """


def _is_local_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def host_resolves_only_to_local_addresses(hostname: str, port: int | None) -> bool:
    """True when every address ``hostname`` resolves to is loopback, private or link-local.

    The same rule the local ``openai-compatible`` gate applies
    (``factory._validate_openai_compatible_local_host``); that gate keeps its
    own copy so this module can never loosen it.
    """
    host = str(hostname or "").strip().lower().strip("[]")
    if not host:
        return False
    if host == "localhost" or host.endswith(".localhost") or _is_local_address(host):
        return True
    try:
        resolved = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addresses = [str(sockaddr[0]) for *_prefix, sockaddr in resolved if sockaddr]
    return bool(addresses) and all(_is_local_address(address) for address in addresses)


def validate_provider_endpoint(
    endpoint: Any,
    *,
    resolve_local: Callable[[str, int | None], bool] = host_resolves_only_to_local_addresses,
) -> str:
    """Return the normalized endpoint (no trailing slash) or raise.

    ``https`` is required; plain ``http`` only when the host resolves only to
    loopback, private or link-local addresses. Credentials, query strings and
    fragments are refused so a key can never ride the URL.
    """
    if not isinstance(endpoint, str) or not endpoint or len(endpoint) > MAX_URL_CHARS:
        raise ProviderDescriptorError("provider endpoint rejected")
    if _CONTROL_RE.search(endpoint) or endpoint != endpoint.strip():
        raise ProviderDescriptorError("provider endpoint rejected")
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError as error:
        raise ProviderDescriptorError("provider endpoint rejected") from error
    hostname = (parts.hostname or "").lower()
    if (
        parts.scheme not in {"https", "http"}
        or not hostname
        or parts.username is not None
        or parts.password is not None
        or "@" in parts.netloc
        or parts.query
        or parts.fragment
        or "?" in endpoint
        or "#" in endpoint
    ):
        raise ProviderDescriptorError("provider endpoint rejected")
    if parts.scheme == "http" and not resolve_local(hostname, port):
        raise ProviderDescriptorError("provider endpoint must use https")
    return endpoint.rstrip("/")


def _positive_int(value: Any, maximum: int) -> TypeGuard[int]:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 < value <= maximum
    )


def _bounded_text(value: Any, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= maximum
        and not _CONTROL_RE.search(value)
    )


def validate_model_id(value: Any) -> str:
    if not _bounded_text(value, MAX_MODEL_ID_CHARS) or value != value.strip():
        raise ProviderDescriptorError("provider model id rejected")
    return str(value)


def _validate_headers(raw: Any) -> list[dict[str, str]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_HEADERS:
        raise ProviderDescriptorError("provider headers rejected")
    admitted: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in raw:
        if not isinstance(row, Mapping) or set(row) != {"name", "value"}:
            raise ProviderDescriptorError("provider headers rejected")
        name = row.get("name")
        canonical = HEADER_ALLOWLIST.get(str(name or "").strip().lower())
        value = row.get("value")
        if (
            canonical is None
            or canonical in seen
            or not _bounded_text(value, MAX_HEADER_VALUE_CHARS)
            or "{" in str(value)
            or "}" in str(value)
        ):
            raise ProviderDescriptorError("provider headers rejected")
        seen.add(canonical)
        admitted.append({"name": canonical, "value": str(value)})
    return admitted


def _validate_catalog_row(row: Any) -> dict[str, Any]:
    if not isinstance(row, Mapping) or not set(row) <= _CATALOG_FIELDS:
        raise ProviderDescriptorError("provider model catalog rejected")
    admitted: dict[str, Any] = {"id": validate_model_id(row.get("id"))}
    if "label" in row and not _bounded_text(row["label"], MAX_LABEL_CHARS):
        raise ProviderDescriptorError("provider model catalog rejected")
    numbers_ok = all(
        _positive_int(row[key], MAX_CONTEXT_TOKENS)
        for key in ("context_length", "max_output_tokens") if key in row
    )
    flags_ok = all(
        isinstance(row[key], bool) for key in ("tools", "vision", "reasoning") if key in row
    )
    if not numbers_ok or not flags_ok:
        raise ProviderDescriptorError("provider model catalog rejected")
    admitted.update({key: row[key] for key in _CATALOG_FIELDS - {"id"} if key in row})
    return admitted


def _validate_catalog(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_CATALOG_ROWS:
        raise ProviderDescriptorError("provider model catalog rejected")
    rows = [_validate_catalog_row(row) for row in raw]
    if len({row["id"] for row in rows}) != len(rows):
        raise ProviderDescriptorError("provider model catalog rejected")
    return rows


def validate_provider_descriptor(
    raw: Mapping[str, Any] | None,
    *,
    resolve_local: Callable[[str, int | None], bool] = host_resolves_only_to_local_addresses,
) -> dict[str, Any]:
    """Admit one v6 descriptor, returning a fresh normalized copy, or raise.

    Unknown fields, an unknown transport or auth profile, a reserved provider
    id, a non-allowlisted header, a placeholder anywhere but the bundle's own
    auth header, and ``http`` to a public host are all refused.
    """
    if not isinstance(raw, Mapping) or not set(raw) <= _FIELDS:
        raise ProviderDescriptorError("provider descriptor rejected")
    version = raw.get("descriptor_schema_version")
    provider_id = raw.get("provider_id")
    transport = raw.get("transport")
    auth_profile = raw.get("auth_profile")
    token_limit_field = raw.get("token_limit_field", "max_tokens")
    if (
        isinstance(version, bool)
        or version != DESCRIPTOR_SCHEMA_VERSION
        or not isinstance(provider_id, str)
        or not _PROVIDER_ID_RE.fullmatch(provider_id)
        or provider_id in RESERVED_PROVIDER_IDS
        or transport not in TRANSPORTS
        or auth_profile not in AUTH_PROFILES
        or token_limit_field not in TOKEN_LIMIT_FIELDS
        or not _bounded_text(raw.get("label"), MAX_LABEL_CHARS)
    ):
        raise ProviderDescriptorError("provider descriptor rejected")
    return {
        "descriptor_schema_version": DESCRIPTOR_SCHEMA_VERSION,
        "provider_id": provider_id,
        "label": str(raw["label"]).strip(),
        "endpoint": validate_provider_endpoint(raw.get("endpoint"), resolve_local=resolve_local),
        "transport": transport,
        "auth_profile": auth_profile,
        "token_limit_field": token_limit_field,
        "headers": _validate_headers(raw.get("headers")),
        "model_catalog": _validate_catalog(raw.get("model_catalog")),
    }


LIMIT_SOURCES = frozenset({"pin", "preset", "provider", "catalog", "fallback"})
_LIMIT_FIELDS = ("context_length", "max_output_tokens", "tools", "vision", "reasoning")


def validate_model_limits(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """Admit the limits Electron resolved for the selected model (plan section 3.5).

    Every field is required and carries its source; the output budget must
    fit inside the window. The sidecar re-validates rather than trusting the
    chain, because these numbers size a paid request.
    """
    if not isinstance(raw, Mapping) or set(raw) != {*_LIMIT_FIELDS, "sources"}:
        raise ProviderDescriptorError("provider model limits rejected")
    sources = raw.get("sources")
    if not isinstance(sources, Mapping) or set(sources) != set(_LIMIT_FIELDS):
        raise ProviderDescriptorError("provider model limits rejected")
    context_length = raw.get("context_length")
    max_output = raw.get("max_output_tokens")
    if (
        not _positive_int(context_length, MAX_CONTEXT_TOKENS)
        or not _positive_int(max_output, MAX_CONTEXT_TOKENS)
        or max_output > context_length
        or not all(isinstance(raw.get(key), bool) for key in ("tools", "vision", "reasoning"))
        or not all(sources.get(key) in LIMIT_SOURCES for key in _LIMIT_FIELDS)
    ):
        raise ProviderDescriptorError("provider model limits rejected")
    return {
        **{key: raw[key] for key in _LIMIT_FIELDS},
        "sources": {key: str(sources[key]) for key in _LIMIT_FIELDS},
    }


def resolved_auth_headers(descriptor: Mapping[str, Any], api_key: str | None) -> dict[str, str]:
    """The request headers for an admitted descriptor: allowlisted extras plus the key header.

    The key header comes only from the auth profile; ``none`` never sends a
    key even when one is configured. A profile that needs a key refuses an
    empty one rather than sending an unauthenticated request.
    """
    headers = {row["name"]: row["value"] for row in descriptor.get("headers", [])}
    profile = descriptor.get("auth_profile")
    if profile == AUTH_NONE:
        return headers
    key = str(api_key or "").strip()
    if not key or _CONTROL_RE.search(key):
        raise ProviderDescriptorError("provider key unavailable")
    if profile == AUTH_BEARER:
        headers["Authorization"] = f"Bearer {key}"
    elif profile == AUTH_HEADER:
        headers["x-api-key"] = key
    else:
        raise ProviderDescriptorError("provider descriptor rejected")
    return headers


__all__ = [
    "AUTH_BEARER",
    "AUTH_HEADER",
    "AUTH_NONE",
    "AUTH_PROFILES",
    "DESCRIPTOR_SCHEMA_VERSION",
    "HEADER_ALLOWLIST",
    "LIMIT_SOURCES",
    "RESERVED_PROVIDER_IDS",
    "TRANSPORTS",
    "TRANSPORT_ANTHROPIC_MESSAGES",
    "TRANSPORT_CHAT_COMPLETIONS",
    "TRANSPORT_RESPONSES",
    "ProviderDescriptorError",
    "host_resolves_only_to_local_addresses",
    "resolved_auth_headers",
    "validate_model_id",
    "validate_model_limits",
    "validate_provider_descriptor",
    "validate_provider_endpoint",
]
