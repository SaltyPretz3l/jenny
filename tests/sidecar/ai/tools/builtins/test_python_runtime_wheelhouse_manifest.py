"""Wheelhouse checksum-manifest verification split out of ``python_runtime.interpreter``."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.python_runtime import interpreter
from sidecar.ai.tools.builtins.python_runtime import wheelhouse_manifest as manifest
from sidecar.ai.tools.builtins.python_runtime.errors import (
    PythonRuntimeWheelhouseIntegrityError,
)

_WHEEL = "demo-1.0-py3-none-any.whl"


def _wheelhouse(tmp_path: Path, *, digest: str | None = None) -> Path:
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    (wheelhouse / _WHEEL).write_bytes(b"wheel bytes")
    real_digest = hashlib.sha256(b"wheel bytes").hexdigest()
    (wheelhouse / manifest.WHEELHOUSE_MANIFEST_FILENAME).write_text(
        json.dumps({"files": {_WHEEL: (digest or real_digest).upper()}}), encoding="utf-8"
    )
    return wheelhouse


def test_matching_wheelhouse_verifies(tmp_path: Path) -> None:
    manifest._verify_wheelhouse_integrity(_wheelhouse(tmp_path))


def test_checksum_mismatch_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(PythonRuntimeWheelhouseIntegrityError, match="checksum verification"):
        manifest._verify_wheelhouse_integrity(_wheelhouse(tmp_path, digest="0" * 64))


def test_unexpected_wheel_fails_closed(tmp_path: Path) -> None:
    wheelhouse = _wheelhouse(tmp_path)
    (wheelhouse / "extra-1.0-py3-none-any.whl").write_bytes(b"extra")

    with pytest.raises(PythonRuntimeWheelhouseIntegrityError, match="unexpected="):
        manifest._verify_wheelhouse_integrity(wheelhouse)


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (None, "missing its checksum manifest"),
        ("{not json", "not valid JSON"),
        ('{"files": {}}', "no file entries"),
        ('{"files": {"": "abc"}}', "no valid entries"),
    ],
)
def test_unusable_manifest_fails_closed(tmp_path: Path, content: str | None, message: str) -> None:
    if content is not None:
        (tmp_path / manifest.WHEELHOUSE_MANIFEST_FILENAME).write_text(content, encoding="utf-8")

    with pytest.raises(PythonRuntimeWheelhouseIntegrityError, match=message):
        manifest._load_wheelhouse_manifest(tmp_path)


def test_interpreter_keeps_its_wheelhouse_names(tmp_path: Path) -> None:
    # The interpreter delegates lazily (startup import budget); same names, same behaviour.
    assert interpreter.WHEELHOUSE_MANIFEST_FILENAME == manifest.WHEELHOUSE_MANIFEST_FILENAME
    wheelhouse = _wheelhouse(tmp_path)
    assert interpreter._wheelhouse_manifest_path(wheelhouse) == manifest._wheelhouse_manifest_path(
        wheelhouse
    )
    interpreter._verify_wheelhouse_integrity(wheelhouse)
    (tmp_path / "bad").mkdir()
    with pytest.raises(PythonRuntimeWheelhouseIntegrityError, match="checksum verification"):
        interpreter._verify_wheelhouse_integrity(_wheelhouse(tmp_path / "bad", digest="0" * 64))
