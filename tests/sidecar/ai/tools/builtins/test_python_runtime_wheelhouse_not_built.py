"""A configured wheelhouse nobody built is reported as not built (dogfood TR-021).

A dev worktree tracks only a ``.gitignore`` sentinel in the wheelhouse folder.
``python_execute`` then failed, after the owner approved it, with "checksum
manifest is unreadable", which reads as tampering.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.python_runtime import interpreter
from sidecar.ai.tools.builtins.python_runtime.errors import (
    PythonRuntimeWheelhouseIntegrityError,
)


def _config(wheelhouse: Path) -> dict[str, str]:
    return {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)}


def test_sentinel_only_wheelhouse_is_reported_as_not_built(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "python-runtime-wheels"
    wheelhouse.mkdir()
    (wheelhouse / ".gitignore").write_text("*\n!.gitignore\n", encoding="utf-8")

    with pytest.raises(FileNotFoundError, match="is not built") as caught:
        interpreter._runtime_requirements_fingerprint(_config(wheelhouse))
    assert "build-python-runtime-bundle.py" in str(caught.value)


def test_wheels_without_their_manifest_still_fail_the_integrity_check(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "python-runtime-wheels"
    wheelhouse.mkdir()
    (wheelhouse / "example-1.0-py3-none-any.whl").write_bytes(b"not a wheel")

    with pytest.raises(PythonRuntimeWheelhouseIntegrityError, match="manifest is unreadable"):
        interpreter._runtime_requirements_fingerprint(_config(wheelhouse))


def test_missing_configured_wheelhouse_keeps_its_not_found_message(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="wheelhouse not found"):
        interpreter._runtime_requirements_fingerprint(_config(tmp_path / "absent"))
