#!/usr/bin/env python
"""Run sanitized, opt-in W1-A evidence against real local model endpoints."""

from __future__ import annotations

import argparse
import base64
import json
import posixpath
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from live_sidecar_harness import (  # noqa: E402
    API_VERSION,
    ForwardingCaptureProxy,
    JsonRpcSidecar,
)

from sidecar.ai.error_codes import CMP_CHAT_INVALID_PARAMS  # noqa: E402

DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
DEFAULT_GEMMA_MODEL = "batiai/gemma4-12b:q6"
DEFAULT_QWEN_MODEL = "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS"
DEFAULT_VISION_MODEL = "hf.co/unsloth/gemma-4-12b-it-GGUF:UD-Q5_K_XL"
DEFAULT_SMALL_MODEL = "ornith:9b"
DEFAULT_OUTPUT = ROOT / "artifacts" / "release-evidence" / "w1-a" / "latest.json"
REQUEST_TIMEOUT_SECONDS = 420.0
STARTUP_TIMEOUT_SECONDS = 120.0
DEFAULT_TOOL_CASES = 12
DEFAULT_CONTROL_CASES = 4
EXPECTED_VISION_REFUSAL_MESSAGE = "The active model does not support image attachments."
COUNTER_NAMES = (
    "tool_call_parse_success_count",
    "tool_call_parse_failure_count",
    "tool_call_repair_count",
    "false_tool_positive_count",
    "tool_argument_validation_failures",
    "tool_execution_retries",
    "final_answer_after_tool_count",
    "turns_with_tool_count",
)
DISABLED_TOOLS_EXCEPT_READ_FILE = (
    "check_background_job",
    "create_artifact",
    "edit_file",
    "fetch_url",
    "git_diff",
    "git_log",
    "git_show",
    "git_status",
    "glob_files",
    "grep_search",
    "list_dir",
    "mermaid_generate",
    "python_execute",
    "run_command",
    "stop_background_job",
    "todo_read",
    "todo_write",
    "web_search",
    "workspace_manifest_read",
    "write_file",
)

# A tiny opaque PNG fixture. Its bytes and local path never enter evidence.
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42Y"
    "AAAAASUVORK5CYII="
)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--phase",
        action="append",
        choices=("ollama", "vllm", "vision", "packaged"),
        help="Gate to run; repeat for multiple gates. Defaults to ollama.",
    )
    parser.add_argument("--ollama-host", default=DEFAULT_OLLAMA_HOST)
    parser.add_argument("--gemma-model", default=DEFAULT_GEMMA_MODEL)
    parser.add_argument("--qwen-model", default=DEFAULT_QWEN_MODEL)
    parser.add_argument("--vision-model", default=DEFAULT_VISION_MODEL)
    parser.add_argument("--small-model", default=DEFAULT_SMALL_MODEL)
    parser.add_argument("--vllm-url", default="")
    parser.add_argument("--vllm-model", default=DEFAULT_QWEN_MODEL)
    parser.add_argument("--packaged-sidecar", default="")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument(
        "--public-output",
        default="",
        help="Optional tracked sanitized copy; only write after all selected gates pass.",
    )
    parser.add_argument("--tool-cases", type=int, default=DEFAULT_TOOL_CASES)
    parser.add_argument("--control-cases", type=int, default=DEFAULT_CONTROL_CASES)
    args = parser.parse_args(list(argv) if argv is not None else None)
    phases = args.phase or ["ollama"]
    if args.tool_cases < 0 or args.control_cases < 0:
        parser.error("--tool-cases and --control-cases must be non-negative")
    if "ollama" in phases and args.tool_cases + args.control_cases < 1:
        parser.error("the ollama evidence phase requires at least one reliability case")
    if args.public_output and "ollama" in phases and (
        args.tool_cases != DEFAULT_TOOL_CASES
        or args.control_cases != DEFAULT_CONTROL_CASES
    ):
        parser.error("tracked ollama evidence requires the canonical 12 tool and 4 control cases")
    return args


