from __future__ import annotations

import base64
import inspect
import json
import subprocess
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.routing import generation_runtime, tool_loop, tool_resolution
from sidecar.ai.routing.engine_messages import engine_messages
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.preview_vision import (
    admit_preview,
    prepare_preview_messages,
    preview_token_cost,
    prune_previews,
)
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.routing.tool_execution_results import tool_result_message
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.tools.preview_image import native_preview_image
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.electron_tool_bridge import _normalize_result_payload
from sidecar.runtime.vllm_engine_support import _build_messages as openai_messages

PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII="
PNG = base64.b64decode(PNG_BASE64)
DESCRIPTOR = MCPToolDescriptor(
    name="preview_test",
    description="",
    input_schema={},
    side_effecting=False,
    source_kind="builtin",
    server_name="electron_tool_bridge",
)


def wire(key="capture_1"):
    return {
        "call_id": key,
        "mime_type": "image/png",
        "width": 2,
        "height": 1,
        "data_base64": PNG_BASE64,
        "byte_length": len(PNG),
    }


def call(key="capture_1"):
    return ToolCallRequest(
        tool_id="preview_test", arguments={"path": "index.html", "screenshot": True}, call_id=key
    )


class Engine:
    capabilities = {"vision": True}
    supports_tool_calling = True

    def __init__(self):
        self.requests = []

    def get_model_max_output_tokens(self):
        return 512

    def generate_with_tools(self, **kwargs):
        self.requests.append(kwargs)
        return GenerationResult(content="Captured red and blue pixels", finish_reason="stop")

    def stream_with_tools(self, **kwargs):
        return self.generate_with_tools(**kwargs)
        yield  # pragma: no cover - generator returning one terminal result


class Client:
    available_tools = []

    def tool_descriptor(self, _name):
        return None


def kernel(root=""):
    return SimpleNamespace(
        _engine=Engine(),
        _active_cancel_handle=None,
        _mcp_client=Client(),
        _config=RuntimeConfig(
            electron_tool_bridge_enabled=True,
            tools_preview_test_enabled=True,
            tools_workspace_root=str(root),
            mode="assist",
            max_tokens=128,
            context_length=8192,
        ),
        _engine_messages=engine_messages,
        _system_prompt_for_engine=str,
        _cache_usage_tokens=lambda raw, *keys: raw.get(keys[0], raw.get(keys[1], 0)),
    )


def rows(*keys):
    return [
        {"role": "user", "content": "Review the preview."},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": key, "name": "preview_test", "arguments": {}} for key in keys],
        },
        *(
            {"role": "tool", "name": "preview_test", "tool_call_id": key, "content": "Loaded"}
            for key in keys
        ),
    ]


def admit(runtime, key="capture_1", engine=None, descriptor=DESCRIPTOR):
    return admit_preview(
        runtime,
        engine or Engine(),
        call(key),
        MCPToolResult("preview_test", "Loaded", True, preview_image=wire(key)),
        descriptor,
    )


