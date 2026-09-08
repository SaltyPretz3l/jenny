from __future__ import annotations

import importlib.util
import sys
import uuid
from pathlib import Path
from types import ModuleType

import pytest


def _load_module() -> ModuleType:
    script = Path(__file__).resolve().parents[2] / "scripts" / "packaging" / "emit_sbom.py"
    name = "test_loader_emit_sbom_hygiene"
    spec = importlib.util.spec_from_file_location(name, script)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load emit_sbom.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_independent_sboms_have_unique_rfc4122_serial_numbers(tmp_path: Path) -> None:
    module = _load_module()
    missing_lock = tmp_path / "missing-lock.txt"

    first = module.build_sbom(lock_path=missing_lock, package_version="1.0.0")
    second = module.build_sbom(lock_path=missing_lock, package_version="1.0.0")

    first_serial = str(first["serialNumber"])
    second_serial = str(second["serialNumber"])
    assert first_serial != second_serial
    assert first_serial.startswith("urn:uuid:")
    assert second_serial.startswith("urn:uuid:")
    assert uuid.UUID(first_serial.removeprefix("urn:uuid:")).version == 4
    assert uuid.UUID(second_serial.removeprefix("urn:uuid:")).version == 4


def _managed_python_components(sbom: dict[str, object]) -> list[dict[str, object]]:
    return [
        component
        for component in sbom["components"]
        if component["name"] == "CPython embeddable runtime"
    ]


def _metadata_properties(sbom: dict[str, object]) -> dict[str, str]:
    return {
        property_["name"]: property_["value"]
        for property_ in sbom["metadata"]["properties"]
    }


def test_explicit_managed_runtime_inclusion_is_host_independent() -> None:
    module = _load_module()

    sbom = module.build_sbom(include_managed_runtime=True, sys_platform="darwin")

    assert [component["version"] for component in _managed_python_components(sbom)] == ["3.13.14"]
    assert any(
        property_["value"] == "managed-python-runtime"
        for component in sbom["components"]
        for property_ in component.get("properties", [])
    )


@pytest.mark.parametrize(
    ("sys_platform", "expected_versions"),
    [("linux", ["3.13.15"]), ("darwin", [])],
)
def test_managed_runtime_default_is_platform_selected(
    sys_platform: str,
    expected_versions: list[str],
) -> None:
    module = _load_module()

    sbom = module.build_sbom(sys_platform=sys_platform)

    assert [component["version"] for component in _managed_python_components(sbom)] == expected_versions
    properties = _metadata_properties(sbom)
    property_name = "jenny:sha256:runtime-bundle-contract"
    if expected_versions:
        contract_path = module.python_runtime_bundle_contract(sys_platform)
        assert properties[property_name] == module._sha256_file(contract_path)
    else:
        assert property_name not in properties
