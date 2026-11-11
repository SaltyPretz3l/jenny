"""fetch_url and web_search say what happened and what to do next (row 129, B1 and B2)."""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from sidecar.ai.error_codes import CMP_WEB_FETCH_FAILED, CMP_WEB_SSRF_BLOCKED
from sidecar.ai.tools.builtins import web as web_module
from sidecar.ai.tools.builtins import web_ddg
from sidecar.ai.tools.builtins.web import fetch_url_tool, web_search_tool
from sidecar.ai.tools.builtins.web_fetch_failures import (
    fetch_failure_reason,
    http_status_failure,
)
from sidecar.ai.tools.builtins.web_http import ValidatedUrl, _read_response_payload
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.failure_taxonomy import classify

_WEB_CONFIG = {
    "tools_web_rate_limit_per_min": 300,
    "tools_web_allow_private_addresses": False,
    "tools_web_max_fetch_bytes": 1_048_576,
    "tools_web_search_provider": "duckduckgo",
}


@pytest.fixture(autouse=True)
def _fresh_fetch_state() -> Iterator[None]:
    web_module.configure_web_tools(_WEB_CONFIG)
    web_module._fetch_cache.clear()
    yield
    web_module.configure_web_tools(_WEB_CONFIG)
    web_module._fetch_cache.clear()


def _class_of(failure: ToolExecutionFailure) -> str:
    return classify(
        failure.code, retryable=failure.retryable, error_details=failure.to_error_data()
    )


@pytest.mark.parametrize(
    ("status", "failure_class", "wording"),
    [
        (404, "not_found", "no page at this address"),
        (410, "not_found", "no page at this address"),
        (401, "denied", "refuses this request"),
        (403, "denied", "refuses this request"),
        (429, "transient", "busy or failing right now"),
        (503, "transient", "busy or failing right now"),
        (400, "precondition_unmet", "did not return the page"),
    ],
)
def test_each_http_answer_has_its_own_class_and_sentence(
    status: int, failure_class: str, wording: str
) -> None:
    failure = http_status_failure(status)

    assert failure.code == CMP_WEB_FETCH_FAILED
    assert str(status) in failure.message and wording in failure.message
    assert _class_of(failure) == failure_class
    # A page that is gone or closed never invites the same call again.
    assert bool(failure.remediation) is (failure_class in {"not_found", "denied"})


def test_a_generic_failure_names_its_cause() -> None:
    assert fetch_failure_reason(OSError("connection refused")) == (
        "Could not fetch the URL (OSError: connection refused)."
    )
    assert fetch_failure_reason(ValueError()) == "Could not fetch the URL (ValueError)."
    assert len(fetch_failure_reason(OSError("x" * 900))) < 220


def test_a_localhost_address_is_refused_with_a_next_step() -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        fetch_url_tool({"url": "http://localhost:3000/"}, None)

    assert excinfo.value.code == CMP_WEB_SSRF_BLOCKED
    assert excinfo.value.message == "Localhost addresses are blocked."
    assert "browser tool" in excinfo.value.remediation
    assert "turn Browser on" in excinfo.value.remediation


@patch("sidecar.ai.tools.builtins.web.read_url_response")
@patch("sidecar.ai.tools.builtins.web.validate_public_url")
def test_a_timeout_and_a_dropped_connection_read_differently(
    mock_validate: MagicMock, mock_read: MagicMock
) -> None:
    mock_validate.return_value = ValidatedUrl(url="https://example.com/a", pinned_ip="")
    mock_read.side_effect = TimeoutError()
    with pytest.raises(ToolExecutionFailure) as timed_out:
        fetch_url_tool({"url": "https://example.com/a"}, None)
    mock_read.side_effect = ConnectionResetError("reset by peer")
    with pytest.raises(ToolExecutionFailure) as dropped:
        fetch_url_tool({"url": "https://example.com/a"}, None)

    assert timed_out.value.message == "The site did not answer within the time limit."
    assert "ConnectionResetError: reset by peer" in dropped.value.message
    assert timed_out.value.retryable is True and dropped.value.retryable is True


def test_a_declared_length_over_the_limit_is_cut_not_refused() -> None:
    body = b"a" * 500
    response = MagicMock()
    response.headers = {"Content-Type": "text/plain", "Content-Length": str(len(body))}
    response.read = io.BytesIO(body).read

    payload, truncated, content_type = _read_response_payload(
        response, limit=100, deadline=web_module.time.monotonic() + 30
    )

    assert payload == b"a" * 100
    assert truncated is True
    assert content_type == "text/plain"


def test_a_domain_filter_still_runs_the_real_search(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []

    def fake_instant(*_args: object, **_kwargs: object) -> bytes:
        return json.dumps({"AbstractText": "", "RelatedTopics": []}).encode()

    def fake_html(query: str, **_kwargs: object) -> list[dict[str, str]]:
        asked.append(query)
        return [
            {"title": "Docs", "url": "https://docs.python.org/3/", "snippet": "the docs"},
            {"title": "Other", "url": "https://example.com/x", "snippet": "elsewhere"},
        ]

    monkeypatch.setattr(web_ddg, "_ddg_http_request", fake_instant)
    monkeypatch.setattr(web_ddg, "_ddg_html_search", fake_html)

    kept = json.loads(
        web_search_tool({"query": "asyncio", "allowed_domains": ["python.org"]}, None).output
    )
    none_left = json.loads(
        web_search_tool({"query": "asyncio", "allowed_domains": ["rust-lang.org"]}, None).output
    )

    assert asked == ["asyncio site:python.org", "asyncio site:rust-lang.org"]
    assert [source["url"] for source in kept["sources"]] == ["https://docs.python.org/3/"]
    assert none_left["sources"] == []
    assert none_left["answer"].startswith("2 result(s) came back and none passed the domain filters.")
