from __future__ import annotations

import logging
import sys
from types import SimpleNamespace

import pytest

from sidecar.runtime import telemetry
from sidecar.runtime.request_dispatch import _apply_telemetry_config


class _FakeSentry:
    def __init__(self) -> None:
        self.init_kwargs = None
        self.closed = False

    def init(self, **kwargs):
        self.init_kwargs = kwargs

    def get_client(self):
        return SimpleNamespace(close=lambda timeout=0: setattr(self, "closed", True))


@pytest.fixture(autouse=True)
def reset_telemetry(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(telemetry, "_sentry_initialized", False)
    monkeypatch.setattr(telemetry, "_last_status", telemetry.TelemetryStatus())
    yield
    monkeypatch.setattr(telemetry, "_sentry_initialized", False)
    monkeypatch.setattr(telemetry, "_last_status", telemetry.TelemetryStatus())
    sys.modules.pop("sentry_sdk", None)


def test_configure_telemetry_rejects_non_sentry_dsn(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="sidecar.runtime.telemetry")

    telemetry.configure_telemetry(
        dsn="https://public@example.com/1",
        consent="opt_in",
        app_version="0.1.0",
    )

    status = telemetry.telemetry_status()
    assert telemetry.telemetry_status()["initialized"] is False
    assert status == {
        "initialized": False,
        "consent": "opt_in",
        "status": "invalid_dsn",
        "failure_reason": "telemetry_dsn_host_not_allowed",
    }
    assert "telemetry DSN rejected" in caplog.text


def test_configure_telemetry_rejects_lookalike_sentry_host() -> None:
    telemetry.configure_telemetry(
        dsn="https://public@attacker-sentry.io/1",
        consent="opt_in",
        app_version="0.1.0",
    )

    assert telemetry.telemetry_status()["status"] == "invalid_dsn"
    assert telemetry.telemetry_status()["failure_reason"] == "telemetry_dsn_host_not_allowed"
    assert telemetry.telemetry_status()["initialized"] is False


def test_configure_telemetry_reports_initialized_status(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_sentry = _FakeSentry()
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake_sentry)

    telemetry.configure_telemetry(
        dsn="https://public@o123.ingest.sentry.io/456",
        consent="opt_in",
        app_version="0.1.0",
    )

    assert telemetry.telemetry_status()["initialized"] is True
    assert fake_sentry.init_kwargs["dsn"] == "https://public@o123.ingest.sentry.io/456"
    assert telemetry.telemetry_status() == {
        "initialized": True,
        "consent": "opt_in",
        "status": "initialized",
        "failure_reason": None,
    }


def test_invalid_telemetry_config_closes_existing_client(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_sentry = _FakeSentry()
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake_sentry)
    telemetry.configure_telemetry(
        dsn="https://public@o123.ingest.sentry.io/456",
        consent="opt_in",
        app_version="0.1.0",
    )

    telemetry.configure_telemetry(
        dsn="https://public@attacker-sentry.io/456",
        consent="opt_in",
        app_version="0.1.0",
    )

    assert fake_sentry.closed is True
    assert telemetry.telemetry_status()["initialized"] is False
    assert telemetry.telemetry_status()["status"] == "invalid_dsn"


def test_configure_telemetry_reports_import_failure(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.runtime.telemetry")
    sys.modules.pop("sentry_sdk", None)
    real_import = __import__

    def fail_sentry_import(name, *args, **kwargs):
        if name == "sentry_sdk":
            raise ImportError("missing sentry")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fail_sentry_import)

    telemetry.configure_telemetry(
        dsn="https://public@o123.ingest.sentry.io/456",
        consent="opt_in",
        app_version="0.1.0",
    )

    assert telemetry.telemetry_status()["status"] == "init_failed"
    assert telemetry.telemetry_status()["failure_reason"] == "ImportError"
    assert "telemetry disabled after init failure" in caplog.text


def test_apply_telemetry_config_returns_initialize_status_payload() -> None:
    status = _apply_telemetry_config(
        {
            "config": {
                "crash_reporting_opt_in": True,
                "telemetry_dsn": "https://public@example.com/1",
            },
            "client_version": "0.1.0",
        }
    )

    assert status == {
        "initialized": False,
        "consent": "opt_in",
        "status": "invalid_dsn",
        "failure_reason": "telemetry_dsn_host_not_allowed",
    }


def test_apply_telemetry_config_prefers_initialize_secrets_dsn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_sentry = _FakeSentry()
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake_sentry)

    status = _apply_telemetry_config(
        {
            "config": {
                "crash_reporting_opt_in": True,
                "telemetry_dsn": "https://public@example.com/1",
            },
            "secrets": {
                "telemetry_dsn": "https://public@o123.ingest.sentry.io/456",
            },
            "client_version": "0.1.0",
        }
    )

    assert status["status"] == "initialized"
    assert fake_sentry.init_kwargs["dsn"] == "https://public@o123.ingest.sentry.io/456"


def test_before_send_sanitizes_event_surfaces_and_drops_user_and_request() -> None:
    event = {
        "message": "failed with OPENAI_API_KEY=sk-message",
        "transaction": "G:/secret/workspace/chat.send",
        "fingerprint": ["authorization=Bearer finger"],
        "user": {"id": "local-user"},
        "request": {"url": "https://example.invalid?token=secret"},
        "tags": {"workspace": "G:/secret/workspace"},
        "contexts": {"runtime": {"path": "G:/secret/workspace", "name": "python"}},
        "breadcrumbs": {
            "values": [
                {
                    "message": "tool used bearer crumbsecret",
                    "data": {"path": "G:/secret/workspace", "api_key": "api_key=crumb"},
                }
            ]
        },
        "exception": {
            "values": [
                {
                    "value": "boom authorization=Bearer exception",
                    "stacktrace": {
                        "frames": [
                            {"vars": {"secret": "OPENAI_API_KEY=sk-frame"}}
                        ]
                    },
                }
            ]
        },
        "extra": {"token": "api_key=extra"},
    }

    sanitized = telemetry._before_send(event, {})
    serialized = str(sanitized)

    assert "user" not in sanitized
    assert "request" not in sanitized
    assert "sk-message" not in serialized
    assert "crumbsecret" not in serialized
    assert "sk-frame" not in serialized
    assert "G:/secret/workspace" not in serialized
    assert "[redacted" in serialized


def test_before_send_redacts_literal_values_selected_by_sensitive_keys() -> None:
    event = {
        "extra": {
            "password": "value-one",
            "api_key": "value-two",
            "dsn": "value-three",
        },
        "contexts": {
            "auth": {
                "access_token": "value-four",
                "client_secret": "value-five",
                "authorization": "value-six",
                "cookie": "value-seven",
            }
        },
    }

    sanitized = telemetry._before_send(event, {})

    assert sanitized["extra"] == {
        "password": "[redacted]",
        "api_key": "[redacted]",
        "dsn": "[redacted]",
    }
    assert sanitized["contexts"]["auth"] == {
        "access_token": "[redacted]",
        "client_secret": "[redacted]",
        "authorization": "[redacted]",
        "cookie": "[redacted]",
    }


def test_before_send_sanitizes_posix_paths() -> None:
    sanitized = telemetry._before_send({"message": "failed at /Users/jenny/project/file.txt"}, {})

    assert "/Users/jenny/project" not in sanitized["message"]
    assert "[redacted:path]" in sanitized["message"]
