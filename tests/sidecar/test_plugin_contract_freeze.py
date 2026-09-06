"""Semantic coverage for the all-or-nothing plugin V1 contract freeze gate."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from scripts.checks import check_plugin_contract_freeze as freeze_check

SCHEMA_NAMES = ["_common.schema.json", *[f"plugin-{index:02d}.schema.json" for index in range(24)]]


def test_frozen_contract_files_are_pinned_to_lf() -> None:
    attributes = (freeze_check.ROOT / ".gitattributes").read_text(encoding="utf-8")
    lines = attributes.splitlines()

    assert "*.js text eol=lf" in lines
    assert "*.mjs text eol=lf" in lines
    assert "*.html text eol=lf" in lines
    assert "*.css text eol=lf" in lines
    assert "*.json text eol=lf" in lines
    assert "config/plugins/v1/*.json text eol=lf" in lines
    assert "config/plugins/contract-lock.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/v2/*.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/contract-lock-v2.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/v3/*.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/contract-lock-v3.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/v4/*.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/contract-lock-v4.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/v5/*.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/contract-lock-v5.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/v6/*.json text eol=lf" in attributes.splitlines()
    assert "config/plugins/contract-lock-v6.json text eol=lf" in attributes.splitlines()
    assert (
        "config/plugins/extensions/session-provider-v1/*.json text eol=lf" in lines
    )
    assert "config/plugins/contract-lock-session-provider-v1.json text eol=lf" in lines


def _write_schemas(contract_dir: Path, *, count: int = 25, frozen: bool) -> dict[str, str]:
    contract_dir.mkdir(parents=True)
    digests: dict[str, str] = {}
    for name in SCHEMA_NAMES[:count]:
        path = contract_dir / name
        payload = (json.dumps({"frozen": frozen}, indent=2) + "\n").encode("utf-8")
        path.write_bytes(payload)
        relative = f"config/plugins/v1/{name}"
        digests[relative] = hashlib.sha256(payload).hexdigest()
    return digests


def _configure_session_provider_contracts(
    source_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contract_dir = (
        tmp_path / "config" / "plugins" / "extensions" / "session-provider-v1"
    )
    shutil.copytree(
        source_root / "config" / "plugins" / "extensions" / "session-provider-v1",
        contract_dir,
    )
    lock_path = (
        tmp_path / "config" / "plugins" / "contract-lock-session-provider-v1.json"
    )
    shutil.copy2(
        source_root / "config" / "plugins" / "contract-lock-session-provider-v1.json",
        lock_path,
    )
    monkeypatch.setattr(freeze_check, "SESSION_PROVIDER_V1_CONTRACT_DIR", contract_dir)
    monkeypatch.setattr(freeze_check, "SESSION_PROVIDER_V1_LOCK_PATH", lock_path)


def _configure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    source_root = freeze_check.ROOT
    contract_dir = tmp_path / "config" / "plugins" / "v1"
    lock_path = tmp_path / "config" / "plugins" / "contract-lock.json"
    v2_contract_dir = tmp_path / "config" / "plugins" / "v2"
    v2_lock_path = tmp_path / "config" / "plugins" / "contract-lock-v2.json"
    v3_contract_dir = tmp_path / "config" / "plugins" / "v3"
    v3_lock_path = tmp_path / "config" / "plugins" / "contract-lock-v3.json"
    monkeypatch.setattr(freeze_check, "ROOT", tmp_path)
    monkeypatch.setattr(freeze_check, "CONTRACT_DIR", contract_dir)
    monkeypatch.setattr(freeze_check, "LOCK_PATH", lock_path)
    monkeypatch.setattr(freeze_check, "V2_CONTRACT_DIR", v2_contract_dir)
    monkeypatch.setattr(freeze_check, "V2_LOCK_PATH", v2_lock_path)
    monkeypatch.setattr(freeze_check, "V3_CONTRACT_DIR", v3_contract_dir)
    monkeypatch.setattr(freeze_check, "V3_LOCK_PATH", v3_lock_path)
    for version in (4, 5, 6):
        source_dir = source_root / "config" / "plugins" / f"v{version}"
        target_dir = tmp_path / "config" / "plugins" / f"v{version}"
        shutil.copytree(source_dir, target_dir)
        source_lock = source_root / "config" / "plugins" / f"contract-lock-v{version}.json"
        target_lock = tmp_path / "config" / "plugins" / f"contract-lock-v{version}.json"
        shutil.copy2(source_lock, target_lock)
        monkeypatch.setattr(freeze_check, f"V{version}_CONTRACT_DIR", target_dir)
        monkeypatch.setattr(freeze_check, f"V{version}_LOCK_PATH", target_lock)
    _configure_session_provider_contracts(source_root, tmp_path, monkeypatch)
    source_abi = source_root / "config" / "plugins" / "capability-abi" / "v1" / "jenny-restricted-host.wit"
    target_abi = tmp_path / "config" / "plugins" / "capability-abi" / "v1" / "jenny-restricted-host.wit"
    target_abi.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_abi, target_abi)
    source_abi_lock = source_root / "config" / "plugins" / "capability-abi-lock-v1.json"
    target_abi_lock = tmp_path / "config" / "plugins" / "capability-abi-lock-v1.json"
    shutil.copy2(source_abi_lock, target_abi_lock)
    monkeypatch.setattr(freeze_check, "ABI_PATH", target_abi)
    monkeypatch.setattr(freeze_check, "ABI_LOCK_PATH", target_abi_lock)
    v2_contract_dir.mkdir(parents=True)
    v2_digests = {}
    for index in range(freeze_check.EXPECTED_V2_FROZEN_FILE_COUNT):
        name = "_common.schema.json" if index == 0 else f"plugin-v2-{index:02d}.schema.json"
        schema_path = v2_contract_dir / name
        payload = (json.dumps({"frozen": True, "contract_version": 2}, indent=2) + "\n").encode("utf-8")
        schema_path.write_bytes(payload)
        v2_digests[f"config/plugins/v2/{name}"] = hashlib.sha256(payload).hexdigest()
    _write_lock(v2_lock_path, v2_digests)
    v3_contract_dir.mkdir(parents=True)
    v3_digests = {}
    for index in range(freeze_check.EXPECTED_V3_FROZEN_FILE_COUNT):
        name = "_common.schema.json" if index == 0 else f"plugin-v3-{index:02d}.schema.json"
        version = 3 if index < 6 else 1
        schema_path = v3_contract_dir / name
        payload = (json.dumps({"frozen": True, "contract_version": version}, indent=2) + "\n").encode("utf-8")
        schema_path.write_bytes(payload)
        v3_digests[f"config/plugins/v3/{name}"] = hashlib.sha256(payload).hexdigest()
    _write_lock(v3_lock_path, v3_digests)
    return contract_dir, lock_path


def _write_lock(lock_path: Path, contracts: dict[str, str], **extra: object) -> None:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    document = {"lock_schema_version": 1, "contracts": contracts, **extra}
    lock_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def test_all_unfrozen_contracts_without_a_lock_remain_a_valid_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, _lock_path = _configure(tmp_path, monkeypatch)
    _write_schemas(contract_dir, frozen=False)

    assert freeze_check.main() == 0
    assert (
        "no frozen V1 contracts yet; 7 V2 + 10 V3 + 8 V4 + 9 V5 + 14 V6 + "
        "3 session-provider V1 frozen contracts; 1 ABI lock"
        in capsys.readouterr().out
    )


def test_partial_freeze_is_rejected_without_a_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, _lock_path = _configure(tmp_path, monkeypatch)
    _write_schemas(contract_dir, frozen=False)
    first = contract_dir / SCHEMA_NAMES[0]
    first.write_text(json.dumps({"frozen": True}) + "\n", encoding="utf-8")

    assert freeze_check.main() == 1
    output = capsys.readouterr().out
    assert "V1 freeze is all-or-nothing" in output
    assert "must contain exactly 25 entries; found 0" in output


def test_exact_25_entry_lock_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    digests = _write_schemas(contract_dir, frozen=True)
    _write_lock(lock_path, digests)

    assert freeze_check.main() == 0
    assert (
        "25 V1 + 7 V2 + 10 V3 + 8 V4 + 9 V5 + 14 V6 + "
        "3 session-provider V1 frozen contracts; 1 ABI lock"
        in capsys.readouterr().out
    )


def test_checkout_line_endings_do_not_change_canonical_digest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    digests = _write_schemas(contract_dir, frozen=True)
    for path in contract_dir.glob("*.json"):
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    _write_lock(lock_path, digests)

    assert freeze_check.main() == 0
    assert (
        "25 V1 + 7 V2 + 10 V3 + 8 V4 + 9 V5 + 14 V6 + "
        "3 session-provider V1 frozen contracts; 1 ABI lock"
        in capsys.readouterr().out
    )


def test_bare_cr_line_endings_are_not_git_canonical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    digests = _write_schemas(contract_dir, frozen=True)
    for path in contract_dir.glob("*.json"):
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r"))
    _write_lock(lock_path, digests)

    assert freeze_check.main() == 1
    assert "does not match its recorded digest" in capsys.readouterr().out


def test_wrong_schema_and_lock_counts_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    digests = _write_schemas(contract_dir, count=24, frozen=True)
    _write_lock(lock_path, digests)

    assert freeze_check.main() == 1
    output = capsys.readouterr().out
    assert "requires exactly 25 schema files; found 24" in output
    assert "must contain exactly 25 entries; found 24" in output


def test_missing_extra_and_mismatched_lock_entries_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    digests = _write_schemas(contract_dir, frozen=True)
    missing = next(iter(digests))
    mismatch = list(digests)[1]
    contracts = dict(digests)
    contracts.pop(missing)
    contracts[mismatch] = "0" * 64
    contracts["config/plugins/v1/missing.schema.json"] = "1" * 64
    _write_lock(lock_path, contracts)

    assert freeze_check.main() == 1
    output = capsys.readouterr().out
    assert f"{missing} is frozen but has no entry" in output
    assert f"{mismatch} does not match its recorded digest" in output
    assert "references missing file config/plugins/v1/missing.schema.json" in output


def test_malformed_lock_version_and_extra_fields_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    digests = _write_schemas(contract_dir, frozen=True)
    _write_lock(lock_path, digests, lock_schema_version=2, unexpected=True)

    assert freeze_check.main() == 1
    output = capsys.readouterr().out
    assert "must declare lock_schema_version 1" in output
    assert "may contain only lock_schema_version and contracts" in output


def test_v2_lock_digest_mismatch_is_rejected_independently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    _write_lock(lock_path, _write_schemas(contract_dir, frozen=True))
    v2_lock = json.loads(freeze_check.V2_LOCK_PATH.read_text(encoding="utf-8"))
    first = next(iter(v2_lock["contracts"]))
    v2_lock["contracts"][first] = "0" * 64
    freeze_check.V2_LOCK_PATH.write_text(json.dumps(v2_lock), encoding="utf-8")

    assert freeze_check.main() == 1
    assert "does not match its recorded V2 digest" in capsys.readouterr().out


def test_v3_lock_digest_mismatch_is_rejected_independently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    _write_lock(lock_path, _write_schemas(contract_dir, frozen=True))
    v3_lock = json.loads(freeze_check.V3_LOCK_PATH.read_text(encoding="utf-8"))
    first = next(iter(v3_lock["contracts"]))
    v3_lock["contracts"][first] = "0" * 64
    freeze_check.V3_LOCK_PATH.write_text(json.dumps(v3_lock), encoding="utf-8")

    assert freeze_check.main() == 1
    assert "does not match its recorded V3 digest" in capsys.readouterr().out


def test_v3_rejects_an_unrecognized_contract_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    contract_dir, lock_path = _configure(tmp_path, monkeypatch)
    _write_lock(lock_path, _write_schemas(contract_dir, frozen=True))
    path = next(freeze_check.V3_CONTRACT_DIR.glob("*.json"))
    path.write_text(json.dumps({"frozen": True, "contract_version": 2}) + "\n", encoding="utf-8")
    lock = json.loads(freeze_check.V3_LOCK_PATH.read_text(encoding="utf-8"))
    lock["contracts"][path.relative_to(tmp_path).as_posix()] = freeze_check._sha256(path)
    freeze_check.V3_LOCK_PATH.write_text(json.dumps(lock), encoding="utf-8")

    assert freeze_check.main() == 1
    assert "must be a frozen V3 contract" in capsys.readouterr().out
