"""fetch_url failure wording: one sentence, a class and a next step per cause (row 129, B2)."""

from __future__ import annotations

from sidecar.ai.error_codes import CMP_WEB_FETCH_FAILED, CMP_WEB_SSRF_BLOCKED
from sidecar.ai.tools.contracts import ToolExecutionFailure

_TRANSIENT_HTTP_STATUSES = frozenset({408, 425, 429})
_HTTP_SERVER_ERROR_MIN = 500
_HTTP_GONE_STATUSES = frozenset({404, 410})
_HTTP_REFUSED_STATUSES = frozenset({401, 403})
# What to do when the address is one this tool may not read (row 129, B2): the
# model used to fall back on python_execute to reach a local dev server.
_BLOCKED_ADDRESS_NEXT_STEP = (
    "fetch_url reads public web pages only. To look at a page on this computer, use the "
    "browser tool if it is in your tool list; if it is not, ask the user to turn Browser on."
)


def blocked_address_failure(exc: Exception) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_WEB_SSRF_BLOCKED,
        message=str(exc),
        retryable=False,
        error_details={"remediation": _BLOCKED_ADDRESS_NEXT_STEP},
    )


def http_status_failure(status: int) -> ToolExecutionFailure:
    """One sentence and a class per kind of HTTP answer (row 129, B2)."""
    retryable = status >= _HTTP_SERVER_ERROR_MIN or status in _TRANSIENT_HTTP_STATUSES
    details: dict[str, object] = {}
    if status in _HTTP_GONE_STATUSES:
        message = f"The site answered {status}: there is no page at this address."
        details = {
            "failure_class": "not_found",
            "remediation": (
                "Check the address for a typo, or use web_search to find the page's "
                "current address. The same address will fail again."
            ),
        }
    elif status in _HTTP_REFUSED_STATUSES:
        message = f"The site answered {status}: it refuses this request."
        details = {
            "failure_class": "denied",
            "remediation": (
                "Do not fetch this address again. Use another source for the same "
                "information, or web_search for a page that is open to read."
            ),
        }
    elif retryable:
        message = f"The site answered {status}: it is busy or failing right now."
    else:
        message = f"The site answered {status} and did not return the page."
    return ToolExecutionFailure(
        code=CMP_WEB_FETCH_FAILED, message=message, retryable=retryable, error_details=details
    )


def fetch_failure_reason(exc: Exception) -> str:
    reason = " ".join(str(getattr(exc, "reason", "") or exc).split())[:160]
    kind = type(exc).__name__
    return f"Could not fetch the URL ({kind}: {reason})." if reason else (
        f"Could not fetch the URL ({kind})."
    )
