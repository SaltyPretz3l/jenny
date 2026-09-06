"""Enforce independently locked plugin-platform contract immutability.

Every file under config/plugins/v1/ carrying ``"frozen": true`` must match the
SHA-256 recorded in config/plugins/contract-lock.json after CRLF checkout
smudging is removed. The repository pins these files to LF in .gitattributes,
while CRLF normalization keeps already-open Windows worktrees verifiable after
that rule lands. Editing a frozen contract is never legal — the only legal move
is adding a new versioned contract file. Flipping the full set to frozen and
writing the lock file is the mechanical Stage 3 exit gate
(PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md, "Contract laboratory").
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = ROOT / "config" / "plugins" / "v1"
LOCK_PATH = ROOT / "config" / "plugins" / "contract-lock.json"
EXPECTED_FROZEN_FILE_COUNT = 25  # _common + 24 named V1 contracts
LOCK_DOCUMENT_KEYS = {"lock_schema_version", "contracts"}
V2_CONTRACT_DIR = ROOT / "config" / "plugins" / "v2"
V2_LOCK_PATH = ROOT / "config" / "plugins" / "contract-lock-v2.json"
EXPECTED_V2_FROZEN_FILE_COUNT = 7
V2_CONTRACT_VERSION = 2
V3_CONTRACT_DIR = ROOT / "config" / "plugins" / "v3"
V3_LOCK_PATH = ROOT / "config" / "plugins" / "contract-lock-v3.json"
EXPECTED_V3_FROZEN_FILE_COUNT = 10
V3_CONTRACT_VERSIONS = frozenset({1, 3})
V4_CONTRACT_DIR = ROOT / "config" / "plugins" / "v4"
V4_LOCK_PATH = ROOT / "config" / "plugins" / "contract-lock-v4.json"
EXPECTED_V4_FROZEN_FILE_COUNT = 8
V4_CONTRACT_VERSIONS = frozenset({4})
V5_CONTRACT_DIR = ROOT / "config" / "plugins" / "v5"
V5_LOCK_PATH = ROOT / "config" / "plugins" / "contract-lock-v5.json"
EXPECTED_V5_FROZEN_FILE_COUNT = 9
V5_CONTRACT_VERSIONS = frozenset({5})
V6_CONTRACT_DIR = ROOT / "config" / "plugins" / "v6"
V6_LOCK_PATH = ROOT / "config" / "plugins" / "contract-lock-v6.json"
EXPECTED_V6_FROZEN_FILE_COUNT = 14
V6_CONTRACT_VERSIONS = frozenset({6})
SESSION_PROVIDER_V1_CONTRACT_DIR = (
    ROOT / "config" / "plugins" / "extensions" / "session-provider-v1"
)
SESSION_PROVIDER_V1_LOCK_PATH = (
    ROOT / "config" / "plugins" / "contract-lock-session-provider-v1.json"
)
EXPECTED_SESSION_PROVIDER_V1_FROZEN_FILE_COUNT = 3
SESSION_PROVIDER_V1_CONTRACT_VERSIONS = frozenset({1})
ABI_PATH = ROOT / "config" / "plugins" / "capability-abi" / "v1" / "jenny-restricted-host.wit"
ABI_LOCK_PATH = ROOT / "config" / "plugins" / "capability-abi-lock-v1.json"


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _sha256(path: Path) -> str:
    canonical_bytes = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(canonical_bytes).hexdigest()


def _load_schema_state(violations: list[str]) -> tuple[set[str], dict[str, str]]:
    frozen_files: dict[str, str] = {}
    schema_files: set[str] = set()
    if not CONTRACT_DIR.exists():
        return schema_files, frozen_files
    for path in sorted(CONTRACT_DIR.glob("*.json")):
        relative_path = _rel(path)
        schema_files.add(relative_path)
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            violations.append(f"{relative_path} is unreadable as JSON: {error}")
            continue
        if isinstance(document, dict) and document.get("frozen") is True:
            frozen_files[relative_path] = _sha256(path)
    return schema_files, frozen_files


def _load_lock_entries(violations: list[str]) -> dict[str, str]:
    if not LOCK_PATH.exists():
        return {}
    try:
        document = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        violations.append(f"{_rel(LOCK_PATH)} is unreadable as JSON: {error}")
        return {}
    if not isinstance(document, dict):
        violations.append(f"{_rel(LOCK_PATH)} must be a JSON object")
        return {}
    if document.get("lock_schema_version") != 1:
        violations.append(f"{_rel(LOCK_PATH)} must declare lock_schema_version 1")
    if set(document) != LOCK_DOCUMENT_KEYS:
        violations.append(
            f"{_rel(LOCK_PATH)} may contain only lock_schema_version and contracts"
        )
    entries = document.get("contracts")
    if not isinstance(entries, dict):
        violations.append(
            f"{_rel(LOCK_PATH)} must contain a 'contracts' object mapping path -> sha256"
        )
        return {}
    lock_entries: dict[str, str] = {}
    for key, value in entries.items():
        if not isinstance(key, str) or not isinstance(value, str):
            violations.append(f"{_rel(LOCK_PATH)} has a non-string contract entry")
            continue
        lock_entries[key] = value.lower()
    return lock_entries


def _validate_freeze_shape(
    schema_files: set[str], frozen_files: dict[str, str], lock_entries: dict[str, str]
) -> list[str]:
    violations: list[str] = []
    if len(schema_files) != EXPECTED_FROZEN_FILE_COUNT:
        violations.append(
            f"V1 freeze requires exactly {EXPECTED_FROZEN_FILE_COUNT} schema files; "
            f"found {len(schema_files)}"
        )
    if frozen_files.keys() != schema_files:
        missing = sorted(schema_files - frozen_files.keys())
        violations.append(
            "V1 freeze is all-or-nothing; unfrozen files: " + ", ".join(missing)
        )
    if len(lock_entries) != EXPECTED_FROZEN_FILE_COUNT:
        violations.append(
            f"{_rel(LOCK_PATH)} must contain exactly {EXPECTED_FROZEN_FILE_COUNT} entries; "
            f"found {len(lock_entries)}"
        )
    return violations


def _validate_lock_digests(
    frozen_files: dict[str, str], lock_entries: dict[str, str]
) -> list[str]:
    violations: list[str] = []
    for rel_path, digest in sorted(frozen_files.items()):
        recorded = lock_entries.get(rel_path)
        if recorded is None:
            violations.append(
                f"{rel_path} is frozen but has no entry in {_rel(LOCK_PATH)}"
            )
        elif recorded != digest:
            violations.append(
                f"{rel_path} does not match its recorded digest — frozen contracts are "
                "immutable; add a new versioned contract instead of editing"
            )
    for rel_path in sorted(lock_entries):
        candidate = ROOT / rel_path
        if not candidate.exists():
            violations.append(f"{_rel(LOCK_PATH)} references missing file {rel_path}")
        elif rel_path not in frozen_files:
            violations.append(
                f"{rel_path} is recorded in the lock but no longer marked frozen — "
                "unfreezing is never legal"
            )
    return violations


def _report_violations(violations: list[str]) -> int:
    print("FAIL: plugin contract freeze check")
    for item in violations:
        print(f"  - {item}")
    return 1


def _validate_versioned_freeze(  # noqa: PLR0913
    violations: list[str],
    *,
    label: str,
    contract_dir: Path,
    lock_path: Path,
    expected_count: int,
    contract_versions: frozenset[int],
) -> int:
    """Validate one separately versioned contract-family lock."""
    schema_files = sorted(contract_dir.glob("*.json"))
    if len(schema_files) != expected_count:
        violations.append(
            f"{label} freeze requires exactly {expected_count} schema files; "
            f"found {len(schema_files)}"
        )
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        violations.append(f"{_rel(lock_path)} is unreadable as JSON: {error}")
        return 0
    if not isinstance(lock, dict) or set(lock) != LOCK_DOCUMENT_KEYS:
        violations.append(f"{_rel(lock_path)} has an invalid lock document shape")
        return 0
    entries = lock.get("contracts")
    if lock.get("lock_schema_version") != 1 or not isinstance(entries, dict):
        violations.append(f"{_rel(lock_path)} must declare schema 1 and a contracts map")
        return 0
    actual: dict[str, str] = {}
    for path in schema_files:
        rel_path = _rel(path)
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            violations.append(f"{rel_path} is unreadable as JSON: {error}")
            continue
        if not isinstance(document, dict):
            violations.append(f"{rel_path} must be a JSON object")
            continue
        if (
            document.get("frozen") is not True
            or document.get("contract_version") not in contract_versions
        ):
            violations.append(f"{rel_path} must be a frozen {label} contract")
        actual[rel_path] = _sha256(path)
    if set(entries) != set(actual):
        violations.append(f"{_rel(lock_path)} must exactly cover the {label} schema directory")
    for rel_path, digest in actual.items():
        if entries.get(rel_path) != digest:
            violations.append(f"{rel_path} does not match its recorded {label} digest")
    return len(actual)


def _validate_v2_freeze(violations: list[str]) -> int:
    return _validate_versioned_freeze(
        violations,
        label="V2",
        contract_dir=V2_CONTRACT_DIR,
        lock_path=V2_LOCK_PATH,
        expected_count=EXPECTED_V2_FROZEN_FILE_COUNT,
        contract_versions=frozenset({V2_CONTRACT_VERSION}),
    )


def _validate_v3_freeze(violations: list[str]) -> int:
    return _validate_versioned_freeze(
        violations,
        label="V3",
        contract_dir=V3_CONTRACT_DIR,
        lock_path=V3_LOCK_PATH,
        expected_count=EXPECTED_V3_FROZEN_FILE_COUNT,
        contract_versions=V3_CONTRACT_VERSIONS,
    )


def _validate_v4_freeze(violations: list[str]) -> int:
    return _validate_versioned_freeze(
        violations,
        label="V4",
        contract_dir=V4_CONTRACT_DIR,
        lock_path=V4_LOCK_PATH,
        expected_count=EXPECTED_V4_FROZEN_FILE_COUNT,
        contract_versions=V4_CONTRACT_VERSIONS,
    )


def _validate_v5_freeze(violations: list[str]) -> int:
    return _validate_versioned_freeze(
        violations,
        label="V5",
        contract_dir=V5_CONTRACT_DIR,
        lock_path=V5_LOCK_PATH,
        expected_count=EXPECTED_V5_FROZEN_FILE_COUNT,
        contract_versions=V5_CONTRACT_VERSIONS,
    )


def _validate_v6_freeze(violations: list[str]) -> int:
    return _validate_versioned_freeze(
        violations,
        label="V6",
        contract_dir=V6_CONTRACT_DIR,
        lock_path=V6_LOCK_PATH,
        expected_count=EXPECTED_V6_FROZEN_FILE_COUNT,
        contract_versions=V6_CONTRACT_VERSIONS,
    )


def _validate_session_provider_v1_freeze(violations: list[str]) -> int:
    return _validate_versioned_freeze(
        violations,
        label="session-provider V1",
        contract_dir=SESSION_PROVIDER_V1_CONTRACT_DIR,
        lock_path=SESSION_PROVIDER_V1_LOCK_PATH,
        expected_count=EXPECTED_SESSION_PROVIDER_V1_FROZEN_FILE_COUNT,
        contract_versions=SESSION_PROVIDER_V1_CONTRACT_VERSIONS,
    )


def _validate_abi_lock(violations: list[str]) -> int:
    try:
        document = json.loads(ABI_LOCK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        violations.append(f"{_rel(ABI_LOCK_PATH)} is unreadable as JSON: {error}")
        return 0
    expected_keys = {"lock_schema_version", "abi", "path", "sha256"}
    if not isinstance(document, dict) or set(document) != expected_keys:
        violations.append(f"{_rel(ABI_LOCK_PATH)} has an invalid lock document shape")
        return 0
    if document.get("lock_schema_version") != 1 \
            or document.get("abi") != "jenny:plugin/restricted-host@1.0.0":
        violations.append(f"{_rel(ABI_LOCK_PATH)} has an invalid ABI identity")
    if document.get("path") != _rel(ABI_PATH):
        violations.append(f"{_rel(ABI_LOCK_PATH)} does not point at the canonical WIT file")
    if not ABI_PATH.exists() or document.get("sha256") != _sha256(ABI_PATH):
        violations.append(f"{_rel(ABI_PATH)} does not match its recorded ABI digest")
    return 1


def main() -> int:
    violations: list[str] = []
    schema_files, frozen_files = _load_schema_state(violations)
    lock_entries = _load_lock_entries(violations)
    v2_count = _validate_v2_freeze(violations)
    v3_count = _validate_v3_freeze(violations)
    v4_count = _validate_v4_freeze(violations)
    v5_count = _validate_v5_freeze(violations)
    v6_count = _validate_v6_freeze(violations)
    session_provider_v1_count = _validate_session_provider_v1_freeze(violations)
    abi_count = _validate_abi_lock(violations)

    if not frozen_files and not lock_entries:
        if violations:
            return _report_violations(violations)
        print(
            "PASS: plugin contract freeze check "
            f"(no frozen V1 contracts yet; {v2_count} V2 + {v3_count} V3 + "
            f"{v4_count} V4 + {v5_count} V5 + {v6_count} V6 + "
            f"{session_provider_v1_count} session-provider V1 frozen contracts; "
            f"{abi_count} ABI lock)"
        )
        return 0

    violations.extend(_validate_freeze_shape(schema_files, frozen_files, lock_entries))
    violations.extend(_validate_lock_digests(frozen_files, lock_entries))
    if violations:
        return _report_violations(violations)
    print(
        "PASS: plugin contract freeze check "
        f"({len(frozen_files)} V1 + {v2_count} V2 + {v3_count} V3 + "
        f"{v4_count} V4 + {v5_count} V5 + {v6_count} V6 + "
        f"{session_provider_v1_count} session-provider V1 frozen contracts; "
        f"{abi_count} ABI lock)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
