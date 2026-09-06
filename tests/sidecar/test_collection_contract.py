from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from tests.conftest import pytest_ignore_collect


def _config(invocation_dir: Path, *args: str) -> SimpleNamespace:
    return SimpleNamespace(
        invocation_params=SimpleNamespace(dir=invocation_dir, args=args),
    )


def test_legacy_server_entrypoint_is_skipped_during_recursive_collection() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    entrypoint = repo_root / "tests" / "sidecar" / "test_server.py"

    assert pytest_ignore_collect(entrypoint, _config(repo_root, "tests/sidecar")) is True


def test_legacy_server_entrypoint_remains_available_when_explicitly_requested() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    entrypoint = repo_root / "tests" / "sidecar" / "test_server.py"

    assert (
        pytest_ignore_collect(
            entrypoint,
            _config(
                repo_root,
                "tests/sidecar/test_server.py::test_process_message_shutdown_returns_acknowledgement",
            ),
        )
        is None
    )