def _git_revision() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _base_config(
    *, engine_type: str, model: str, api_url: str, state_root: Path, workspace_root: Path
) -> dict[str, Any]:
    return {
        "engine_type": engine_type,
        "model": model,
        "api_url": api_url,
        "context_length": 8192,
        "temperature": 0,
        "ollama_request_timeout_seconds": 360,
        "tools_workspace_root": str(workspace_root),
        "tools_shell_enabled": False,
        "tools_web_enabled": False,
        "tools_todo_enabled": False,
        "tools_mermaid_enabled": False,
        "tools_workspace_manifest_enabled": False,
        "tools_image_read_enabled": False,
        "tools_python_runtime_enabled": False,
        "tools_edit_file_enabled": False,
        "tools_glob_enabled": False,
        "tools_grep_enabled": False,
        "tools_confirm_side_effects": True,
        "tool_call_reliability_net_enabled": True,
        "max_tools_per_turn": 2,
        "max_loop_iterations": 3,
        "max_chat_loop_iterations": 3,
        "max_inline_payload_bytes": 131072,
        "electron_state_root": str(state_root),
        "memory_db_path": str(state_root / "sidecar-memory.db"),
        "diagnostics_capture_mode": "redacted",
    }


def _initialize(  # noqa: PLR0913 - explicit live-target boundary
    sidecar: JsonRpcSidecar,
    *,
    engine_type: str,
    model: str,
    api_url: str,
    state_root: Path,
    workspace_root: Path,
) -> dict[str, Any]:
    response, _ = sidecar.request(
        "initialize",
        {
            "accept_version": API_VERSION,
            "client_version": "w1-a-live-local-evidence",
            "config": _base_config(
                engine_type=engine_type,
                model=model,
                api_url=api_url,
                state_root=state_root,
                workspace_root=workspace_root,
            ),
            "secrets": {},
        },
        timeout_seconds=STARTUP_TIMEOUT_SECONDS,
    )
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("initialize returned no result")
    if result.get("active_engine") != engine_type or result.get("active_model") != model:
        raise RuntimeError("initialize active target mismatch")
    return result


def _chat_params(
    *,
    request_id: str,
    content: str,
    attachments: list[dict[str, Any]] | None = None,
    mode: str = "assist",
) -> dict[str, Any]:
    return {
        "accept_version": API_VERSION,
        "request_id": request_id,
        "trace_id": request_id,
        "session_id": "w1-a-disposable-session",
        "session_start_date": "2026-08-10",
        "mode": mode,
        "reasoning_effort": "low",
        "messages": [{"role": "user", "content": content}],
        "canonical_session_messages": [],
        "debug_options": {"lean_context": True},
        "tool_preferences": {
            "enabled_tools": ["read_file"],
            "disabled_tools": list(DISABLED_TOOLS_EXCEPT_READ_FILE),
        },
        "attachments": attachments or [],
    }


def _notification_summary(
    request_id: str,
    notifications: Iterable[dict[str, Any]],
    *,
    expected_tool: bool,
    expected_tool_path: str = "",
) -> dict[str, Any]:
    items = _notifications_for_request(request_id, notifications)
    methods = [str(item.get("method") or "") for item in items]
    tool_executing = [
        item for item in items if item.get("method") == "tool.executing"
    ]
    tool_results = [item for item in items if item.get("method") == "tool.result"]
    tokens = [item for item in items if item.get("method") == "chat.token"]
    read_file_exec = [
        item
        for item in tool_executing
        if str((item.get("params") or {}).get("tool_name") or "") == "read_file"
    ]
    read_file_success = [
        item
        for item in tool_results
        if str((item.get("params") or {}).get("tool_name") or "") == "read_file"
        and (item.get("params") or {}).get("success") is True
    ]
    expected_path = _normalize_relative_tool_path(expected_tool_path)
    observed_path = ""
    executing_call_id = ""
    if len(read_file_exec) == 1:
        params = read_file_exec[0].get("params") or {}
        tool_input = params.get("tool_input")
        if isinstance(tool_input, dict):
            observed_path = _normalize_relative_tool_path(tool_input.get("path"))
        executing_call_id = str(params.get("tool_call_id") or "").strip()
    successful_call_id = ""
    if len(read_file_success) == 1:
        successful_call_id = str(
            (read_file_success[0].get("params") or {}).get("tool_call_id") or ""
        ).strip()
    tool_input_matched = bool(expected_path) and observed_path == expected_path
    tool_result_matched = bool(executing_call_id) and successful_call_id == executing_call_id
    terminal = (
        "done"
        if "chat.done" in methods
        else "error"
        if "chat.error" in methods
        else "missing"
    )
    passed = (
        terminal == "done"
        and bool(tokens)
        and (
            len(read_file_exec) == 1
            and len(read_file_success) == 1
            and tool_input_matched
            and tool_result_matched
            if expected_tool
            else not tool_executing
        )
    )
    return {
        "expected_tool": expected_tool,
        "passed": passed,
        "terminal": terminal,
        "stream_id": request_id if items else None,
        "stream_id_observed": bool(items),
        "tool_input_matched": tool_input_matched if expected_tool else None,
        "tool_result_matched": tool_result_matched if expected_tool else None,
        "token_events": len(tokens),
        "tool_executions": len(tool_executing),
        "tool_results": len(tool_results),
    }


