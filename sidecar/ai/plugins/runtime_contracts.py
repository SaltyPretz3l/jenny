"""Strict parsing and validation helpers for plugin runtime contracts."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Final, Mapping, cast

from sidecar.ai.error_codes import CMP_PLUGIN_GENERATION_INVALID
from sidecar.ai.plugins.generated_plugin_contracts import validate

MAX_CONTENT_ROWS: Final[int] = 512
STAGE4B_SCHEMA_VERSION: Final[int] = 2
STAGE5_SCHEMA_VERSION: Final[int] = 3
STAGE6_SCHEMA_VERSION: Final[int] = 4
STAGE7_SCHEMA_VERSION: Final[int] = 5
STAGE8_SCHEMA_VERSION: Final[int] = 6
_HASH_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{64}$")
_CONTRIBUTION_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class PluginRuntimeContractError(ValueError):
    def __init__(
        self,
        reason_code: str,
        *,
        code: str = CMP_PLUGIN_GENERATION_INVALID,
        rejected_contributions: tuple[dict[str, object], ...] = (),
    ) -> None:
        super().__init__(reason_code)
        self.code = code
        self.reason_code = reason_code
        self.rejected_contributions = rejected_contributions


def contract_rejection(
    reason_code: str,
    contribution_id: str | None = None,
) -> PluginRuntimeContractError:
    rejected: tuple[dict[str, object], ...] = ()
    if contribution_id is not None and _CONTRIBUTION_ID_RE.fullmatch(contribution_id):
        rejected = ({
            "contribution_id": contribution_id,
            "reason_code": reason_code,
            "retryable": False,
        },)
    return PluginRuntimeContractError(reason_code, rejected_contributions=rejected)


def validated_contract(
    contract_name: str,
    value: object,
    reason_code: str,
) -> dict[str, Any]:
    verdict = validate(contract_name, value)
    if verdict.get("ok") is not True or not isinstance(verdict.get("value"), dict):
        raise contract_rejection(reason_code)
    return cast(dict[str, Any], verdict["value"])


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def reject_json_constant(_value: str) -> None:
    raise ValueError("non-finite number")


def _parse_exact_content(
    content_json: str, expected_digest: str, *, contract_name: str
) -> dict[str, Any]:
    try:
        encoded = content_json.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise contract_rejection("runtime_content_utf8_invalid") from error
    if hashlib.sha256(encoded).hexdigest() != expected_digest:
        raise contract_rejection("runtime_content_digest_mismatch")
    try:
        parsed = json.loads(
            content_json,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_json_constant,
        )
    except (TypeError, ValueError) as error:
        raise contract_rejection("runtime_content_json_invalid") from error
    return validated_contract(
        contract_name,
        parsed,
        "runtime_declarative_content_invalid",
    )


def descriptor_identity(descriptor: Mapping[str, Any]) -> tuple[str, str, str]:
    return (
        cast(str, descriptor["publisher_id"]),
        cast(str, descriptor["plugin_id"]),
        cast(str, descriptor["contribution_id"]),
    )


def expected_content(
    declarative: Mapping[str, Any],
    *,
    arrays: Mapping[str, str],
) -> dict[str, tuple[tuple[str, str, str], str, int]]:
    expected: dict[str, tuple[tuple[str, str, str], str, int]] = {}
    for array_name, kind in arrays.items():
        for descriptor in cast(list[dict[str, Any]], declarative[array_name]):
            digest = cast(str, descriptor["content_digest"])
            if digest in expected:
                raise contract_rejection("runtime_content_digest_duplicate")
            expected[digest] = (
                descriptor_identity(descriptor),
                kind,
                cast(int, descriptor.get("content_schema_version", 1)),
            )
    return expected


def parsed_content(  # noqa: C901
    content_envelope: object,
    expected: Mapping[str, tuple[tuple[str, str, str], str, int]],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    if not isinstance(content_envelope, list) or len(content_envelope) > MAX_CONTENT_ROWS:
        raise contract_rejection("runtime_content_envelope_invalid")
    parsed: dict[str, dict[str, Any]] = {}
    settings: dict[str, dict[str, Any]] = {}
    for row in content_envelope:
        if isinstance(row, dict) and set(row) == {"state_digest", "state_json"}:
            digest = row.get("state_digest")
            state_json = row.get("state_json")
            if (
                not isinstance(digest, str)
                or _HASH_RE.fullmatch(digest) is None
                or not isinstance(state_json, str)
            ):
                raise contract_rejection("runtime_settings_envelope_invalid")
            try:
                state = json.loads(
                    state_json,
                    object_pairs_hook=reject_duplicate_keys,
                    parse_constant=reject_json_constant,
                )
            except (TypeError, ValueError) as error:
                raise contract_rejection("runtime_settings_json_invalid") from error
            state = validated_contract(
                "PluginSettingsStateV2", state, "runtime_settings_state_invalid"
            )
            canonical = json.dumps(
                state, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")
            if hashlib.sha256(canonical).hexdigest() != digest or digest in settings:
                raise contract_rejection("runtime_settings_digest_mismatch")
            settings[digest] = state
            continue
        if not isinstance(row, dict) or set(row) != {"content_digest", "content_json"}:
            raise contract_rejection("runtime_content_envelope_invalid")
        digest = row.get("content_digest")
        content_json = row.get("content_json")
        if not isinstance(digest, str) or _HASH_RE.fullmatch(digest) is None:
            raise contract_rejection("runtime_content_envelope_invalid")
        if not isinstance(content_json, str):
            raise contract_rejection("runtime_content_envelope_invalid")
        if digest in parsed:
            raise contract_rejection("runtime_content_envelope_duplicate")
        expected_row = expected.get(digest)
        if expected_row is None:
            raise contract_rejection("runtime_content_closure_mismatch")
        contract_name = {
            1: "PluginDeclarativeContentV1",
            STAGE4B_SCHEMA_VERSION: "PluginDeclarativeContentV2",
            STAGE5_SCHEMA_VERSION: "PluginDeclarativeContentV3",
            STAGE6_SCHEMA_VERSION: "PluginRestrictedContentV4",
        }.get(expected_row[2])
        if contract_name is None:
            raise contract_rejection("runtime_content_schema_unsupported")
        parsed[digest] = _parse_exact_content(
            content_json, digest, contract_name=contract_name
        )
    return parsed, settings