@pytest.fixture(scope="module")
def captured(tmp_path_factory):
    root = tmp_path_factory.mktemp("preview-capture")
    (root / "index.html").write_text('<button id="inspect">Inspect</button>', encoding="utf8")
    repo = Path(__file__).resolve().parents[4]
    result = subprocess.run(
        ["node", str(repo / "tests/helpers/preview-capture-fixture.js"), str(root)],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return root, json.loads(result.stdout)["result"]


@pytest.mark.parametrize("streaming", [False, True])
def test_native_capture_executor_bridge_admission_and_next_generation(captured, streaming, caplog):
    root, payload = captured
    harness = kernel(root)
    context = ChatRequestContext(
        request_id="preview",
        trace_id="preview",
        session_id="visual_review",
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=True,
    )
    contract = tool_resolution.assemble_tool_contract(harness, request_context=context)
    sent = []
    runtime = LoopRuntime(
        request_id="preview",
        session_id="visual_review",
        streaming=streaming,
        request_context=context,
        electron_tool_writer=sent.append,
        electron_tool_reader_factory=lambda expected_id, **_: (
            lambda timeout: {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": payload,
            }
        ),
    )
    outcome = execute_tool(
        harness,
        call(),
        request_id="preview",
        session_id="visual_review",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=runtime,
    )
    assert outcome.success
    assert outcome.metadata["model_delivery_status"] == "queued"
    assert runtime.preview_images["capture_1"].image.data == PNG
    messages = rows("capture_1")
    messages[-1] = tool_result_message(call(), outcome)
    generation_runtime.generate_step(
        harness,
        latest_user_content="Review the preview.",
        working_messages=messages,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        source_key="main",
        system_prompt="sys",
        tool_schemas=[],
        cache_break_detector=None,
        runtime=runtime,
    )
    delivered = harness._engine.requests[-1]["messages"]
    assert [row["role"] for row in delivered] == ["user", "assistant", "tool", "user"]
    assert delivered[-1]["images"][0].data == PNG
    assert OllamaEngine._build_messages("", "", delivered)[-1]["images"] == [PNG_BASE64]
    compatible = openai_messages(prompt="", system="", messages=delivered)
    assert (
        compatible[-1]["content"][-1]["image_url"]["url"] == "data:image/png;base64," + PNG_BASE64
    )
    assert "capture_1" in delivered[-1]["content"]
    assert PNG_BASE64 not in json.dumps(asdict(outcome))
    assert PNG_BASE64 not in json.dumps(messages)
    assert PNG_BASE64 not in caplog.text


def test_batch_observations_follow_all_tool_results():
    runtime = LoopRuntime()
    assert admit(runtime, "a")[0] == "queued"
    assert admit(runtime, "b")[0] == "queued"
    messages, _ = prepare_preview_messages(
        kernel(), runtime, rows("a", "b"), system="", tools=[], max_tokens=128
    )
    assert [row["role"] for row in messages] == [
        "user",
        "assistant",
        "tool",
        "tool",
        "user",
        "user",
    ]
    assert "a" in messages[-2]["content"] and "b" in messages[-1]["content"]


def test_incomplete_tool_group_never_inserts_or_marks_unseen_pixels():
    runtime = LoopRuntime()
    admit(runtime, "a")
    messages, _ = prepare_preview_messages(
        kernel(),
        runtime,
        rows("a", "b")[:-1],
        system="",
        tools=[],
        max_tokens=128,
    )
    assert not any(row.get("images") for row in messages)
    assert runtime.preview_images["a"].supplied is False


def test_1000_reviews_keep_at_most_four_images_and_preserve_user_images():
    user = VisionImage("image/png", 2, 1, 1, PNG)
    runtime = LoopRuntime(request_context=SimpleNamespace(vision_images=(user,)))
    messages = []
    for number in range(1000):
        key = f"capture_{number}"
        assert admit(runtime, key)[0] == "queued"
        messages.extend(rows(key)[1:])
        for entry in runtime.preview_images.values():
            entry.supplied = True
        assert len(runtime.preview_images) <= 3
    assert "capture_999" in runtime.preview_images
    assert runtime.request_context.vision_images == (user,)
    assert preview_token_cost(runtime) > 0
    prune_previews(runtime, [])
    assert not runtime.preview_images
    assert not LoopRuntime().preview_images


def test_image_and_context_budgets_and_nonvision_refuse_honestly():
    runtime = LoopRuntime()
    for key in ("a", "b", "c", "d"):
        assert admit(runtime, key)[0] == "queued"
    assert admit(runtime, "e")[0] == "budget_exceeded"
    no_vision = SimpleNamespace(capabilities={"vision": False})
    assert admit(LoopRuntime(), engine=no_vision)[0] == "unsupported"
    harness = kernel()
    harness._config = replace(harness._config, context_length=300)
    output, _ = prepare_preview_messages(
        harness, runtime, rows("a", "b", "c", "d"), system="", tools=[], max_tokens=128
    )
    assert not any(row.get("images") for row in output)
    assert not runtime.preview_images
    assert "No screenshot pixels" in output[-1]["content"]
    full = VisionImage("image/png", 2, 1, 1, b"x" * 20_000_000)
    assert (
        admit(LoopRuntime(request_context=SimpleNamespace(vision_images=(full,))))[0]
        == "budget_exceeded"
    )


@pytest.mark.parametrize(
    "descriptor",
    [
        replace(DESCRIPTOR, source_kind="mcp"),
        replace(DESCRIPTOR, source_kind="synthetic"),
        replace(DESCRIPTOR, server_name="external"),
        None,
    ],
)
def test_untrusted_origins_never_admitted(descriptor):
    runtime = LoopRuntime()
    assert admit(runtime, descriptor=descriptor) == ("", "")
    assert not runtime.preview_images


def test_bridge_identity_replay_and_malformed_images(captured):
    _, payload = captured
    assert (
        _normalize_result_payload(payload, fallback_tool_name="preview_test").preview_image is None
    )
    assert (
        _normalize_result_payload(
            payload, fallback_tool_name="preview_test", preview_call_id="wrong"
        ).preview_image
        is None
    )
    assert (
        _normalize_result_payload(
            payload, fallback_tool_name="read_file", preview_call_id="capture_1"
        ).preview_image
        is None
    )
    for changes in (
        {"data_base64": "?" * len(PNG_BASE64)},
        {"byte_length": 3_000_000},
        {"width": 500},
        {"call_id": "wrong"},
        {"data_base64": base64.b64encode(PNG[:-1] + b"x").decode()},
    ):
        with pytest.raises(ValueError):
            native_preview_image({**wire(), **changes}, call_id="capture_1")


@pytest.mark.parametrize("failure", [False, True])
def test_loop_terminal_releases_pixels(monkeypatch, failure):
    runtime = LoopRuntime()
    admit(runtime)

    class Run:
        def execute(self):
            if failure:
                raise RuntimeError("cancelled")
            return "finished"

    monkeypatch.setattr(tool_loop, "_ToolLoopRun", lambda **kwargs: Run())
    kwargs = {
        name: None
        for name, param in inspect.signature(tool_loop.run_tool_loop).parameters.items()
        if param.default is inspect.Parameter.empty
    }
    kwargs["runtime"] = runtime
    if failure:
        with pytest.raises(RuntimeError, match="cancelled"):
            tool_loop.run_tool_loop(**kwargs)
    else:
        assert tool_loop.run_tool_loop(**kwargs) == "finished"
    assert not runtime.preview_images
