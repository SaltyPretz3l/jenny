"""Tests for sidecar.runtime.framing — Content-Length framing helpers."""

from __future__ import annotations

import io
import json

import pytest

from sidecar.runtime.framing import (
    RecoverablePayloadError,
    TransportDesynchronizedError,
    encode_framed_body,
    read_framed_message,
    write_framed_message,
)

HEADER = "Content-Length"
MAX_BYTES = 10 * 1024 * 1024


def _make_frame(payload: dict[str, object]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    header = f"{HEADER}: {len(body)}\r\n\r\n".encode("utf-8")
    return header + body


# ── read_framed_message ──


def test_read_valid_message() -> None:
    payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize"}
    stdin = io.BytesIO(_make_frame(payload))
    result = read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    assert result == payload


def test_read_multiple_messages_sequentially() -> None:
    p1 = {"jsonrpc": "2.0", "id": 1}
    p2 = {"jsonrpc": "2.0", "id": 2}
    stdin = io.BytesIO(_make_frame(p1) + _make_frame(p2))
    r1 = read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    r2 = read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    assert r1["id"] == 1
    assert r2["id"] == 2


def test_read_missing_header_raises_value_error() -> None:
    stdin = io.BytesIO(b"X-Other: 5\r\n\r\n{}")
    with pytest.raises(ValueError, match="missing Content-Length"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_invalid_header_value_raises_value_error() -> None:
    stdin = io.BytesIO(b"Content-Length: abc\r\n\r\n")
    with pytest.raises(ValueError, match="invalid Content-Length"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_oversized_payload_raises_value_error() -> None:
    stdin = io.BytesIO(b"Content-Length: 999999999\r\n\r\n")
    with pytest.raises(ValueError, match="Content-Length out of range"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=1024,
        )


def test_oversized_frame_is_terminal_and_later_frame_is_not_consumed() -> None:
    later = _make_frame({"jsonrpc": "2.0", "id": 2, "method": "shutdown"})
    stdin = io.BytesIO(b"Content-Length: 999999999\r\n\r\n" + later)

    with pytest.raises(TransportDesynchronizedError, match="out of range"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=1024,
        )

    assert stdin.read() == later


def test_read_negative_length_raises_value_error() -> None:
    stdin = io.BytesIO(b"Content-Length: -1\r\n\r\n")
    with pytest.raises(ValueError, match="Content-Length out of range"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_closed_stdin_raises_eof_error() -> None:
    stdin = io.BytesIO(b"")
    with pytest.raises(EOFError, match="stdin closed"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_incomplete_body_raises_eof_error() -> None:
    stdin = io.BytesIO(b"Content-Length: 100\r\n\r\nshort")
    with pytest.raises(EOFError, match="incomplete payload body"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_unicode_payload() -> None:
    payload = {"text": "héllo wörld 🎉"}
    stdin = io.BytesIO(_make_frame(payload))
    result = read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    assert result["text"] == "héllo wörld 🎉"


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_read_rejects_nonfinite_json_after_consuming_the_frame(token: str) -> None:
    body = f'{{"jsonrpc":"2.0","id":1,"value":{token}}}'.encode()
    later = _make_frame({"jsonrpc": "2.0", "id": 2})
    stdin = io.BytesIO(f"Content-Length: {len(body)}\r\n\r\n".encode() + body + later)

    with pytest.raises(RecoverablePayloadError, match="non-finite"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )

    parsed = read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    assert parsed["id"] == 2


@pytest.mark.parametrize(
    ("body", "match"),
    [(b"{", "not valid JSON"), (b"[]", "expected JSON object"), (b"\xff", "invalid UTF-8")],
)
def test_fully_consumed_payload_errors_preserve_next_frame(
    body: bytes, match: str
) -> None:
    later = _make_frame({"jsonrpc": "2.0", "id": 3})
    stdin = io.BytesIO(f"Content-Length: {len(body)}\r\n\r\n".encode() + body + later)

    with pytest.raises(RecoverablePayloadError, match=match):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )

    assert read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )["id"] == 3


# A fully-consumed body leaves the stream frame-aligned, so EVERY decoder
# rejection is recoverable — including the two that are not JSONDecodeError.
# Before this guard both escaped read_framed_message raw and were cached as
# message_reader._terminal_error, permanently killing the stdin pump.


@pytest.mark.parametrize(
    ("body", "match"),
    [
        # RecursionError: derives from RuntimeError, not ValueError.
        (b'{"a": ' + b"[" * 1200 + b"]" * 1200 + b"}", "nesting is too deep"),
        # Bare ValueError: int_max_str_digits, not a JSONDecodeError.
        (b'{"a": ' + b"1" * 4400 + b"}", "could not be decoded"),
    ],
    ids=["deep-nesting", "oversized-integer"],
)
def test_undecodable_payload_is_recoverable_not_terminal(body: bytes, match: str) -> None:
    later = _make_frame({"jsonrpc": "2.0", "id": 7, "method": "shutdown"})
    stdin = io.BytesIO(f"Content-Length: {len(body)}\r\n\r\n".encode() + body + later)

    with pytest.raises(RecoverablePayloadError, match=match):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )

    # The stream stayed in sync: the next frame parses normally.
    assert read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )["id"] == 7


# Header guard regressions


def test_read_rejects_oversized_header_line() -> None:
    stdin = io.BytesIO(b"X-Test: " + (b"x" * 8193) + b"\r\n\r\n")

    with pytest.raises(ValueError, match="header line too large"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_rejects_too_many_headers() -> None:
    payload = {"jsonrpc": "2.0", "id": 1}
    body = json.dumps(payload).encode("utf-8")
    headers = b"".join(f"X-Test-{index}: value\r\n".encode("utf-8") for index in range(33))
    stdin = io.BytesIO(headers + f"{HEADER}: {len(body)}\r\n\r\n".encode("utf-8") + body)

    with pytest.raises(ValueError, match="too many headers"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_rejects_total_header_bytes_over_cap() -> None:
    payload = {"jsonrpc": "2.0", "id": 1}
    body = json.dumps(payload).encode("utf-8")
    headers = b"".join(f"X-Test-{index}: {'x' * 120}\r\n".encode("utf-8") for index in range(10))
    stdin = io.BytesIO(headers + f"{HEADER}: {len(body)}\r\n\r\n".encode("utf-8") + body)

    with pytest.raises(ValueError, match="headers too large"):
        read_framed_message(
            stdin_buffer=stdin,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
            max_total_header_bytes=1024,
        )


def test_read_accepts_valid_headers_near_caps() -> None:
    payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize"}
    body = json.dumps(payload).encode("utf-8")
    headers = (
        b"X-Test-A: value\r\n"
        b"X-Test-B: value\r\n"
        + f"{HEADER}: {len(body)}\r\n\r\n".encode("utf-8")
    )
    stdin = io.BytesIO(headers + body)

    result = read_framed_message(
        stdin_buffer=stdin,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
        max_header_count=3,
        max_total_header_bytes=len(headers),
    )

    assert result == payload


# write_framed_message


def test_write_produces_valid_frame() -> None:
    stdout = io.BytesIO()
    payload = {"jsonrpc": "2.0", "id": 42, "result": {"ok": True}}
    write_framed_message(
        stdout_buffer=stdout,
        content_length_header=HEADER,
        message=payload,
    )
    raw = stdout.getvalue()
    header_part, body_part = raw.split(b"\r\n\r\n", 1)
    assert header_part.startswith(b"Content-Length: ")
    length = int(header_part.split(b": ", 1)[1])
    assert len(body_part) == length
    parsed = json.loads(body_part.decode("utf-8"))
    assert parsed == payload


def test_write_unicode_message() -> None:
    stdout = io.BytesIO()
    payload = {"text": "日本語テスト"}
    write_framed_message(
        stdout_buffer=stdout,
        content_length_header=HEADER,
        message=payload,
    )
    raw = stdout.getvalue()
    _, body_part = raw.split(b"\r\n\r\n", 1)
    parsed = json.loads(body_part.decode("utf-8"))
    assert parsed["text"] == "日本語テスト"


# ── round-trip ──


def test_write_then_read_round_trip() -> None:
    payload = {"jsonrpc": "2.0", "id": 99, "params": {"nested": [1, 2, 3]}}
    buf = io.BytesIO()
    write_framed_message(
        stdout_buffer=buf,
        content_length_header=HEADER,
        message=payload,
    )
    buf.seek(0)
    result = read_framed_message(
        stdin_buffer=buf,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    assert result == payload


def test_write_message_with_surrogates_does_not_crash() -> None:
    """Surrogate codepoints in message values must not crash the framing layer."""
    stdout = io.BytesIO()
    payload = {"text": "hello\udc8fworld"}
    write_framed_message(
        stdout_buffer=stdout,
        content_length_header=HEADER,
        message=payload,
    )
    raw = stdout.getvalue()
    _, body_part = raw.split(b"\r\n\r\n", 1)
    parsed = json.loads(body_part.decode("utf-8"))
    assert "hello" in parsed["text"]
    assert "world" in parsed["text"]
    for ch in parsed["text"]:
        assert not (0xD800 <= ord(ch) <= 0xDFFF), f"surrogate found: {ch!r}"


def test_read_mixed_newlines_in_headers() -> None:
    # Verify we accept both \r\n and \n in header lines
    raw = b"Content-Length: 18\nContent-Type: application/json\r\n\r\n{\"jsonrpc\": \"2.0\"}"
    buf = io.BytesIO(raw)
    result = read_framed_message(
        stdin_buffer=buf,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    assert result == {"jsonrpc": "2.0"}


def test_read_sudden_eof_mid_header() -> None:
    # EOF mid-line (without \n) raises ValueError
    raw = b"Content-Length: 18"
    buf = io.BytesIO(raw)
    with pytest.raises(ValueError, match="header line too large"):
        read_framed_message(
            stdin_buffer=buf,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_sudden_eof_after_headers_before_body() -> None:
    # EOF after headers before body is read raises EOFError
    raw = b"Content-Length: 18\r\n\r\n{\"j"
    buf = io.BytesIO(raw)
    with pytest.raises(EOFError, match="incomplete payload body"):
        read_framed_message(
            stdin_buffer=buf,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


def test_read_boundary_payload_sizes() -> None:
    # Boundary tests for payload limits
    # Payload equal to max_content_length_bytes should be read successfully
    body = b'{"x":"' + b'y' * (MAX_BYTES - 9) + b'"}'
    raw = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body
    buf = io.BytesIO(raw)
    result = read_framed_message(
        stdin_buffer=buf,
        content_length_header=HEADER,
        max_content_length_bytes=MAX_BYTES,
    )
    assert len(result["x"]) == MAX_BYTES - 9

    # Payload above max_content_length_bytes raises ValueError
    raw_too_large = f"Content-Length: {MAX_BYTES + 1}\r\n\r\n".encode("ascii")
    buf = io.BytesIO(raw_too_large)
    with pytest.raises(ValueError, match="Content-Length out of range"):
        read_framed_message(
            stdin_buffer=buf,
            content_length_header=HEADER,
            max_content_length_bytes=MAX_BYTES,
        )


# ── CTL-011: the framing boundary must never emit non-finite JSON tokens ──


def _reject_constant(value: str) -> None:
    raise AssertionError(f"wire body contains non-standard JSON token: {value}")


def test_encode_framed_body_never_emits_nonfinite_tokens() -> None:
    body = encode_framed_body(
        {
            "jsonrpc": "2.0",
            "method": "chat.thinking",
            "params": {
                "tokens_per_second": float("nan"),
                "nested": {"rate": float("inf")},
                "list": [float("-inf"), 1.5],
            },
        }
    )
    # parse_constant fires only on NaN/Infinity/-Infinity — exactly the tokens
    # JavaScript's JSON.parse rejects. A valid body parses without touching it.
    message = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
    # Non-finite values degrade to null (omission-equivalent), finite survive.
    assert message["params"]["tokens_per_second"] is None
    assert message["params"]["nested"]["rate"] is None
    assert message["params"]["list"] == [None, 1.5]


def test_encode_framed_body_repairs_nonfinite_dict_keys() -> None:
    # A non-finite float dict KEY is also rejected by allow_nan=False, so the
    # repair pass must fix keys too — otherwise the fallback dumps raises an
    # uncaught ValueError and the transport tears down (the CTL-011 class).
    body = encode_framed_body(
        {
            "jsonrpc": "2.0",
            "method": "chat.thinking",
            "params": {"by_bucket": {float("nan"): 1, 2.5: "ok"}},
        }
    )
    message = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
    # The non-finite key degrades to "null"; the finite float key keeps its repr.
    assert message["params"]["by_bucket"] == {"null": 1, "2.5": "ok"}


def test_write_framed_message_with_nonfinite_value_stays_parseable() -> None:
    stdout = io.BytesIO()
    write_framed_message(
        stdout_buffer=stdout,
        content_length_header=HEADER,
        message={"jsonrpc": "2.0", "method": "x", "params": {"rate": float("nan")}},
    )
    raw = stdout.getvalue()
    header, _, body = raw.partition(b"\r\n\r\n")
    declared = int(header.decode("utf-8").split(":")[1].strip())
    assert declared == len(body), "Content-Length must match the emitted body"
    message = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
    assert message["params"]["rate"] is None
