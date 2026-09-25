"""Request-owned admission and checkpoint bridges for ordinary approval resume."""
from __future__ import annotations

from typing import Any

from sidecar.runtime.continuation_checkpoint import build_continuation_checkpoint_callback
from sidecar.runtime.inference_admission import build_inference_admission_callback
from sidecar.runtime.operation_admission import build_operation_admission_callback


def build_resume_admission(*, plan: Any, engine_type: str, write_message: Any,
                           response_reader_factory: Any, cancel_handle: Any) -> dict[str, Any]:
    continuation_checkpoint = build_continuation_checkpoint_callback(
        context=plan.request_context.continuation_context,
        write_message=write_message,
        response_reader_factory=response_reader_factory,
        cancel_handle=cancel_handle,
    )
    operation_admission = build_operation_admission_callback(
        request_id=plan.request_id,
        session_id=plan.session_id,
        execution_context=plan.request_context.execution_context,
        write_message=write_message,
        response_reader_factory=response_reader_factory,
        cancel_handle=cancel_handle,
        continuation_enabled=plan.request_context.continuation_context is not None,
    )
    inference_admission = build_inference_admission_callback(
        request_id=plan.request_id,
        session_id=plan.session_id,
        execution_context=plan.request_context.execution_context,
        require_budget=plan.request_context.inference_budget_required,
        engine_type=engine_type,
        write_message=write_message,
        response_reader_factory=response_reader_factory,
        cancel_handle=cancel_handle,
    )
    return {"continuation_checkpoint": continuation_checkpoint,
            "operation_admission": operation_admission, "inference_admission": inference_admission}
