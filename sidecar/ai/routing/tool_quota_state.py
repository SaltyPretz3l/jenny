"""Closed portable state for request-owned quota admissions, not tool authority."""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

from sidecar.runtime.cooldowns import normalize_tool_quota_cooldowns

MAX_ADMISSIONS = 2000
_MIN_STATE_BYTES = 2
_MAX_SAFE_INTEGER = 9007199254740991
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TOOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}\Z")
_SHA256 = re.compile(r"[a-f0-9]{64}\Z")


def arguments_digest(arguments: Any) -> str:
    body = json.dumps(
        arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def call_arguments_digest(call: Any) -> str:
    from sidecar.ai.routing.tool_execution_snapshots import (  # noqa: PLC0415
        split_visible_execution_arguments,
    )

    return arguments_digest(split_visible_execution_arguments(call)[0])


def quota_policy_state(policy: Any) -> dict[str, int]:
    return {
        "web_per_turn": policy.max_web_tool_calls_per_turn,
        "code_per_turn": policy.max_code_intelligence_tool_calls_per_turn,
        "session_calls": policy.max_tool_calls_per_session,
        "cooldown_ms": math.ceil(policy.tool_cooldown_seconds * 1000),
    }


def _record(value: Any, keys: set[str]) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("quota_state_shape_invalid")
    return value


def normalize_quota_state(value: Any) -> dict[str, Any]:
    value = _record(
        value,
        {"schema_version", "enabled", "policy", "session_baseline", "admissions", "cooldowns"},
    )
    if (
        type(value["schema_version"]) is not int
        or value["schema_version"] != 1
        or type(value["enabled"]) is not bool
        or type(value["session_baseline"]) is not int
        or not 0 <= value["session_baseline"] <= _MAX_SAFE_INTEGER
        or not isinstance(value["admissions"], list)
        or len(value["admissions"]) > MAX_ADMISSIONS
    ):
        raise ValueError("quota_state_invalid")
    policy = _record(
        value["policy"], {"web_per_turn", "code_per_turn", "session_calls", "cooldown_ms"}
    )
    for key, maximum in {
        "web_per_turn": 100,
        "code_per_turn": 100,
        "session_calls": 2000,
        "cooldown_ms": 604800000,
    }.items():
        if type(policy[key]) is not int or not int(key != "cooldown_ms") <= policy[key] <= maximum:
            raise ValueError("quota_state_policy_invalid")
    admissions = []
    for raw in value["admissions"]:
        item = _record(
            raw, {"call_id", "tool_id", "arguments_sha256", "web", "code", "web_refunded"}
        )
        if (
            any(
                not isinstance(item[key], str) or pattern.fullmatch(item[key]) is None
                for key, pattern in (
                    ("call_id", _ID),
                    ("tool_id", _TOOL),
                    ("arguments_sha256", _SHA256),
                )
            )
            or any(type(item[key]) is not bool for key in ("web", "code", "web_refunded"))
            or (item["web_refunded"] and not item["web"])
        ):
            raise ValueError("quota_state_admission_invalid")
        admissions.append(dict(item))
    cooldowns = normalize_tool_quota_cooldowns(value["cooldowns"])
    if (
        len({item["call_id"] for item in admissions}) != len(admissions)
        or value["session_baseline"] + len(admissions) > _MAX_SAFE_INTEGER
        or (
            not value["enabled"]
            and (admissions or value["session_baseline"] or cooldowns["entries"])
        )
    ):
        raise ValueError("quota_state_admissions_invalid")
    if (
        sum(item["web"] and not item["web_refunded"] for item in admissions)
        > policy["web_per_turn"]
        or sum(item["code"] for item in admissions) > policy["code_per_turn"]
        or (admissions and value["session_baseline"] + len(admissions) > policy["session_calls"])
    ):
        raise ValueError("quota_state_limits_invalid")
    return {**value, "policy": dict(policy), "admissions": admissions, "cooldowns": cooldowns}


def _dumps(state: dict[str, Any]) -> bytes:
    return json.dumps(
        state,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def encode_quota_state(value: Any) -> bytes:
    return _dumps(normalize_quota_state(value))


def decode_quota_state(value: bytes) -> dict[str, Any]:
    if not isinstance(value, bytes) or not _MIN_STATE_BYTES <= len(value) <= 1024 * 1024:
        raise ValueError("quota_state_bytes_invalid")
    state = normalize_quota_state(json.loads(value))
    if _dumps(state) != value:
        raise ValueError("quota_state_encoding_invalid")
    return state
