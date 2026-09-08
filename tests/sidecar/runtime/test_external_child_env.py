from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.runtime import external_child_env


def test_not_frozen_returns_unchanged_copy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_child_env,
        "os",
        SimpleNamespace(name="posix", environ={}),
    )
    monkeypatch.setattr(external_child_env, "sys", SimpleNamespace(frozen=False))
    base = {"LD_LIBRARY_PATH": "/bundled", "KEEP": "yes"}

    result = external_child_env.external_child_environment(base)

    assert result == base
    assert result is not base
    assert base == {"LD_LIBRARY_PATH": "/bundled", "KEEP": "yes"}


def test_frozen_posix_restores_original_library_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        external_child_env,
        "os",
        SimpleNamespace(name="posix", environ={}),
    )
    monkeypatch.setattr(external_child_env, "sys", SimpleNamespace(frozen=True))

    result = external_child_env.external_child_environment(
        {
            "LD_LIBRARY_PATH": "/bundled",
            "LD_LIBRARY_PATH_ORIG": "/opt/lib",
        }
    )

    assert result["LD_LIBRARY_PATH"] == "/opt/lib"
    assert "LD_LIBRARY_PATH_ORIG" not in result


def test_frozen_posix_without_original_removes_library_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        external_child_env,
        "os",
        SimpleNamespace(name="posix", environ={}),
    )
    monkeypatch.setattr(external_child_env, "sys", SimpleNamespace(frozen=True))

    result = external_child_env.external_child_environment(
        {"LD_LIBRARY_PATH": "/bundled"}
    )

    assert "LD_LIBRARY_PATH" not in result


def test_frozen_windows_returns_unchanged_copy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        external_child_env,
        "os",
        SimpleNamespace(name="nt", environ={}),
    )
    monkeypatch.setattr(external_child_env, "sys", SimpleNamespace(frozen=True))
    base = {
        "LD_LIBRARY_PATH": "/bundled",
        "LD_LIBRARY_PATH_ORIG": "/opt/lib",
    }

    result = external_child_env.external_child_environment(base)

    assert result == base
    assert result is not base


def test_base_none_reads_process_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process_environment = {"FROM_PROCESS": "yes"}
    monkeypatch.setattr(
        external_child_env,
        "os",
        SimpleNamespace(name="nt", environ=process_environment),
    )
    monkeypatch.setattr(external_child_env, "sys", SimpleNamespace(frozen=False))

    result = external_child_env.external_child_environment()

    assert result == process_environment
    assert result is not process_environment
