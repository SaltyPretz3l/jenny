"""Server-side exact prompt counts for OpenAI-compatible servers (row 66, W3).

llama-server counts through ``/apply-template`` then ``/tokenize`` at the server
root; NInfer through ``/v1/responses/input_tokens``. Every failure is ``None``
and a failed route is not retried until the next load.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from sidecar.ai.context.context_count import resolve_token_scale
from sidecar.ai.context.context_rows import render_context_entries
from sidecar.ai.context.token_budget import CharEstimationBackend
from sidecar.ai.engines import vllm_engine as vllm_engine_module
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.server_token_count import (
    ServerTokenCounter,
    build_count_payload,
    chat_messages_to_responses,
)

FIXTURES = Path(__file__).parent / "fixtures" / "ninfer"
ROOT = "http://127.0.0.1:8080"

Handler = Callable[[httpx.Request], httpx.Response]


def _json(status: int, body: Any) -> httpx.Response:
    return httpx.Response(status, json=body)


class _Server:
    """Routes by path and records every request that reaches the transport."""

    def __init__(self, routes: dict[str, Handler | httpx.Response | Any]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        route = self.routes.get(request.url.path)
        if route is None:
            return httpx.Response(404, json={"error": "not found"})
        if isinstance(route, Exception):
            raise route
        return route(request) if callable(route) else route

    def paths(self) -> list[str]:
        return [request.url.path for request in self.requests]

    def body(self, path: str) -> dict[str, Any]:
        request = next(r for r in self.requests if r.url.path == path)
        return json.loads(request.content)


@contextlib.contextmanager
def _engine(server: _Server, *, props: bool) -> Iterator[OpenAICompatibleEngine]:
    engine = OpenAICompatibleEngine(host=f"{ROOT}/v1")
    engine._service._client.close()
    engine._service._client = httpx.Client(
        base_url=engine._base_url, transport=httpx.MockTransport(server)
    )
    engine.model_name = "qwen3.8-27b-nvfp4"
    engine._served_props_ok = props
    try:
        yield engine
    finally:
        with contextlib.suppress(Exception):
            engine.close()


MESSAGES = [
    {"role": "system", "content": "You are Jenny."},
    {"role": "user", "content": "List the files."},
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": "call_1", "name": "list_dir", "arguments": {"path": "."}}],
    },
    {"role": "tool", "tool_call_id": "call_1", "name": "list_dir", "content": "a.txt\nb.txt"},
    {"role": "user", "content": "Thanks."},
]
TOOLS = [
    {
        "name": "list_dir",
        "description": "List a directory.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
    }
]


def _llama_routes(prompt_tokens: int = 4_321) -> dict[str, Any]:
    return {
        "/apply-template": _json(200, {"prompt": "<|im_start|>system\nYou are Jenny."}),
        "/tokenize": _json(200, {"tokens": list(range(prompt_tokens))}),
    }


# -- llama-server ------------------------------------------------------------


def test_llama_server_counts_through_apply_template_then_tokenize_at_the_root() -> None:
    server = _Server(_llama_routes(4_321))
    with _engine(server, props=True) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) == 4_321

    assert server.paths() == ["/apply-template", "/tokenize"]
    template_body = server.body("/apply-template")
    assert [m["role"] for m in template_body["messages"]] == [
        "system",
        "user",
        "assistant",
        "tool",
        "user",
    ]
    assert template_body["tools"][0]["function"]["name"] == "list_dir"
    assert server.body("/tokenize") == {"content": "<|im_start|>system\nYou are Jenny."}


# -- NInfer ------------------------------------------------------------------


def test_ninfer_counts_through_responses_input_tokens() -> None:
    server = _Server({"/v1/responses/input_tokens": _json(200, {"input_tokens": 777})})
    with _engine(server, props=False) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) == 777

    assert server.paths() == ["/v1/responses/input_tokens"]
    body = server.body("/v1/responses/input_tokens")
    assert body["model"] == "qwen3.8-27b-nvfp4"
    assert body["instructions"] == "You are Jenny."
    types = [(item["type"], item.get("role")) for item in body["input"]]
    assert types == [
        ("message", "user"),
        ("function_call", None),
        ("function_call_output", None),
        ("message", "user"),
    ]
    call = body["input"][1]
    assert (call["name"], call["call_id"], json.loads(call["arguments"])) == (
        "list_dir",
        "call_1",
        {"path": "."},
    )
    assert body["input"][2] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": "a.txt\nb.txt",
    }
    assert body["tools"] == [
        {
            "type": "function",
            "name": "list_dir",
            "description": "List a directory.",
            "strict": False,
            "parameters": TOOLS[0]["parameters"],
        }
    ]


def test_ninfer_with_props_falls_through_after_the_llama_route_is_missing() -> None:
    # NInfer serves a llama-style /props, so props alone cannot name the server.
    server = _Server({"/v1/responses/input_tokens": _json(200, {"input_tokens": 555})})
    with _engine(server, props=True) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) == 555
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) == 555

    assert server.paths() == [
        "/apply-template",
        "/v1/responses/input_tokens",
        "/v1/responses/input_tokens",
    ]


def test_ninfer_reads_a_count_nested_under_usage() -> None:
    server = _Server({"/v1/responses/input_tokens": _json(200, {"usage": {"input_tokens": 91}})})
    with _engine(server, props=False) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) == 91


def test_assistant_text_and_unpaired_calls_convert_cleanly() -> None:
    instructions, items = chat_messages_to_responses(
        [
            {"role": "system", "content": "A"},
            {"role": "system", "content": "B"},
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {"role": "assistant", "content": "ok"},
            {"role": "system", "content": "nudge"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}
                ],
            },
            {"role": "tool", "tool_call_id": "orphan", "content": "x"},
        ]
    )
    assert instructions == "A\n\nB"
    assert [(i["type"], i.get("role")) for i in items] == [
        ("message", "user"),
        ("message", "assistant"),
        ("message", "user"),
    ]
    assert items[0]["content"] == [{"type": "input_text", "text": "hi"}]
    assert items[1]["content"] == [{"type": "output_text", "text": "ok"}]
    assert items[2]["content"] == [{"type": "input_text", "text": "nudge"}]


# -- failure modes -----------------------------------------------------------

_BAD_LLAMA_TOKENIZE = [
    _json(404, {"error": "no"}),
    _json(500, {"error": "boom"}),
    httpx.Response(200, content=b"not json"),
    _json(200, {"tokens": []}),
    _json(200, {"tokens": "abc"}),
    _json(200, ["a"]),
    _json(200, {}),
    httpx.ReadTimeout("slow"),
]


@pytest.mark.parametrize("tokenize", _BAD_LLAMA_TOKENIZE)
def test_llama_failures_are_none(tokenize: Any) -> None:
    routes = _llama_routes()
    routes["/tokenize"] = tokenize
    with _engine(_Server(routes), props=True) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None


@pytest.mark.parametrize(
    "template",
    [
        _json(404, {}),
        _json(500, {}),
        httpx.Response(200, content=b"{"),
        _json(200, {"prompt": ""}),
        _json(200, {"prompt": 5}),
        httpx.ConnectTimeout("slow"),
    ],
)
def test_llama_apply_template_failures_are_none(template: Any) -> None:
    routes = _llama_routes()
    routes["/apply-template"] = template
    server = _Server(routes)
    with _engine(server, props=True) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None
    assert "/tokenize" not in server.paths()


@pytest.mark.parametrize(
    "reply",
    [
        _json(404, {}),
        _json(500, {}),
        httpx.Response(200, content=b"nope"),
        _json(200, {}),
        _json(200, {"input_tokens": 0}),
        _json(200, {"input_tokens": -4}),
        _json(200, {"input_tokens": True}),
        _json(200, {"input_tokens": "12"}),
        _json(200, {"input_tokens": 12.5}),
        _json(200, {"usage": {"input_tokens": True}}),
        _json(200, [12]),
        httpx.ReadTimeout("slow"),
    ],
)
def test_ninfer_failures_are_none(reply: Any) -> None:
    server = _Server({"/v1/responses/input_tokens": reply})
    with _engine(server, props=False) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None


def test_the_count_asks_the_server_for_at_most_two_seconds() -> None:
    timeouts: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        timeouts.append(request.extensions["timeout"])
        return _json(200, {"input_tokens": 5})

    with _engine(_Server({"/v1/responses/input_tokens": handler}), props=False) as engine:
        engine.count_request_tokens(messages=MESSAGES, tools=TOOLS)

    assert timeouts == [{"connect": 2.0, "read": 2.0, "write": 2.0, "pool": 2.0}]


# -- negative cache ----------------------------------------------------------


def test_a_failed_route_is_asked_once_per_load_and_reset_on_unload() -> None:
    server = _Server({})
    with _engine(server, props=False) as engine:
        for _ in range(3):
            assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None
        assert server.paths() == ["/v1/responses/input_tokens"]

        server.routes["/v1/responses/input_tokens"] = _json(200, {"input_tokens": 42})
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None
        assert len(server.requests) == 1

        engine.unload_model()
        engine.model_name = "qwen3.8-27b-nvfp4"
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) == 42
        assert len(server.requests) == 2


def test_both_routes_failing_cost_one_round_trip_each_per_load() -> None:
    server = _Server({})
    with _engine(server, props=True) as engine:
        for _ in range(3):
            assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None
    assert server.paths() == ["/apply-template", "/v1/responses/input_tokens"]


def test_a_model_load_clears_the_negative_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    props = json.loads((FIXTURES / "props.json").read_text(encoding="utf-8"))
    monkeypatch.setattr(vllm_engine_module, "probe_server_modalities", lambda **_kw: props)
    models = (FIXTURES / "v1_models.json").read_bytes()
    server = _Server(
        {
            "/v1/models": lambda request: httpx.Response(
                200,
                request=request,
                headers={"content-type": "application/json"},
                stream=httpx.ByteStream(models),
            )
        }
    )
    with _engine(server, props=False) as engine:
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None
        server.routes["/v1/responses/input_tokens"] = _json(200, {"input_tokens": 9})
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) is None
        engine.load_model("qwen3.8-27b-nvfp4")
        assert engine._served_props_ok is True
        assert engine.count_request_tokens(messages=MESSAGES, tools=TOOLS) == 9


# -- guards ------------------------------------------------------------------


def test_an_image_request_is_not_counted_and_makes_no_http_call() -> None:
    server = _Server(_llama_routes())
    payload = {
        "model": "m",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            }
        ],
    }
    with _engine(server, props=True) as engine:
        assert engine._exact_prompt_tokens(payload) is None
    assert server.requests == []


def test_no_messages_makes_no_http_call() -> None:
    server = _Server(_llama_routes())
    with _engine(server, props=True) as engine:
        assert engine.count_request_tokens(messages=[], tools=TOOLS) is None
    assert server.requests == []


def test_count_request_tokens_counts_the_messages_the_engine_sends() -> None:
    server = _Server(_llama_routes())
    with _engine(server, props=True) as engine:
        engine.count_request_tokens(messages=MESSAGES, tools=TOOLS)
        sent = engine._build_payload(
            prompt="",
            max_tokens=64,
            temperature=0.2,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system="",
            messages=MESSAGES,
            response_format=None,
        )
    assert server.body("/apply-template")["messages"] == sent["messages"]


def test_a_count_never_logs_message_content(caplog: pytest.LogCaptureFixture) -> None:
    secret = "tops3cret-body-text"
    server = _Server({})
    with caplog.at_level("DEBUG"), _engine(server, props=False) as engine:
        engine.count_request_tokens(
            messages=[{"role": "user", "content": secret}], tools=[]
        )
    assert caplog.records
    assert secret not in caplog.text
    assert any(
        getattr(r, "event", "") == "ai.engines.server_token_count.route_disabled"
        for r in caplog.records
    )


# -- the ladder --------------------------------------------------------------


def test_resolve_token_scale_uses_the_exact_source_with_this_engine() -> None:
    server = _Server({"/v1/responses/input_tokens": _json(200, {"input_tokens": 9_000})})
    history = [{"role": "user", "content": "x" * (4 * 5_996)}]  # ~6,000 estimator tokens
    with _engine(server, props=False) as engine:
        scale, source = resolve_token_scale(
            engine=engine,
            config=SimpleNamespace(engine_type="openai-compatible", model="m"),
            messages=history,
            tool_payload=[],
            calibration=None,
            inner_backend=CharEstimationBackend(),
            raw_window=10_000,
        )
    assert source == "exact"
    assert scale == pytest.approx(9_000 / 6_000, rel=0.01)
    assert len(server.requests) == 1


# -- transient failures ------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def _counter_client(server: _Server) -> httpx.Client:
    return httpx.Client(base_url=f"{ROOT}/v1", transport=httpx.MockTransport(server))


def _payload() -> dict[str, Any]:
    return build_count_payload(model="qwen3.8", messages=MESSAGES, tools=TOOLS)


@pytest.mark.parametrize(
    "failure",
    [_json(500, {"error": "busy"}), _json(503, {}), httpx.ReadTimeout("slow")],
    ids=["500", "503", "timeout"],
)
def test_a_transient_failure_rests_the_route_then_retries(failure: Any) -> None:
    server = _Server({"/v1/responses/input_tokens": failure})
    clock = _Clock()
    counter = ServerTokenCounter(clock=clock)
    with _counter_client(server) as client:
        assert counter.count(client, f"{ROOT}/v1", _payload(), llama_props=False) is None
        # Resting: no second round trip inside the cooldown.
        assert counter.count(client, f"{ROOT}/v1", _payload(), llama_props=False) is None
        assert len(server.requests) == 1

        server.routes["/v1/responses/input_tokens"] = _json(200, {"input_tokens": 77})
        clock.now += 61
        assert counter.count(client, f"{ROOT}/v1", _payload(), llama_props=False) == 77
        assert len(server.requests) == 2


def test_a_transient_llama_failure_does_not_chain_into_the_ninfer_route() -> None:
    server = _Server(
        {
            "/apply-template": httpx.ReadTimeout("slow"),
            "/v1/responses/input_tokens": _json(200, {"input_tokens": 5}),
        }
    )
    counter = ServerTokenCounter(clock=_Clock())
    with _counter_client(server) as client:
        assert counter.count(client, f"{ROOT}/v1", _payload(), llama_props=True) is None
    # One route's timeout per turn start, never two stacked.
    assert server.paths() == ["/apply-template"]


@pytest.mark.parametrize("status", [404, 405, 501])
def test_a_missing_route_is_skipped_until_the_next_load(status: int) -> None:
    server = _Server({"/v1/responses/input_tokens": _json(status, {})})
    clock = _Clock()
    counter = ServerTokenCounter(clock=clock)
    with _counter_client(server) as client:
        assert counter.count(client, f"{ROOT}/v1", _payload(), llama_props=False) is None
        clock.now += 3_600
        assert counter.count(client, f"{ROOT}/v1", _payload(), llama_props=False) is None
        assert len(server.requests) == 1
        counter.reset()
        counter.count(client, f"{ROOT}/v1", _payload(), llama_props=False)
        assert len(server.requests) == 2


# -- the rows the real request renders ---------------------------------------


def _context_row(body: str) -> dict[str, Any]:
    envelope = {
        "schema_version": 1,
        "message_id": "11111111-1111-4111-8111-111111111111",
        "source_session_id": "session-src",
        "source_session_incarnation": "inc-src",
        "source_project_id": "project-src",
        "destination_session_id": "session-dst",
        "destination_session_incarnation": "inc-dst",
        "destination_project_id": None,
        "source_turn_id": None,
        "kind": "user_message",
        "created_at": "2026-10-15T12:00:00.000Z",
        "body": body,
        "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "report": None,
    }
    return {"role": "context", "kind": "session_message", "content": body, "session_message": envelope}


def test_context_rows_are_counted_as_the_user_entries_the_request_sends() -> None:
    row = _context_row("Please review the migration plan.")
    rendered = render_context_entries(row)
    assert rendered and rendered[0]["role"] == "user"

    payload = build_count_payload(
        model="qwen3.8", messages=[MESSAGES[0], row, MESSAGES[1]], tools=[]
    )

    contents = [str(message.get("content", "")) for message in payload["messages"]]
    assert [message["role"] for message in payload["messages"]] == ["system", "user", "user"]
    assert rendered[0]["content"] in contents[1]


def test_a_late_system_row_is_demoted_like_the_real_request() -> None:
    messages = [*MESSAGES[:2], {"role": "system", "content": "Runtime note."}]

    payload = build_count_payload(model="qwen3.8", messages=messages, tools=[])

    roles = [message["role"] for message in payload["messages"]]
    assert roles.count("system") == 1 and roles[0] == "system"