def _notifications_for_request(
    request_id: str, notifications: Iterable[dict[str, Any]]
) -> list[dict[str, Any]]:
    return [
        item
        for item in notifications
        if str((item.get("params") or {}).get("request_id") or "") == request_id
    ]


def _normalize_relative_tool_path(value: Any) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        return ""
    normalized = posixpath.normpath(raw)
    return "" if normalized in {"", "."} or normalized.startswith("/") else normalized


def _is_expected_vision_refusal(
    *, capabilities: Any, error_payload: dict[str, Any], response: dict[str, Any]
) -> bool:
    active_model_vision = (
        capabilities.get("vision") if isinstance(capabilities, dict) else None
    )
    return (
        active_model_vision is not True
        and "error" in response
        and error_payload.get("code") == CMP_CHAT_INVALID_PARAMS
        and error_payload.get("message") == EXPECTED_VISION_REFUSAL_MESSAGE
        and error_payload.get("retryable") is False
    )


def _counter_snapshot(snapshot: dict[str, Any]) -> dict[str, int]:
    counters = {name: 0 for name in COUNTER_NAMES}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            candidate = value.get("reliability_counters")
            if isinstance(candidate, dict):
                for name in COUNTER_NAMES:
                    raw = candidate.get(name, 0)
                    if isinstance(raw, int) and raw >= 0:
                        counters[name] += raw
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(snapshot)
    return counters


def _counter_delta(before: dict[str, int], after: dict[str, int]) -> dict[str, int]:
    return {name: max(after[name] - before[name], 0) for name in COUNTER_NAMES}


def _tool_prompt(index: int) -> str:
    return (
        "/no_think\nUse read_file exactly once on the file "
        f"case_{index:02d}.txt. After the tool result, return one short final line. "
        "Do not call any other tool."
    )


def _control_prompt(index: int) -> str:
    return (
        "/no_think\nAnswer without tools. Return one short line containing the result of "
        f"{index + 3} plus {index + 8}. Do not call read_file."
    )


