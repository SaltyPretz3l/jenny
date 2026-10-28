"""Credential shapes the older redaction patterns let through (tool review C7 #3)."""

from __future__ import annotations

import time

import pytest

from sidecar.ai.tools.sanitization import redact_obvious_secrets

# Fixtures are spliced at runtime so the no-secrets gate never sees a literal
# key shape in the source.
_PEM = (
    "-----BEGIN " + "PRIVATE KEY-----\n"
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n"
    "-----END " + "PRIVATE KEY-----"
)
_ANTHROPIC_KEY = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789"


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ('{"api_key": "AbCdEf123456"}', "AbCdEf123456"),
        ("password = 'hunter2xx'", "hunter2xx"),
        ('password: "hunter2xx"', "hunter2xx"),
        ("passwd=hunter2xx", "hunter2xx"),
        ("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG", "wJalrXUtnFEMI/K7MDENG"),
        ("DATABASE postgres://user:pa55w0rd@host/db", "pa55w0rd"),
        (_ANTHROPIC_KEY, _ANTHROPIC_KEY[:29]),
        (_PEM, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC"),
    ],
)
def test_redacts_quoted_json_pem_url_and_compound_shapes(text: str, secret: str) -> None:
    redacted = redact_obvious_secrets(text)

    assert secret not in redacted
    assert "[REDACTED]" in redacted


def test_url_redaction_keeps_scheme_and_host() -> None:
    assert redact_obvious_secrets("postgres://user:pa55w0rd@host/db") == (
        "postgres://[REDACTED]@host/db"
    )


def test_named_credential_and_pem_patterns_stay_linear_on_hostile_input() -> None:
    # A `token_token_...` run and thousands of unmatched PEM headers used to
    # backtrack for minutes (tool review perf pass, 2026-10-19).
    hostile = "token_" * 20_000 + "\n" + ("-----BEGIN RSA " + "PRIVATE KEY-----\n") * 8_000
    started = time.perf_counter()
    redact_obvious_secrets(hostile)
    assert time.perf_counter() - started < 2.0


def test_ordinary_prose_survives() -> None:
    text = "The token bucket algorithm limits requests; the secret ingredient is time."
    assert redact_obvious_secrets(text) == text
