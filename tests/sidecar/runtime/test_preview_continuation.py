from __future__ import annotations

import hashlib
import json
from dataclasses import replace

from sidecar.ai.routing import tool_resolution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.preview_vision import prepare_preview_messages
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.routing.tool_execution_results import tool_result_message
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval_plan import stable_hash
from sidecar.runtime.chat_continuation_resume import HydratedBeforeToolDispatchResume
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.continuation_codec import encode_continuation_checkpoint
from sidecar.runtime.decision_checkpoint import prepare_question_decision
from tests.sidecar.ai.routing.test_preview_vision import (  # noqa: F401 -- `captured` is a fixture
    PNG,
    PNG_BASE64,
    call,
    captured,
    kernel,
)
from tests.sidecar.runtime.test_chat_continuation_resume import _artifacts, _canonical
from tests.sidecar.runtime.test_continuation_checkpoint import _decision_plan


def test_captured_preview_survives_question_checkpoint_only_as_text(captured):  # noqa: F811
    root, payload = captured
    harness = kernel(root)
    context = ChatRequestContext(request_id="preview", trace_id="preview", session_id="visual_review",
        mode="assist", approvals_pre_granted=True, workspace_root_present=True)
    contract = tool_resolution.assemble_tool_contract(harness, request_context=context)
    sent = []
    runtime = LoopRuntime(request_id="preview", session_id="visual_review", request_context=context,
        electron_tool_writer=sent.append, electron_tool_reader_factory=lambda expected_id, **_: (
            lambda timeout: {"jsonrpc": "2.0", "id": expected_id, "result": payload}))
    outcome = execute_tool(harness, call(), request_id="preview", session_id="visual_review",
        read_snapshot_cache={}, tool_contract=contract, runtime=runtime)
    assert outcome.success and runtime.preview_images["capture_1"].image.data == PNG
    assert len(sent) == 1
    plan = _decision_plan()
    args = {"questions": [{"id": "choice", "prompt": "Continue?"}]}
    question = ToolCallRequest(call_id="call_1", tool_id="ask_user", arguments=args)
    frozen = replace(plan.frozen_inputs[0], tool_name="ask_user", visible_tool_arguments=args,
        effective_tool_arguments=args, effective_args_fingerprint=stable_hash(args))
    runtime.current_iteration = 2
    runtime.max_iterations = 5
    runtime.tool_call_limit = 6
    runtime.tool_calls_consumed = 2
    snapshot = prepare_question_decision(frozen, runtime=runtime, request_context=plan.request_context,
        tool_contract=contract, pending_calls=(question,), completed_outcomes=(outcome,))
    assert snapshot is not None
    params = json.loads(snapshot.params_json)
    assert PNG_BASE64 not in snapshot.params_json.decode()
    source = _artifacts()
    checkpoint = json.loads(source["checkpoint_body"])
    calls = json.loads(source["tool_batch_bytes"])["calls"][:1]
    calls[0].update(tool_id="ask_user", arguments=args)
    frozen_wire = json.loads(source["frozen_input_bytes"])
    frozen_wire.update(tool_name="ask_user", visible_tool_arguments=args,
        effective_tool_arguments=args, effective_args_fingerprint=stable_hash(args))
    for prefix, body in (("tool_batch", _canonical({"calls": calls})), ("frozen_input", _canonical(frozen_wire))):
        source[prefix + "_bytes"] = body
        source[prefix + "_sha256"] = hashlib.sha256(body).hexdigest()
    checkpoint["canonical_refs"]["tool_batch_ref"]["sha256"] = source["tool_batch_sha256"]
    checkpoint["pending_call"].update(tool_id="ask_user", effective_args_sha256=stable_hash(args))
    checkpoint["pending_call"]["frozen_input_ref"]["sha256"] = source["frozen_input_sha256"]
    checkpoint.update(schema_version=3, kind="before_decision_wait", decision=params["decision"],
        completed_effect_refs=params["completed_effect_refs"], prior_checkpoint_ref=None, prior_effect_count=0)
    checkpoint["position"]["ordered_call_ids"] = ["call_1"]
    checkpoint["wait"].update(kind="explicit_pause", resource_class=None)
    checkpoint["eligibility"].update(prior_outcome_count=1, emitted_tool_execution_count=2)
    events = [{"event_id": "stream_a:canonical:3", "turn_id": "turn_1", "kind": "tool_result",
        "tool_call_id": outcome.call_id, "payload": {"tool_name": outcome.tool_name,
        "success": outcome.success, "tool_output_summary": outcome.output,
        "tool_input": outcome.tool_input, "metadata": outcome.metadata}}]
    canonical = _canonical(events)
    assert PNG_BASE64 not in canonical.decode()
    checkpoint["canonical_refs"]["turn_ref"]["sha256"] = hashlib.sha256(canonical).hexdigest()
    encoded = encode_continuation_checkpoint(checkpoint)
    source.update(checkpoint_body=encoded.body, checkpoint_sha256=encoded.sha256, canonical_events_bytes=canonical)
    source["checkpoint_ref"].update(sha256=encoded.sha256, bytes=len(encoded.body))
    restored = HydratedBeforeToolDispatchResume.from_artifacts(**source).completed_outcomes()[0]
    fresh = LoopRuntime()
    messages = [{"role": "user", "content": "Continue after the saved question."},
        tool_result_message(call(), restored)]
    next_messages, _ = prepare_preview_messages(harness, fresh, messages, system="sys", tools=[], max_tokens=128)
    assert "No screenshot pixels accompany" in next_messages[-1]["content"]
    assert not any(row.get("images") for row in next_messages)
    assert not fresh.preview_images
    assert len(sent) == 1, "Restoring the result must not recapture a screenshot"
