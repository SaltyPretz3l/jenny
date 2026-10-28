"""Config-free manifest descriptors are cached; only two tools take config overrides."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.tools import catalog as catalog_module
from sidecar.ai.tools.catalog import (
    bool_config_flag,
    manifest_descriptors,
    manifest_platform_supported,
)


def _by_name(config: object = None) -> dict[str, object]:
    return {descriptor.name: descriptor for descriptor in manifest_descriptors(config=config)}


def test_manifest_is_parsed_once_and_unchanged_descriptors_are_shared(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_module.clear_manifest_caches()
    calls = {"count": 0}
    original = catalog_module._manifest_descriptor

    def _counting(entry: dict[str, object]) -> object:
        calls["count"] += 1
        return original(entry)

    monkeypatch.setattr(catalog_module, "_manifest_descriptor", _counting)
    try:
        first, second = _by_name(), _by_name(SimpleNamespace(tools_image_read_enabled=True))
        parsed = calls["count"]
        _by_name()
        assert calls["count"] == parsed  # the third call re-parses nothing
        assert first["git_status"] is second["git_status"]
    finally:
        catalog_module.clear_manifest_caches()


def test_read_file_pages_override_never_mutates_the_cache() -> None:
    without_pages = _by_name()["read_file"]
    with_pages = _by_name(SimpleNamespace(tools_image_read_enabled=True))["read_file"]

    assert "pages" not in without_pages.input_schema["properties"]  # type: ignore[attr-defined]
    assert "pages" in with_pages.input_schema["properties"]  # type: ignore[attr-defined]
    # A second default read still hides it: the first override copied, not popped in place.
    assert "pages" not in _by_name()["read_file"].input_schema["properties"]  # type: ignore[attr-defined]


def test_run_command_host_worker_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(catalog_module, "host_execution_worker_enabled", lambda config: True)
    monkeypatch.setattr(catalog_module, "host_run_command_schema", lambda: {"type": "object"})

    descriptor = _by_name(SimpleNamespace())["run_command"]

    assert descriptor.input_schema == {"type": "object"}  # type: ignore[attr-defined]
    assert "offline disposable workspace" in descriptor.description  # type: ignore[attr-defined]
    monkeypatch.undo()
    assert "offline disposable" not in _by_name()["run_command"].description  # type: ignore[attr-defined]


def test_manifest_platform_supported_reads_availability_platforms() -> None:
    # python_execute declares platforms ["win32"]; read_file declares none.
    assert manifest_platform_supported("python_execute", "win32") is True
    assert manifest_platform_supported("python_execute", "linux") is False
    assert manifest_platform_supported("read_file", "linux") is True
    assert manifest_platform_supported("no_such_tool", "win32") is False


@pytest.mark.parametrize(
    ("config", "default", "expected"),
    [
        (None, True, True),
        ({}, False, False),
        ({"flag": True}, False, True),
        ({"flag": False}, True, False),
        ({"flag": None}, True, False),
        ({"flag": "true"}, True, False),
        (SimpleNamespace(flag=1), True, False),
        (SimpleNamespace(), True, True),
    ],
)
def test_bool_config_flag_fails_closed_on_present_non_bool(
    config: object, default: bool, expected: bool
) -> None:
    assert bool_config_flag(config, "flag", default=default) is expected
