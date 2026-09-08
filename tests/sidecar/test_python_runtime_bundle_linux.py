from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
LINUX_CONTRACT = ROOT / "config" / "python-runtime-bundle-lock.linux-x64.json"
WINDOWS_CONTRACT = ROOT / "config" / "python-runtime-bundle-lock.json"


def _load_script(module_suffix: str) -> ModuleType:
    script_path = ROOT / "scripts" / "build-python-runtime-bundle.py"
    module_name = f"test_python_runtime_bundle_linux_{module_suffix}"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load script: {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _add_file(
    bundle: tarfile.TarFile,
    scratch: Path,
    name: str,
    content: bytes,
    mode: int = 0o644,
) -> None:
    source = scratch / f"source-{len(bundle.getmembers())}"
    source.write_bytes(content)
    source.chmod(mode)
    bundle.add(source, arcname=name, recursive=False)


def _add_link(
    bundle: tarfile.TarFile,
    name: str,
    target: str,
    *,
    link_type: bytes = tarfile.SYMTYPE,
) -> None:
    member = tarfile.TarInfo(name)
    member.type = link_type
    member.linkname = target
    member.mode = 0o777
    bundle.addfile(member)


def _add_directory(bundle: tarfile.TarFile, name: str) -> None:
    member = tarfile.TarInfo(name)
    member.type = tarfile.DIRTYPE
    member.mode = 0o755
    bundle.addfile(member)


def _extract(builder: ModuleType, archive: Path, destination: Path, **caps: int) -> None:
    builder._extract_embed_archive(  # noqa: SLF001
        archive,
        destination,
        archive_format="tar.gz",
        strip_prefix="python",
        max_members=caps.get("max_members", 100),
        max_extracted_bytes=caps.get("max_extracted_bytes", 1024),
    )


def _write_valid_archive(tmp_path: Path, name: str = "python.tar.gz") -> Path:
    archive = tmp_path / name
    scratch = tmp_path / f"{name}.sources"
    scratch.mkdir()
    with tarfile.open(archive, "w:gz") as bundle:
        _add_file(bundle, scratch, "python/bin/python3.13", b"ELF", 0o755)
        _add_link(bundle, "python/bin/python3", "python3.13")
        _add_link(bundle, "python/bin/python", "python3")
        _add_file(bundle, scratch, "python/lib/libpython3.13.so.1.0", b"LIB")
        _add_link(bundle, "python/lib/libpython3.13.so", "libpython3.13.so.1.0")
        _add_file(bundle, scratch, "python/lib/python3.13/os.py", b"# os")
    return archive


def test_extract_pbs_tar_strips_prefix_and_materializes_symlinks(tmp_path: Path) -> None:
    builder = _load_script("extract")
    destination = tmp_path / "python-embed"

    _extract(builder, _write_valid_archive(tmp_path), destination)

    assert (destination / "bin/python3.13").read_bytes() == b"ELF"
    assert (destination / "bin/python3").read_bytes() == b"ELF"
    assert (destination / "bin/python").read_bytes() == b"ELF"
    assert (destination / "lib/libpython3.13.so").read_bytes() == b"LIB"
    assert (destination / "lib/python3.13/os.py").is_file()
    for relative in ("bin/python3.13", "bin/python3", "bin/python"):
        assert os.access(destination / relative, os.X_OK)
    assert not any(os.path.islink(path) for path in destination.rglob("*"))


def test_extract_pbs_tar_skips_excluded_paths_but_resolves_through_them(tmp_path: Path) -> None:
    builder = _load_script("excludes")
    destination = tmp_path / "python-embed"

    builder._extract_embed_archive(  # noqa: SLF001
        _write_valid_archive(tmp_path),
        destination,
        archive_format="tar.gz",
        strip_prefix="python",
        max_members=100,
        max_extracted_bytes=1024,
        excludes=("bin/python3", "lib/libpython3.13.so"),
    )

    assert not (destination / "bin/python3").exists()
    assert not (destination / "lib/libpython3.13.so").exists()
    # bin/python -> python3 -> python3.13: the excluded alias still resolves the chain.
    assert (destination / "bin/python").read_bytes() == b"ELF"
    assert (destination / "bin/python3.13").read_bytes() == b"ELF"
    assert (destination / "lib/libpython3.13.so.1.0").read_bytes() == b"LIB"


@pytest.mark.parametrize(
    "shape",
    [
        "outside_prefix",
        "parent_member",
        "absolute_link",
        "escaping_link",
        "directory_link",
        "missing_link",
        "hard_link",
        "character_device",
    ],
)
def test_extract_pbs_tar_rejects_unsafe_members(tmp_path: Path, shape: str) -> None:
    builder = _load_script(f"reject_{shape}")
    archive = tmp_path / f"{shape}.tar.gz"
    scratch = tmp_path / "sources"
    scratch.mkdir()
    with tarfile.open(archive, "w:gz") as bundle:
        if shape == "outside_prefix":
            _add_file(bundle, scratch, "other/x", b"x")
        elif shape == "parent_member":
            _add_file(bundle, scratch, "python/../escape", b"x")
        elif shape in {"absolute_link", "escaping_link", "missing_link"}:
            targets = {
                "absolute_link": "/python/bin/python3.13",
                "escaping_link": "../../outside",
                "missing_link": "missing",
            }
            _add_link(bundle, "python/bin/python", targets[shape])
        elif shape == "directory_link":
            _add_directory(bundle, "python/lib/python3.13")
            _add_link(bundle, "python/lib/current", "python3.13")
        elif shape == "hard_link":
            _add_link(bundle, "python/bin/python", "python/bin/python3.13", link_type=tarfile.LNKTYPE)
        else:
            member = tarfile.TarInfo("python/dev/tty")
            member.type = tarfile.CHRTYPE
            bundle.addfile(member)

    with pytest.raises(RuntimeError):
        _extract(builder, archive, tmp_path / "destination")

    assert not (tmp_path / "escape").exists()
    assert not (tmp_path / "outside").exists()


def test_extract_pbs_tar_enforces_member_and_byte_caps(tmp_path: Path) -> None:
    builder = _load_script("caps")
    archive = tmp_path / "caps.tar.gz"
    scratch = tmp_path / "sources"
    scratch.mkdir()
    with tarfile.open(archive, "w:gz") as bundle:
        _add_file(bundle, scratch, "python/a", b"ab")
        _add_file(bundle, scratch, "python/b", b"cd")

    with pytest.raises(RuntimeError, match="too many members"):
        _extract(builder, archive, tmp_path / "members", max_members=1)
    with pytest.raises(RuntimeError, match="configured limit"):
        _extract(builder, archive, tmp_path / "declared", max_extracted_bytes=1)
    with pytest.raises(RuntimeError, match="configured limit"):
        _extract(builder, archive, tmp_path / "counter", max_extracted_bytes=3)


def test_load_contract_accepts_shipped_contracts_and_resolves_defaults() -> None:
    builder = _load_script("contracts")

    linux = builder._load_contract(LINUX_CONTRACT)  # noqa: SLF001
    windows = builder._load_contract(WINDOWS_CONTRACT)  # noqa: SLF001

    assert linux["python"]["distribution"] == "python-build-standalone"
    assert linux["python"]["archive_format"] == "tar.gz"
    assert windows["python"]["distribution"] == "cpython-embeddable"
    assert windows["python"]["archive_format"] == "zip"
    assert "platform_tags" not in windows["python"]
    assert windows["python"]["exclude"] == []
    assert linux["python"]["exclude"] == [
        "bin/python",
        "bin/python3",
        "lib/libpython3.13.so",
        "include",
        "share",
    ]
    assert windows["python"]["max_members"] == builder.MAX_ARCHIVE_MEMBERS
    assert windows["python"]["max_extracted_bytes"] == builder.MAX_EXTRACTED_BYTES


def test_load_contract_rejects_invalid_pbs_contracts(tmp_path: Path) -> None:
    builder = _load_script("invalid_contracts")
    original = json.loads(LINUX_CONTRACT.read_text(encoding="utf-8"))

    invalid_contracts = []
    missing_prefix = json.loads(json.dumps(original))
    missing_prefix["python"].pop("strip_prefix")
    invalid_contracts.append(missing_prefix)
    missing_platform = json.loads(json.dumps(original))
    missing_platform["python"]["platform_tags"] = ["manylinux_2_17_x86_64"]
    invalid_contracts.append(missing_platform)
    wrong_format = json.loads(json.dumps(original))
    wrong_format["python"]["archive_format"] = "zip"
    invalid_contracts.append(wrong_format)
    bad_caps = json.loads(json.dumps(original))
    bad_caps["python"]["max_archive_bytes"] = bad_caps["python"]["max_extracted_bytes"] + 1
    invalid_contracts.append(bad_caps)

    bad_exclude = json.loads(json.dumps(original))
    bad_exclude["python"]["exclude"] = ["../escape"]
    invalid_contracts.append(bad_exclude)

    for index, contract in enumerate(invalid_contracts):
        path = tmp_path / f"invalid-{index}.json"
        path.write_text(json.dumps(contract), encoding="utf-8")
        with pytest.raises(RuntimeError):
            builder._load_contract(path)  # noqa: SLF001


def test_linux_pip_download_uses_all_platform_tags(tmp_path: Path, monkeypatch) -> None:
    builder = _load_script("pip")
    python_contract = builder._load_contract(LINUX_CONTRACT)["python"]  # noqa: SLF001
    observed: list[str] = []

    def _fake_run(command, **kwargs):  # noqa: ANN001
        del kwargs
        observed.extend(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(builder.subprocess, "run", _fake_run)
    builder._run_pip_download(  # noqa: SLF001
        "python", tmp_path / "runtime-lock.txt", tmp_path / "wheels", python_contract
    )

    indexes = [index for index, value in enumerate(observed) if value == "--platform"]
    assert [observed[index + 1] for index in indexes] == python_contract["platform_tags"]
    assert observed[observed.index("--abi") + 1] == "cp313"
    assert observed[observed.index("--python-version") + 1] == "3.13.15"
    assert "--require-hashes" in observed
    assert "--only-binary=:all:" in observed


def test_build_runtime_bundle_from_pbs_archive(tmp_path: Path, monkeypatch) -> None:
    builder = _load_script("build")
    archive = _write_valid_archive(tmp_path)
    contract = json.loads(LINUX_CONTRACT.read_text(encoding="utf-8"))
    contract["python"]["embed_url"] = "https://example.invalid/python.tar.gz"
    contract["python"]["embed_sha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
    contract["python"]["max_archive_bytes"] = archive.stat().st_size + 1
    contract_path = tmp_path / "contract.json"
    contract_path.write_text(json.dumps(contract), encoding="utf-8")

    def _fake_download(_python, _lock, destination, _contract):  # noqa: ANN001
        (destination / "x-1.0-py3-none-any.whl").write_bytes(b"wheel")

    monkeypatch.setattr(builder, "_run_pip_download", _fake_download)
    embed = tmp_path / "vendor" / "python-embed"
    wheelhouse = tmp_path / "vendor" / "python-runtime-wheels"
    builder.build_runtime_bundle(
        contract_path=contract_path,
        python_executable="python",
        embed_destination=embed,
        wheelhouse_destination=wheelhouse,
        embed_archive=archive,
    )

    manifest = json.loads((embed / "python-embed-manifest.json").read_text(encoding="utf-8"))
    assert manifest["distribution"] == "python-build-standalone"
    assert manifest["platform"] == "manylinux_2_28_x86_64"
    assert manifest["sys_platform"] == "linux"
    assert manifest["platform_tags"] == contract["python"]["platform_tags"]
    assert os.access(embed / "bin/python3.13", os.X_OK)
    assert not list(embed.rglob("*._pth"))
