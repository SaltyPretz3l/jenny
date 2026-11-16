"""The frozen jenny-file-access interface, as data. Runs on every OS: no library is loaded.

`native/jenny-file-access/abi.json` is the one place the export list, argument
kinds, status and detail numbers and the listing record layout are written. The
Rust constants (slice 3b-2a) and the `ctypes` table (slice 3b-4a) are tested
against it; these tests keep the file itself well formed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
ABI_PATH = ROOT / "native" / "jenny-file-access" / "abi.json"
VECTORS_PATH = ROOT / "tests" / "fixtures" / "win32-segment-name-vectors.json"

EXPECTED_EXPORTS = [
    "jfa_abi_version",
    "jfa_build_flags",
    "jfa_root_open",
    "jfa_pin_identity",
    "jfa_pin_close",
    "jfa_open_file",
    "jfa_file_take",
    "jfa_file_check",
    "jfa_file_close",
    "jfa_list",
    "jfa_write_atomic",
    "jfa_test_set_token_state",
]
EXPECTED_STATUS = {
    "ok": 0, "path_refused": 1, "not_found": 2, "io_failed": 3, "busy": 4,
    "durability_uncertain": 5, "buffer_too_small": 6, "invalid_argument": 7,
    "internal": 8, "platform_unsupported": 9, "api_missing": 20, "elevated": 21,
    "backup_privilege": 22, "volume_unsupported": 23, "root_invalid": 24,
    "root_identity": 25, "selfcheck_failed": 26,
}
FIXED_WIDTH_BYTES = {"u16": 2, "u32": 4, "u64": 8}
EXPECTED_REASONS = {
    "none": 0, "name_invalid": 1, "reparse_point": 2, "not_regular": 3, "alias_mismatch": 4,
    "missing_directory": 5, "too_deep": 6, "target_read_only": 7, "root_changed": 8,
}
_SEGMENTS = [("segments", "ptr_utf16"), ("segments_units", "u32")]
_DETAIL = ("out_detail", "out_detail")
# The frozen signatures, written out: (export, returns, [(argument, kind), ...]).
EXPECTED_SIGNATURES = [
    ("jfa_abi_version", "u32", []),
    ("jfa_build_flags", "u32", []),
    ("jfa_root_open", "status", [
        ("root", "ptr_utf16"), ("root_units", "u32"), ("expected_device", "u64"),
        ("expected_inode", "u64"), ("out_pin", "out_u64"), _DETAIL]),
    ("jfa_pin_identity", "status", [("pin", "u64"), ("out_device", "out_u64"), ("out_inode", "out_u64")]),
    ("jfa_pin_close", "status", [("pin", "u64")]),
    ("jfa_open_file", "status", [("pin", "u64"), *_SEGMENTS, ("out_token", "out_u64"), _DETAIL]),
    ("jfa_file_take", "status", [("token", "u64"), ("out_handle", "out_handle")]),
    ("jfa_file_check", "status", [("token", "u64")]),
    ("jfa_file_close", "status", [("token", "u64"), ("reclaim", "u32")]),
    ("jfa_list", "status", [
        ("pin", "u64"), *_SEGMENTS, ("max_entries", "u32"), ("buffer", "ptr_bytes_mut"),
        ("capacity", "u32"), ("out_bytes_used", "out_u32"), ("out_entry_count", "out_u32"), _DETAIL]),
    ("jfa_write_atomic", "status", [
        ("pin", "u64"), *_SEGMENTS, ("content", "ptr_bytes"), ("content_len", "usize"),
        ("expectation_kind", "u32"), ("expected", "ptr_bytes"), ("expected_len", "usize"),
        ("out_outcome", "out_u32"), _DETAIL]),
    ("jfa_test_set_token_state", "status", [("state", "u32")]),
]


@pytest.fixture(scope="module")
def abi() -> dict:
    return json.loads(ABI_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def vectors() -> dict:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def test_abi_version_is_one(abi: dict) -> None:
    assert abi["abi_version"] == 1


def test_exports_are_the_spec_list_in_order_with_unique_prefixed_names(abi: dict) -> None:
    names = [export["name"] for export in abi["exports"]]

    assert names == EXPECTED_EXPORTS
    assert len(set(names)) == len(names)
    assert all(name.startswith("jfa_") for name in names)


def test_status_numbers_and_names_are_unique_and_match_the_spec(abi: dict) -> None:
    status = abi["status"]
    names = [row["name"] for row in status]
    values = [row["value"] for row in status]

    assert len(set(names)) == len(names)
    assert len(set(values)) == len(values)
    assert dict(zip(names, values, strict=True)) == EXPECTED_STATUS
    root_open_only = {row["name"] for row in status if row.get("root_open_only")}
    assert root_open_only == {name for name, value in EXPECTED_STATUS.items() if value >= 20}


def test_detail_reason_numbers_are_unique_and_start_at_none(abi: dict) -> None:
    reasons = abi["detail"]["reasons"]
    names = [row["name"] for row in reasons]
    values = [row["value"] for row in reasons]

    assert len(set(names)) == len(names)
    assert len(set(values)) == len(values)
    assert dict(zip(names, values, strict=True)) == EXPECTED_REASONS


def test_export_signatures_are_the_frozen_table(abi: dict) -> None:
    actual = [
        (export["name"], export["returns"], [(arg["name"], arg["kind"]) for arg in export["args"]])
        for export in abi["exports"]
    ]

    assert actual == EXPECTED_SIGNATURES


def test_every_argument_uses_a_declared_kind_and_names_are_unique_per_export(abi: dict) -> None:
    kinds = set(abi["argument_kinds"])

    for export in abi["exports"]:
        arg_names = [arg["name"] for arg in export["args"]]
        assert len(set(arg_names)) == len(arg_names), export["name"]
        for arg in export["args"]:
            assert arg["kind"] in kinds, (export["name"], arg)
        assert export["returns"] in {"u32", "status"}, export["name"]


def test_no_export_takes_a_raw_handle_value(abi: dict) -> None:
    # The only handle crossing the boundary is the one jfa_file_take writes out.
    assert not [kind for kind in abi["argument_kinds"] if "handle" in kind and not kind.startswith("out_")]
    args = [(export["name"], arg) for export in abi["exports"] for arg in export["args"]]
    assert not [
        (call, arg["name"]) for call, arg in args
        if not arg["kind"].startswith("out_") and "handle" in arg["name"]
    ]
    assert [(call, arg["name"]) for call, arg in args if arg["kind"] == "out_handle"] == [
        ("jfa_file_take", "out_handle")
    ]


def test_out_detail_is_last_on_every_call_that_reports_one(abi: dict) -> None:
    for export in abi["exports"]:
        kinds = [arg["kind"] for arg in export["args"]]
        assert kinds.count("out_detail") <= 1, export["name"]
        if "out_detail" in kinds:
            assert kinds[-1] == "out_detail", export["name"]


def test_every_segment_list_carries_its_unit_count(abi: dict) -> None:
    for export in abi["exports"]:
        arg_names = [arg["name"] for arg in export["args"]]
        if "segments" in arg_names:
            position = arg_names.index("segments")
            assert arg_names[position + 1] == "segments_units", export["name"]


def test_only_the_test_export_is_test_seams_only(abi: dict) -> None:
    gated = [export["name"] for export in abi["exports"] if export.get("test_seams_only")]

    assert gated == ["jfa_test_set_token_state"]
    assert {"name": "test_seams", "bit": 0} in abi["build_flags"]


def test_enumerations_that_cross_the_boundary_have_unique_values(abi: dict) -> None:
    for key in ("expectation_kinds", "write_outcomes"):
        values = [row["value"] for row in abi[key]]
        assert len(set(values)) == len(values), key
    assert {row["name"]: row["value"] for row in abi["expectation_kinds"]} == {
        "must_not_exist": 0, "no_expectation": 1, "bytes": 2,
    }
    assert {row["name"]: row["value"] for row in abi["write_outcomes"]} == {
        "not_matched": 0, "replaced": 1,
    }


def test_limits_match_the_spec(abi: dict) -> None:
    limits = abi["limits"]

    assert limits["pin_table_entries"] == 32
    assert limits["file_table_entries"] == 256
    assert limits["max_write_bytes"] == 2**31 - 1
    assert limits["max_listing_buffer_bytes"] == 16 * 1024 * 1024
    assert abi["segments"]["max_segment_units"] == 255
    assert abi["segments"]["max_depth"] == 64


def test_listing_record_is_little_endian_and_unpadded(abi: dict) -> None:
    record = abi["listing_record"]
    fields = record["fields"]

    assert [(field["name"], field["kind"]) for field in fields] == [
        ("flags", "u32"), ("size", "u64"), ("name_units", "u16"), ("name", "utf16le"),
    ]
    fixed = sum(FIXED_WIDTH_BYTES[field["kind"]] for field in fields if field["kind"] in FIXED_WIDTH_BYTES)
    assert record["fixed_header_bytes"] == fixed == 14
    for field in fields:
        if field["kind"] in FIXED_WIDTH_BYTES:
            assert field["bytes"] == FIXED_WIDTH_BYTES[field["kind"]]
    bits = {flag["name"]: flag["bit"] for flag in record["flags"]}
    assert bits == {"directory": 0, "reparse_point": 1, "size_known": 2}


def test_name_vectors_parse_and_every_vector_has_a_verdict(vectors: dict) -> None:
    assert vectors["vectors"]
    for vector in vectors["vectors"]:
        assert vector["verdict"] in {"accept", "refuse"}, vector
        assert vector["rule"] in vectors["rules"], vector
        units = vector["units"]
        assert isinstance(units, list)
        assert all(isinstance(unit, int) and 0 <= unit <= 0xFFFF for unit in units), vector
        assert 0 not in units, "U+0000 is the list separator and never inside a name"
    for vector in vectors["path_vectors"]:
        assert vector["verdict"] in {"accept", "refuse"}, vector
        assert vector["segments"], vector


def test_name_vectors_are_unique_and_name_matches_units(vectors: dict) -> None:
    seen = set()
    for vector in vectors["vectors"]:
        key = tuple(vector["units"])
        assert key not in seen, vector
        seen.add(key)
        if "name" in vector:
            encoded = vector["name"].encode("utf-16-le")
            units = [int.from_bytes(encoded[i:i + 2], "little") for i in range(0, len(encoded), 2)]
            assert units == vector["units"], vector
        else:
            # Only a lone surrogate has no text form.
            assert any(0xD800 <= unit <= 0xDFFF for unit in vector["units"]), vector


def test_name_vectors_cover_every_refusal_rule_in_the_spec(vectors: dict) -> None:
    refused_rules = {v["rule"] for v in vectors["vectors"] if v["verdict"] == "refuse"}

    assert {
        "empty", "dot", "dotdot", "separator_or_colon", "invalid_char", "control_char",
        "lone_surrogate", "trailing_dot", "trailing_space", "reserved_device", "too_long",
    } <= refused_rules
    refused_paths = {v["rule"] for v in vectors["path_vectors"] if v["verdict"] == "refuse"}
    assert "too_deep" in refused_paths


def test_name_vectors_state_the_spec_examples(vectors: dict) -> None:
    by_name = {v["name"]: v["verdict"] for v in vectors["vectors"] if "name" in v}

    assert by_name["a.txt:s"] == "refuse"
    assert by_name["a.txt::$DATA"] == "refuse"
    for device in ("CON", "prn", "Aux", "NUL", "COM1", "lpt9", "com0", "lpt0", "con.txt",
                   "nul.tar.gz", "COM¹", "LPT²", "LPT³", "CONIN$", "conout$.txt"):
        assert by_name[device] == "refuse", device
    # Only COM0 to COM9 and LPT0 to LPT9 are devices; case variants of ordinary names are fine.
    for ordinary in ("console", "com10", "lpt10", "README.md", "PROGRA~1", "com⁴"):
        assert by_name[ordinary] == "accept", ordinary
    assert by_name["x" * 255] == "accept"
    assert by_name["x" * 256] == "refuse"
    assert by_name["a."] == "refuse"
    assert by_name["a "] == "refuse"
