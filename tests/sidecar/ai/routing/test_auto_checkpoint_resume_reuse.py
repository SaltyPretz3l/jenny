"""An approval resume reuses the turn's earlier checkpoint instead of creating another.

Every approved call in Ask mode rebuilds the run with ``checkpoint_created=False``;
before this, each resume asked Electron for a fresh git ref (9 refs in one turn
on 2026-10-31). The first checkpoint of a turn still happens.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.routing import auto_checkpoint as _auto_ckpt
from sidecar.ai.routing.loop_runtime import LoopRuntime

_EARLIER = {
    "kind": "git_checkpoint",
    "ref": "refs/jenny/checkpoints/sess1/1",
    "created_at": "2026-10-31T12:00:00.000Z",
}


def _kernel() -> SimpleNamespace:
    return SimpleNamespace(_config=SimpleNamespace(feature_flags={}))


def _runtime() -> LoopRuntime:
    return LoopRuntime(
        electron_tool_writer=lambda _message: None,
        electron_tool_reader=None,
        electron_tool_reader_factory=None,
        trace_id=None,
    )


def _outcome_with_point(point: dict[str, str]) -> SimpleNamespace:
    return SimpleNamespace(
        metadata={
            "scripted_change_review": {
                "schema_version": 1,
                "state": "observed",
                "restore_point": point,
            }
        }
    )


def _no_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        _auto_ckpt, "_request_checkpoint", lambda _run: pytest.fail("no new checkpoint")
    )


@pytest.mark.parametrize(
    "earlier", [_EARLIER, {"kind": "head", "created_at": "2026-10-31T12:00:00.000Z"}]
)
def test_an_approved_batch_reuses_the_turns_checkpoint_without_requesting_one(
    monkeypatch: pytest.MonkeyPatch, earlier: dict[str, str]
) -> None:
    _no_request(monkeypatch)
    runtime = _runtime()

    _auto_ckpt.prepare_resume_restore_point(
        runtime,
        [(SimpleNamespace(tool_id="run_command"), 0)],
        kernel=_kernel(),
        request_id="req1",
        session_id="sess1",
        outcomes=[SimpleNamespace(metadata={}), _outcome_with_point(earlier)],
    )

    assert runtime.restore_point == earlier


def test_a_resumed_loop_run_reuses_the_turns_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_request(monkeypatch)
    loop_run = SimpleNamespace(
        kernel=_kernel(),
        runtime=_runtime(),
        request_id="req1",
        session_id="sess1",
        checkpoint_created=False,
        outcomes=[_outcome_with_point(_EARLIER)],
    )

    _auto_ckpt.maybe_create_auto_checkpoint(loop_run, [(SimpleNamespace(tool_id="edit_file"), 0)])

    assert loop_run.restore_point == _EARLIER
    assert loop_run.checkpoint_created is True


def test_an_earlier_none_point_still_lets_the_resume_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: list[str] = []

    def _request(run: object) -> object:
        requested.append(str(getattr(run, "request_id", "")))
        return SimpleNamespace(
            success=True,
            metadata={"created": True, "ref": "refs/jenny/checkpoints/sess1/2"},
            error_code=None,
        )

    monkeypatch.setattr(_auto_ckpt, "_request_checkpoint", _request)
    runtime = _runtime()

    _auto_ckpt.prepare_resume_restore_point(
        runtime,
        [(SimpleNamespace(tool_id="run_command"), 0)],
        kernel=_kernel(),
        request_id="req1",
        session_id="sess1",
        outcomes=[_outcome_with_point({"kind": "none", "reason": "failed"})],
    )

    assert requested == ["req1"]
    assert runtime.restore_point["ref"] == "refs/jenny/checkpoints/sess1/2"


def test_the_first_checkpoint_of_a_turn_is_still_requested(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: list[str] = []
    monkeypatch.setattr(
        _auto_ckpt,
        "_request_checkpoint",
        lambda run: (
            requested.append(run.request_id)
            or SimpleNamespace(
                success=True,
                metadata={"reason": "nothing_to_checkpoint"},
                error_code=None,
            )
        ),
    )
    runtime = _runtime()

    _auto_ckpt.prepare_resume_restore_point(
        runtime,
        [(SimpleNamespace(tool_id="write_file"), 0)],
        kernel=_kernel(),
        request_id="req1",
        session_id="sess1",
        outcomes=[],
    )

    assert requested == ["req1"]
    assert runtime.restore_point["kind"] == "head"
