from __future__ import annotations

import importlib.util
import json
import re
import sys
import tomllib
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]
UPPER_BOUND_PACKAGES = {"filelock", "httpx", "jinja2", "pydantic", "PyYAML"}


def _load_toml() -> dict[str, object]:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def _requirement_name(requirement: str) -> str:
    return re.split(r"[<>=!~;\[]", requirement, maxsplit=1)[0].strip()


def _load_packaging_module(script_name: str) -> ModuleType:
    script_path = ROOT / "scripts" / "packaging" / script_name
    module_name = f"test_loader_contract_{script_name}"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load packaging script module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def test_optional_dependency_all_extra_matches_named_extras_union() -> None:
    pyproject = _load_toml()
    optional = pyproject["project"]["optional-dependencies"]  # type: ignore[index]
    expected: set[str] = set()
    for extra_name, requirements in optional.items():
        if extra_name == "all":
            continue
        expected.update(requirements)

    assert set(optional["all"]) == expected


def test_spreadsheet_extra_includes_xml_hardening_dependency() -> None:
    pyproject = _load_toml()
    optional = pyproject["project"]["optional-dependencies"]  # type: ignore[index]

    assert "openpyxl==3.1.5" in optional["spreadsheet"]
    assert "defusedxml==0.7.1" in optional["spreadsheet"]


def test_default_on_rich_file_dependencies_ship_in_the_base_runtime() -> None:
    pyproject = _load_toml()
    dependencies = pyproject["project"]["dependencies"]  # type: ignore[index]

    assert "openpyxl==3.1.5" in dependencies
    assert "defusedxml==0.7.1" in dependencies


def test_base_dependencies_keep_known_major_upper_bounds() -> None:
    pyproject = _load_toml()
    dependencies = pyproject["project"]["dependencies"]  # type: ignore[index]
    by_name = {_requirement_name(requirement): requirement for requirement in dependencies}

    for package_name in UPPER_BOUND_PACKAGES:
        assert package_name in by_name
        assert "<" in by_name[package_name]


def test_requirements_lock_pins_base_and_packaging_dependencies() -> None:
    pyproject = _load_toml()
    project = pyproject["project"]  # type: ignore[index]
    required_names = {
        _requirement_name(requirement).lower()
        for requirement in project["dependencies"]  # type: ignore[index]
    }
    optional = project["optional-dependencies"]  # type: ignore[index]
    required_names.update(
        _requirement_name(requirement).lower()
        for requirement in optional["packaging"]
    )
    lock_text = (ROOT / "requirements-lock.txt").read_text(encoding="utf-8")

    for name in required_names:
        assert re.search(rf"^{re.escape(name)}==", lock_text, re.IGNORECASE | re.MULTILINE), name


def test_requirements_lock_uses_hash_pinned_install_contract() -> None:
    lock_lines = (ROOT / "requirements-lock.txt").read_text(encoding="utf-8").splitlines()
    requirement_lines = [
        index for index, line in enumerate(lock_lines) if re.match(r"^[A-Za-z0-9_.-]+==", line)
    ]

    assert requirement_lines
    for index in requirement_lines:
        assert lock_lines[index].endswith("\\")
        assert re.match(r"\s+--hash=sha256:[a-f0-9]{64}$", lock_lines[index + 1])


def test_build_backend_uses_separate_exact_hash_locked_toolchain() -> None:
    pyproject = _load_toml()
    assert pyproject["build-system"]["requires"] == [
        "setuptools==83.0.0",
        "wheel==0.47.0",
    ]

    build_lock = (ROOT / "requirements-build-lock.txt").read_text(encoding="utf-8")
    for pin in (
        "packaging==25.0",
        "pip==26.2",
        "setuptools==83.0.0",
        "wheel==0.47.0",
    ):
        assert f"{pin} \\\n" in build_lock
    assert "setuptools==65.5.0" not in (
        ROOT / "requirements-lock.txt"
    ).read_text(encoding="utf-8")


def test_ruff_per_file_ignores_reference_real_paths() -> None:
    """Guard against orphaned ruff per-file-ignores entries.

    Every concrete-path key must exist on disk, and every glob key must match
    at least one file, so a future file deletion/rename surfaces immediately
    instead of leaving a silently dead ignore entry behind (see P4 narrowing).
    """
    pyproject = _load_toml()
    per_file_ignores = pyproject["tool"]["ruff"]["lint"]["per-file-ignores"]  # type: ignore[index]

    missing_concrete_paths: list[str] = []
    empty_globs: list[str] = []
    for key in per_file_ignores:
        if "*" in key:
            if not any(ROOT.glob(key)):
                empty_globs.append(key)
        elif not (ROOT / key).is_file():
            missing_concrete_paths.append(key)

    assert not missing_concrete_paths, (
        "per-file-ignores references files that don't exist on disk: "
        f"{missing_concrete_paths}"
    )
    assert not empty_globs, (
        f"per-file-ignores glob patterns match zero files: {empty_globs}"
    )


def test_emit_sbom_script_writes_cyclonedx_component_inventory(tmp_path: Path) -> None:
    module = _load_packaging_module("emit_sbom.py")
    lock_path = tmp_path / "requirements-lock.txt"
    lock_path.write_text("httpx==0.28.1\nPyYAML==6.0.3\n", encoding="utf-8")
    output_path = tmp_path / "sidecar-sbom.json"

    module.emit_sbom(lock_path=lock_path, output_path=output_path)

    sbom = json.loads(output_path.read_text(encoding="utf-8"))
    assert sbom["bomFormat"] == "CycloneDX"
    assert sbom["specVersion"] == "1.5"
    assert [component["name"] for component in sbom["components"]] == ["httpx", "PyYAML"]


def test_release_sbom_includes_build_tools_managed_runtime_and_cpython() -> None:
    module = _load_packaging_module("emit_sbom.py")

    sbom = module.build_sbom(include_managed_runtime=True)

    components = sbom["components"]
    assert any(component["name"] == "CPython embeddable runtime" for component in components)
    scopes = {
        prop["value"]
        for component in components
        for prop in component.get("properties", [])
        if prop.get("name") == "jenny:dependency-scope"
    }
    assert {
        "sidecar-runtime",
        "sidecar-build",
        "managed-python-runtime",
        "managed-python-interpreter",
    } <= scopes
