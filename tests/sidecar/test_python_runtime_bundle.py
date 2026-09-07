from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

from sidecar.ai.tools.builtins.python_runtime import interpreter
from sidecar.ai.tools.builtins.python_runtime import pip_bootstrap

ROOT = Path(__file__).resolve().parents[2]
WHEEL_FILENAMES = (
    "contourpy-1.3.3-cp313-cp313-win_amd64.whl",
    "cycler-0.12.1-py3-none-any.whl",
    "fonttools-4.63.0-cp313-cp313-win_amd64.whl",
    "kiwisolver-1.5.0-cp313-cp313-win_amd64.whl",
    "matplotlib-3.10.8-cp313-cp313-win_amd64.whl",
    "numpy-2.4.3-cp313-cp313-win_amd64.whl",
    "packaging-26.2-py3-none-any.whl",
    "pandas-3.0.1-cp313-cp313-win_amd64.whl",
    "pillow-12.3.0-cp313-cp313-win_amd64.whl",
    "pip-26.2-py3-none-any.whl",
    "pyparsing-3.3.2-py3-none-any.whl",
    "python_dateutil-2.9.0.post0-py2.py3-none-any.whl",
    "scipy-1.17.1-cp313-cp313-win_amd64.whl",
    "seaborn-0.13.2-py3-none-any.whl",
    "six-1.17.0-py2.py3-none-any.whl",
    "tabulate-0.10.0-py3-none-any.whl",
    "tzdata-2026.3-py2.py3-none-any.whl",
)


def _load_script(relative_path: str, module_suffix: str) -> ModuleType:
    script_path = ROOT / relative_path
    module_name = f"test_python_runtime_bundle_{module_suffix}"
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
    (target / "config").mkdir(parents=True)
    for relative in (
        "config/python-runtime-bundle-lock.json",
        "requirements-build-lock.txt",
        "requirements-python-runtime-lock.txt",
        "requirements-lock.txt",
        "pyproject.toml",
    ):
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, destination)
    return json.loads(
        (target / "config" / "python-runtime-bundle-lock.json").read_text(encoding="utf-8")
    )


def _file_manifest(directory: Path, manifest_name: str) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): _sha256(path)
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name not in {".gitignore", manifest_name}
    }


def _build_valid_bundle(target: Path) -> tuple[Path, Path]:
    contract = _copy_contract_files(target)
    python = contract["python"]
    embed = target / "vendor" / "python-embed"
    wheelhouse = target / "vendor" / "python-runtime-wheels"
    embed.mkdir(parents=True)
    wheelhouse.mkdir(parents=True)
    (embed / "python.exe").write_bytes(b"fake-python")
    (embed / "python313.zip").write_bytes(b"fake-stdlib")
    (embed / "python313._pth").write_text(
        "python313.zip\n.\nLib/site-packages\nimport site\n",
        encoding="utf-8",
    )
    for filename in WHEEL_FILENAMES:
        (wheelhouse / filename).write_bytes(filename.encode("utf-8"))

    contract_path = target / "config" / "python-runtime-bundle-lock.json"
    build_lock = target / str(contract["build_lock"])
    runtime_lock = target / str(contract["runtime_lock"])
    common = {
        "schema_version": 1,
        "contract_sha256": _sha256(contract_path),
        "build_lock_sha256": _sha256(build_lock),
        "runtime_lock_sha256": _sha256(runtime_lock),
        "python_version": python["version"],
        "platform": python["platform"],
        "abi": python["abi"],
    }
    embed_manifest_name = str(contract["embed_manifest"])
    wheel_manifest_name = str(contract["wheelhouse_manifest"])
    (embed / embed_manifest_name).write_text(
        json.dumps(
            {
                **common,
                "distribution": "cpython-embeddable",
                "source_url": python["embed_url"],
                "source_sha256": python["embed_sha256"],
                "files": _file_manifest(embed, embed_manifest_name),
            }
        ),
        encoding="utf-8",
    )
    (wheelhouse / wheel_manifest_name).write_text(
        json.dumps(
            {
                **common,
                "runtime_packages": contract["runtime_packages"],
                "bootstrap_packages": contract["bootstrap_packages"],
                "files": _file_manifest(wheelhouse, wheel_manifest_name),
            }
        ),
        encoding="utf-8",
    )
    return embed, wheelhouse


def test_bundle_contract_pins_cpython_and_build_backend() -> None:
    contract = json.loads(
        (ROOT / "config" / "python-runtime-bundle-lock.json").read_text(encoding="utf-8")
    )

    assert contract["python"]["version"] == "3.13.14"
    assert contract["python"]["platform"] == "win_amd64"
    assert contract["python"]["embed_sha256"] == (
        "90b4e5b9898b72d744650524bff92377c367f44bd5fbd09e3148656c080ad907"
    )
    build_lock = (ROOT / "requirements-build-lock.txt").read_text(encoding="utf-8")
    assert "pip==26.2" in build_lock
    assert "setuptools==83.0.0" in build_lock
    assert "wheel==0.47.0" in build_lock


