"""Versioned contract helpers for the workspace mutation journal."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import stat
import struct
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence, cast

from sidecar.ai.error_codes import (
    CMP_TOOL_DISABLED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)

CANONICALIZATION = "jenny_canonical_json_v1"
MAX_JOURNAL_BYTES = 4 * 1024 * 1024
MAX_JOURNAL_ENTRIES = 10_000
MAX_VALIDATION_ERRORS = 32
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()

JournalState = Literal["prepared", "in_progress", "committed", "rolled_back", "interrupted"]
SignatureKind = Literal["missing", "file", "directory", "symlink", "junction", "other"]
OperationKind = Literal["create", "modify", "delete", "move"]
OperationStatus = Literal[
    "planned", "applying", "applied", "undoing", "undone", "skipped", "conflict", "unknown"
]

_DRIVE_RE = re.compile(r"^[A-Za-z]:")


@dataclass(frozen=True)
class ContractFailure:
    code: str
    reason: str
    message: str
    details: tuple[str, ...] = ()


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    failure: ContractFailure | None = None


@dataclass(frozen=True)
class ParseResult:
    ok: bool
    record: dict[str, Any] | None = None
    failure: ContractFailure | None = None


@dataclass(frozen=True)
class SignatureResult:
    ok: bool
    signature: PathSignature | None = None
    failure: ContractFailure | None = None


@dataclass(frozen=True)
class PathSignature:
    kind: SignatureKind
    byte_size: int
    sha256: str

    def as_dict(self) -> dict[str, object]:
        return {"kind": self.kind, "byte_size": self.byte_size, "sha256": self.sha256}

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> PathSignature:
        return cls(
            kind=cast(SignatureKind, value["kind"]),
            byte_size=cast(int, value["byte_size"]),
            sha256=cast(str, value["sha256"]),
        )


@dataclass(frozen=True)
class WorkspaceIdentity:
    configured_path: str
    real_path: str
    device_id: str
    file_id: str
    fingerprint: str
    workspace_id: str

    def as_dict(self) -> dict[str, object]:
        return {
            "configured_path": self.configured_path,
            "real_path": self.real_path,
            "device_id": self.device_id,
            "file_id": self.file_id,
            "fingerprint": self.fingerprint,
            "workspace_id": self.workspace_id,
        }


@dataclass(frozen=True)
class JournalHeader:
    schema_version: int
    change_set_id: str
    state: JournalState
    workspace: WorkspaceIdentity
    session_id: str | None
    turn_id: str | None
    actor: Literal["sidecar_tools", "explorer"]


@dataclass(frozen=True)
class JournalOperation:
    sequence: int
    status: OperationStatus
    kind: OperationKind
    tool_name: str
    tool_call_id: str
    observed_at: str
    source: Mapping[str, object] | None
    destination: Mapping[str, object] | None


@dataclass(frozen=True)
class SignatureLimits:
    max_entries: int = 100_000
    max_bytes: int = 8 * 1024 * 1024 * 1024


@dataclass
class _SignatureBudget:
    limits: SignatureLimits
    entries: int = 0
    bytes_seen: int = 0

    def add_entry(self) -> None:
        self.entries += 1
        if self.entries > self.limits.max_entries:
            raise _SignatureBound("signature_entry_cap_exceeded")

    def add_bytes(self, count: int) -> None:
        self.bytes_seen += count
        if self.bytes_seen > self.limits.max_bytes:
            raise _SignatureBound("signature_byte_cap_exceeded")


class _SignatureBound(Exception):
    pass


def canonical_json_bytes(value: object) -> bytes:
    """Return deterministic UTF-8 JSON terminated by exactly one LF."""

    text = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return text.encode("utf-8") + b"\n"


def seal_record(record: Mapping[str, Any]) -> dict[str, Any]:
    """Copy a record and replace its integrity member with canonical payload metadata."""

    sealed = copy.deepcopy(dict(record))
    sealed.pop("integrity", None)
    payload = canonical_json_bytes(sealed)
    sealed["integrity"] = {
        "canonicalization": CANONICALIZATION,
        "payload_byte_length": len(payload),
        "payload_sha256": hashlib.sha256(payload).hexdigest(),
    }
    return sealed


def verify_record_integrity(record: Mapping[str, Any]) -> ValidationResult:
    integrity = record.get("integrity")
    if not isinstance(integrity, Mapping):
        return _failure("journal_integrity_missing", "Journal integrity metadata is missing.")
    payload_record = copy.deepcopy(dict(record))
    payload_record.pop("integrity", None)
    try:
        payload = canonical_json_bytes(payload_record)
    except (TypeError, ValueError, OverflowError):
        return _failure("journal_canonicalization_failed", "Journal payload is not canonical JSON.")
    expected_length = integrity.get("payload_byte_length")
    expected_hash = integrity.get("payload_sha256")
    if expected_length != len(payload) or expected_hash != hashlib.sha256(payload).hexdigest():
        return _failure("journal_checksum_mismatch", "Journal checksum verification failed.")
    return ValidationResult(ok=True)


def validate_relative_path(value: object) -> ValidationResult:
    if not isinstance(value, str) or not value:
        return _failure("journal_path_invalid", "Journal path must be a non-empty string.")
    if value != unicodedata.normalize("NFC", value):
        return _failure("journal_path_not_nfc", "Journal path must be NFC-normalized.")
    has_drive = any(_DRIVE_RE.match(part) for part in value.split("/"))
    if "\\" in value or value.startswith("/") or has_drive:
        return _failure("journal_path_not_relative", "Journal path must be relative and use '/'.")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return _failure("journal_path_invalid", "Journal path contains an unsafe segment.")
    if "\x00" in value:
        return _failure("journal_path_invalid", "Journal path contains an invalid character.")
    return ValidationResult(ok=True)


def workspace_identity(workspace_root: str | Path) -> WorkspaceIdentity:
    configured = Path(workspace_root).expanduser().absolute()
    configured_stat = configured.lstat()
    real = configured.resolve(strict=True)
    root_stat = real.stat()
    if (
        stat.S_ISLNK(configured_stat.st_mode)
        or _is_junction(configured)
        or not stat.S_ISDIR(configured_stat.st_mode)
    ):
        raise ValueError("workspace root must be a real directory")
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ValueError("workspace root must resolve to a real directory")
    configured_text = unicodedata.normalize("NFC", configured.as_posix())
    real_text = unicodedata.normalize("NFC", real.as_posix())
    fingerprint_path = real_text.casefold() if os.name == "nt" else real_text
    device_id = str(root_stat.st_dev)
    file_id = str(root_stat.st_ino)
    fingerprint_input = (
        f"jenny-workspace-v1\0{fingerprint_path}\0{device_id}\0{file_id}".encode("utf-8")
    )
    fingerprint = hashlib.sha256(fingerprint_input).hexdigest()
    return WorkspaceIdentity(
        configured_path=configured_text,
        real_path=real_text,
        device_id=device_id,
        file_id=file_id,
        fingerprint=fingerprint,
        workspace_id=f"ws_{fingerprint[:32]}",
    )
def signature_for_path(
    path: str | Path, *, limits: SignatureLimits | None = None
) -> SignatureResult:
    budget = _SignatureBudget(limits or SignatureLimits())
    try:
        signature = _sign_path(Path(path), budget)
    except _SignatureBound as error:
        return SignatureResult(
            ok=False,
            failure=ContractFailure(
                code=CMP_TOOL_OUTSIDE_WORKSPACE,
                reason=str(error),
                message="Workspace signature exceeded its configured resource bound.",
            ),
        )
    except (OSError, UnicodeError, ValueError) as error:
        return SignatureResult(
            ok=False,
            failure=ContractFailure(
                code=CMP_TOOL_INVALID_PATH,
                reason="signature_failed",
                message="Workspace signature could not be completed.",
                details=(type(error).__name__,),
            ),
        )
    return SignatureResult(ok=True, signature=signature)


def _sign_path(path: Path, budget: _SignatureBudget) -> PathSignature:
    signature, _descendants = _sign_node(path, budget)
    return signature


def _sign_node(
    path: Path, budget: _SignatureBudget
) -> tuple[PathSignature, list[tuple[bytes, PathSignature]]]:
    try:
        path_stat = path.lstat()
    except FileNotFoundError:
        return PathSignature("missing", 0, EMPTY_SHA256), []
    budget.add_entry()
    if _is_junction(path):
        return _sign_link(path, "junction", budget), []
    if stat.S_ISLNK(path_stat.st_mode):
        return _sign_link(path, "symlink", budget), []
    if stat.S_ISREG(path_stat.st_mode):
        return _sign_file(path, budget), []
    if stat.S_ISDIR(path_stat.st_mode):
        return _sign_directory(path, budget)
    signature = PathSignature("other", 0, hashlib.sha256(b"jenny-other-v1\0").hexdigest())
    return signature, []


def _is_junction(path: Path) -> bool:
    checker = getattr(os.path, "isjunction", None)
    if checker is not None and checker(path):
        return True
    try:
        path_stat = path.lstat()
    except OSError:
        return False
    mount_point_tag = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)
    return getattr(path_stat, "st_reparse_tag", None) == mount_point_tag


def _sign_link(
    path: Path, kind: Literal["symlink", "junction"], budget: _SignatureBudget
) -> PathSignature:
    target = os.readlink(path)
    target_bytes = os.fsencode(target)
    budget.add_bytes(len(target_bytes))
    return PathSignature(kind, len(target_bytes), hashlib.sha256(target_bytes).hexdigest())


def _sign_file(path: Path, budget: _SignatureBudget) -> PathSignature:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            size += len(chunk)
            budget.add_bytes(len(chunk))
            digest.update(chunk)
    return PathSignature("file", size, digest.hexdigest())


def _sign_directory(
    path: Path, budget: _SignatureBudget
) -> tuple[PathSignature, list[tuple[bytes, PathSignature]]]:
    rows: list[tuple[bytes, PathSignature]] = []
    with os.scandir(path) as entries:
        children = sorted(entries, key=lambda item: _normalized_name_bytes(item.name))
    total_bytes = 0
    for child in children:
        name_bytes = _normalized_name_bytes(child.name)
        child_signature, descendants = _sign_node(Path(child.path), budget)
        rows.append((name_bytes, child_signature))
        rows.extend(
            (name_bytes + b"/" + relative, signature)
            for relative, signature in descendants
        )
        total_bytes += child_signature.byte_size
    digest = hashlib.sha256(b"jenny-directory-signature-v1\0")
    rows.sort(key=lambda item: item[0])
    for name_bytes, child_signature in rows:
        digest.update(_directory_frame(name_bytes, child_signature))
    signature = PathSignature("directory", total_bytes, digest.hexdigest())
    return signature, rows


def _normalized_name_bytes(name: str) -> bytes:
    return unicodedata.normalize("NFC", name).encode("utf-8")


def _directory_frame(name: bytes, signature: PathSignature) -> bytes:
    kind = signature.kind.encode("ascii")
    digest = bytes.fromhex(signature.sha256)
    return b"".join(
        (
            struct.pack(">H", len(kind)),
            kind,
            struct.pack(">I", len(name)),
            name,
            struct.pack(">Q", signature.byte_size),
            digest,
        )
    )


def load_journal_schema() -> dict[str, Any]:
    schema_path = (
        Path(__file__).resolve().parents[3]
        / "config"
        / "workspace-mutation-journal-v1.schema.json"
    )
    parsed = json.loads(schema_path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError("workspace mutation journal schema root is not an object")
    return cast(dict[str, Any], parsed)


def validate_record(record: object) -> ValidationResult:
    try:
        schema = load_journal_schema()
    except (OSError, UnicodeError, json.JSONDecodeError, RuntimeError) as error:
        return _failure(
            "journal_schema_unavailable",
            "Workspace journal schema is unavailable.",
            (type(error).__name__,),
        )
    issues: list[str] = []
    _validate_schema_value(record, schema, schema, "$", issues)
    if isinstance(record, dict) and not issues:
        issues.extend(_semantic_issues(cast(dict[str, Any], record)))
    if issues:
        return _failure(
            "journal_schema_invalid",
            "Workspace journal does not match schema version 1.",
            tuple(issues[:MAX_VALIDATION_ERRORS]),
        )
    return ValidationResult(ok=True)


def parse_record_bytes(
    data: bytes,
    *,
    byte_cap: int = MAX_JOURNAL_BYTES,
    entry_cap: int = MAX_JOURNAL_ENTRIES,
) -> ParseResult:
    if len(data) > byte_cap:
        return _parse_failure("journal_oversized", "Workspace journal exceeds its byte cap.")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, OverflowError, RecursionError):
        return _parse_failure("journal_parse_failed", "Workspace journal is not valid UTF-8 JSON.")
    if isinstance(value, dict):
        operations = value.get("operations")
        if isinstance(operations, list) and len(operations) > entry_cap:
            return _parse_failure(
                "journal_entry_cap_exceeded",
                "Workspace journal exceeds its operation entry cap.",
            )
    return _validate_parsed_record(value, data)


def _validate_parsed_record(value: object, data: bytes) -> ParseResult:
    validation = validate_record(value)
    if not validation.ok:
        return ParseResult(ok=False, failure=validation.failure)
    record = cast(dict[str, Any], value)
    integrity = verify_record_integrity(record)
    if not integrity.ok:
        return ParseResult(ok=False, failure=integrity.failure)
    canonical = canonical_json_bytes(record)
    if data != canonical:
        return _parse_failure("journal_not_canonical", "Workspace journal is not canonical JSON.")
    return ParseResult(ok=True, record=record)


def _validate_schema_value(
    value: object,
    schema: Mapping[str, Any],
    root: Mapping[str, Any],
    path: str,
    issues: list[str],
) -> None:
    if len(issues) >= MAX_VALIDATION_ERRORS:
        return
    resolved = _resolve_schema(schema, root)
    if "anyOf" in resolved:
        options = cast(Sequence[Mapping[str, Any]], resolved["anyOf"])
        if not _matches_any(value, options, root, path):
            issues.append(f"{path}: does not match any allowed shape")
        return
    if not _matches_type(value, resolved.get("type")):
        issues.append(f"{path}: invalid type")
        return
    if "const" in resolved and value != resolved["const"]:
        issues.append(f"{path}: must equal {resolved['const']!r}")
    if "enum" in resolved and value not in resolved["enum"]:
        issues.append(f"{path}: value is not allowed")
    if isinstance(value, str):
        _validate_string(value, resolved, path, issues)
    elif isinstance(value, list):
        _validate_array(value, resolved, root, path, issues)
    elif isinstance(value, dict):
        _validate_object(value, resolved, root, path, issues)
    elif isinstance(value, int) and not isinstance(value, bool):
        _validate_integer(value, resolved, path, issues)
    _validate_all_of(value, resolved, root, path, issues)


def _validate_all_of(
    value: object,
    schema: Mapping[str, Any],
    root: Mapping[str, Any],
    path: str,
    issues: list[str],
) -> None:
    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        for condition in all_of:
            if isinstance(condition, Mapping):
                _validate_conditional(value, condition, root, path, issues)


def _validate_conditional(
    value: object,
    schema: Mapping[str, Any],
    root: Mapping[str, Any],
    path: str,
    issues: list[str],
) -> None:
    condition = schema.get("if")
    consequence = schema.get("then")
    if not isinstance(condition, Mapping) or not isinstance(consequence, Mapping):
        _validate_schema_value(value, schema, root, path, issues)
        return
    probe: list[str] = []
    _validate_schema_value(value, condition, root, path, probe)
    if not probe:
        _validate_schema_value(value, consequence, root, path, issues)


def _resolve_schema(schema: Mapping[str, Any], root: Mapping[str, Any]) -> Mapping[str, Any]:
    reference = schema.get("$ref")
    if not isinstance(reference, str):
        return schema
    if not reference.startswith("#/"):
        return {}
    current: object = root
    for part in reference[2:].split("/"):
        if not isinstance(current, Mapping) or part not in current:
            return {}
        current = current[part]
    return cast(Mapping[str, Any], current) if isinstance(current, Mapping) else {}


def _matches_any(
    value: object,
    options: Sequence[Mapping[str, Any]],
    root: Mapping[str, Any],
    path: str,
) -> bool:
    for option in options:
        local: list[str] = []
        _validate_schema_value(value, option, root, path, local)
        if not local:
            return True
    return False


def _matches_type(value: object, expected: object) -> bool:
    if expected is None:
        return True
    choices = [expected] if isinstance(expected, str) else expected
    if not isinstance(choices, list):
        return False
    return any(_matches_one_type(value, item) for item in choices)


def _matches_one_type(value: object, expected: object) -> bool:
    return {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "null": value is None,
    }.get(str(expected), False)


def _validate_string(
    value: str, schema: Mapping[str, Any], path: str, issues: list[str]
) -> None:
    minimum = schema.get("minLength")
    maximum = schema.get("maxLength")
    pattern = schema.get("pattern")
    if isinstance(minimum, int) and len(value) < minimum:
        issues.append(f"{path}: string is too short")
    if isinstance(maximum, int) and len(value) > maximum:
        issues.append(f"{path}: string is too long")
    if isinstance(pattern, str) and re.search(pattern, value) is None:
        issues.append(f"{path}: string does not match the required pattern")


def _validate_array(
    value: list[object],
    schema: Mapping[str, Any],
    root: Mapping[str, Any],
    path: str,
    issues: list[str],
) -> None:
    minimum = schema.get("minItems")
    maximum = schema.get("maxItems")
    if isinstance(minimum, int) and len(value) < minimum:
        issues.append(f"{path}: array has too few items")
    if isinstance(maximum, int) and len(value) > maximum:
        issues.append(f"{path}: array has too many items")
    if schema.get("uniqueItems") is True and len({_freeze(item) for item in value}) != len(value):
        issues.append(f"{path}: array items must be unique")
    item_schema = schema.get("items")
    if isinstance(item_schema, Mapping):
        for index, item in enumerate(value):
            _validate_schema_value(item, item_schema, root, f"{path}[{index}]", issues)


def _validate_object(
    value: dict[object, object],
    schema: Mapping[str, Any],
    root: Mapping[str, Any],
    path: str,
    issues: list[str],
) -> None:
    properties = schema.get("properties", {})
    required = schema.get("required", [])
    if isinstance(required, list):
        for key in required:
            if key not in value:
                issues.append(f"{path}: missing required property {key}")
    allowed = properties if isinstance(properties, Mapping) else {}
    if schema.get("additionalProperties") is False:
        for key in value:
            if key not in allowed:
                issues.append(f"{path}: unknown property {key}")
    maximum = schema.get("maxProperties")
    if isinstance(maximum, int) and len(value) > maximum:
        issues.append(f"{path}: object has too many properties")
    for key, child_schema in allowed.items():
        if key in value and isinstance(child_schema, Mapping):
            _validate_schema_value(value[key], child_schema, root, f"{path}.{key}", issues)


def _validate_integer(
    value: int, schema: Mapping[str, Any], path: str, issues: list[str]
) -> None:
    minimum = schema.get("minimum")
    maximum = schema.get("maximum")
    if isinstance(minimum, int) and value < minimum:
        issues.append(f"{path}: integer is below minimum")
    if isinstance(maximum, int) and value > maximum:
        issues.append(f"{path}: integer is above maximum")


def _semantic_issues(record: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    operations = cast(list[dict[str, Any]], record["operations"])
    sequences = [operation["sequence"] for operation in operations]
    if sequences != list(range(1, len(operations) + 1)):
        issues.append("$.operations: sequences must be one-based and gap-free")
    if record["operation_count"] != len(operations):
        issues.append("$.operation_count: must equal operations length")
    completed = cast(list[int], record["completed_sequences"])
    applied = [item["sequence"] for item in operations if item["status"] == "applied"]
    if completed != applied:
        issues.append("$.completed_sequences: must exactly list applied operation sequences")
    workspace = cast(dict[str, Any], record["workspace"])
    if workspace["workspace_id"] != f"ws_{workspace['fingerprint'][:32]}":
        issues.append("$.workspace.workspace_id: must derive from fingerprint")
    if record["actor"] == "sidecar_tools" and not record["tool_call_ids"]:
        issues.append("$.tool_call_ids: sidecar_tools actor requires at least one id")
    if record["actor"] == "sidecar_tools" and (
        record["session_id"] is None or record["turn_id"] is None
    ):
        issues.append("$: sidecar_tools actor requires session_id and turn_id")
    if record["actor"] == "explorer" and (
        record["session_id"] is not None or record["turn_id"] is not None
    ):
        issues.append("$: explorer actor cannot carry chat identity")
    tool_call_ids = cast(list[str], record["tool_call_ids"])
    if record["actor"] == "sidecar_tools" and any(
        operation["tool_call_id"] not in tool_call_ids for operation in operations
    ):
        issues.append("$.operations: tool_call_id must be declared in the header")
    if record["actor"] == "sidecar_tools" and any(
        operation["tool_name"] == "explorer_rename" for operation in operations
    ):
        issues.append("$.operations: sidecar_tools cannot use explorer attribution")
    if record["actor"] == "explorer" and any(
        operation["tool_name"] != "explorer_rename" for operation in operations
    ):
        issues.append("$.operations: explorer operations require explorer attribution")
    issues.extend(_nested_value_issues(record))
    issues.extend(_retention_issues(record))
    for index, operation in enumerate(operations):
        issues.extend(_operation_issues(operation, index))
    return issues


def _operation_issues(operation: dict[str, Any], index: int) -> list[str]:
    issues: list[str] = []
    base = f"$.operations[{index}]"
    issues.extend(_operation_shape_issues(operation, base))
    return issues


_PATH_FIELDS = frozenset(
    {
        "relative_path",
        "workspace_relative_path",
        "from_relative_path",
        "to_relative_path",
        "alternate_relative_path",
        "stage_relative_path",
    }
)


def _nested_value_issues(value: object, path: str = "$") -> list[str]:
    issues: list[str] = []
    if isinstance(value, dict):
        if value.get("kind") == "missing" and (
            value.get("byte_size") != 0 or value.get("sha256") != EMPTY_SHA256
        ):
            issues.append(f"{path}: missing signature must use the zero-byte digest")
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key in _PATH_FIELDS and child is not None:
                if not validate_relative_path(child).ok:
                    issues.append(f"{child_path}: unsafe path")
            else:
                issues.extend(_nested_value_issues(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            issues.extend(_nested_value_issues(child, f"{path}[{index}]"))
    return issues


def _retention_issues(record: Mapping[str, Any]) -> list[str]:
    objects: dict[str, dict[str, Any]] = {}
    inconsistent = False
    operations = cast(list[dict[str, Any]], record["operations"])
    restore = cast(dict[str, Any], record["restore"])
    candidates = [
        *(
            recovery
            for operation in operations
            for recovery in cast(list[dict[str, Any]], operation["recovery_objects"])
        ),
        *cast(list[dict[str, Any]], restore["protected_occupants"]),
    ]
    for recovery in candidates:
        object_id = cast(str, recovery["object_id"])
        if object_id in objects and objects[object_id] != recovery:
            inconsistent = True
        objects[object_id] = recovery
    retention = cast(dict[str, Any], record["retention"])
    referenced = cast(list[str], retention["referenced_object_ids"])
    expected_bytes = sum(
        cast(int, cast(dict[str, Any], recovery["signature"])["byte_size"])
        for recovery in objects.values()
    )
    issues: list[str] = []
    if inconsistent:
        issues.append("$.retention: duplicate recovery object ids must describe one object")
    if set(referenced) != set(objects):
        issues.append("$.retention.referenced_object_ids: must exactly match recovery objects")
    if retention["reserved_entries"] != len(objects):
        issues.append("$.retention.reserved_entries: must equal unique recovery object count")
    if retention["reserved_bytes"] != expected_bytes:
        issues.append("$.retention.reserved_bytes: must equal unique recovery object bytes")
    return issues


def _operation_shape_issues(operation: dict[str, Any], base: str) -> list[str]:
    issues: list[str] = []
    kind = operation["kind"]
    source = operation["source"]
    destination = operation["destination"]
    if kind in {"create", "modify"} and (source is not None or destination is None):
        issues.append(f"{base}: {kind} requires only destination")
    if kind == "delete" and (source is None or destination is not None):
        issues.append(f"{base}: delete requires only source")
    if kind == "move" and (source is None or destination is None):
        issues.append(f"{base}: move requires source and destination")
    if kind in {"modify", "delete"} and not operation["recovery_objects"]:
        issues.append(f"{base}: {kind} requires a recovery object")
    issues.extend(_operation_signature_issues(operation, base))
    return issues


def _operation_signature_issues(operation: dict[str, Any], base: str) -> list[str]:
    issues: list[str] = []
    kind = operation["kind"]
    source = operation["source"]
    destination = operation["destination"]
    if kind == "create" and destination["pre_signature"]["kind"] != "missing":
        issues.append(f"{base}: create destination pre-signature must be missing")
    if kind == "create" and destination["post_signature"]["kind"] == "missing":
        issues.append(f"{base}: create destination post-signature cannot be missing")
    if kind == "delete" and source["post_signature"]["kind"] != "missing":
        issues.append(f"{base}: delete source post-signature must be missing")
    if kind == "move" and source["post_signature"]["kind"] != "missing":
        issues.append(f"{base}: move source post-signature must be missing")
    if kind == "move" and source["pre_signature"] != destination["post_signature"]:
        issues.append(f"{base}: move signatures must preserve the moved object")
    if kind == "move" and destination["pre_signature"]["kind"] != "missing":
        if not operation["recovery_objects"]:
            issues.append(f"{base}: overwritten move destination requires recovery")
    return issues


def _freeze(value: object) -> str:
    try:
        return canonical_json_bytes(value).decode("utf-8")
    except (TypeError, ValueError, OverflowError):
        return repr(value)


def _failure(reason: str, message: str, details: tuple[str, ...] = ()) -> ValidationResult:
    return ValidationResult(
        ok=False,
        failure=ContractFailure(
            code=CMP_TOOL_DISABLED, reason=reason, message=message, details=details
        ),
    )


def _parse_failure(reason: str, message: str) -> ParseResult:
    return ParseResult(
        ok=False,
        failure=ContractFailure(code=CMP_TOOL_DISABLED, reason=reason, message=message),
    )
