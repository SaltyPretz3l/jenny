from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from sidecar.ai.tools import workspace_manifest as manifest_module


def _result(stdout: str, *, drain_incomplete: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        returncode=0,
        timed_out=False,
        aborted=False,
        drain_incomplete=drain_incomplete,
        stdout=stdout,
        output=SimpleNamespace(truncated=False),
    )


def test_partial_git_status_output_leaves_measured_fields_unknown(
    tmp_path: Path,
    monkeypatch,
) -> None:
    results = iter(
        (
            _result("true"),
            _result("main"),
            _result("abc1234"),
            _result("## main\n M partial.py", drain_incomplete=True),
        )
    )
    service = SimpleNamespace(run=lambda *_args, **_kwargs: next(results))
    monkeypatch.setattr(manifest_module, "get_owned_process_service", lambda: service)

    snapshot = manifest_module._build_git_snapshot(tmp_path)

    assert snapshot["known"] is False
    assert snapshot["ahead"] is None
    assert snapshot["behind"] is None
    assert snapshot["dirty_count"] is None