def test_bundle_checker_accepts_exact_manifest_and_lock_fixture(tmp_path: Path) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "checker_valid")
    embed, wheelhouse = _build_valid_bundle(tmp_path)

    assert checker.validate_python_runtime_bundle(
        tmp_path,
        embed_dir=embed,
        wheelhouse_dir=wheelhouse,
        probe_python=False,
    ) == []


def test_bundle_checker_rejects_corrupt_wheel(tmp_path: Path) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "checker_corrupt")
    embed, wheelhouse = _build_valid_bundle(tmp_path)
    (wheelhouse / WHEEL_FILENAMES[0]).write_bytes(b"tampered")

    violations = checker.validate_python_runtime_bundle(
        tmp_path,
        embed_dir=embed,
        wheelhouse_dir=wheelhouse,
        probe_python=False,
    )

    assert any("checksum mismatch" in violation for violation in violations)


def test_bundle_checker_fails_closed_when_generated_resources_are_absent(
    tmp_path: Path,
) -> None:
    checker = _load_script("scripts/checks/check_python_runtime_bundle.py", "checker_missing")
    _copy_contract_files(tmp_path)

    violations = checker.validate_python_runtime_bundle(tmp_path, probe_python=False)

    assert any("manifest is missing or invalid" in violation for violation in violations)


def test_builder_enables_site_packages_idempotently(tmp_path: Path) -> None:
    builder = _load_script("scripts/build-python-runtime-bundle.py", "builder_path")
    path_file = tmp_path / "python313._pth"
    path_file.write_text("python313.zip\n.\n#import site\n", encoding="utf-8")

    builder._enable_embedded_site_packages(path_file)
    builder._enable_embedded_site_packages(path_file)

    assert path_file.read_text(encoding="utf-8").splitlines() == [
        "python313.zip",
        ".",
        "Lib/site-packages",
        "import site",
    ]


@pytest.mark.parametrize("member", ["../escape", "/absolute", "folder/../escape"])
def test_builder_rejects_archive_path_escape(member: str) -> None:
    builder = _load_script("scripts/build-python-runtime-bundle.py", f"builder_escape_{len(member)}")

    with pytest.raises(RuntimeError, match="unsafe path"):
        builder._safe_member_path(member)


