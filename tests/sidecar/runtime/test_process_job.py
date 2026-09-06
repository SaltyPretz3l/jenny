from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.runtime import process_job as process_job_module
from sidecar.runtime.process_containment import WindowsJobContainment
from sidecar.runtime.process_job import WindowsJobObject


def _job_with_query(query, *, last_error: int) -> WindowsJobObject:
    job = object.__new__(WindowsJobObject)
    job._handle = 1  # noqa: SLF001
    job._kernel32 = SimpleNamespace(  # noqa: SLF001
        QueryInformationJobObject=query,
        GetLastError=lambda: last_error,
    )
    return job


def test_assigned_process_ids_raises_when_query_fails_unexpectedly() -> None:
    job = _job_with_query(lambda *args: 0, last_error=5)

    with pytest.raises(OSError, match="QueryInformationJobObject failed with error 5"):
        job.assigned_process_ids()


def test_assigned_process_ids_capacity_exhaustion_keeps_containment_nonempty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(process_job_module, "_PROCESS_ID_LIST_CAPACITY", 1)
    monkeypatch.setattr(process_job_module, "_PROCESS_ID_LIST_MAX_CAPACITY", 2)
    job = _job_with_query(lambda *args: 0, last_error=234)
    containment = WindowsJobContainment(job)
    containment._pid = 4242  # noqa: SLF001

    assert containment.is_empty() is False
