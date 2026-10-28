"""Deterministic contracts for the opt-in W1-A live evidence runner."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = ROOT / "scripts" / "tests"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

SPEC = importlib.util.spec_from_file_location(
    "live_local_evidence", SCRIPT_DIR / "live-local-evidence.py"
)
assert SPEC is not None and SPEC.loader is not None
live = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live)

VLLM_SPEC = importlib.util.spec_from_file_location(
    "run_vllm_exact", SCRIPT_DIR / "run-vllm-exact.py"
)
assert VLLM_SPEC is not None and VLLM_SPEC.loader is not None
vllm_launcher = importlib.util.module_from_spec(VLLM_SPEC)
VLLM_SPEC.loader.exec_module(vllm_launcher)

from live_sidecar_harness import ForwardingCaptureProxy  # noqa: E402

from sidecar.runtime.vision_attachments import normalize_vision_attachments  # noqa: E402


def test_defaults_pin_the_approved_w1a_targets() -> None:
    args = live.parse_args([])
    assert args.gemma_model == "batiai/gemma4-12b:q6"
    assert args.qwen_model == "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS"
    assert args.vision_model == "hf.co/unsloth/gemma-4-12b-it-GGUF:UD-Q5_K_XL"
    assert args.small_model == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M"
    assert args.tool_cases == 12
    assert args.control_cases == 4


def test_capture_proxy_retains_only_sampler_allowlist() -> None:
    proxy = ForwardingCaptureProxy("http://127.0.0.1:1")
    proxy._capture(  # direct unit coverage of the redaction boundary
        "/api/chat",
        json.dumps(
            {
                "model": "secret-model",
                "messages": [{"role": "user", "content": "private prompt"}],
                "tools": [{"function": {"arguments": {"path": "private"}}}],
                "options": {"temperature": 1.0, "top_k": 40, "seed": 99},
            }
        ).encode(),
    )
    captures = proxy.captures(path="/api/chat")
    assert len(captures) == 1
    assert captures[0].fields == {"temperature": 1.0, "top_k": 40}
    assert "private" not in repr(captures[0])
    assert "secret-model" not in repr(captures[0])


def test_counter_snapshot_and_delta_are_bounded_to_named_fields() -> None:
    before = live._counter_snapshot(
        {
            "runtime": {
                "provider_capability_profiles": [
                    {
                        "reliability_counters": {
                            "tool_call_parse_success_count": 2,
                            "tool_call_repair_count": 1,
                            "unknown": 999,
                        }
                    }
                ]
            }
        }
    )
    after = dict(before)
    after["tool_call_parse_success_count"] += 3
    delta = live._counter_delta(before, after)
    assert delta["tool_call_parse_success_count"] == 3
    assert delta["tool_call_repair_count"] == 0
    assert "unknown" not in delta


def test_notification_summary_omits_text_and_tool_arguments() -> None:
    notifications = [
        {
            "method": "tool.executing",
            "params": {
                "request_id": "stream-1",
                "tool_name": "read_file",
                "tool_call_id": "call-1",
                "tool_input": {"path": "case_00.txt", "private": "omitted"},
            },
        },
        {
            "method": "tool.result",
            "params": {
                "request_id": "stream-1",
                "tool_name": "read_file",
                "tool_call_id": "call-1",
                "success": True,
                "content": "private output",
            },
        },
        {"method": "chat.token", "params": {"request_id": "stream-1", "delta": "private"}},
        {"method": "chat.done", "params": {"request_id": "stream-1"}},
    ]
    summary = live._notification_summary(
        "stream-1",
        notifications,
        expected_tool=True,
        expected_tool_path="case_00.txt",
    )
    assert summary["passed"] is True
    assert summary["stream_id"] == "stream-1"
    assert summary["stream_id_observed"] is True
    assert "private" not in repr(summary)


def test_notification_summary_rejects_late_events_from_another_stream() -> None:
    notifications = [
        {
            "method": "tool.executing",
            "params": {
                "request_id": "old-stream",
                "tool_name": "read_file",
                "tool_call_id": "old-call",
                "tool_input": {"path": "case_00.txt"},
            },
        },
        {
            "method": "tool.result",
            "params": {
                "request_id": "old-stream",
                "tool_name": "read_file",
                "tool_call_id": "old-call",
                "success": True,
            },
        },
        {"method": "chat.token", "params": {"request_id": "old-stream"}},
        {"method": "chat.done", "params": {"request_id": "current-stream"}},
    ]
    summary = live._notification_summary(
        "current-stream",
        notifications,
        expected_tool=True,
        expected_tool_path="case_00.txt",
    )
    assert summary["passed"] is False
    assert summary["tool_executions"] == 0
    assert summary["token_events"] == 0


def test_notification_summary_rejects_wrong_file_or_result_call_id() -> None:
    notifications = [
        {
            "method": "tool.executing",
            "params": {
                "request_id": "stream-1",
                "tool_name": "read_file",
                "tool_call_id": "call-1",
                "tool_input": {"path": "wrong.txt"},
            },
        },
        {
            "method": "tool.result",
            "params": {
                "request_id": "stream-1",
                "tool_name": "read_file",
                "tool_call_id": "call-2",
                "success": True,
            },
        },
        {"method": "chat.token", "params": {"request_id": "stream-1"}},
        {"method": "chat.done", "params": {"request_id": "stream-1"}},
    ]
    summary = live._notification_summary(
        "stream-1",
        notifications,
        expected_tool=True,
        expected_tool_path="case_00.txt",
    )
    assert summary["passed"] is False
    assert summary["tool_input_matched"] is False
    assert summary["tool_result_matched"] is False


def test_vision_refusal_requires_the_exact_fail_closed_contract() -> None:
    good_error = {
        "code": "CMP-CHAT-0001",
        "message": "The active model does not support image attachments.",
        "retryable": False,
    }
    assert live._is_expected_vision_refusal(
        capabilities={"vision": False},
        error_payload=good_error,
        response={"error": {"code": -32602}},
    )
    assert live._is_expected_vision_refusal(
        capabilities=None,
        error_payload=good_error,
        response={"error": {"code": -32602}},
    )
    assert not live._is_expected_vision_refusal(
        capabilities={"vision": False},
        error_payload={**good_error, "message": "Provider unavailable"},
        response={"error": {"code": -32000}},
    )


def test_cli_rejects_empty_negative_and_noncanonical_public_matrices() -> None:
    with pytest.raises(SystemExit):
        live.parse_args(["--tool-cases", "-1"])
    with pytest.raises(SystemExit):
        live.parse_args(["--tool-cases", "0", "--control-cases", "0"])
    with pytest.raises(SystemExit):
        live.parse_args(
            [
                "--public-output",
                "public.json",
                "--tool-cases",
                "1",
                "--control-cases",
                "1",
            ]
        )


def test_packaged_phase_keeps_its_internal_noncanonical_matrix_available() -> None:
    args = live.parse_args(
        ["--phase", "packaged", "--tool-cases", "0", "--control-cases", "0"]
    )
    assert args.phase == ["packaged"]


def test_vllm_phase_requires_explicit_endpoint() -> None:
    try:
        live.run_vllm_sampling(model=live.DEFAULT_QWEN_MODEL, vllm_url="")
    except ValueError as error:
        assert "--vllm-url" in str(error)
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("missing endpoint should fail closed")


def test_live_vision_fixture_crosses_the_real_attachment_decoder(tmp_path: Path) -> None:
    managed_root = tmp_path / "attachments" / "images"
    managed_root.mkdir(parents=True)
    image_path = managed_root / "fixture.png"
    image_path.write_bytes(live.PNG_BYTES)
    normalized = normalize_vision_attachments(
        [
            {
                "id": "fixture",
                "kind": "image",
                "displayName": "fixture.png",
                "mimeType": "image/png",
                "assetPath": str(image_path),
                "sourceKind": "file",
            }
        ],
        managed_root=managed_root,
    )
    assert normalized[0]["width"] == 1
    assert normalized[0]["height"] == 1


def test_vision_request_uses_the_runtime_chat_mode_contract() -> None:
    params = live._chat_params(
        request_id="vision", content="omitted", attachments=[{"kind": "image"}], mode="chat"
    )
    assert params["mode"] == "chat"


def test_vllm_exact_launcher_fails_closed_for_nonlocal_bind(tmp_path: Path) -> None:
    weights = tmp_path / "model.gguf"
    weights.write_bytes(b"GGUF")
    args = vllm_launcher.parse_args(
        [
            "--model-config",
            "Qwen/Qwen3.6-35B-A3B",
            "--model-weights",
            str(weights),
            "--served-model-name",
            live.DEFAULT_QWEN_MODEL,
            "--tokenizer",
            "Qwen/Qwen3.6-35B-A3B",
            "--host",
            "0.0.0.0",
        ]
    )
    try:
        vllm_launcher._validate(args)
    except ValueError as error:
        assert "localhost" in str(error)
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("nonlocal bind must fail closed")
