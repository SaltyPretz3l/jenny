"""Mid-turn background-job notices: ``session.job_settled`` parks jobs on the live turn."""

from __future__ import annotations

import logging
import queue
from typing import Any

import pytest

from sidecar.runtime.multiplexer import StdioTransportMultiplexer
from sidecar.runtime.turn_job_notices import (
    MAX_PENDING_JOB_NOTICES,
    PendingJobNoticeQueue,
    bind_pending_job_notices,
    current_pending_job_notices,
    sanitize_job_command,
)

_LOGGER = "tests.multiplexer.job_settled"


def _job_id(n: int) -> str:
    return f"{n:012x}"


def job(n: int, **overrides: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "job_id": _job_id(n),
        "command": f"npm test {n}",
        "state": "failed",
        "exit_code": 1,
    }
    entry.update(overrides)
    return entry


def _reader(items: "queue.Queue[dict[str, object]]"):
    def _read() -> dict[str, object]:
        return items.get(timeout=1.0)

    return _read


@pytest.fixture
def transport():
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger(_LOGGER),
    )
    handle = multiplexer.register_turn(
        request_id="req-job", trace_id=None, session_id="session-job"
    )

    def deliver(params: object, *, next_id: int = 900) -> None:
        incoming.put({"jsonrpc": "2.0", "method": "session.job_settled", "params": params})
        incoming.put({"jsonrpc": "2.0", "id": next_id, "method": "initialize", "params": {}})
        routed = multiplexer.read_request()
        assert routed["method"] == "initialize", "the notification is consumed, never dispatched"

    try:
        yield handle, deliver
    finally:
        multiplexer.close()


def _events(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [getattr(record, "event", "") for record in caplog.records if record.name == _LOGGER]


def _frame(jobs: object) -> dict[str, object]:
    return {"session_id": "session-job", "request_id": "req-job", "jobs": jobs}


def test_valid_notification_parks_jobs_on_the_registered_turn(transport, caplog) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver(_frame([job(1), job(2, state="completed", exit_code=None)]))

    drained = handle.pending_job_notices.drain()
    assert [entry["job_id"] for entry in drained] == [_job_id(1), _job_id(2)]
    assert drained[0] == {"job_id": _job_id(1), "command": "npm test 1", "state": "failed", "exit_code": 1}
    assert drained[1]["exit_code"] is None
    assert handle.pending_job_notices.drain() == []
    assert "sidecar.runtime.job_settled" in _events(caplog)
    assert all("npm test" not in record.getMessage() for record in caplog.records)
    assert all("npm test" not in str(getattr(record, "__dict__", "")) for record in caplog.records)


def test_stale_request_id_or_session_is_ignored(transport, caplog) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver({"session_id": "session-job", "request_id": "req-older", "jobs": [job(1)]})
    deliver({"session_id": "session-other", "request_id": "req-job", "jobs": [job(2)]}, next_id=901)

    assert handle.pending_job_notices.drain() == []
    assert _events(caplog).count("sidecar.runtime.job_settled.stale") == 2


@pytest.mark.parametrize(
    "params",
    [
        {"request_id": "req-job", "jobs": []},
        {"session_id": "", "request_id": "req-job", "jobs": []},
        {"session_id": "session-job", "request_id": 7, "jobs": []},
        {"session_id": "session-job", "request_id": "req-job", "jobs": "job"},
        {"session_id": "session-job", "request_id": "req-job"},
    ],
)
def test_malformed_params_are_ignored(transport, caplog, params) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver(params)

    assert handle.pending_job_notices.drain() == []
    assert "sidecar.runtime.job_settled.invalid" in _events(caplog)


def test_invalid_entries_are_dropped_and_valid_ones_kept(transport, caplog) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver(
        _frame(
            [
                job(1, job_id=_job_id(1) + "\n"),  # a trailing newline is not a job id
                job(2, job_id="ABCDEF012345"),
                job(3, state="running"),
                job(4, exit_code="1"),
                job(5, exit_code=True),
                job(6, command=None),
                "not a dict",
                job(7),
            ]
        )
    )

    assert [entry["job_id"] for entry in handle.pending_job_notices.drain()] == [_job_id(7)]
    dropped = [r for r in caplog.records if getattr(r, "event", "") == "sidecar.runtime.job_settled.dropped"]
    assert [r.count for r in dropped] == [7]


def test_only_the_first_eight_jobs_of_a_frame_are_read(transport) -> None:
    handle, deliver = transport
    deliver(_frame([job(n) for n in range(1, 13)]))

    assert [entry["job_id"] for entry in handle.pending_job_notices.drain()] == [_job_id(n) for n in range(1, 9)]


def test_the_seventeenth_job_is_dropped_by_the_per_turn_bound(transport) -> None:
    handle, deliver = transport
    deliver(_frame([job(n) for n in range(1, 9)]))
    deliver(_frame([job(n) for n in range(9, 17)]), next_id=901)
    assert len(handle.pending_job_notices.drain()) == 16  # a drain does not reset the bound
    deliver(_frame([job(17), job(1)]), next_id=902)

    assert handle.pending_job_notices.drain() == []
    assert MAX_PENDING_JOB_NOTICES == 16


def test_queue_accepts_a_job_id_once_per_turn() -> None:
    pending = PendingJobNoticeQueue()
    first = {"job_id": _job_id(1), "command": "a", "state": "completed", "exit_code": 0}
    assert pending.push([first, dict(first)]) == ([_job_id(1)], 1)
    assert pending.drain() == [first]
    assert pending.push([dict(first)]) == ([], 1), "a drained id is still remembered"


def test_command_is_sanitized_and_clipped() -> None:
    assert sanitize_job_command("echo `id`\n\tdone\u202e\u200b  now\u2028x") == "echo id done now x"
    long = sanitize_job_command("x" * 500)
    assert len(long) == 120
    assert long == "x" * 119 + "…"
    assert sanitize_job_command("y" * 120) == "y" * 120


def test_admitted_command_is_sanitized(transport) -> None:
    handle, deliver = transport
    deliver(_frame([job(1, command="echo `whoami`\r\nrm -rf /")]))

    assert handle.pending_job_notices.drain()[0]["command"] == "echo whoami rm -rf /"


def test_pending_job_notice_binding_is_scoped() -> None:
    pending = PendingJobNoticeQueue()
    assert current_pending_job_notices() is None
    with bind_pending_job_notices(pending):
        assert current_pending_job_notices() is pending
    assert current_pending_job_notices() is None
