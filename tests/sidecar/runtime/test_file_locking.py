from __future__ import annotations

import pytest
from filelock import FileLock

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.file_locking import acquire_file_lock, acquire_regenerable_file_lock


def test_acquire_file_lock_raises_retryable_tool_failure_on_timeout(tmp_path) -> None:
    target_path = tmp_path / "memory.md"
    lock = FileLock(str(target_path.with_name(f"{target_path.name}.lock")))

    with lock.acquire(timeout=1):
        with pytest.raises(ToolExecutionFailure) as exc_info:
            with acquire_file_lock(target_path, timeout_seconds=0.01):
                raise AssertionError("lock should not be acquired")

    assert exc_info.value.code == CMP_TOOL_IO_FAILED
    assert exc_info.value.retryable is True
    assert "timed out waiting for file lock" in str(exc_info.value)


def test_acquire_regenerable_file_lock_reports_graceful_skip_on_timeout(tmp_path) -> None:
    target_path = tmp_path / "session-note.md"
    lock = FileLock(str(target_path.with_name(f"{target_path.name}.lock")))

    with lock.acquire(timeout=1):
        with acquire_regenerable_file_lock(target_path, timeout_seconds=0.01) as attempt:
            assert attempt.acquired is False
            assert "timed out waiting for file lock" in attempt.reason
