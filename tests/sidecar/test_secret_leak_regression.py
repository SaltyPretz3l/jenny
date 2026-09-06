"""Regression lock for secret redaction across log / diagnostic surfaces.

This test does not add behaviour — it pins the redaction that already exists so a
future change cannot silently start leaking secrets into logs, JSON-RPC error
payloads, or diagnostic snippets. There are two defensive layers, and each
secret shape is asserted against the layer that is contractually responsible for
it (see ``sidecar/ai/tools/sanitization.py`` and ``sidecar/runtime/diagnostics.py``):

* ``sanitization.py`` (``redact_obvious_secrets`` / ``sanitize_tool_output``)
  unconditionally redacts bare token shapes (``sk-``, ``ghp_``, ``AKIA``,
  ``xox*``, JWTs) to ``[REDACTED]`` — this guards tool/assistant output.
* ``diagnostics.py`` (``sanitize_diagnostic_text`` / ``sanitize_diagnostic_value``
  / the structured log formatter / ``rpc.error_response``) redacts
  key-adjacent secrets (``api_key=``, ``Authorization:``, ``Bearer``,
  ``password=``) and sensitive dict keys to ``[redacted]`` — this guards the
  emitted log lines and the JSON-RPC error surface.
"""

from __future__ import annotations

import json
import logging

from sidecar.ai.tools.sanitization import redact_obvious_secrets, sanitize_tool_output
from sidecar.runtime.diagnostics import (
    StructuredLogFormatter,
    apply_logging_preferences,
    build_redacted_snippet_data,
    sanitize_diagnostic_text,
    sanitize_diagnostic_value,
)
from sidecar.runtime.rpc import error_response

# Representative secret-shaped strings. All are fabricated and match the
# documented detector patterns; none is a real credential.
OPENAI_KEY = "sk-AbCdEfGh0123456789ABCDEF"
# Embeds "example" so the repo secret-scanner treats it as a placeholder (same
# convention the AWS id below relies on); the redactor under test keys off the
# ``ghp_`` shape, not the placeholder, so this does not weaken the assertion.
GITHUB_TOKEN = "ghp_exampleabcdefghijklmnop0123456789ABCD"
AWS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
# Assembled at runtime so the file never contains a contiguous Slack-token shape:
# GitHub push protection blocks the public seed on the literal, while the
# redactor under test only ever sees the joined value.
SLACK_TOKEN = "xoxb-" + "123456789012-abcdefghijklmnop"
JWT = (
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
)
BEARER_VALUE = "Bearer abcDEF123456_~tok"
CONFIG_SECRET = "supersecretconfigvalue123"

# Bare token shapes that the tool-output sanitizer must catch unconditionally.
BARE_TOKENS = (OPENAI_KEY, GITHUB_TOKEN, AWS_KEY_ID, SLACK_TOKEN, JWT)


# ---------------------------------------------------------------------------
# Tool / assistant output sanitizer (sanitization.py)
# ---------------------------------------------------------------------------


def test_redact_obvious_secrets_strips_every_bare_token_shape() -> None:
    for secret in BARE_TOKENS:
        text = f"the leaked credential is {secret} please ignore"
        redacted = redact_obvious_secrets(text)
        assert secret not in redacted, f"{secret!r} survived redact_obvious_secrets"
        assert "[REDACTED]" in redacted


def test_sanitize_tool_output_strips_bare_tokens() -> None:
    for secret in BARE_TOKENS:
        cleaned = sanitize_tool_output(f"value={secret}", max_chars=500, tool_name="web_fetch")
        assert secret not in cleaned, f"{secret!r} survived sanitize_tool_output"
        assert "[REDACTED]" in cleaned


# ---------------------------------------------------------------------------
# Diagnostic text + value sanitizers (diagnostics.py)
# ---------------------------------------------------------------------------


def test_sanitize_diagnostic_text_redacts_key_adjacent_secrets() -> None:
    raw = (
        f"Authorization: {BEARER_VALUE} api_key={CONFIG_SECRET} "
        f"password=hunter2-{CONFIG_SECRET}"
    )
    sanitized = sanitize_diagnostic_text(raw)
    assert CONFIG_SECRET not in sanitized
    assert "hunter2" not in sanitized
    assert "[redacted]" in sanitized