def run_reliability_model(
    *,
    model: str,
    ollama_host: str,
    tool_cases: int,
    control_cases: int,
    command: Sequence[str] | None = None,
) -> dict[str, Any]:
    if tool_cases < 0 or control_cases < 0:
        raise ValueError("reliability case counts must be non-negative")
    if tool_cases + control_cases < 1:
        raise ValueError("at least one reliability case is required")
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="jenny-w1a-reliability-") as temp_dir:
        root = Path(temp_dir)
        workspace = root / "workspace"
        workspace.mkdir()
        for index in range(tool_cases):
            (workspace / f"case_{index:02d}.txt").write_text(
                f"case {index:02d} disposable evidence\n", encoding="utf-8"
            )
        with ForwardingCaptureProxy(ollama_host) as proxy:
            sidecar = JsonRpcSidecar(command=command)
            try:
                initialize = _initialize(
                    sidecar,
                    engine_type="ollama",
                    model=model,
                    api_url=proxy.url,
                    state_root=root,
                    workspace_root=workspace,
                )
                before = _counter_snapshot(sidecar.inspect())
                cases: list[dict[str, Any]] = []
                for index in range(tool_cases + control_cases):
                    expected_tool = index < tool_cases
                    case_index = index if expected_tool else index - tool_cases
                    request_id = f"w1a_{'tool' if expected_tool else 'control'}_{index:02d}"
                    prompt = (
                        _tool_prompt(case_index)
                        if expected_tool
                        else _control_prompt(case_index)
                    )
                    response, notifications = sidecar.request(
                        "chat.send",
                        _chat_params(request_id=request_id, content=prompt),
                        timeout_seconds=REQUEST_TIMEOUT_SECONDS,
                    )
                    summary = _notification_summary(
                        request_id,
                        notifications,
                        expected_tool=expected_tool,
                        expected_tool_path=(
                            f"case_{case_index:02d}.txt" if expected_tool else ""
                        ),
                    )
                    case_kind = "tool" if expected_tool else "control"
                    summary["case_id"] = f"{case_kind}-{case_index + 1:02d}"
                    summary["rpc_error"] = "error" in response
                    summary["passed"] = summary["passed"] and "error" not in response
                    cases.append(summary)
                after = _counter_snapshot(sidecar.inspect())
            finally:
                sidecar.shutdown()
        sampler_capture = [item.fields for item in proxy.captures(path="/api/chat")]
    normalized_model = model.lower()
    verify_sampling = "gemma" in normalized_model or "qwen" in normalized_model
    expected_sampling = (
        {"temperature": 1.0, "top_k": 40}
        if "gemma" in normalized_model
        else {
            "temperature": 0.6,
            "top_k": 20,
            "top_p": 0.95,
            "min_p": 0.0,
            "repeat_penalty": 1.0,
        }
    )
    sampling_match = bool(sampler_capture) and all(
        all(capture.get(key) == value for key, value in expected_sampling.items())
        for capture in sampler_capture
    )
    sampling_passed = sampling_match if verify_sampling else True
    counter_delta = _counter_delta(before, after)
    passed_cases = sum(1 for case in cases if case["passed"])
    all_stream_ids = bool(cases) and all(
        case["stream_id_observed"] for case in cases
    )
    return {
        "status": (
            "passed"
            if passed_cases == len(cases) and sampling_passed and all_stream_ids
            else "failed"
        ),
        "target": model,
        "engine": "ollama",
        "profile": str(initialize.get("active_app_profile") or ""),
        "duration_seconds": round(time.monotonic() - started, 3),
        "cases": cases,
        "summary": {
            "total": len(cases),
            "passed": passed_cases,
            "tool_cases": tool_cases,
            "control_cases": control_cases,
            "all_stream_ids_observed": all_stream_ids,
        },
        "reliability_counter_delta": counter_delta,
        "sampling": {
            "status": (
                "passed" if sampling_match else "failed"
            ) if verify_sampling else "not_applicable",
            "expected": expected_sampling if verify_sampling else {},
            "observed_request_count": len(sampler_capture),
            "all_requests_matched": sampling_match if verify_sampling else None,
        },
    }


