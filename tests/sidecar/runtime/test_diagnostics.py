from __future__ import annotations

import json
import logging
import os
import sys
import time
from unittest.mock import patch

import pytest

import sidecar.runtime.diagnostics as _diag_module
from sidecar.runtime.diagnostics import (
    SCHEMA_VERSION,
    NdjsonRollingFileHandler,
    StructuredLogFormatter,
    apply_logging_preferences,
    build_redacted_snippet_data,
    configure_sidecar_logging,
    correlation_from_params,
    diagnostics_context,
    emit_startup_audit_mark,
    log_event,
    log_tool_execution,
    sanitize_diagnostic_text,
    sanitize_diagnostic_value,
    shutdown_sidecar_logging,
)


def test_diagnostics_schema_version_is_integer() -> None:
    # Pin the concrete schema version so an accidental bump is caught; a bare
    # isinstance(..., int) check is a tautology over a module constant.
    assert SCHEMA_VERSION == 1


def test_shutdown_logging_returns_drain_result_and_writes_final_stage_timings(
    tmp_path,
) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path)
    shutdown_started_at = time.perf_counter()

    result = shutdown_sidecar_logging(
        timeout_seconds=0.5,
        shutdown_started_at=shutdown_started_at,
        shutdown_deadline=shutdown_started_at + 1.0,
        shutdown_confirmed=True,
    )

    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    stage_records = [
        record for record in records
        if record.get("event") == "sidecar.runtime.shutdown_stage"
    ]
    assert result["drained"] is True
    assert result["duration_ms"] >= 0
    assert [record["data"]["stage"] for record in stage_records] == [
        "diagnostics_flush",
        "total",
    ]
    assert all(record["duration_ms"] >= 0 for record in stage_records)
    assert all(record["data"]["remaining_budget_ms"] >= 0 for record in stage_records)


def test_build_redacted_snippet_data_hashes_content_without_raw_payload() -> None:
    data = build_redacted_snippet_data(
        prompt="secret prompt payload",
        response="assistant response",
        tool_output="tool output",
    )

    assert data["prompt_chars"] == len("secret prompt payload")
    assert "prompt_hash" in data
    assert "prompt_snippet" not in data


