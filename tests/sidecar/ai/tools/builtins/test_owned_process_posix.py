"""POSIX launch preflight and supervisor-report helpers split out of ``owned_process``."""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar._owned_process_supervisor import (
    LINEAGE_CONTAINMENT,
    PROOF_BYTE,
    SAMPLED_PROOF_BYTE,
    SUBREAPER_CONTAINMENT,
)
from sidecar.ai.tools.builtins.owned_process import OwnedProcessService
from sidecar.ai.tools.builtins.owned_process_posix import (
    await_supervisor_ready,
    preflight_posix_target,
    read_supervisor_report,
    supervisor_proved_cleanup,
)
from tests.sidecar._platform_skips import posix_only


def _owned(report: bytes = b"", ready_fd: int | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        containment="initial",
        _supervisor_ready_fd=ready_fd,
        _supervisor_report=report,
        _supervisor_ready_lock=threading.Lock(),
    )


def test_preflight_refuses_a_missing_working_directory(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        preflight_posix_target([sys.executable], tmp_path / "absent", None)


def test_preflight_refuses_a_program_that_is_not_on_path(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError) as raised:
        preflight_posix_target(["jenny-no-such-program-xyz"], tmp_path, {"PATH": str(tmp_path)})
    assert raised.value.filename == "jenny-no-such-program-xyz"


def test_preflight_accepts_an_existing_absolute_program(tmp_path: Path) -> None:
    preflight_posix_target([sys.executable], tmp_path, None)


@pytest.mark.parametrize(
    ("report", "proved", "containment"),
    [
        (PROOF_BYTE, True, SUBREAPER_CONTAINMENT),
        (SAMPLED_PROOF_BYTE, True, LINEAGE_CONTAINMENT),
        (b"", False, "initial"),
    ],
)
def test_supervisor_proof_names_the_mechanism_it_used(
    report: bytes, proved: bool, containment: str
) -> None:
    owned = _owned(report)

    assert supervisor_proved_cleanup(owned) is proved
    assert owned.containment == containment


def test_ready_wait_without_a_report_pipe_returns_at_once() -> None:
    owned = _owned()

    await_supervisor_ready(owned, 5.0)

    assert owned._supervisor_report == b""


@posix_only("supervisor report pipe")
def test_report_reader_collects_bytes_and_closes_at_eof() -> None:
    read_fd, write_fd = os.pipe()
    os.write(write_fd, PROOF_BYTE)
    os.close(write_fd)
    owned = _owned(ready_fd=read_fd)

    read_supervisor_report(owned, 1.0)

    assert owned._supervisor_report == PROOF_BYTE
    assert owned._supervisor_ready_fd is None


def test_owned_process_keeps_its_preflight_seam(tmp_path: Path) -> None:
    # The service delegates lazily (startup import budget) but keeps the seam's
    # contract: the same checks, the same errors.
    seam = OwnedProcessService._preflight_posix_target
    seam([sys.executable], tmp_path, None)
    with pytest.raises(FileNotFoundError):
        seam([sys.executable], tmp_path / "absent", None)