def test_sanitize_diagnostic_value_redacts_sensitive_dict_keys() -> None:
    payload = {
        "authorization": BEARER_VALUE,
        "api_key": OPENAI_KEY,
        "apikey": GITHUB_TOKEN,
        "client_secret": CONFIG_SECRET,
        "password": "hunter2",
        "keep_me": "harmless-value",
    }
    sanitized = sanitize_diagnostic_value(payload)
    blob = json.dumps(sanitized)
    for secret in (BEARER_VALUE, OPENAI_KEY, GITHUB_TOKEN, CONFIG_SECRET, "hunter2"):
        assert secret not in blob, f"{secret!r} survived sanitize_diagnostic_value"
    # Non-sensitive keys are preserved verbatim.
    assert sanitized["keep_me"] == "harmless-value"
    for key in ("authorization", "api_key", "apikey", "client_secret", "password"):
        assert sanitized[key] == "[redacted]"


# ---------------------------------------------------------------------------
# Emitted structured log line (diagnostics.py StructuredLogFormatter)
# ---------------------------------------------------------------------------


def test_structured_log_formatter_emits_no_verbatim_secret() -> None:
    record = logging.makeLogRecord(
        {
            "msg": f"request failed: Authorization: {BEARER_VALUE} api_key={CONFIG_SECRET}",
            "component": "ai.router",
            "event": "ai.router.tool_call_failed",
            "data": {
                "authorization": BEARER_VALUE,
                "api_key": CONFIG_SECRET,
                "note": "kept",
            },
        }
    )
    line = StructuredLogFormatter().format(record)
    assert CONFIG_SECRET not in line
    assert BEARER_VALUE not in line
    # The emitted line is still valid JSON and keeps the redaction marker.
    payload = json.loads(line)
    assert "[redacted]" in line
    assert payload["data"]["api_key"] == "[redacted]"
    assert payload["data"]["note"] == "kept"


# ---------------------------------------------------------------------------
# JSON-RPC error surface (rpc.error_response)
# ---------------------------------------------------------------------------


def test_error_response_redacts_message_and_data() -> None:
    envelope = error_response(
        7,
        code=-32000,
        message=f"models.unload failed with api_key={CONFIG_SECRET}",
        data={
            "detail": f"provider said Authorization: {BEARER_VALUE}",
            "headers": {"authorization": BEARER_VALUE},
        },
    )
    blob = json.dumps(envelope)
    assert CONFIG_SECRET not in blob
    assert BEARER_VALUE not in blob
    assert envelope["error"]["message"] == "models.unload failed with api_key=[redacted]"
    assert envelope["error"]["data"]["headers"]["authorization"] == "[redacted]"


# ---------------------------------------------------------------------------
# Diagnostic snippet builder (diagnostics.py build_redacted_snippet_data)
# ---------------------------------------------------------------------------


def test_redacted_snippet_default_mode_hashes_without_raw_text() -> None:
    # Default capture mode ("redacted") records only char-counts + hashes, so the
    # raw text (and any secret in it) never appears in the diagnostic snapshot.
    # Establish it explicitly because other diagnostics tests exercise the
    # process-global sanitized-snippets mode in the same pytest worker.
    apply_logging_preferences({"diagnostics_capture_mode": "redacted"})
    data = build_redacted_snippet_data(
        prompt=f"please use api_key={CONFIG_SECRET}",
        response=f"sure, token is {OPENAI_KEY}",
        tool_output=f"AWS id {AWS_KEY_ID}",
    )
    blob = json.dumps(data)
    for secret in (CONFIG_SECRET, OPENAI_KEY, AWS_KEY_ID):
        assert secret not in blob
    assert "prompt_hash" in data and "response_hash" in data and "tool_output_hash" in data
    assert "prompt_snippet" not in data  # snippets are off in default mode


def test_redacted_snippet_sanitized_mode_redacts_key_adjacent_secrets() -> None:
    # In sanitized_snippets mode the builder emits snippets, but routes them
    # through the diagnostic text sanitizer so key-adjacent secrets are redacted.
    try:
        apply_logging_preferences({"diagnostics_capture_mode": "sanitized_snippets"})
        data = build_redacted_snippet_data(prompt=f"api_key={CONFIG_SECRET} now")
        snippet = data.get("prompt_snippet", "")
        assert snippet, "expected a prompt snippet in sanitized_snippets mode"
        assert CONFIG_SECRET not in json.dumps(data)
        assert "[redacted]" in snippet
    finally:
        # Reset the process-global capture mode so other tests see the default.
        apply_logging_preferences({"diagnostics_capture_mode": "redacted"})