def test_configured_logging_writes_ndjson_with_correlation_context(tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    logger = logging.getLogger("tests.sidecar.runtime.diagnostics")
    configure_sidecar_logging(log_path)
    try:
        with diagnostics_context(
            trace_id="trace-123",
            request_id="req-123",
            session_id="session-123",
            agent_id="planner@req-123",
        ):
            log_event(
                logger,
                logging.INFO,
                component="tests.diagnostics",
                event="sidecar.tests.diagnostics",
                message="diagnostics smoke event",
                status="ok",
                data={"sample": "value"},
            )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["trace_id"] == "trace-123"
    assert payload["request_id"] == "req-123"
    assert payload["session_id"] == "session-123"
    assert payload["agent_id"] == "planner@req-123"
    assert payload["event"] == "sidecar.tests.diagnostics"
    assert payload["schema_version"] == SCHEMA_VERSION
    assert isinstance(payload["schema_version"], int)


def test_correlation_from_params_includes_agent_id() -> None:
    correlation = correlation_from_params(
        {
            "trace_id": "trace-1",
            "request_id": "req-1",
            "session_id": "session-1",
            "agent_id": "verifier@req-1",
        }
    )

    assert correlation["agent_id"] == "verifier@req-1"


def test_configured_logging_preserves_exception_details_after_queue_prepare(tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    logger = logging.getLogger("tests.sidecar.runtime.diagnostics.exceptions")
    configure_sidecar_logging(log_path)
    try:
        try:
            raise RuntimeError("api_key=secret-value boom")
        except RuntimeError:
            logger.exception("structured exception test")
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["data"]["error_type"] == "RuntimeError"
    assert "api_key=[redacted]" in payload["data"]["error_message"]
    assert "secret-value" not in payload["data"]["error_message"]


def test_sanitize_diagnostic_text_redacts_terminal_secret_shapes() -> None:
    raw = (
        "Authorization: Bearer token-value api_key=secret-value "
        "password=hunter2 data:image/png;base64,ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    )

    sanitized = sanitize_diagnostic_text(raw)

    assert "token-value" not in sanitized
    assert "secret-value" not in sanitized
    assert "hunter2" not in sanitized
    assert "ABCDEFGHIJKLMNOPQRSTUVWXYZ" not in sanitized
    assert "Authorization: [redacted]" in sanitized
    assert "api_key=[redacted]" in sanitized
    assert "password=[redacted]" in sanitized
    assert "data:[redacted]" in sanitized


def test_sanitize_diagnostic_text_redacts_full_cookie_header_values() -> None:
    raw = (
        "Cookie: session=abc123; refresh=def456\n"
        "Set-Cookie: jwt=ghi789; Path=/; HttpOnly\n"
        "message=keep"
    )

    sanitized = sanitize_diagnostic_text(raw)

    assert "abc123" not in sanitized
    assert "def456" not in sanitized
    assert "ghi789" not in sanitized
    assert "Cookie: [redacted]" in sanitized
    assert "Set-Cookie: [redacted]" in sanitized
    assert "message=keep" in sanitized


def test_sanitize_diagnostic_text_redacts_full_authorization_header_values() -> None:
    raw = "Authorization: Basic abc123\nmessage=keep"

    sanitized = sanitize_diagnostic_text(raw)

    assert "Basic" not in sanitized
    assert "abc123" not in sanitized
    assert "Authorization: [redacted]" in sanitized
    assert "message=keep" in sanitized


def test_sanitize_diagnostic_value_redacts_recursive_terminal_secret_keys() -> None:
    sanitized = sanitize_diagnostic_value(
        {
            "headers": {
                "Set-Cookie": "session=secret-cookie",
                "x-request-id": "req_123",
            },
            "client_secret": "client-secret-value",
            "refreshToken": "refresh-token-value",
            "nested": [{"accessToken": "access-token-value"}],
        }
    )

    raw = json.dumps(sanitized)
    assert "secret-cookie" not in raw
    assert "client-secret-value" not in raw
    assert "refresh-token-value" not in raw
    assert "access-token-value" not in raw
    assert sanitized["headers"]["Set-Cookie"] == "[redacted]"
    assert sanitized["headers"]["x-request-id"] == "req_123"


def test_log_tool_execution_writes_structured_trace_at_debug_level(tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    logger = logging.getLogger("tests.sidecar.runtime.diagnostics.tool_exec")
    configure_sidecar_logging(log_path, log_level="debug")
    try:
        log_tool_execution(
            logger,
            tool_name="read_file",
            arguments={"path": "README.md"},
            duration_ms=12.5,
            result_size=1024,
            success=True,
        )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["event"] == "ai.tools.execution"
    assert payload["level"] == "DEBUG"
    assert payload["data"]["tool_name"] == "read_file"
    assert payload["data"]["success"] is True
    assert payload["data"]["duration_ms"] == 12.5
    assert payload["data"]["result_size"] == 1024
    assert payload["status"] == "success"


def test_log_tool_execution_uses_warn_level_for_failures(tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    logger = logging.getLogger("tests.sidecar.runtime.diagnostics.tool_warn")
    configure_sidecar_logging(log_path)
    try:
        log_tool_execution(
            logger,
            tool_name="write_file",
            success=False,
        )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["level"] == "WARNING"
    assert payload["status"] == "failure"


def test_log_tool_execution_uses_error_level_for_coded_failures(tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    logger = logging.getLogger("tests.sidecar.runtime.diagnostics.tool_error")
    configure_sidecar_logging(log_path)
    try:
        log_tool_execution(
            logger,
            tool_name="edit_file",
            success=False,
            error_code="CMP-TOOL-0006",
        )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["level"] == "ERROR"
    assert payload["data"]["error_code"] == "CMP-TOOL-0006"


def test_log_tool_execution_redacts_sensitive_arguments(tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    logger = logging.getLogger("tests.sidecar.runtime.diagnostics.tool_redact")
    configure_sidecar_logging(log_path, log_level="debug")
    try:
        log_tool_execution(
            logger,
            tool_name="fetch_url",
            arguments={
                "url": "https://example.com",
                "token": "authorization=secret-token-value",
                "password": "hunter2",
                "headers": {"authorization": "Bearer abcdef123456"},
                "dsn": "https://example.invalid/project-id",
                "tokenizer_model": "keep-tokenizer-value",
            },
            success=True,
        )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    raw = json.dumps(payload)
    assert "secret-token-value" not in raw
    assert "hunter2" not in raw
    assert "abcdef123456" not in raw
    assert "project-id" not in raw
    assert payload["data"]["arguments"]["password"] == "[redacted]"
    assert payload["data"]["arguments"]["headers"]["authorization"] == "[redacted]"
    assert payload["data"]["arguments"]["tokenizer_model"] == "keep-tokenizer-value"


def test_log_tool_execution_includes_duration_and_result_size(tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    logger = logging.getLogger("tests.sidecar.runtime.diagnostics.tool_data")
    configure_sidecar_logging(log_path, log_level="debug")
    try:
        log_tool_execution(
            logger,
            tool_name="grep_search",
            duration_ms=45.3,
            result_size=256,
            success=True,
        )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["duration_ms"] == 45.3
    assert payload["data"]["duration_ms"] == 45.3
    assert payload["data"]["result_size"] == 256


def test_log_tool_execution_skips_sanitization_when_debug_is_disabled() -> None:
    logger = logging.getLogger("tests.sidecar.disabled_tool_debug")
    logger.setLevel(logging.INFO)
    with patch.object(_diag_module, "_sanitize_value") as sanitize:
        log_tool_execution(logger, tool_name="read_file", arguments={"path": "secret"})
    sanitize.assert_not_called()


def test_sanitize_mapping_and_sequence_traversal_is_bounded() -> None:
    class BoundedItems(dict[str, int]):
        def items(self):  # type: ignore[override]
            for index in range(21):
                if index == 20:
                    raise AssertionError("mapping traversed past the 20-item bound")
                yield f"key-{index}", index

    class BoundedSequence(list[int]):
        def __iter__(self):  # type: ignore[override]
            for index in range(9):
                if index == 8:
                    raise AssertionError("sequence traversed past the 8-item bound")
                yield index

    assert len(sanitize_diagnostic_value(BoundedItems())) == 20
    assert len(sanitize_diagnostic_value(BoundedSequence())) == 8


@pytest.mark.parametrize(
    ("configured_level", "expected"),
    [
        ("debug", logging.DEBUG),
        ("info", logging.INFO),
        ("warn", logging.WARNING),
        ("warning", logging.WARNING),
        ("error", logging.ERROR),
        ("bogus", logging.INFO),
    ],
)
def test_apply_logging_preferences_supports_named_log_levels(
    configured_level: str,
    expected: int,
) -> None:
    root = logging.getLogger()
    original_level = root.level
    try:
        apply_logging_preferences({"diagnostics_log_level": configured_level})
        assert root.level == expected
    finally:
        root.setLevel(original_level)


# ---------------------------------------------------------------------------
# _sanitize_value deep-nesting branches (lines 144-161)
# ---------------------------------------------------------------------------


def test_sanitize_value_deep_dict_returns_key_summary() -> None:
    # Build a structure 3 levels deep so depth >= 3 triggers line 145
    deep = {"a": 1, "b": 2, "c": 3}
    nested = {"level2": {"level3": deep}}
    result = sanitize_diagnostic_value({"level1": nested})

    level3 = result["level1"]["level2"]["level3"]
    assert isinstance(level3, dict)
    # At depth >= 3 the dict collapses to a key summary: only the (sorted) keys
    # and a count, never the raw values (1, 2, 3).
    assert level3["key_count"] == 3
    assert level3["keys"] == ["a", "b", "c"]
    # Raw values must not leak through the summary at all.
    assert set(level3.keys()) == {"keys", "key_count"}
    assert 1 not in level3["keys"]


def test_sanitize_value_deep_list_returns_item_count() -> None:
    # Build a list nested 3 levels deep so depth >= 3 triggers line 157
    deep_list = [1, 2, 3, 4, 5]
    nested = {"level2": {"level3": deep_list}}
    result = sanitize_diagnostic_value({"level1": nested})

    level3 = result["level1"]["level2"]["level3"]
    assert isinstance(level3, dict)
    assert level3 == {"item_count": 5}


def test_sanitize_value_exception_returns_type_and_message() -> None:
    # BaseException branch (lines 159-161)
    err = ValueError("something went wrong")
    result = sanitize_diagnostic_value(err)

    assert isinstance(result, dict)
    assert result["type"] == "ValueError"
    assert "something went wrong" in result["message"]


def test_sanitize_value_exception_redacts_sensitive_message() -> None:
    err = RuntimeError("api_key=top-secret boom")
    result = sanitize_diagnostic_value(err)

    assert result["type"] == "RuntimeError"
    assert "top-secret" not in result["message"]
    assert "api_key=[redacted]" in result["message"]


# ---------------------------------------------------------------------------
# _safe_data non-dict data branch (line 178) and exc_info branch (188-191)
# ---------------------------------------------------------------------------


def test_safe_data_wraps_non_dict_sanitized_value_in_value_key(tmp_path) -> None:
    # Feed a record whose .data is a plain string; _sanitize_value returns a
    # string, _safe_data must then wrap it in {"value": ...} (line 178).
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, log_level="debug")
    logger = logging.getLogger("tests.sidecar.safe_data.nondict")
    try:
        logger.log(
            logging.DEBUG,
            "non-dict data test",
            extra={"layer": "sidecar", "component": "test", "event": "test", "data": "plain-string"},
        )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    # The string sanitized value is wrapped in {"value": ...}
    assert payload["data"] == {"value": "plain-string"}


def test_safe_data_reads_exc_info_when_no_diagnostics_exception() -> None:
    # Lines 187-193: exc_info branch — no diagnostics_exception attribute, but
    # record.exc_info is set.  This happens when using the formatter directly
    # (not via ContextQueueHandler which strips exc_info).
    formatter = StructuredLogFormatter()

    try:
        raise TypeError("raw exc_info branch test")
    except TypeError:
        exc_info = sys.exc_info()

    record = logging.LogRecord(
        name="test",
        level=logging.ERROR,
        pathname="",
        lineno=0,
        msg="boom",
        args=(),
        exc_info=exc_info,
    )
    # Do NOT set diagnostics_exception so the elif branch is taken
    record.data = {}

    formatted = formatter.format(record)
    payload = json.loads(formatted)

    assert payload["data"]["error_type"] == "TypeError"
    assert "raw exc_info branch test" in payload["data"]["error_message"]


# ---------------------------------------------------------------------------
# _coerce_int returning None (line 211)
# ---------------------------------------------------------------------------


def test_structured_log_formatter_coerces_non_int_approval_id_to_null(tmp_path) -> None:
    # _coerce_int("not-an-int") returns None → approval_id must be null
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, log_level="debug")
    logger = logging.getLogger("tests.sidecar.coerce_int")
    try:
        logger.log(
            logging.DEBUG,
            "coerce int test",
            extra={
                "layer": "sidecar",
                "component": "test",
                "event": "test",
                "data": {},
                "approval_id": "not-a-number",
                "rpc_id": "also-not-a-number",
            },
        )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    payload = json.loads(lines[0])
    assert payload["approval_id"] is None
    assert payload["rpc_id"] is None


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_structured_log_formatter_emits_strict_finite_json(value: float) -> None:
    formatter = StructuredLogFormatter()
    record = logging.LogRecord("test", logging.INFO, "", 0, "strict", (), None)
    record.duration_ms = value
    record.data = {"metric": value, "nested": [value]}

    formatted = formatter.format(record)

    def reject_constant(token: str) -> None:
        raise AssertionError(f"non-standard JSON constant: {token}")

    payload = json.loads(formatted, parse_constant=reject_constant)
    assert payload["duration_ms"] is None
    assert payload["data"] == {"metric": None, "nested": [None]}


# ---------------------------------------------------------------------------
# NdjsonRollingFileHandler rotation (lines 288-318)
# ---------------------------------------------------------------------------


def test_ndjson_handler_rotates_when_segment_size_exceeded(tmp_path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "sidecar.log"

    # Write a large existing file so the next emit triggers rotation
    large_content = b"x" * (_diag_module.SEGMENT_MAX_BYTES + 1)
    log_path.write_bytes(large_content)

    handler = NdjsonRollingFileHandler(log_path)
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg="rotation test", args=(), exc_info=None,
    )
    record.data = {}
    handler.emit(record)
    handler.close()

    # After rotation the original oversized file should be renamed to .1
    rotated = log_dir / "sidecar.log.1"
    assert rotated.exists(), "rotation must produce sidecar.log.1"
    # A fresh sidecar.log must exist with the new record
    assert log_path.exists(), "new sidecar.log must be written after rotation"
    new_content = log_path.read_text("utf-8")
    assert "rotation test" in new_content


def test_ndjson_handler_prunes_on_startup_rotation_megabyte_and_shutdown_only(
    tmp_path, monkeypatch
) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    handler = NdjsonRollingFileHandler(log_path)
    prune_calls = 0
    original_prune = handler._prune_locked

    def count_prune() -> None:
        nonlocal prune_calls
        prune_calls += 1
        original_prune()

    monkeypatch.setattr(handler, "_prune_locked", count_prune)
    record = logging.LogRecord("test", logging.INFO, "", 0, "small", (), None)
    record.data = {}

    handler.prune()  # configure/startup cadence
    assert prune_calls == 1
    handler.emit(record)
    handler.emit(record)
    assert prune_calls == 1, "sub-threshold records must not scan retention"

    handler._bytes_since_prune = 1_048_575
    handler.emit(record)
    assert prune_calls == 2, "each additional MiB triggers one prune"

    monkeypatch.setattr(_diag_module, "SEGMENT_MAX_BYTES", 1)
    handler.emit(record)
    assert prune_calls == 3, "rotation triggers one prune"

    handler.close()
    assert prune_calls == 4, "shutdown triggers one prune"


def test_ndjson_handler_list_layer_files_returns_empty_when_dir_missing(tmp_path) -> None:
    missing_dir = tmp_path / "nonexistent"
    log_path = missing_dir / "sidecar.log"
    handler = NdjsonRollingFileHandler(log_path)
    files = handler._list_layer_files()
    handler.close()
    assert files == []


def test_ndjson_handler_list_layer_files_returns_main_and_rotated(tmp_path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "sidecar.log"

    # Create main log and two rotation segments
    log_path.write_text("main\n", encoding="utf-8")
    (log_dir / "sidecar.log.1").write_text("old1\n", encoding="utf-8")
    (log_dir / "sidecar.log.2").write_text("old2\n", encoding="utf-8")
    # An unrelated file must not appear
    (log_dir / "other.log").write_text("unrelated\n", encoding="utf-8")

    handler = NdjsonRollingFileHandler(log_path)
    files = handler._list_layer_files()
    handler.close()

    names = [f.name for f in files]
    assert "sidecar.log" in names
    assert "sidecar.log.1" in names
    assert "sidecar.log.2" in names
    assert "other.log" not in names
    # Main file must come first (index 0)
    assert files[0].name == "sidecar.log"


def test_ndjson_handler_ignores_non_numeric_rotation_suffixes(tmp_path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "sidecar.log"
    log_path.write_text("main\n", encoding="utf-8")
    (log_dir / "sidecar.log.1").write_text("rotation\n", encoding="utf-8")
    for suffix in ("old", "tmp", "1.old", "١"):
        (log_dir / f"sidecar.log.{suffix}").write_text("sentinel\n", encoding="utf-8")

    handler = NdjsonRollingFileHandler(log_path)
    files = handler._list_layer_files()
    handler._prune()
    handler.close()

    assert [path.name for path in files] == ["sidecar.log", "sidecar.log.1"]
    for suffix in ("old", "tmp", "1.old", "١"):
        assert (log_dir / f"sidecar.log.{suffix}").read_text("utf-8") == "sentinel\n"


def test_ndjson_handler_surfaces_prune_failure_once_per_streak(
    tmp_path, monkeypatch
) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    handler = NdjsonRollingFileHandler(log_path)

    def fail_prune() -> None:
        raise PermissionError("private local path must not be logged")

    monkeypatch.setattr(handler, "_prune_locked", fail_prune)
    handler.prune()
    handler.prune()
    handler.close()

    payloads = [json.loads(line) for line in log_path.read_text("utf-8").splitlines()]
    failures = [
        payload
        for payload in payloads
        if payload["event"] == "sidecar.runtime.diagnostics_prune_failed"
    ]
    assert len(failures) == 1
    assert failures[0]["data"]["failure_count"] == 1
    assert "private local path" not in log_path.read_text("utf-8")
    assert handler.prune_failure_count == 3


def test_ndjson_handler_prune_failure_uses_redacted_structured_stderr_fallback(
    tmp_path, monkeypatch, capsys
) -> None:
    handler = NdjsonRollingFileHandler(tmp_path / "logs" / "sidecar.log")

    def fail_prune() -> None:
        raise PermissionError("private prune path")

    def fail_stream() -> None:
        raise PermissionError("private sink path")

    monkeypatch.setattr(handler, "_prune_locked", fail_prune)
    monkeypatch.setattr(handler, "_ensure_stream", fail_stream)

    handler.prune()
    payload = json.loads(capsys.readouterr().err.strip())
    handler.close()

    assert payload["event"] == "sidecar.runtime.diagnostics_prune_failed"
    assert payload["status"] == "degraded"
    assert payload["data"]["error_type"] == "PermissionError"
    assert "private" not in json.dumps(payload)


# ---------------------------------------------------------------------------
# _prune: old-file cutoff deletion (line 342) and per-layer cap (342-351)
# ---------------------------------------------------------------------------


def test_ndjson_handler_prune_deletes_old_rotation_segments(tmp_path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "sidecar.log"

    log_path.write_text("current\n", encoding="utf-8")

    # Create a rotated file and back-date its mtime to 20 days ago (past RETENTION_DAYS=14)
    old_seg = log_dir / "sidecar.log.1"
    old_seg.write_text("ancient\n", encoding="utf-8")
    ancient_mtime = time.time() - (20 * 24 * 3600)
    os.utime(str(old_seg), (ancient_mtime, ancient_mtime))

    handler = NdjsonRollingFileHandler(log_path)
    handler._prune()
    handler.close()

    assert not old_seg.exists(), "prune must delete rotation segment older than RETENTION_DAYS"
    assert log_path.exists(), "current log must be preserved"


def test_ndjson_handler_prune_trims_per_layer_cap(tmp_path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "sidecar.log"

    # Create a large current log (but below SEGMENT_MAX_BYTES individually)
    chunk = b"a" * (1024 * 1024)  # 1 MB per file
    log_path.write_bytes(chunk)

    # Create many rotation segments totalling > PER_LAYER_CAP_BYTES
    # PER_LAYER_CAP_BYTES = 50 MB; create 55 x 1MB = 55 MB total
    seg_names = []
    for i in range(1, 56):
        seg = log_dir / f"sidecar.log.{i}"
        seg.write_bytes(chunk)
        seg_names.append(seg)

    handler = NdjsonRollingFileHandler(log_path)
    handler._prune()
    handler.close()

    # Some of the oldest (highest index) rotation segments should have been deleted
    remaining = list(log_dir.glob("sidecar.log.*"))
    assert len(remaining) < 55, "prune must remove rotation segments beyond per-layer cap"
    # The current log must always survive
    assert log_path.exists()


def test_ndjson_handler_prune_global_cap_skips_active_log(tmp_path) -> None:
    # Lines 365-371: global cap loop skips files ending in .log (active logs)
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "sidecar.log"

    # Make a large current log
    huge = b"b" * (1024 * 1024)  # 1 MB
    log_path.write_bytes(huge)

    # Create many .log.N segments across two "layers" to exceed GLOBAL_CAP_BYTES
    # GLOBAL_CAP_BYTES = 200 MB; use 210 x 1MB = 210 MB worth of .log.N files
    for i in range(1, 211):
        seg = log_dir / f"sidecar.log.{i}"
        seg.write_bytes(huge)

    handler = NdjsonRollingFileHandler(log_path)
    handler._prune()
    handler.close()

    # Active .log must not be deleted
    assert log_path.exists(), "active .log must survive global cap pruning"
    # Some .log.N files must have been removed
    remaining = list(log_dir.glob("sidecar.log.*"))
    assert len(remaining) < 210, "prune must remove some .log.N files above global cap"


# ---------------------------------------------------------------------------
# NdjsonRollingFileHandler.close() calls super().close() (line 383)
# ---------------------------------------------------------------------------


def test_ndjson_handler_close_closes_open_stream(tmp_path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "sidecar.log"

    handler = NdjsonRollingFileHandler(log_path)
    # Force the stream open
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg="open stream", args=(), exc_info=None,
    )
    record.data = {}
    handler.emit(record)
    assert handler._stream is not None and not handler._stream.closed

    handler.close()
    # Stream must be closed and None after close()
    assert handler._stream is None


# ---------------------------------------------------------------------------
# configure_sidecar_logging re-entry tears down previous state (lines 410-411)
# ---------------------------------------------------------------------------


def test_configure_sidecar_logging_stops_previous_listener_on_reconfigure(tmp_path, monkeypatch) -> None:
    log_path1 = tmp_path / "logs" / "sidecar.log"
    log_path2 = tmp_path / "logs2" / "sidecar.log"
    http_loggers = [logging.getLogger(name) for name in ("httpx", "httpcore")]
    for logger in http_loggers:
        monkeypatch.setattr(logger, "level", logger.level)
    configure_sidecar_logging(log_path1)
    assert [logger.level for logger in http_loggers] == [logging.WARNING, logging.WARNING]
    # Second call must tear down the first listener without error
    configure_sidecar_logging(log_path2)
    logger = logging.getLogger("tests.sidecar.reconfigure")
    logger.info("post-reconfigure message")

    shutdown_sidecar_logging()

    # Only the second log file should exist (first was closed, second got the message)
    assert log_path2.exists()
    lines = log_path2.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert "post-reconfigure message" in payload["message"]


def test_shutdown_closes_file_handler_even_when_drain_times_out(
    tmp_path, monkeypatch
) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path)
    state = _diag_module._STATE
    assert state is not None
    real_stop = state.listener.stop
    monkeypatch.setattr(
        state.listener, "stop", lambda timeout_seconds=2.0: {"drained": False}
    )
    logging.getLogger("tests.sidecar.timeout").info("force stream open")
    # Poll for the listener to actually open the stream instead of guessing 50ms.
    # The closing assertion is `_stream is None`, so on a loaded runner where the
    # stream never opened in time this test passed without exercising anything.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and state.file_handler._stream is None:
        time.sleep(0.01)
    assert state.file_handler._stream is not None, (
        "the listener never opened the stream, so the close below proves nothing"
    )

    shutdown_sidecar_logging()

    # W2-31-F07: disposal transferred to the still-draining listener — the fd
    # is closed by the listener's own exit path once it actually stops.
    real_stop(timeout_seconds=2.0)  # actually stop the still-running listener
    assert state.file_handler._stream is None


# ---------------------------------------------------------------------------
# emit_startup_audit_mark (lines 499-530)
# ---------------------------------------------------------------------------


def test_emit_startup_audit_mark_is_suppressed_when_audit_not_enabled(tmp_path) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, log_level="debug")
    logger = logging.getLogger("tests.sidecar.audit.off")
    try:
        with patch.dict(os.environ, {"JENNY_COLD_START_AUDIT": "0"}, clear=False):
            emit_startup_audit_mark(logger, "test-mark", status="ok")
    finally:
        shutdown_sidecar_logging()

    # Suppression must short-circuit before any logging happens, so no audit
    # mark event may be present. (A bare `if exists` guard would let the assert
    # be skipped entirely in the very case it is meant to verify.)
    lines = (
        log_path.read_text("utf-8").strip().splitlines() if log_path.exists() else []
    )
    events = [json.loads(line)["event"] for line in lines if line]
    assert "startup.audit.mark" not in events
    assert lines == []


def test_emit_startup_audit_mark_is_suppressed_for_empty_mark(tmp_path) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, log_level="debug")
    logger = logging.getLogger("tests.sidecar.audit.empty")
    try:
        with patch.dict(os.environ, {"JENNY_COLD_START_AUDIT": "true"}, clear=False):
            emit_startup_audit_mark(logger, "   ", status="ok")
    finally:
        shutdown_sidecar_logging()

    # Audit is enabled but the mark is blank/whitespace, so the function must
    # still bail out before emitting. Assert unconditionally that no audit mark
    # event was written.
    lines = (
        log_path.read_text("utf-8").strip().splitlines() if log_path.exists() else []
    )
    events = [json.loads(line)["event"] for line in lines if line]
    assert "startup.audit.mark" not in events
    assert lines == []


def test_emit_startup_audit_mark_writes_mark_event_when_enabled(tmp_path) -> None:
    # Lines 510-520: full happy path
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, log_level="debug")
    logger = logging.getLogger("tests.sidecar.audit.on")
    try:
        with patch.dict(
            os.environ,
            {"JENNY_COLD_START_AUDIT": "true", "JENNY_COLD_START_AUDIT_RUN_ID": "run-xyz"},
            clear=False,
        ):
            emit_startup_audit_mark(
                logger,
                "server.ready",
                status="ok",
                duration_ms=42.0,
                data={"extra": "info"},
            )
    finally:
        shutdown_sidecar_logging()

    lines = log_path.read_text("utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["event"] == "startup.audit.mark"
    assert payload["data"]["mark"] == "server.ready"
    assert payload["data"]["audit_run_id"] == "run-xyz"
    assert "perf_counter_ms" in payload["data"]
    assert payload["data"]["extra"] == "info"
    assert payload["status"] == "ok"
    assert payload["duration_ms"] == 42.0


# ---------------------------------------------------------------------------
# build_redacted_snippet_data with sanitized_snippets mode (lines 596-607)
# ---------------------------------------------------------------------------


def test_build_redacted_snippet_data_includes_snippets_in_sanitized_mode(tmp_path) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, capture_mode="sanitized_snippets")
    try:
        data = build_redacted_snippet_data(
            prompt="Hello world",
            response="assistant says hi",
            tool_output="tool result",
        )
    finally:
        shutdown_sidecar_logging()

    assert "prompt_snippet" in data
    assert "response_snippet" in data
    assert "tool_output_snippet" in data
    assert data["prompt_snippet"] == "Hello world"
    assert data["response_snippet"] == "assistant says hi"
    assert data["tool_output_snippet"] == "tool result"
    # Hash fields must also be present
    assert "prompt_hash" in data
    assert "response_hash" in data


def test_build_redacted_snippet_data_omits_snippets_for_none_values_in_sanitized_mode(
    tmp_path,
) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, capture_mode="sanitized_snippets")
    try:
        data = build_redacted_snippet_data(prompt="only prompt")
    finally:
        shutdown_sidecar_logging()

    assert "prompt_snippet" in data
    assert "response_snippet" not in data
    assert "tool_output_snippet" not in data


def test_build_redacted_snippet_data_redacts_secrets_in_snippet(tmp_path) -> None:
    log_path = tmp_path / "logs" / "sidecar.log"
    configure_sidecar_logging(log_path, capture_mode="sanitized_snippets")
    try:
        data = build_redacted_snippet_data(prompt="Authorization: Bearer secret-token-value")
    finally:
        shutdown_sidecar_logging()

    assert "prompt_snippet" in data
    assert "secret-token-value" not in data["prompt_snippet"]
