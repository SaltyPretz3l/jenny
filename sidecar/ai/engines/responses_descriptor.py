"""Jenny-owned closed-vocabulary Responses provider interpreter."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import urlparse

from sidecar.ai.engines.chatgpt_subscription import ChatGPTSubscriptionEngine
from sidecar.ai.engines.responses_descriptor_adapters import CORE_ADAPTERS
from sidecar.ai.exceptions import GenerationError

_REQUIRED_ADAPTERS = CORE_ADAPTERS
_DESCRIPTOR_SCHEMA_VERSION = 5
_REQUIRED_HEADERS = {
    "Authorization": "Bearer {secret:access_token}",
    "ChatGPT-Account-ID": "{auth:account_id}",
    "originator": "jenny",
    "User-Agent": "jenny",
    "Accept": "text/event-stream",
    "Content-Type": "application/json",
}
_REQUIRED_LOOKUP_TABLES = {
    "reasoning_effort": {
        "minimal": "low", "low": "low", "medium": "medium",
        "high": "high", "xhigh": "xhigh", "max": "max",
    }
}
_REQUIRED_SAFE_SCALARS = {
    ("error.code", "string", 64, 0, 0),
    ("error.message", "string", 512, 0, 0),
    ("rate_limit.reset_at", "number", 0, 0, 9_007_199_254_740_991),
}
_REQUIRED_ERROR_MAP = {
    (401, "", "authentication_required", False),
    (429, "", "rate_limited", True),
    (500, "", "provider_unavailable", True),
}
_REQUIRED_STREAM_MAP = {
    ("response.output_text.delta", "text_delta", "delta"),
    ("response.reasoning_summary_text.delta", "reasoning_delta", "delta"),
    ("response.reasoning_text.delta", "reasoning_delta", "delta"),
    ("response.output_item.done", "output_item", "item"),
    ("response.completed", "completed", "response"),
    ("response.failed", "failed", "response.error"),
}


class ResponsesDescriptorError(ValueError):
    """Raised before network creation when a provider descriptor is not admissible."""


def _resolved_headers(descriptor: Mapping[str, Any], *, access_token: str,
                      account_id: str | None) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for row in descriptor.get("headers", []):
        if not isinstance(row, Mapping):
            raise ResponsesDescriptorError("provider headers rejected")
        name = str(row.get("name") or "")
        template = str(row.get("value") or "")
        value = template.replace("{secret:access_token}", access_token).replace(
            "{auth:account_id}", str(account_id or "").strip()
        )
        if "{" in value or "}" in value:
            raise ResponsesDescriptorError("provider header placeholder rejected")
        if name == "ChatGPT-Account-ID" and not value:
            continue
        resolved[name] = value
    return resolved


def validate_responses_descriptor(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise ResponsesDescriptorError("provider descriptor unavailable")
    descriptor = dict(raw)
    endpoint = str(descriptor.get("endpoint") or "")
    parsed = urlparse(endpoint)
    header_rows = descriptor.get("headers", [])
    lookup_rows = descriptor.get("lookup_tables", [])
    scalar_rows = descriptor.get("safe_scalar_rules", [])
    error_rows = descriptor.get("error_map", [])
    stream_rows = descriptor.get("stream_map", [])
    model_catalog = descriptor.get("model_catalog", [])
    if not all(isinstance(rows, list) for rows in (
        header_rows, lookup_rows, scalar_rows, error_rows, stream_rows, model_catalog
    )):
        raise ResponsesDescriptorError("provider descriptor rejected")
    headers = {str(row.get("name")): str(row.get("value"))
               for row in header_rows if isinstance(row, Mapping)}
    lookup_tables = {
        str(row.get("name")): {
            str(entry.get("from")): str(entry.get("to"))
            for entry in row.get("entries", []) if isinstance(entry, Mapping)
        }
        for row in lookup_rows if isinstance(row, Mapping)
    }
    scalar_rules = {
        (str(row.get("name")), str(row.get("kind")), row.get("max_utf8_bytes"),
         row.get("minimum"), row.get("maximum"))
        for row in scalar_rows if isinstance(row, Mapping)
    }
    error_map = {
        (row.get("status_code"), str(row.get("provider_code")),
         str(row.get("reason_code")), row.get("retryable"))
        for row in error_rows if isinstance(row, Mapping)
    }
    stream_map = {
        (str(row.get("event")), str(row.get("output_kind")), str(row.get("source_path")))
        for row in stream_rows if isinstance(row, Mapping)
    }
    model_ids = [str(row.get("id")) for row in model_catalog if isinstance(row, Mapping)]
    models_valid = bool(model_catalog) and len(model_ids) == len(model_catalog) \
        and len(set(model_ids)) == len(model_ids) and all(
            isinstance(row.get("label"), str) and bool(row["label"].strip())
            and isinstance(row.get("context_length"), int)
            and not isinstance(row.get("context_length"), bool)
            and row["context_length"] > 0
            for row in model_catalog if isinstance(row, Mapping)
        )
    if descriptor.get("descriptor_schema_version") != _DESCRIPTOR_SCHEMA_VERSION \
            or descriptor.get("provider_id") != "chatgpt" \
            or descriptor.get("engine_type") != "chatgpt" \
            or descriptor.get("auth_profile") != "chatgpt_subscription_oauth" \
            or descriptor.get("request_template") != "openai_responses_v1" \
            or descriptor.get("input_template") != "openai_responses_input_v1" \
            or descriptor.get("tool_template") != "openai_function_tools_v1" \
            or endpoint != "https://chatgpt.com/backend-api/codex" \
            or parsed.scheme != "https" or parsed.hostname != "chatgpt.com" \
            or len(headers) != len(header_rows) \
            or headers != _REQUIRED_HEADERS \
            or len(lookup_tables) != len(lookup_rows) \
            or lookup_tables != _REQUIRED_LOOKUP_TABLES \
            or len(scalar_rules) != len(scalar_rows) \
            or scalar_rules != _REQUIRED_SAFE_SCALARS \
            or len(error_map) != len(error_rows) \
            or error_map != _REQUIRED_ERROR_MAP \
            or len(stream_map) != len(stream_rows) \
            or stream_map != _REQUIRED_STREAM_MAP \
            or not models_valid \
            or len(descriptor.get("core_adapters", [])) != len(_REQUIRED_ADAPTERS) \
            or set(descriptor.get("core_adapters", [])) != _REQUIRED_ADAPTERS:
        raise ResponsesDescriptorError("provider descriptor rejected")
    return descriptor


class ResponsesDescriptorEngine(ChatGPTSubscriptionEngine):
    """Generic Responses engine configured only by an admitted V5 descriptor."""

    def __init__(  # noqa: PLR0913 - provider construction is explicit and secret-safe.
        self, *, descriptor: Mapping[str, Any], model: str, access_token: str,
                 account_id: str | None, max_reasoning_items: int,
                 authority_check: Callable[[], bool] | None = None) -> None:
        admitted = validate_responses_descriptor(descriptor)
        self.provider_descriptor = admitted
        self._authority_check = authority_check
        self._descriptor_context_lengths = {
            str(item["id"]): int(item["context_length"])
            for item in admitted.get("model_catalog", [])
            if isinstance(item, Mapping)
        }
        super().__init__(
            model=model,
            access_token=access_token,
            account_id=account_id,
            base_url=str(admitted["endpoint"]),
            max_reasoning_items=max_reasoning_items,
            request_profile=str(admitted["request_template"]),
            stream_profile="openai_responses_sse_v1",
            headers_override=_resolved_headers(
                admitted, access_token=access_token, account_id=account_id
            ),
        )

    def stream_with_tools(self, *args: Any, **kwargs: Any) -> Any:
        if self._authority_check is not None:
            try:
                current = self._authority_check()
            except Exception:  # noqa: BLE001 - authority failures are fail-closed.
                current = False
            if current is not True:
                raise GenerationError("ChatGPT provider authority is no longer active")
        return (yield from super().stream_with_tools(*args, **kwargs))

    def get_model_context_length(self) -> int:
        return self._descriptor_context_lengths.get(
            self.model_name, super().get_model_context_length()
        )