def run_vision(
    *,
    model: str,
    ollama_host: str,
    command: Sequence[str] | None = None,
    expect_refusal: bool = False,
) -> dict[str, Any]:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="jenny-w1a-vision-") as temp_dir:
        root = Path(temp_dir)
        workspace = root / "workspace"
        managed_images = root / "attachments" / "images"
        workspace.mkdir()
        managed_images.mkdir(parents=True)
        image_path = managed_images / "fixture.png"
        image_path.write_bytes(PNG_BYTES)
        sidecar = JsonRpcSidecar(command=command)
        try:
            initialize = _initialize(
                sidecar,
                engine_type="ollama",
                model=model,
                api_url=ollama_host,
                state_root=root,
                workspace_root=workspace,
            )
            request_id = "w1a_vision_refusal" if expect_refusal else "w1a_vision_supported"
            response, notifications = sidecar.request(
                "chat.send",
                _chat_params(
                    request_id=request_id,
                    content=(
                        "/no_think\nDescribe the attached image in one short line "
                        "without tools."
                    ),
                    attachments=[
                        {
                            "id": "w1a-image",
                            "kind": "image",
                            "displayName": "fixture.png",
                            "mimeType": "image/png",
                            "assetPath": str(image_path),
                            "sourceKind": "file",
                        }
                    ],
                    mode="chat",
                ),
                timeout_seconds=REQUEST_TIMEOUT_SECONDS,
            )
        finally:
            sidecar.shutdown()
    request_notifications = _notifications_for_request(request_id, notifications)
    methods = [str(item.get("method") or "") for item in request_notifications]
    token_events = sum(1 for method in methods if method == "chat.token")
    error_payload = next(
        (
            item.get("params") or {}
            for item in request_notifications
            if item.get("method") == "chat.error"
        ),
        {},
    )
    capabilities = initialize.get("active_model_capabilities")
    if expect_refusal:
        passed = "chat.error" in methods and _is_expected_vision_refusal(
            capabilities=capabilities,
            error_payload=error_payload,
            response=response,
        )
    else:
        passed = "error" not in response and "chat.done" in methods and token_events > 0
    return {
        "status": "passed" if passed else "failed",
        "target": model,
        "engine": "ollama",
        "expectation": "unsupported_model_refusal" if expect_refusal else "vision_response",
        "active_model_vision": (
            capabilities.get("vision") if isinstance(capabilities, dict) else None
        ),
        "terminal": (
            "done" if "chat.done" in methods else "error" if "chat.error" in methods else "missing"
        ),
        "token_events": token_events,
        "error_code": str(error_payload.get("code") or "") or None,
        "error_subcode": str(error_payload.get("subcode") or "") or None,
        "retryable": error_payload.get("retryable") is True,
        "stream_id": request_id,
        "stream_id_observed": any(
            str((item.get("params") or {}).get("request_id") or "") == request_id
            for item in request_notifications
        ),
        "duration_seconds": round(time.monotonic() - started, 3),
    }


def run_vllm_sampling(*, model: str, vllm_url: str) -> dict[str, Any]:
    if not vllm_url.strip():
        raise ValueError("--vllm-url is required for the vllm phase")
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="jenny-w1a-vllm-") as temp_dir:
        root = Path(temp_dir)
        workspace = root / "workspace"
        workspace.mkdir()
        with ForwardingCaptureProxy(vllm_url) as proxy:
            sidecar = JsonRpcSidecar()
            try:
                initialize = _initialize(
                    sidecar,
                    engine_type="vllm",
                    model=model,
                    api_url=proxy.url,
                    state_root=root,
                    workspace_root=workspace,
                )
                response, notifications = sidecar.request(
                    "chat.send",
                    _chat_params(
                        request_id="w1a_vllm_sampling",
                        content="/no_think\nAnswer with one short line and do not call tools.",
                    ),
                    timeout_seconds=REQUEST_TIMEOUT_SECONDS,
                )
            finally:
                sidecar.shutdown()
            captures = [item.fields for item in proxy.captures(path="/v1/chat/completions")]
    expected = {
        "temperature": 0.6,
        "top_k": 20,
        "top_p": 0.95,
        "min_p": 0.0,
        "presence_penalty": 0.0,
        "repeat_penalty": 1.0,
    }
    sampling_match = bool(captures) and all(
        all(capture.get(key) == value for key, value in expected.items())
        for capture in captures
    )
    request_notifications = _notifications_for_request(
        "w1a_vllm_sampling", notifications
    )
    methods = [str(item.get("method") or "") for item in request_notifications]
    passed = sampling_match and "error" not in response and "chat.done" in methods
    return {
        "status": "passed" if passed else "failed",
        "target": model,
        "engine": "vllm",
        "profile": str(initialize.get("active_app_profile") or ""),
        "duration_seconds": round(time.monotonic() - started, 3),
        "terminal": (
            "done"
            if "chat.done" in methods
            else "error"
            if "chat.error" in methods
            else "missing"
        ),
        "stream_id": "w1a_vllm_sampling",
        "stream_id_observed": any(
            str((item.get("params") or {}).get("request_id") or "")
            == "w1a_vllm_sampling"
            for item in request_notifications
        ),
        "sampling": {
            "status": "passed" if sampling_match else "failed",
            "expected": expected,
            "observed_request_count": len(captures),
            "all_requests_matched": sampling_match,
        },
    }


