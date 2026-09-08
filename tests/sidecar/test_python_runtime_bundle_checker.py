from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLATFORM_TAGS = [
    "manylinux_2_28_x86_64",
    "manylinux_2_27_x86_64",
    "manylinux_2_24_x86_64",
    "manylinux_2_17_x86_64",
    "manylinux2014_x86_64",
    "manylinux_2_5_x86_64",
    "manylinux1_x86_64",
]
COMPILED_PACKAGES = {
    "contourpy",
    "fonttools",
    "kiwisolver",
    "matplotlib",
    "numpy",
    "pandas",
    "pillow",
    "scipy",
}


def _load_script(relative_path: str, module_suffix: str) -> ModuleType:
    script_path = ROOT / relative_path
    module_name = f"test_python_runtime_bundle_checker_{module_suffix}"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load script: {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _copy_contract_files(target: Path) -> dict[str, object]:
    relative_files = (
        "config/python-runtime-bundle-lock.json",
        "requirements-build-lock.txt",
        "requirements-python-runtime-lock.txt",
        "requirements-lock.txt",
        "pyproject.toml",
    )
    for relative in relative_files:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, destination)
    return json.loads(
        (target / "config/python-runtime-bundle-lock.json").read_text(encoding="utf-8")
    )


def _write_linux_contract(target: Path, windows: dict[str, object]) -> Path:
    source = ROOT / "config" / "python-runtime-bundle-lock.linux-x64.json"
    destination = target / "config" / source.name
    if source.exists():
        shutil.copyfile(source, destination)
        return destination
    contract = dict(windows)
    windows_python = windows["python"]
    assert isinstance(windows_python, dict)
    python = dict(windows_python)
    python.update(
        {
            "distribution": "python-build-standalone",
            "archive_format": "tar.gz",
            "strip_prefix": "python",
            "platform": "manylinux_2_28_x86_64",
            "platform_tags": PLATFORM_TAGS,
            "sys_platform": "linux",
            "executable": "bin/python3.13",
            "stdlib_marker": "lib/python3.13/os.py",
            "max_extracted_bytes": 536870912,
            "max_members": 50000,
        }
    )
    for field in ("stdlib_archive", "path_file", "max_archive_bytes"):
        python.pop(field, None)
    contract["python"] = python
    destination.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")
    return destination


def _lock_pins(checker: ModuleType, lock: Path) -> dict[str, str]:
    pins, errors = checker._parse_hashed_lock(lock)  # noqa: SLF001
    assert errors == []
    return pins


def _file_manifest(directory: Path, manifest_name: str) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): _sha256(path)
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name not in {".gitignore", manifest_name}
    }


def _wheel_filename(name: str, version: str) -> str:
    distribution = name.replace("-", "_")
    if name in COMPILED_PACKAGES:
        suffix = "cp313-cp313-manylinux_2_27_x86_64.manylinux_2_28_x86_64"
    else:
        suffix = "py3-none-any"
    return f"{distribution}-{version}-{suffix}.whl"


def _write_wheel_manifest(
    wheelhouse: Path,
    contract: dict[str, object],
    common: dict[str, object],
) -> None:
    manifest_name = str(contract["wheelhouse_manifest"])
    (wheelhouse / manifest_name).write_text(
        json.dumps(
            {
                **common,
                "runtime_packages": contract["runtime_packages"],
                "bootstrap_packages": contract["bootstrap_packages"],
                "files": _file_manifest(wheelhouse, manifest_name),
            }
        ),
        encoding="utf-8",
    )


def _build_linux_bundle(
    target: Path,
    checker: ModuleType,
) -> tuple[Path, Path, Path]:
    windows = _copy_contract_files(target)
    contract_path = _write_linux_contract(target, windows)
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    python = contract["python"]
    embed = target / "vendor" / "python-embed"
    wheelhouse = target / "vendor" / "python-runtime-wheels"
    (embed / "bin").mkdir(parents=True)
    (embed / "lib" / "python3.13").mkdir(parents=True)
    wheelhouse.mkdir(parents=True)
    (embed / "bin" / "python3.13").write_bytes(b"fake-python")
    (embed / "lib" / "python3.13" / "os.py").write_bytes(b"# fake stdlib\n")
    pins = _lock_pins(checker, target / str(contract["runtime_lock"]))
    for name, version in pins.items():
        if name != "tzdata":
            filename = _wheel_filename(name, version)
            (wheelhouse / filename).write_bytes(filename.encode("utf-8"))
    common = {
        "schema_version": 1,
        "contract_sha256": _sha256(contract_path),
        "build_lock_sha256": _sha256(target / str(contract["build_lock"])),
        "runtime_lock_sha256": _sha256(target / str(contract["runtime_lock"])),
        "python_version": python["version"],
        "platform": python["platform"],
        "abi": python["abi"],
        "sys_platform": python["sys_platform"],
        "platform_tags": python["platform_tags"],
    }
    embed_manifest_name = str(contract["embed_manifest"])
    (embed / embed_manifest_name).write_text(
        json.dumps(
            {
                **common,
                "distribution": python["distribution"],
                "source_url": python["embed_url"],
                "source_sha256": python["embed_sha256"],
                "files": _file_manifest(embed, embed_manifest_name),
            }
        ),
        encoding="utf-8",
    )
    _write_wheel_manifest(wheelhouse, contract, common)
    return contract_path, embed, wheelhouse


