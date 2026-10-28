"""fetch_url: which HTTP failures earn the MCP reconnect-and-replay.

A retryable failure makes the MCP client restart ``jenny_local_tools`` and
re-send the same request before surfacing the error; a 4xx is the site's answer.
"""

from __future__ import annotations

import urllib.error
from unittest.mock import MagicMock, patch

import pytest

from sidecar.ai.tools.builtins.web import fetch_url_tool
from sidecar.ai.tools.builtins.web_http import ValidatedUrl
from sidecar.ai.tools.contracts import ToolExecutionFailure


@pytest.mark.parametrize(
    ("status", "retryable"),
    [(400, False), (401, False), (403, False), (404, False), (410, False), (422, False),
     (408, True), (425, True), (429, True), (500, True), (502, True), (503, True)],
)
@patch("sidecar.ai.tools.builtins.web.read_url_response")
@patch("sidecar.ai.tools.builtins.web.validate_public_url")
def test_fetch_url_http_errors_carry_the_status_transience(
    mock_validate: MagicMock, mock_read: MagicMock, status: int, retryable: bool,
) -> None:
    mock_validate.return_value = ValidatedUrl(url="https://example.com/page", pinned_ip="")
    mock_read.side_effect = urllib.error.HTTPError(
        "https://example.com/page", status, "nope", {}, None
    )

    with pytest.raises(ToolExecutionFailure) as excinfo:
        fetch_url_tool({"url": "https://example.com/page"}, None)

    assert excinfo.value.code == "CMP-WEB-0004"
    assert excinfo.value.message == f"HTTP error {status}"
    assert excinfo.value.retryable is retryable
