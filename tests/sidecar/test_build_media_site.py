from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load_builder() -> ModuleType:
    script_path = ROOT / "scripts" / "packaging" / "build_media_site.py"
    module_name = "test_build_media_site_script"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load script: {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("sys_platform", "expected"),
    [
        ("win32", "win_amd64"),
        ("linux", "manylinux_2_28_x86_64"),
        ("darwin", "macosx_11_0_arm64"),
    ],
)
def test_platform_defaults(sys_platform: str, expected: str) -> None:
    builder = _load_builder()

    assert builder._default_platform(sys_platform) == expected  # noqa: SLF001


def test_manifest_assembly_hashes_relative_files_and_excludes_manifest(
    tmp_path: Path,
) -> None:
    builder = _load_builder()
    site = tmp_path / "site"
    lock = tmp_path / "requirements-media-site-lock.txt"
    nested = site / "package" / "data.bin"
    nested.parent.mkdir(parents=True)
    nested.write_bytes(b"payload")
    (site / "manifest.json").write_text("stale", encoding="utf-8")
    lock.write_text("example==1.0\n", encoding="utf-8")

    manifest = builder._assemble_manifest(  # noqa: SLF001
        site,
        lock_path=lock,
        python_version="3.11",
        platform="win_amd64",
        generated_at="2026-01-01T00:00:00Z",
    )

    assert manifest == {
        "schema_version": 1,
        "python_version": "3.11",
        "platform": "win_amd64",
        "lock": lock.name,
        "lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "generated_at": "2026-01-01T00:00:00Z",
        "files": {"package/data.bin": hashlib.sha256(nested.read_bytes()).hexdigest()},
    }


def test_generated_timestamp_honors_source_date_epoch(monkeypatch) -> None:
    builder = _load_builder()
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "0")

    assert builder._timestamp() == "1970-01-01T00:00:00Z"  # noqa: SLF001


def test_prune_removes_script_and_bytecode_directories(tmp_path: Path) -> None:
    builder = _load_builder()
    site = tmp_path / "site"
    for relative in ("bin/tool", "Scripts/tool.exe", "pkg/__pycache__/module.pyc"):
        path = site / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"generated")
    kept = site / "pkg" / "module.py"
    kept.write_text("VALUE = 1\n", encoding="utf-8")

    removed = builder._prune_site(site)  # noqa: SLF001

    assert removed == ("Scripts", "bin", "pkg/__pycache__")
    assert kept.is_file()
    assert not (site / "bin").exists()
    assert not (site / "Scripts").exists()
    assert not (site / "pkg" / "__pycache__").exists()


def test_download_command_is_hash_locked_platform_specific_and_allows_sdist_only(
    tmp_path: Path,
) -> None:
    builder = _load_builder()
    lock = tmp_path / "lock.txt"
    wheels = tmp_path / "wheels"

    download = builder._download_command(  # noqa: SLF001
        python_executable="python.exe",
        lock_path=lock,
        wheels_directory=wheels,
        target=builder.MediaSiteTarget(platform="win_amd64", python_version="3.11"),
    )

    assert download[:6] == [
        "python.exe",
        "-m",
        "pip",
        "download",
        "--require-hashes",
        "--only-binary=:all:",
    ]
    assert download[6:8] == ["--no-binary", "antlr4-python3-runtime"]
    assert download[8:] == [
        "--no-deps",
        "--platform",
        "win_amd64",
        "--python-version",
        "3.11",
        "--implementation",
        "cp",
        "--abi",
        "cp311",
        "-r",
        str(lock),
        "-d",
        str(wheels),
    ]


def test_sdists_are_built_into_wheels_and_installed_from_the_wheelhouse(tmp_path: Path) -> None:
    builder = _load_builder()
    wheels = tmp_path / "wheels"
    wheels.mkdir()
    (wheels / "numpy-2.4.3-cp311-cp311-win_amd64.whl").write_bytes(b"w")
    (wheels / "antlr4-python3-runtime-4.9.3.tar.gz").write_bytes(b"s")

    sdists = builder._sdists(wheels)  # noqa: SLF001
    assert sdists == [wheels / "antlr4-python3-runtime-4.9.3.tar.gz"]

    wheel = builder._wheel_command(  # noqa: SLF001
        python_executable="python.exe", sdist=sdists[0], wheels_directory=wheels
    )
    assert wheel == [
        "python.exe",
        "-m",
        "pip",
        "wheel",
        "--no-deps",
        "--no-build-isolation",
        "--no-index",
        "--wheel-dir",
        str(wheels),
        str(sdists[0]),
    ]

    install = builder._install_command(  # noqa: SLF001
        python_executable="python.exe",
        wheel_paths=sorted(wheels.glob("*.whl")),
        site_directory=tmp_path / "site",
    )
    assert install[:4] == ["python.exe", "-m", "pip", "install"]
    assert "--require-hashes" not in install
    assert "--no-index" in install and "--no-deps" in install
    assert install[-1] == str(wheels / "numpy-2.4.3-cp311-cp311-win_amd64.whl")
