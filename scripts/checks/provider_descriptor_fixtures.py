"""Load and structurally validate the ChatGPT provider-descriptor fixtures.

One loader serves both live consumers:

  - ``scripts/checks/check_provider_descriptor_fixtures.py`` (schema + registry
    + redaction gate, run from ``scripts/checks/run_all.py``), and
  - ``tests/sidecar/ai/plugins/test_provider_descriptor_conformance.py`` (runs
    every executable case against the real engine).

That shape mirrors ``scripts/checks/plugin_parity_corpus.py``: one loader, cases
co-located with their frozen expectations, so a case cannot be added without an
expectation and cannot be added without the gate seeing it.

Deliberately NOT the codegen-parity pattern (generator -> twin JS/Python
validators -> byte diff): that exists to prove two independent implementations
agree, and here there is exactly one implementation and no second runtime. No
descriptor interpreter is built or implied by this module.

Pure stdlib, no sidecar imports: the check script must run in the policy lane
without the sidecar dependency set.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = ROOT / "tests" / "fixtures" / "plugins" / "provider-descriptor"
INDEX_NAME = "index.json"
SCHEMA_VERSION = 1


class ProviderDescriptorFixtureError(ValueError):
    """Raised when a fixture document is structurally invalid."""


# Closed binding vocabulary. Every executable case names one of these, and
# tests/sidecar/ai/plugins/provider_descriptor_bindings.py must supply an
# adapter for exactly this set (asserted by the conformance suite).
BINDING_VOCABULARY: frozenset[str] = frozenset(
    {
        "constant_identity",
        "context_catalog",
        "endpoint",
        "event_recognition",
        "function_tools",
        "initial_status",
        "input_items",
        "model_context_length",
        "reasoning_cache",
        "reasoning_effort",
        "request_headers",
        "responses_payload",
        "sse_stream",
        "tool_loop_turns",
    }
)

# Per-binding closed key vocabularies. Closing `expect` is what keeps the
# mutation suite honest: an expectation key no adapter reads would produce a
# mutant that changes nothing and still passes.
BINDING_INPUT_KEYS: dict[str, frozenset[str]] = {
    "constant_identity": frozenset({"name"}),
    "context_catalog": frozenset({"unknown_model"}),
    "endpoint": frozenset({"base_url", "sse_lines"}),
    "event_recognition": frozenset({"events"}),
    "function_tools": frozenset({"tools"}),
    "initial_status": frozenset({"status_code", "response_headers", "response_body"}),
    "input_items": frozenset({"prompt", "system", "messages"}),
    "model_context_length": frozenset({"model"}),
    "reasoning_cache": frozenset({"requested_max_reasoning_items", "captures"}),
    "reasoning_effort": frozenset({"value"}),
    "request_headers": frozenset({"account_id"}),
    "responses_payload": frozenset(
        {"model", "prompt", "system", "messages", "tools", "reasoning_effort"}
    ),
    "sse_stream": frozenset({"sse_lines", "raw_byte_framing", "prompt", "tools"}),
    "tool_loop_turns": frozenset({"turn_1", "turn_2"}),
}

BINDING_EXPECT_KEYS: dict[str, frozenset[str]] = {
    "constant_identity": frozenset({"value"}),
    "context_catalog": frozenset(
        {"catalog", "catalog_version", "catalog_source", "fallback_context_length"}
    ),
    "endpoint": frozenset({"method", "path", "base_url", "payload_fields"}),
    "event_recognition": frozenset({"stream_items", "result", "diagnostics"}),
    "function_tools": frozenset({"tools"}),
    "initial_status": frozenset(
        {
            "error_type",
            "status_code",
            "classification",
            "retryable",
            "code",
            "body",
            "message",
            "retry_after_seconds",
            "retry_after_is_non_negative",
        }
    ),
    "input_items": frozenset({"instructions", "items"}),
    "model_context_length": frozenset({"context_length"}),
    "reasoning_cache": frozenset({"cached_call_ids", "cache_size", "max_reasoning_items"}),
    "reasoning_effort": frozenset({"wire_value"}),
    "request_headers": frozenset({"headers", "declared_header_names"}),
    "responses_payload": frozenset({"payload_fields", "payload_key_set"}),
    "sse_stream": frozenset({"stream_items", "result", "diagnostics", "error"}),
    "tool_loop_turns": frozenset(
        {
            "turn_1_stream_items",
            "turn_1_result",
            "turn_1_request_tools",
            "turn_2_request_input_items",
            "turn_2_result",
        }
    ),
}

FIXTURE_REQUIRED_KEYS: frozenset[str] = frozenset(
    {
        "fixture_id",
        "schema_version",
        "description",
        "source_tests",
        "declarative_verdict",
        "cases",
        "non_executable",
    }
)
FIXTURE_OPTIONAL_KEYS: frozenset[str] = frozenset(
    {"constants", "notes", "executable", "reason"}
)
FIXTURE_ALLOWED_KEYS = FIXTURE_REQUIRED_KEYS | FIXTURE_OPTIONAL_KEYS

CASE_EXECUTABLE_KEYS: frozenset[str] = frozenset(
    {"case_id", "executable", "binding", "input", "expect", "rule"}
)
CASE_NON_EXECUTABLE_KEYS: frozenset[str] = frozenset(
    {"case_id", "executable", "reason", "rule"}
)

INDEX_REQUIRED_KEYS: frozenset[str] = frozenset(
    {
        "spike",
        "schema_version",
        "question",
        "verdict_doc",
        "extracted_from",
        "redaction_note",
        "minimum_executable_cases",
        "non_executable_fixtures",
        "files",
    }
)

# Redaction guard. The directory's own redaction_note claims no real credential
# ever lands here; this makes that claim mechanical rather than a promise.
# ``Bearer ${ACCESS_TOKEN}`` does not match (the substitution braces are outside
# the token charset), which is exactly why header templates use a constant.
SECRET_SHAPED_RE = re.compile(
    r"(?i)bearer\s+[A-Za-z0-9_\-./+=]{12,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
)

_PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def fixture_paths() -> list[Path]:
    """Every fixture document except the registry, in deterministic order."""
    return sorted(
        path
        for path in FIXTURES_DIR.rglob("*.json")
        if path.name != INDEX_NAME
    )


def fixture_id_for(path: Path) -> str:
    """Path-derived identity: the posix path under the fixture root, sans suffix."""
    relative = path.relative_to(FIXTURES_DIR).as_posix()
    return relative[: -len(".json")]


def registry_key_for(path: Path) -> str:
    return path.relative_to(FIXTURES_DIR).as_posix()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProviderDescriptorFixtureError(f"{path.name}: unreadable JSON ({error})") from error


def load_index() -> dict[str, Any]:
    document = _read_json(FIXTURES_DIR / INDEX_NAME)
    if not isinstance(document, dict):
        raise ProviderDescriptorFixtureError(f"{INDEX_NAME}: top level must be an object")
    return document


def load_fixture(path: Path) -> dict[str, Any]:
    document = _read_json(path)
    if not isinstance(document, dict):
        raise ProviderDescriptorFixtureError(f"{path.name}: top level must be an object")
    return document


def substitute(value: Any, constants: dict[str, Any], *, where: str) -> Any:
    """Expand ``${NAME}`` references against a fixture's ``constants`` block.

    A string that is EXACTLY one reference yields the constant's raw value (so a
    non-string constant keeps its type); an embedded reference is interpolated.
    """
    if isinstance(value, str):
        whole = _PLACEHOLDER_RE.fullmatch(value)
        if whole is not None:
            name = whole.group(1)
            if name not in constants:
                raise ProviderDescriptorFixtureError(f"{where}: undeclared constant '{name}'")
            return constants[name]

        def _replace(match: re.Match[str]) -> str:
            name = match.group(1)
            if name not in constants:
                raise ProviderDescriptorFixtureError(f"{where}: undeclared constant '{name}'")
            return str(constants[name])

        return _PLACEHOLDER_RE.sub(_replace, value)
    if isinstance(value, list):
        return [substitute(item, constants, where=where) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, constants, where=where) for key, item in value.items()}
    return value


def _validate_case(
    fixture_id: str,
    case: Any,
    seen_case_ids: set[str],
) -> list[str]:
    where = f"{fixture_id}"
    if not isinstance(case, dict):
        return [f"{where}: every entry of 'cases' must be an object"]
    case_id = case.get("case_id")
    if not isinstance(case_id, str) or not case_id.strip():
        return [f"{where}: every case needs a non-empty string 'case_id'"]
    where = f"{fixture_id}#{case_id}"
    errors: list[str] = []
    if case_id in seen_case_ids:
        errors.append(f"{where}: duplicate case_id within the fixture")
    seen_case_ids.add(case_id)

    executable = case.get("executable")
    if not isinstance(executable, bool):
        # Declared, never implied: an absent flag is a fixture that has not
        # decided whether it proves anything.
        return errors + [f"{where}: 'executable' must be present as a literal boolean"]

    rule = case.get("rule")
    if not isinstance(rule, str) or not rule.strip():
        errors.append(f"{where}: every case needs a non-empty 'rule'")

    if not executable:
        unknown = set(case) - CASE_NON_EXECUTABLE_KEYS
        if unknown:
            errors.append(f"{where}: unknown key(s) {sorted(unknown)} on a non-executable case")
        reason = case.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            errors.append(f"{where}: a non-executable case needs a non-empty 'reason'")
        return errors

    unknown = set(case) - CASE_EXECUTABLE_KEYS
    if unknown:
        errors.append(f"{where}: unknown key(s) {sorted(unknown)} on an executable case")
    binding = case.get("binding")
    if not isinstance(binding, str) or not binding.strip() or binding not in BINDING_VOCABULARY:
        errors.append(f"{where}: binding {binding!r} is outside the closed vocabulary")
        return errors

    case_input = case.get("input")
    if not isinstance(case_input, dict):
        errors.append(f"{where}: 'input' must be present as an object (it may be empty)")
    else:
        extra_input = set(case_input) - BINDING_INPUT_KEYS[binding]
        if extra_input:
            errors.append(f"{where}: input key(s) {sorted(extra_input)} unknown for '{binding}'")

    expect = case.get("expect")
    if not isinstance(expect, dict) or not expect:
        # Anti-vacuous: a case that expects nothing proves nothing.
        errors.append(f"{where}: 'expect' must be a non-empty object")
    else:
        extra_expect = set(expect) - BINDING_EXPECT_KEYS[binding]
        if extra_expect:
            errors.append(f"{where}: expect key(s) {sorted(extra_expect)} unknown for '{binding}'")
    return errors


def _validate_constants(fixture_id: str, document: dict[str, Any]) -> list[str]:
    constants = document.get("constants", {})
    if not isinstance(constants, dict):
        return [f"{fixture_id}: 'constants' must be an object"]
    if not constants:
        return []
    pinned = {
        case.get("input", {}).get("name")
        for case in document.get("cases", [])
        if isinstance(case, dict) and case.get("binding") == "constant_identity"
        and isinstance(case.get("input"), dict)
    }
    return [
        f"{fixture_id}: constant '{name}' is never pinned by a constant_identity case"
        for name in sorted(constants)
        if name not in pinned
    ]


def _validate_fixture(path: Path) -> tuple[list[str], int]:
    """Return ``(errors, executable_case_count)`` for one fixture document."""
    fixture_id = fixture_id_for(path)
    try:
        document = load_fixture(path)
    except ProviderDescriptorFixtureError as error:
        return [str(error)], 0

    errors: list[str] = []
    unknown = set(document) - FIXTURE_ALLOWED_KEYS
    if unknown:
        errors.append(f"{fixture_id}: unknown top-level key(s) {sorted(unknown)}")
    missing = FIXTURE_REQUIRED_KEYS - set(document)
    if missing:
        errors.append(f"{fixture_id}: missing required top-level key(s) {sorted(missing)}")
    if document.get("schema_version") != SCHEMA_VERSION:
        errors.append(
            f"{fixture_id}: schema_version must be {SCHEMA_VERSION}, "
            f"got {document.get('schema_version')!r}"
        )
    if document.get("fixture_id") != fixture_id:
        errors.append(
            f"{fixture_id}: fixture_id is {document.get('fixture_id')!r}, "
            "expected the path-derived id"
        )
    non_executable = document.get("non_executable")
    if not isinstance(non_executable, list):
        errors.append(f"{fixture_id}: 'non_executable' must be a list (it may be empty)")
    else:
        for entry in non_executable:
            if (
                not isinstance(entry, dict)
                or not str(entry.get("section", "")).strip()
                or not str(entry.get("reason", "")).strip()
                or set(entry) != {"section", "reason"}
            ):
                errors.append(
                    f"{fixture_id}: every 'non_executable' entry must be "
                    "{'section', 'reason'} with non-empty values"
                )

    cases = document.get("cases")
    if not isinstance(cases, list):
        return errors + [f"{fixture_id}: 'cases' must be a list"], 0

    seen_case_ids: set[str] = set()
    for case in cases:
        errors.extend(_validate_case(fixture_id, case, seen_case_ids))
    errors.extend(_validate_constants(fixture_id, document))

    executable_count = sum(
        1 for case in cases if isinstance(case, dict) and case.get("executable") is True
    )
    if executable_count == 0 and document.get("executable") is not False:
        errors.append(
            f"{fixture_id}: fixture declares no executable cases "
            "(needs top-level \"executable\": false plus a \"reason\")"
        )
    if executable_count == 0 and not str(document.get("reason", "")).strip():
        errors.append(f"{fixture_id}: a fixture with no executable cases needs a 'reason'")
    if executable_count > 0 and "executable" in document:
        errors.append(
            f"{fixture_id}: top-level 'executable' is only for fixtures with zero "
            "executable cases"
        )

    raw = path.read_text(encoding="utf-8")
    if SECRET_SHAPED_RE.search(raw):
        errors.append(f"{fixture_id}: file contains bearer/JWT-shaped bytes (redaction guard)")
    return errors, executable_count


def _validate_index(executable_total: int, zero_case_fixtures: set[str]) -> list[str]:
    try:
        index = load_index()
    except ProviderDescriptorFixtureError as error:
        return [str(error)]

    errors: list[str] = []
    missing = INDEX_REQUIRED_KEYS - set(index)
    if missing:
        errors.append(f"{INDEX_NAME}: missing required key(s) {sorted(missing)}")
    if index.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"{INDEX_NAME}: schema_version must be {SCHEMA_VERSION}")

    files = index.get("files")
    if not isinstance(files, dict):
        return errors + [f"{INDEX_NAME}: 'files' must be an object"]
    registered = set(files)
    present = {registry_key_for(path) for path in fixture_paths()}
    for orphan in sorted(present - registered):
        errors.append(f"{INDEX_NAME}: fixture {orphan} exists but is not registered in 'files'")
    for ghost in sorted(registered - present):
        errors.append(f"{INDEX_NAME}: 'files' registers {ghost}, which does not exist")

    declared_non_executable = index.get("non_executable_fixtures")
    if not isinstance(declared_non_executable, list):
        errors.append(f"{INDEX_NAME}: 'non_executable_fixtures' must be a list")
    else:
        declared = set(declared_non_executable)
        for missing_entry in sorted(zero_case_fixtures - declared):
            errors.append(
                f"{INDEX_NAME}: {missing_entry} has no executable cases and must be listed "
                "in 'non_executable_fixtures'"
            )
        for stale in sorted(declared - zero_case_fixtures):
            errors.append(
                f"{INDEX_NAME}: 'non_executable_fixtures' lists {stale}, which now has "
                "executable cases"
            )

    minimum = index.get("minimum_executable_cases")
    if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum < 1:
        errors.append(f"{INDEX_NAME}: 'minimum_executable_cases' must be a positive integer")
    elif executable_total < minimum:
        errors.append(
            f"{INDEX_NAME}: executable case ratchet broken — {executable_total} cases present, "
            f"minimum_executable_cases is {minimum}"
        )
    return errors


def validate() -> list[str]:
    """Return every schema/registry/redaction violation, newest-first per file."""
    if not FIXTURES_DIR.is_dir():
        return [f"{FIXTURES_DIR}: fixture directory is missing"]
    paths = fixture_paths()
    if not paths:
        return [f"{FIXTURES_DIR}: no fixture documents found"]

    errors: list[str] = []
    executable_total = 0
    zero_case_fixtures: set[str] = set()
    for path in paths:
        file_errors, count = _validate_fixture(path)
        errors.extend(file_errors)
        executable_total += count
        if count == 0:
            zero_case_fixtures.add(registry_key_for(path))
    errors.extend(_validate_index(executable_total, zero_case_fixtures))
    return errors


def iter_executable_cases() -> list[dict[str, Any]]:
    """Every executable case, with ``${...}`` constants already expanded.

    Raises if the corpus does not validate: a runner must never silently execute
    a corpus the gate would reject.
    """
    errors = validate()
    if errors:
        raise ProviderDescriptorFixtureError(
            "provider-descriptor fixtures are invalid:\n  - " + "\n  - ".join(errors)
        )
    cases: list[dict[str, Any]] = []
    for path in fixture_paths():
        document = load_fixture(path)
        fixture_id = fixture_id_for(path)
        constants = document.get("constants", {})
        for case in document["cases"]:
            if case.get("executable") is not True:
                continue
            where = f"{fixture_id}#{case['case_id']}"
            cases.append(
                {
                    "fixture_id": fixture_id,
                    "case_id": case["case_id"],
                    "id": where,
                    "binding": case["binding"],
                    "rule": case["rule"],
                    "input": substitute(case["input"], constants, where=where),
                    "expect": substitute(case["expect"], constants, where=where),
                }
            )
    return cases


__all__ = [
    "BINDING_EXPECT_KEYS",
    "BINDING_INPUT_KEYS",
    "BINDING_VOCABULARY",
    "FIXTURES_DIR",
    "ProviderDescriptorFixtureError",
    "SCHEMA_VERSION",
    "fixture_id_for",
    "fixture_paths",
    "iter_executable_cases",
    "load_fixture",
    "load_index",
    "validate",
]
