"""Pure structural sanity checks for provider tool schemas.

Schemas roundtrip through the existing normalization path, with the result
cached once per provider profile. A failed roundtrip triggers an in-band
downgrade.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from .contracts import validate_tool_arguments
from .models import ToolSchema
from .normalization import normalize_generation_response
from .schema_examples import minimal_valid_arguments

# ---------------------------------------------------------------------------
# Public DTO
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RoundtripResult:
    """Outcome of :func:`schema_roundtrip_check`."""

    passed: bool
    provider: str
    mismatched_tools: tuple[str, ...] = ()
    reason: str | None = None


_OK_PROVIDERS: frozenset[str] = frozenset({"openai", "ollama", "vllm"})

# ---------------------------------------------------------------------------
# Public helper
# ---------------------------------------------------------------------------


def schema_roundtrip_check(
    tool_schemas: Iterable[ToolSchema],
    *,
    provider: str,
) -> RoundtripResult:
    """Verify each schema serializes-then-parses without losing identity.

    For every schema:
      1. Build a placeholder arguments dict whose keys are the schema's
         required-field set (or the full property set if ``required`` is
         absent / empty).
      2. Wrap it in a provider-shaped response payload using the provider's
         own envelope conventions.
      3. Parse the payload via :func:`normalize_generation_response`.
      4. Compare the parsed :class:`ToolCallRequest` against the schema:
         the ``tool_id`` must match the schema name, and the parsed
         arguments must contain every required key.

    Any mismatch → the schema's name is recorded in ``mismatched_tools`` and
    the overall ``passed`` flag flips to False. Empty input is treated as a
    pass (there is nothing to mismatch).
    """
    schemas = list(tool_schemas or [])
    normalized_provider = str(provider or "").strip().lower()

    if not normalized_provider:
        return RoundtripResult(
            passed=False,
            provider=normalized_provider,
            reason="provider_missing",
        )

    if not schemas:
        return RoundtripResult(passed=True, provider=normalized_provider)

    if normalized_provider not in _OK_PROVIDERS:
        return RoundtripResult(
            passed=False,
            provider=normalized_provider,
            reason=f"unsupported_provider:{normalized_provider}",
        )

    mismatched: list[str] = []
    for schema in schemas:
        try:
            if not _roundtrip_one(schema, provider=normalized_provider):
                mismatched.append(schema.name or schema.tool_id or "<unnamed>")
        except Exception:  # noqa: BLE001 — defensive; record as mismatch.
            mismatched.append(schema.name or schema.tool_id or "<unnamed>")

    if mismatched:
        return RoundtripResult(
            passed=False,
            provider=normalized_provider,
            mismatched_tools=tuple(mismatched),
            reason="parsed_schema_mismatch",
        )
    return RoundtripResult(passed=True, provider=normalized_provider)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _roundtrip_one(schema: ToolSchema, *, provider: str) -> bool:
    name = (schema.name or "").strip()
    if not name:
        return False
    placeholder_args = _build_placeholder_arguments(schema)
    payload = _build_provider_payload(name, placeholder_args, provider=provider)
    parsed = normalize_generation_response(payload, provider)
    if not parsed.tool_calls:
        return False
    call = parsed.tool_calls[0]
    if (call.tool_id or "").strip() != name:
        return False
    expected_keys = set(placeholder_args.keys())
    actual_keys = set((call.arguments or {}).keys())
    if not expected_keys.issubset(actual_keys):
        return False
    validate_tool_arguments(
        tool_name=name,
        arguments=call.arguments or {},
        input_schema=dict(schema.parameters) if isinstance(schema.parameters, Mapping) else {},
    )
    return True


def _build_placeholder_arguments(schema: ToolSchema) -> dict[str, Any]:
    """Build arguments that satisfy the same schema enforced at dispatch."""
    parameters = dict(schema.parameters) if isinstance(schema.parameters, Mapping) else {}
    return minimal_valid_arguments(parameters)


def _build_provider_payload(
    name: str,
    arguments: dict[str, Any],
    *,
    provider: str,
) -> dict[str, Any]:
    """Construct a minimal provider-shaped payload that should roundtrip cleanly."""
    if provider == "ollama":
        return {
            "message": {
                "content": "",
                "tool_calls": [
                    {
                        "id": "rt_call_1",
                        "function": {
                            "name": name,
                            "arguments": arguments,
                        },
                    }
                ],
            }
        }
    # OpenAI-shaped envelopes cover local OpenAI-compatible and vLLM providers.
    return {
        "choices": [
            {
                "message": {
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "rt_call_1",
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


__all__ = [
    "RoundtripResult",
    "schema_roundtrip_check",
]