def test_builder_download_command_is_hash_locked_to_cp313_win_amd64(
    tmp_path: Path,
    monkeypatch,
) -> None:
    builder = _load_script("scripts/build-python-runtime-bundle.py", "builder_pip")
    observed: list[str] = []

    def _fake_run(command, **kwargs):  # noqa: ANN001
        del kwargs
        observed.extend(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(builder.subprocess, "run", _fake_run)
    builder._run_pip_download(
        "python",
        tmp_path / "runtime-lock.txt",
        tmp_path / "wheels",
        {"platform": "win_amd64", "version": "3.13.14", "abi": "cp313"},
    )

    assert "--require-hashes" in observed
    assert "--only-binary=:all:" in observed
    assert observed[observed.index("--platform") + 1] == "win_amd64"
    assert observed[observed.index("--abi") + 1] == "cp313"


def test_embeddable_runtime_is_copied_instead_of_invoking_venv(tmp_path: Path) -> None:
    source = tmp_path / "python-embed"
    source.mkdir()
    (source / "python.exe").write_bytes(b"python")
    (source / "python313._pth").write_text("python313.zip\n", encoding="utf-8")
    (source / interpreter.EMBED_MANIFEST_FILENAME).write_text("{}", encoding="utf-8")
    staging = tmp_path / "runtime.build"

    assert interpreter._is_bundled_embeddable_interpreter(source / "python.exe")
    copied_python = interpreter._copy_embeddable_runtime(source / "python.exe", staging)

    assert copied_python == staging / "python.exe"
    assert copied_python.read_bytes() == b"python"


def test_embeddable_runtime_bootstraps_pip_from_verified_wheel(
    tmp_path: Path,
    monkeypatch,
) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    python_executable = runtime / "python.exe"
    python_executable.write_bytes(b"python")
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    pip_wheel = wheelhouse / "pip-26.2-py3-none-any.whl"
    with zipfile.ZipFile(pip_wheel, "w") as archive:
        archive.writestr("pip/__init__.py", "")
        archive.writestr("pip-26.2.dist-info/METADATA", "Name: pip\nVersion: 26.2\n")
    # The probe seam carries a failure detail now, not a bare bool, so the
    # bootstrap error can name its own cause. Same two-step contract: pip is
    # absent before extraction and present after it.
    availability = iter(((False, "pip probe exited 1"), (True, "")))
    monkeypatch.setattr(
        pip_bootstrap, "_probe_pip", lambda _python, **_kwargs: next(availability)
    )

    interpreter._ensure_offline_pip(python_executable, wheelhouse)

    assert (runtime / "Lib" / "site-packages" / "pip" / "__init__.py").is_file()
    assert (runtime / "Lib" / "site-packages" / "pip-26.2.dist-info" / "METADATA").is_file()


@pytest.mark.parametrize("unsafe_name", ("../escape.py", "safe.py:stream", "CON.txt"))
def test_embeddable_runtime_rejects_unsafe_pip_wheel_paths(
    tmp_path: Path,
    unsafe_name: str,
) -> None:
    pip_wheel = tmp_path / "pip.whl"
    site_packages = tmp_path / "site-packages"
    with zipfile.ZipFile(pip_wheel, "w") as archive:
        archive.writestr(unsafe_name, "unsafe")

    with pytest.raises(interpreter.PythonRuntimeWheelhouseIntegrityError, match="unsafe"):
        interpreter._extract_verified_pip_wheel(  # noqa: SLF001
            pip_wheel,
            site_packages,
        )

    assert not site_packages.exists()


def test_runtime_readiness_fingerprint_changes_with_transitive_lock(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    manifest = wheelhouse / interpreter.WHEELHOUSE_MANIFEST_FILENAME
    config = {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)}
    manifest.write_text(json.dumps({"runtime_lock_sha256": "a" * 64}), encoding="utf-8")
    first = interpreter._runtime_requirements_fingerprint(config)
    manifest.write_text(json.dumps({"runtime_lock_sha256": "b" * 64}), encoding="utf-8")

    second = interpreter._runtime_requirements_fingerprint(config)

    assert first != second
    assert interpreter._marker_matches_expected(
        {
            "schema_version": interpreter.RUNTIME_MARKER_SCHEMA_VERSION,
            "requirements_fingerprint": first,
            "interpreter_identity": "3.13.14",
            "validated_imports": list(interpreter._REQUIRED_IMPORT_NAMES),
        },
        second,
    ) is False


def _seed_publish_pair(tmp_path: Path) -> tuple[ModuleType, Path, Path, Path]:
    builder = _load_script("scripts/build-python-runtime-bundle.py", "builder_publish")
    embed_destination = tmp_path / "python-embed"
    wheelhouse_destination = tmp_path / "python-runtime-wheels"
    for destination, marker in (
        (embed_destination, "old-embed"),
        (wheelhouse_destination, "old-wheels"),
    ):
        destination.mkdir()
        (destination / "marker.txt").write_text(marker, encoding="utf-8")
    embed_staging = tmp_path / "embed-staging"
    embed_staging.mkdir()
    (embed_staging / "marker.txt").write_text("new-embed", encoding="utf-8")
    return builder, embed_destination, wheelhouse_destination, embed_staging


def test_publish_rolls_both_destinations_back_when_the_second_move_fails(
    tmp_path: Path,
) -> None:
    """The embed and wheelhouse trees are one artifact and must publish together.

    Publishing them with two independent moves let the first succeed and the
    second fail, leaving a new interpreter beside a stale wheelhouse -- a pairing
    no manifest describes and nothing downstream detects.
    """
    builder, embed_destination, wheelhouse_destination, embed_staging = _seed_publish_pair(tmp_path)
    missing_wheelhouse_staging = tmp_path / "wheelhouse-staging-that-was-never-created"

    with pytest.raises(OSError):
        builder._publish_directories(
            (
                (embed_staging, embed_destination),
                (missing_wheelhouse_staging, wheelhouse_destination),
            )
        )

    assert (embed_destination / "marker.txt").read_text(encoding="utf-8") == "old-embed"
    assert (wheelhouse_destination / "marker.txt").read_text(encoding="utf-8") == "old-wheels"


def test_publish_swaps_both_destinations_and_clears_the_backups(tmp_path: Path) -> None:
    builder, embed_destination, wheelhouse_destination, embed_staging = _seed_publish_pair(tmp_path)
    wheelhouse_staging = tmp_path / "wheelhouse-staging"
    wheelhouse_staging.mkdir()
    (wheelhouse_staging / "marker.txt").write_text("new-wheels", encoding="utf-8")

    builder._publish_directories(
        (
            (embed_staging, embed_destination),
            (wheelhouse_staging, wheelhouse_destination),
        )
    )

    assert (embed_destination / "marker.txt").read_text(encoding="utf-8") == "new-embed"
    assert (wheelhouse_destination / "marker.txt").read_text(encoding="utf-8") == "new-wheels"
    for destination in (embed_destination, wheelhouse_destination):
        assert not destination.with_name(f".{destination.name}.previous").exists()