@pytest.fixture
def linux_bundle(tmp_path: Path) -> tuple[ModuleType, Path, Path, Path]:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", tmp_path.name)
    contract, embed, wheelhouse = _build_linux_bundle(tmp_path, checker)
    return checker, contract, embed, wheelhouse


def _validate_linux(bundle: tuple[ModuleType, Path, Path, Path]) -> list[str]:
    checker, contract, embed, wheelhouse = bundle
    return checker.validate_python_runtime_bundle(
        contract.parents[1],
        contract_path=contract,
        embed_dir=embed,
        wheelhouse_dir=wheelhouse,
        probe_python=False,
    )


def test_linux_bundle_accepts_marker_filtered_lock_and_compressed_tags(
    linux_bundle: tuple[ModuleType, Path, Path, Path],
) -> None:
    assert _validate_linux(linux_bundle) == []


def test_linux_bundle_rejects_extra_marker_excluded_wheel(
    linux_bundle: tuple[ModuleType, Path, Path, Path],
) -> None:
    _checker, contract_path, _embed, wheelhouse = linux_bundle
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    manifest = json.loads((wheelhouse / contract["wheelhouse_manifest"]).read_text())
    tzdata = wheelhouse / "tzdata-2026.3-py2.py3-none-any.whl"
    tzdata.write_bytes(b"tzdata")
    manifest["files"] = _file_manifest(wheelhouse, contract["wheelhouse_manifest"])
    (wheelhouse / contract["wheelhouse_manifest"]).write_text(json.dumps(manifest))

    assert any("wheelhouse does not exactly match" in error for error in _validate_linux(linux_bundle))


def test_linux_bundle_rejects_windows_wheel(
    linux_bundle: tuple[ModuleType, Path, Path, Path],
) -> None:
    _checker, contract_path, _embed, wheelhouse = linux_bundle
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    linux_wheel = next(wheelhouse.glob("contourpy-*-manylinux*.whl"))
    windows_wheel = wheelhouse / linux_wheel.name.replace(
        "manylinux_2_27_x86_64.manylinux_2_28_x86_64", "win_amd64"
    )
    linux_wheel.rename(windows_wheel)
    manifest_path = wheelhouse / contract["wheelhouse_manifest"]
    manifest = json.loads(manifest_path.read_text())
    manifest["files"] = _file_manifest(wheelhouse, contract["wheelhouse_manifest"])
    manifest_path.write_text(json.dumps(manifest))

    assert any("targets the wrong platform" in error for error in _validate_linux(linux_bundle))


def test_linux_bundle_rejects_wrong_distribution(
    linux_bundle: tuple[ModuleType, Path, Path, Path],
) -> None:
    _checker, contract_path, embed, _wheelhouse = linux_bundle
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    manifest_path = embed / contract["embed_manifest"]
    manifest = json.loads(manifest_path.read_text())
    manifest["distribution"] = "cpython-embeddable"
    manifest_path.write_text(json.dumps(manifest))

    assert any("distribution" in error for error in _validate_linux(linux_bundle))


def test_windows_bundle_marker_keeps_tzdata(tmp_path: Path) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "windows")
    existing = _load_script("tests/sidecar/test_python_runtime_bundle.py", "fixture")
    embed, wheelhouse = existing._build_valid_bundle(tmp_path)  # noqa: SLF001
    assert checker.validate_python_runtime_bundle(
        tmp_path, embed_dir=embed, wheelhouse_dir=wheelhouse, probe_python=False
    ) == []

    (wheelhouse / "tzdata-2026.3-py2.py3-none-any.whl").unlink()
    manifest_path = wheelhouse / "wheelhouse-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"] = _file_manifest(wheelhouse, manifest_path.name)
    manifest_path.write_text(json.dumps(manifest))
    violations = checker.validate_python_runtime_bundle(
        tmp_path, embed_dir=embed, wheelhouse_dir=wheelhouse, probe_python=False
    )
    assert any("wheelhouse does not exactly match" in error for error in violations)


