"""WIDE-011 regression gate: canonical job-ID validation and bounded,
schema-checked status reads for the background-job tools.

``check_background_job_tool`` (shell.py) previously accepted any nonempty
string as ``job_id`` and joined it into a raw path (``_job_dir`` in
shell_background.py), so traversal (``..``), absolute drive/UNC paths (which
DISCARD the left operand on a Windows ``Path.join``), separators, and
symlinked job directories could read a status.json outside the workspace.
``read_background_job`` also had no byte cap and no top-level-type check, so
a scalar/list JSON body crashed ``status.get("state")`` with AttributeError.

This module asserts: (1) only canonical ``^[0-9a-f]{12}$`` IDs are accepted,
everything else is a typed soft failure naming the expected format; (2) the
job directory is read through ``GuardedWorkspaceStore`` beneath its verified
``tool-results`` namespace, so a symlinked/junctioned job dir cannot redirect
reads outside the workspace; (3) the
status.json read is capped at 256 KiB and its parsed JSON must be a dict —
oversized/scalar/list/malformed content is a typed soft failure, never a
crash.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_BACKGROUND_NOT_FOUND,
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_INVALID_PATH,
)
from sidecar.ai.tools.builtins import shell_background as shell_background_module
from sidecar.ai.tools.builtins import shell_background_status as shell_background_status_module
from sidecar.ai.tools.builtins.shell import check_background_job_tool
from sidecar.ai.tools.builtins.shell_background import is_valid_job_id, read_background_job
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

VALID_ID = "0123456789ab"


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _write_status(tmp_path: Path, job_id: str, payload: object) -> Path:
    jdir = tmp_path / ".jenny" / "tool-results" / job_id
    jdir.mkdir(parents=True)
    status_file = jdir / "status.json"
    if isinstance(payload, str):
        status_file.write_text(payload, encoding="utf-8")
    else:
        status_file.write_text(json.dumps(payload), encoding="utf-8")
    return status_file


def _completed_status(**overrides: object) -> dict[str, object]:
    status: dict[str, object] = {
        "schema_version": 1,
        "job_id": VALID_ID,
        "state": "completed",
        "exit_code": 0,
        "stdout": "ok",
        "stderr": "",
    }
    status.update(overrides)
    return status


def _can_create_symlink(tmp_path: Path) -> bool:
    src = tmp_path / "_probe_src"
    dst = tmp_path / "_probe_dst"
    src.write_text("x", encoding="utf-8")
    try:
        os.symlink(src, dst)
    except (OSError, NotImplementedError):
        return False
    finally:
        if dst.exists() or dst.is_symlink():
            try:
                dst.unlink()
            except OSError:
                pass
        if src.exists():
            src.unlink()
    return True


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


# ── Canonical format validation ────────────────────────────────────────


def test_is_valid_job_id_accepts_canonical_form() -> None:
    assert is_valid_job_id(VALID_ID) is True


@pytest.mark.parametrize(
    "job_id",
    [
        "../../evil",
        "C:\\evil",
        "\\\\server\\share",
        "a/b",
        "a\\b",
        "test123",
        "nonexistent",
        "",
        "0123456789ABCD",  # too long / uppercase
        "0123456789a",  # too short
        "0123456789az",  # non-hex char
        " 0123456789ab",
        "0123456789ab ",
        "0123456789ab\n",
    ],
)
def test_is_valid_job_id_rejects_noncanonical_form(job_id: str) -> None:
    assert is_valid_job_id(job_id) is False


def test_check_background_job_valid_id_reads_status(tmp_path: Path) -> None:
    _write_status(
        tmp_path,
        VALID_ID,
        {"job_id": VALID_ID, "state": "completed", "exit_code": 0, "stdout": "ok", "stderr": ""},
    )
    result = check_background_job_tool({"job_id": VALID_ID}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["state"] == "completed"
    assert body["schema_version"] == 0
    assert result.success is True


@pytest.mark.parametrize(
    "job_id",
    ["../../evil", "C:\\evil", "\\\\server\\share", "a/b", "a\\b"],
)
def test_check_background_job_rejects_hostile_ids_without_crashing(
    tmp_path: Path, job_id: str
) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        check_background_job_tool({"job_id": job_id}, _guard(tmp_path))
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH
    assert "12 lowercase hex characters" in excinfo.value.message


def test_check_background_job_rejects_hostile_id_does_not_touch_outside_file(
    tmp_path: Path,
) -> None:
    outside_dir = tmp_path.parent / f"{tmp_path.name}_outside_sentinel"
    outside_dir.mkdir(exist_ok=True)
    sentinel = outside_dir / "secret.txt"
    sentinel.write_text("do-not-touch", encoding="utf-8")
    try:
        with pytest.raises(ToolExecutionFailure):
            check_background_job_tool(
                {"job_id": f"..\\{outside_dir.name}\\secret.txt"}, _guard(tmp_path)
            )
        assert sentinel.read_text(encoding="utf-8") == "do-not-touch"
    finally:
        sentinel.unlink()
        outside_dir.rmdir()


# ── Symlinked / junctioned job directory ────────────────────────────────


def test_check_background_job_rejects_symlinked_job_dir_posix(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("posix symlink path; see junction variant for Windows")
    if not _can_create_symlink(tmp_path):
        pytest.skip("symlink creation not permitted in this environment")

    outside = tmp_path.parent / f"{tmp_path.name}_outside"
    outside.mkdir(exist_ok=True)
    sentinel = outside / "status.json"
    sentinel.write_text(json.dumps({"job_id": VALID_ID, "state": "completed"}), encoding="utf-8")

    results_dir = tmp_path / ".jenny" / "tool-results"
    results_dir.mkdir(parents=True)
    link = results_dir / VALID_ID
    os.symlink(outside, link)

    try:
        with pytest.raises(ToolExecutionFailure) as excinfo:
            check_background_job_tool({"job_id": VALID_ID}, _guard(tmp_path))
        assert excinfo.value.code == CMP_TOOL_BACKGROUND_NOT_FOUND
        assert sentinel.read_text(encoding="utf-8") == json.dumps(
            {"job_id": VALID_ID, "state": "completed"}
        )
    finally:
        sentinel.unlink()
        outside.rmdir()


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_check_background_job_rejects_junctioned_job_dir_windows(tmp_path: Path) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}_outside"
    outside.mkdir(exist_ok=True)
    sentinel = outside / "status.json"
    sentinel.write_text(json.dumps({"job_id": VALID_ID, "state": "completed"}), encoding="utf-8")

    results_dir = tmp_path / ".jenny" / "tool-results"
    results_dir.mkdir(parents=True)
    link = results_dir / VALID_ID

    if not _make_junction(link, outside):
        sentinel.unlink()
        outside.rmdir()
        pytest.skip("mklink /J not permitted in this environment")

    try:
        with pytest.raises(ToolExecutionFailure) as excinfo:
            check_background_job_tool({"job_id": VALID_ID}, _guard(tmp_path))
        assert excinfo.value.code == CMP_TOOL_BACKGROUND_NOT_FOUND
        assert sentinel.read_text(encoding="utf-8") == json.dumps(
            {"job_id": VALID_ID, "state": "completed"}
        )
        quarantine = tmp_path / ".jenny" / "quarantine"
        quarantined = [entry for entry in quarantine.iterdir() if VALID_ID in entry.name]
        assert len(quarantined) == 1
    finally:
        if link.exists():
            os.rmdir(link)
        for entry in (tmp_path / ".jenny" / "quarantine").iterdir():
            if VALID_ID in entry.name:
                os.rmdir(entry)
        sentinel.unlink()
        outside.rmdir()


# ── Oversized / malformed status.json ────────────────────────────────────


def test_check_background_job_oversized_status_file_is_typed_failure(tmp_path: Path) -> None:
    jdir = tmp_path / ".jenny" / "tool-results" / VALID_ID
    jdir.mkdir(parents=True)
    # > 256 KiB of padding inside an otherwise-valid JSON string value.
    oversized_payload = json.dumps({"job_id": VALID_ID, "state": "completed", "stdout": "x" * (262_144 + 10)})
    (jdir / "status.json").write_text(oversized_payload, encoding="utf-8")

    result = check_background_job_tool({"job_id": VALID_ID}, _guard(tmp_path))
    assert result.success is False
    body = json.loads(result.output)
    assert body["state"] != "completed"
    assert "error" in body


@pytest.mark.parametrize(
    "raw",
    [
        "42",  # scalar
        "[]",  # list
        "{nope",  # malformed
        "9" * 5_000,  # Python 3.11 integer digit-limit ValueError
        "[" * 1_100 + "]" * 1_100,  # parser recursion limit
    ],
)
def test_check_background_job_non_dict_or_malformed_json_is_typed_failure_not_crash(
    tmp_path: Path, raw: str
) -> None:
    _write_status(tmp_path, VALID_ID, raw)

    result = check_background_job_tool({"job_id": VALID_ID}, _guard(tmp_path))
    assert result.success is False
    body = json.loads(result.output)
    assert body["job_id"] == VALID_ID
    assert "error" in body


def test_read_background_job_accepts_and_sanitizes_versioned_running_status(
    tmp_path: Path,
) -> None:
    _write_status(
        tmp_path,
        VALID_ID,
        {
            "schema_version": 1,
            "job_id": VALID_ID,
            "state": "running",
            "pid": 42,
        },
    )

    assert read_background_job(tmp_path, VALID_ID) == {
        "schema_version": 1,
        "job_id": VALID_ID,
        "state": "running",
        "pid": 42,
    }


@pytest.mark.parametrize("duplicate_field", ["schema_version", "job_id", "state"])
def test_read_background_job_rejects_duplicate_json_fields(
    tmp_path: Path,
    duplicate_field: str,
) -> None:
    raw = (
        '{"schema_version":1,"job_id":"0123456789ab","state":"completed",'
        '"exit_code":0,"stdout":"ok","stderr":"",'
        f'"{duplicate_field}":"attacker"}}'
    )
    _write_status(tmp_path, VALID_ID, raw)

    result = read_background_job(tmp_path, VALID_ID)

    assert result["reason_code"] == "duplicate_field"
    assert "attacker" not in json.dumps(result)


def test_read_background_job_accepts_windows_unsigned_process_exit_code(
    tmp_path: Path,
) -> None:
    _write_status(
        tmp_path,
        VALID_ID,
        _completed_status(state="failed", exit_code=0xC000013A),
    )

    result = read_background_job(tmp_path, VALID_ID)

    assert result["state"] == "failed"
    assert result["exit_code"] == 0xC000013A


@pytest.mark.parametrize(
    ("payload", "reason_code"),
    [
        (_completed_status(schema_version=True), "invalid_schema_version"),
        (_completed_status(schema_version=2), "unsupported_schema_version"),
        (_completed_status(job_id="ffffffffffff"), "job_id_mismatch"),
        (_completed_status(state="paused"), "invalid_state"),
        (
            {"schema_version": 1, "job_id": VALID_ID, "state": "running", "pid": 0},
            "invalid_pid",
        ),
        (_completed_status(exit_code=True), "invalid_exit_code"),
        (_completed_status(exit_code=2**32), "invalid_exit_code"),
        (_completed_status(exit_code=1), "inconsistent_terminal_state"),
        (_completed_status(state="failed", exit_code=0), "inconsistent_terminal_state"),
        (_completed_status(error="impossible"), "inconsistent_terminal_state"),
        (_completed_status(stdout="x" * 20_016), "invalid_stdout"),
        (
            _completed_status(state="failed", exit_code=1, error="x" * 2_049),
            "invalid_error",
        ),
        (_completed_status(output_truncated=1), "invalid_output_flag"),
        (_completed_status(full_output_complete=True), "inconsistent_output_metadata"),
        (
            _completed_status(
                output_counters={
                    "stdout_bytes": 10,
                    "stderr_bytes": 0,
                    "captured_bytes": 10,
                    "discarded_bytes": 1,
                }
            ),
            "inconsistent_output_counters",
        ),
        (
            _completed_status(
                output_counters={
                    "stdout_bytes": 10,
                    "stderr_bytes": 0,
                    "captured_bytes": True,
                    "discarded_bytes": 0,
                }
            ),
            "invalid_output_counters",
        ),
        (
            {
                "schema_version": 1,
                "job_id": VALID_ID,
                "state": "completed",
                "exit_code": 0,
                "stdout": "ok",
            },
            "missing_field",
        ),
        (_completed_status(attacker="secret"), "unexpected_field"),
        (_completed_status(pid=42), "unexpected_field"),
    ],
)
def test_read_background_job_rejects_tampered_versioned_status_without_rewrite(
    tmp_path: Path,
    payload: dict[str, object],
    reason_code: str,
) -> None:
    status_file = _write_status(tmp_path, VALID_ID, payload)
    before = status_file.read_bytes()

    result = read_background_job(tmp_path, VALID_ID)

    assert result["state"] == "unknown"
    assert result["reason_code"] == reason_code
    assert status_file.read_bytes() == before
    assert "attacker" not in result


def test_read_background_job_rejects_forged_output_path_without_touching_target(
    tmp_path: Path,
) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside-output.txt"
    outside.write_text("do-not-touch", encoding="utf-8")
    status_file = _write_status(
        tmp_path,
        VALID_ID,
        _completed_status(full_output_path=str(outside.resolve())),
    )
    before = status_file.read_bytes()
    try:
        result = read_background_job(tmp_path, VALID_ID)

        assert result["reason_code"] == "invalid_full_output_path"
        assert "full_output_path" not in result
        assert str(outside) not in json.dumps(result)
        assert status_file.read_bytes() == before
        assert outside.read_text(encoding="utf-8") == "do-not-touch"
    finally:
        outside.unlink(missing_ok=True)


def test_read_background_job_rejects_noncanonical_alias_of_expected_output_path(
    tmp_path: Path,
) -> None:
    expected = tmp_path / ".jenny" / "tool-results" / VALID_ID / "output.txt"
    aliased = expected.parent / "unused" / ".." / expected.name
    _write_status(
        tmp_path,
        VALID_ID,
        _completed_status(full_output_path=os.fspath(aliased.absolute())),
    )

    result = read_background_job(tmp_path, VALID_ID)

    assert result["reason_code"] == "invalid_full_output_path"
    assert "full_output_path" not in result


def test_read_background_job_returns_only_the_trusted_canonical_output_path(
    tmp_path: Path,
) -> None:
    expected = (tmp_path / ".jenny" / "tool-results" / VALID_ID / "output.txt").absolute()
    _write_status(
        tmp_path,
        VALID_ID,
        _completed_status(full_output_path=os.fspath(expected)),
    )

    result = read_background_job(tmp_path, VALID_ID)

    assert result["full_output_path"] == os.path.abspath(expected)


def test_status_rejection_diagnostic_is_bounded_and_redacted(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: list[dict[str, object]] = []
    secret = "do-not-log-this-value"

    def _capture_log_event(*_args: object, **kwargs: object) -> None:
        captured.append(kwargs)

    monkeypatch.setattr(shell_background_status_module, "log_event", _capture_log_event)
    _write_status(tmp_path, VALID_ID, _completed_status(attacker=secret))

    result = read_background_job(tmp_path, VALID_ID)

    assert result["reason_code"] == "unexpected_field"
    assert secret not in json.dumps(result)
    assert captured == [
        {
            "component": "ai.tools.shell_background",
            "event": "ai.tools.shell_background.status_rejected",
            "message": "Background job status was rejected.",
            "data": {"reason_code": "unexpected_field", "schema_version": 1},
        }
    ]


def test_huge_schema_version_is_rejected_without_echoing_unbounded_digits(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: list[dict[str, object]] = []

    def _capture_log_event(*_args: object, **kwargs: object) -> None:
        captured.append(kwargs)

    monkeypatch.setattr(shell_background_status_module, "log_event", _capture_log_event)
    huge_schema = int("9" * 4_000)
    _write_status(tmp_path, VALID_ID, _completed_status(schema_version=huge_schema))

    result = read_background_job(tmp_path, VALID_ID)

    assert result["reason_code"] == "invalid_schema_version"
    assert "schema_version" not in result
    assert len(json.dumps(result)) < 512
    assert captured[0]["data"] == {"reason_code": "invalid_schema_version"}


def test_invalid_job_id_error_is_bounded_and_does_not_echo_model_input(
    tmp_path: Path,
) -> None:
    attacker_value = "A\n" + "x" * 100_000

    with pytest.raises(ToolExecutionFailure) as excinfo:
        check_background_job_tool({"job_id": attacker_value}, _guard(tmp_path))

    assert len(excinfo.value.message) < 128
    assert attacker_value not in excinfo.value.message
    direct = read_background_job(tmp_path, attacker_value)
    assert direct["job_id"] == ""
    assert len(json.dumps(direct)) < 256


def test_status_cap_failure_uses_error_code_not_message_text(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    def _fail_read(*_args: object, **_kwargs: object) -> bytes:
        raise ToolExecutionFailure(
            code=CMP_TOOL_CAP_EXCEEDED,
            message="message wording intentionally changed",
            retryable=False,
        )

    monkeypatch.setattr(
        shell_background_module.GuardedWorkspaceStore,
        "read_bytes",
        _fail_read,
    )

    result = read_background_job(tmp_path, VALID_ID)

    assert result["reason_code"] == "status_too_large"


def test_status_file_at_exact_byte_cap_is_accepted(tmp_path: Path) -> None:
    status_file = _write_status(tmp_path, VALID_ID, _completed_status())
    raw = json.dumps(_completed_status(), separators=(",", ":")).encode("utf-8")
    raw += b" " * (shell_background_status_module.MAX_STATUS_FILE_BYTES - len(raw))
    status_file.write_bytes(raw)

    result = read_background_job(tmp_path, VALID_ID)

    assert result["state"] == "completed"
    assert result["job_id"] == VALID_ID
