"""Exact ordered approval inputs, separate from the legacy first-input carrier."""
from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import replace
from typing import Any

from sidecar.ai.routing.tool_restored_inputs import RestoredToolInputs
from sidecar.runtime.approval_plan import FrozenExecutionInputs, stable_hash

_MAX_BYTES = 1024 * 1024
_MIN_BYTES = 2
_MAX_CALLS = 256


def checkpoint_approval_input(frozen: FrozenExecutionInputs) -> FrozenExecutionInputs:
    """Persist exact user inputs without a pending mutation's transient identity."""
    effective = {key: value for key, value in frozen.effective_tool_arguments.items()
                 if key != "_jenny_change_set_id"}
    return replace(frozen, effective_tool_arguments=effective,
        effective_args_fingerprint=stable_hash(effective),
        injected_arg_keys=tuple(
            key for key in frozen.injected_arg_keys if key != "_jenny_change_set_id"),
        execution_context_payload={
            key: value for key, value in frozen.execution_context_payload.items()
            if key != "_jenny_change_set_id"})


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode()


def encode_approval_inputs(leaves: tuple[bytes, ...]) -> tuple[str, str]:
    body = canonical({"schema_version": 1, "inputs": [
        {"frozen_input_bytes": base64.b64encode(leaf).decode(),
         "frozen_input_sha256": hashlib.sha256(leaf).hexdigest()} for leaf in leaves]})
    if not 1 <= len(leaves) <= _MAX_CALLS or len(body) > _MAX_BYTES:
        raise ValueError("approval_inputs_capacity")
    return base64.b64encode(body).decode(), hashlib.sha256(body).hexdigest()


def decode_approval_inputs(body: bytes, checkpoint: dict, calls: tuple,
                           first_input: bytes) -> tuple[RestoredToolInputs, ...]:
    if (not isinstance(body, bytes) or not _MIN_BYTES <= len(body) <= _MAX_BYTES
            or hashlib.sha256(body).hexdigest() != checkpoint["approval_inputs_ref"]["sha256"]):
        raise ValueError("approval_inputs_digest_mismatch")
    bundle = json.loads(body)
    if (not isinstance(bundle, dict) or set(bundle) != {"schema_version", "inputs"}
            or type(bundle["schema_version"]) is not int or bundle["schema_version"] != 1
            or not isinstance(bundle["inputs"], list) or len(bundle["inputs"]) != len(calls)
            or not 1 <= len(calls) <= _MAX_CALLS or canonical(bundle) != body):
        raise ValueError("approval_inputs_invalid")
    restored = []
    expected_scope = {"session_id": checkpoint["identity"]["session_id"],
                      "logical_turn_id": checkpoint["identity"]["turn_id"],
                      "authority_revision": checkpoint["source_attempt"]["authority_revision"],
                      **{key: checkpoint["authority"][key]
                         for key in ("project_id", "root_id", "root_revision")}}
    for index, (entry, call) in enumerate(zip(bundle["inputs"], calls, strict=True)):
        if (not isinstance(entry, dict)
                or set(entry) != {"frozen_input_bytes", "frozen_input_sha256"}):
            raise ValueError("approval_input_invalid")
        leaf = base64.b64decode(entry["frozen_input_bytes"], validate=True)
        if (base64.b64encode(leaf).decode() != entry["frozen_input_bytes"]
                or (index == 0 and leaf != first_input)):
            raise ValueError("approval_first_input_mismatch")
        item = RestoredToolInputs.from_canonical_bytes(leaf, entry["frozen_input_sha256"])
        source = item.source_frozen_inputs()
        if (source.call_id != call.call_id or source.tool_name != call.tool_id
                or source.visible_tool_arguments != call.arguments
                or any(source.execution_context_payload.get(key) != value
                       for key, value in expected_scope.items())
                or any("_jenny_change_set_id" in value for value in
                       (source.effective_tool_arguments, source.execution_context_payload))):
            raise ValueError("approval_input_scope_mismatch")
        restored.append(item)
    return tuple(restored)