def _packaged_command(path: str) -> list[str]:
    candidate = Path(path).resolve()
    if not candidate.is_file():
        raise ValueError("--packaged-sidecar does not name an existing file")
    return [str(candidate)]


def _write_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    phases = args.phase or ["ollama"]
    evidence: dict[str, Any] = {
        "schema_version": 1,
        "scope": "W1-A core local-model evidence",
        "source_revision": _git_revision(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sanitization": {
            "prompts": "omitted",
            "generated_text": "omitted",
            "tool_arguments": "omitted",
            "provider_payloads": "sampler_allowlist_only",
            "local_paths": "omitted",
            "secrets": "omitted",
        },
        "targets": {
            "daily_gemma": args.gemma_model,
            "daily_qwen": args.qwen_model,
            "vision": args.vision_model,
            "packaged_small": args.small_model,
            "packaged_large": args.qwen_model,
        },
        "gates": {},
        "status": "running",
    }
    output = Path(args.output).resolve()
    current_phase = "initialization"
    try:
        if "ollama" in phases:
            current_phase = "ollama"
            evidence["gates"]["ollama_gemma_reliability"] = run_reliability_model(
                model=args.gemma_model,
                ollama_host=args.ollama_host,
                tool_cases=args.tool_cases,
                control_cases=args.control_cases,
            )
            evidence["gates"]["ollama_qwen_reliability"] = run_reliability_model(
                model=args.qwen_model,
                ollama_host=args.ollama_host,
                tool_cases=args.tool_cases,
                control_cases=args.control_cases,
            )
        if "vllm" in phases:
            current_phase = "vllm"
            evidence["gates"]["vllm_qwen_sampling"] = run_vllm_sampling(
                model=args.vllm_model, vllm_url=args.vllm_url
            )
        if "vision" in phases:
            current_phase = "vision"
            evidence["gates"]["ollama_supported_vision"] = run_vision(
                model=args.vision_model, ollama_host=args.ollama_host
            )
        if "packaged" in phases:
            current_phase = "packaged"
            command = _packaged_command(args.packaged_sidecar)
            evidence["gates"]["packaged_supported_vision"] = run_vision(
                model=args.vision_model,
                ollama_host=args.ollama_host,
                command=command,
            )
            evidence["gates"]["packaged_small_vision_refusal"] = run_vision(
                model=args.small_model,
                ollama_host=args.ollama_host,
                command=command,
                expect_refusal=True,
            )
            evidence["gates"]["packaged_small_readiness"] = run_reliability_model(
                model=args.small_model,
                ollama_host=args.ollama_host,
                tool_cases=0,
                control_cases=1,
                command=command,
            )
            evidence["gates"]["packaged_large_readiness"] = run_reliability_model(
                model=args.qwen_model,
                ollama_host=args.ollama_host,
                tool_cases=1,
                control_cases=1,
                command=command,
            )
        gates = list(evidence["gates"].values())
        evidence["status"] = (
            "passed"
            if gates and all(gate.get("status") == "passed" for gate in gates)
            else "failed"
        )
    except Exception as error:  # noqa: BLE001 - produce bounded failure evidence
        evidence["status"] = "failed"
        evidence["failure"] = {
            "error_type": type(error).__name__,
            "stage": current_phase,
        }
    _write_evidence(output, evidence)
    if evidence["status"] == "passed" and args.public_output:
        _write_evidence(Path(args.public_output).resolve(), evidence)
    print(
        json.dumps(
            {
                "status": evidence["status"],
                "gate_count": len(evidence["gates"]),
                "output": (
                    str(output.relative_to(ROOT))
                    if output.is_relative_to(ROOT)
                    else "external"
                ),
            },
            sort_keys=True,
        )
    )
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