def test_default_contract_path_and_explicit_contract_main(
    linux_bundle: tuple[ModuleType, Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    checker, contract, _embed, _wheelhouse = linux_bundle
    root = contract.parents[1]
    assert checker.default_contract_path(root, os_name="nt", sys_platform="win32") == (
        root / "config" / "python-runtime-bundle-lock.json"
    )
    assert checker.default_contract_path(root, os_name="posix", sys_platform="linux") == contract
    assert checker.default_contract_path(root, os_name="posix", sys_platform="darwin") is None
    monkeypatch.setattr(checker, "ROOT", root)
    assert checker.main(["--contract", str(contract), "--no-probe"]) == 0
    assert capsys.readouterr().out == "PASS: managed Python runtime bundle is package-ready\n"


def _write_synthetic_lock(path: Path, marker: str) -> None:
    digest = "0" * 64
    foo_record = f"foo==1.0 ; sys_platform == 'linux' \\\n    --hash=sha256:{digest}\n"
    bar_record = f"bar==1.0 ; {marker} \\\n    --hash=sha256:{digest}\n"
    path.write_text(
        foo_record + bar_record,
        encoding="utf-8",
    )


def test_runtime_pins_evaluate_markers_for_target(tmp_path: Path) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "markers")
    lock = tmp_path / "requirements-lock.txt"
    _write_synthetic_lock(lock, "python_version < '3'")
    assert checker._runtime_pins_for_target(lock, "linux") == ({"foo": "1.0"}, [])  # noqa: SLF001
    assert checker._runtime_pins_for_target(lock, "win32") == ({}, [])  # noqa: SLF001


def test_runtime_pins_reject_invalid_marker_and_missing_packaging(tmp_path: Path) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "bad_markers")
    lock = tmp_path / "requirements-lock.txt"
    _write_synthetic_lock(lock, "sys_platform === 'linux'")
    _pins, errors = checker._runtime_pins_for_target(lock, "linux")  # noqa: SLF001
    assert any("bar" in error for error in errors)

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(checker, "Marker", None)
    try:
        _pins, errors = checker._runtime_pins_for_target(lock, "linux")  # noqa: SLF001
    finally:
        monkeypatch.undo()
    assert "packaging is required to evaluate lock markers" in errors


def test_runtime_pins_evaluate_python_markers_against_the_bundle(tmp_path: Path) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "python_markers")
    lock = tmp_path / "requirements-lock.txt"
    _write_synthetic_lock(lock, "python_full_version >= '3.13'")
    kept = checker._runtime_pins_for_target(lock, "linux", "3.13.15")  # noqa: SLF001
    assert kept == ({"foo": "1.0", "bar": "1.0"}, [])
    dropped = checker._runtime_pins_for_target(lock, "linux", "3.11.9")  # noqa: SLF001
    assert dropped == ({"foo": "1.0"}, [])


def test_runtime_pins_evaluate_implementation_and_machine_markers(
    tmp_path: Path,
) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "target_markers")
    lock = tmp_path / "requirements-lock.txt"
    _write_synthetic_lock(
        lock, "implementation_version >= '3.13' and platform_machine == 'x86_64'"
    )

    linux = checker._runtime_pins_for_target(  # noqa: SLF001
        lock, "linux", "3.13.15", architecture="x64"
    )
    assert linux == ({"foo": "1.0", "bar": "1.0"}, [])
    windows = checker._runtime_pins_for_target(  # noqa: SLF001
        lock, "win32", "3.13.15", architecture="x64"
    )
    assert windows == ({}, [])
    unsupported = checker._runtime_pins_for_target(  # noqa: SLF001
        lock, "linux", "3.13.15", architecture="riscv"
    )
    assert unsupported == (
        {},
        ["unsupported bundle architecture for marker evaluation: riscv"],
    )


def test_lock_parser_rejects_wildcard_pins(tmp_path: Path) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "wildcard")
    lock = tmp_path / "requirements-lock.txt"
    lock.write_text(f"foo==1.* \\\n    --hash=sha256:{'0' * 64}\n", encoding="utf-8")
    _pins, errors = checker._parse_hashed_lock(lock)  # noqa: SLF001
    assert any("unparseable" in error for error in errors)
    assert checker.PIN_RE.fullmatch("pandas==3.*") is None
