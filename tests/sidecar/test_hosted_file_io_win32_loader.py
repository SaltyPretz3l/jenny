"""Finding and checking the Windows file access library, with an injected file
system and loader. Runs on every OS: no real library is loaded."""

from __future__ import annotations

import ctypes
import json
import os
import stat
import sys
from pathlib import Path
from unittest import mock

import pytest

from sidecar.ai import config as sidecar_config
from sidecar.ai.tools import hosted_file_io_win32_library as win32_library
from tests.sidecar._hosted_file_io_win32_fake import FakeLibrary, regular_file_stat

ROOT = Path(__file__).resolve().parents[2]
ABI = json.loads((ROOT / "native" / "jenny-file-access" / "abi.json").read_text(encoding="utf-8"))
SOURCE_PLACE = ROOT / "build" / "sidecar" / "jenny_file_access.dll"
POINTER_BYTES = ctypes.sizeof(ctypes.c_void_p)
P = ctypes.POINTER
# Every argument and result kind, written out: (ctypes type, its size, the
# pointee and its size for a pointer kind).
PINNED_KINDS = {
    "u32": (ctypes.c_uint32, 4, None, None),
    "u64": (ctypes.c_uint64, 8, None, None),
    "usize": (ctypes.c_size_t, POINTER_BYTES, None, None),
    "status": (ctypes.c_int32, 4, None, None),
    "ptr_utf16": (P(ctypes.c_uint16), POINTER_BYTES, ctypes.c_uint16, 2),
    "ptr_bytes": (ctypes.c_char_p, POINTER_BYTES, None, None),
    "ptr_bytes_mut": (P(ctypes.c_ubyte), POINTER_BYTES, ctypes.c_ubyte, 1),
    "out_u32": (P(ctypes.c_uint32), POINTER_BYTES, ctypes.c_uint32, 4),
    "out_u64": (P(ctypes.c_uint64), POINTER_BYTES, ctypes.c_uint64, 8),
    "out_handle": (P(ctypes.c_size_t), POINTER_BYTES, ctypes.c_size_t, POINTER_BYTES),
    "out_detail": (P(ctypes.c_uint32), POINTER_BYTES, ctypes.c_uint32, 4),
}


def _stat(mode: int, attributes: int = 0) -> os.stat_result:
    result = mock.Mock(spec=["st_mode", "st_file_attributes"])
    result.st_mode = mode
    result.st_file_attributes = attributes
    return result


class Recorder:
    def __init__(self, answer=regular_file_stat, library: object | None = None) -> None:
        self.stat_paths: list[Path] = []
        self.load_paths: list[Path] = []
        self.answer = answer
        self.library = library if library is not None else FakeLibrary()

    def lstat(self, path: Path):
        self.stat_paths.append(path)
        return self.answer(path)

    def load(self, path: Path):
        self.load_paths.append(path)
        if isinstance(self.library, BaseException):
            raise self.library
        return self.library

    def run(self) -> win32_library.FileAccessLibrary:
        return win32_library.load_library(lstat=self.lstat, loader=self.load)


def _refusal(recorder: Recorder) -> str:
    with pytest.raises(win32_library.ComponentMissing) as caught:
        recorder.run()
    return caught.value.detail


def _missing(path: Path):
    raise FileNotFoundError(2, "absent")


@pytest.mark.parametrize(("case", "recorder", "detail"), [
    ("missing file", lambda: Recorder(_missing), "missing"),
    ("symlink at the path", lambda: Recorder(lambda p: _stat(stat.S_IFLNK | 0o777)), "missing"),
    ("reparse point", lambda: Recorder(
        lambda p: _stat(stat.S_IFREG, stat.FILE_ATTRIBUTE_REPARSE_POINT)), "missing"),
    ("directory", lambda: Recorder(lambda p: _stat(stat.S_IFDIR)), "missing"),
    ("load failure", lambda: Recorder(library=OSError(193, "bad image")), "load_failed"),
    ("abi version 2", lambda: Recorder(library=FakeLibrary(abi_version=2)), "version_mismatch"),
    ("missing export", lambda: Recorder(library=FakeLibrary(missing=("jfa_list",))),
     "version_mismatch"),
    ("test build flag", lambda: Recorder(library=FakeLibrary(build_flags=1)), "test_build"),
    ("test export with flags 0",
     lambda: Recorder(library=FakeLibrary(build_flags=0, test_export=True)), "test_build"),
])
def test_each_refusal_names_its_detail(case: str, recorder, detail: str) -> None:
    assert _refusal(recorder()) == detail


def test_every_kind_has_its_pinned_ctypes_type_and_size() -> None:
    assert set(PINNED_KINDS) == set(ABI["argument_kinds"]) | {"status"}
    for kind, (expected, size, pointee, pointee_size) in PINNED_KINDS.items():
        actual = win32_library.ctypes_type(kind)
        assert actual is expected, kind
        assert ctypes.sizeof(actual) == size, kind
        if pointee is not None:
            assert actual._type_ is pointee, kind
            assert ctypes.sizeof(pointee) == pointee_size, kind


def test_a_good_library_is_bound_as_abi_json_says() -> None:
    fake = FakeLibrary()
    loaded = Recorder(library=fake).run()

    assert loaded.latched is False
    for export in ABI["exports"]:
        if export.get("test_seams_only"):
            continue
        bound = getattr(fake, export["name"])
        assert bound.restype is PINNED_KINDS[export["returns"]][0], export["name"]
        assert bound.argtypes == [PINNED_KINDS[a["kind"]][0] for a in export["args"]]


def test_the_fake_refuses_what_a_real_call_would() -> None:
    loaded = Recorder().run()
    for args in (("token", 0), (1,), (1, 0, 0)):  # wrong type, too few, too many
        with pytest.raises((TypeError, ctypes.ArgumentError)):
            loaded.call("jfa_file_close", *args)
    with pytest.raises((TypeError, ctypes.ArgumentError)):
        loaded.call("jfa_pin_identity", 1, 5, 6)  # integers where pointers go


def test_the_ctypes_table_equals_abi_json() -> None:
    table = [
        {"name": s.name, "returns": s.returns, "test_seams_only": s.test_seams_only,
         "args": [{"name": n, "kind": k} for n, k in s.args]}
        for s in win32_library.SIGNATURES
    ]
    frozen = [
        {"name": e["name"], "returns": e["returns"],
         "test_seams_only": e.get("test_seams_only", False), "args": e["args"]}
        for e in ABI["exports"]
    ]
    assert table == frozen


def test_the_numbers_equal_abi_json() -> None:
    def named(rows: list[dict], key: str = "value") -> dict[str, int]:
        return {row["name"]: row[key] for row in rows}

    assert win32_library.ABI_VERSION == ABI["abi_version"]
    assert win32_library.STATUS == named(ABI["status"])
    assert win32_library.DETAIL_REASONS == named(ABI["detail"]["reasons"])
    assert win32_library.EXPECTATION_KINDS == named(ABI["expectation_kinds"])
    assert win32_library.WRITE_OUTCOMES == named(ABI["write_outcomes"])
    assert win32_library.LISTING_FLAG_BITS == named(ABI["listing_record"]["flags"], "bit")
    assert win32_library.LISTING_HEADER_BYTES == ABI["listing_record"]["fixed_header_bytes"]
    assert win32_library.LIMITS == ABI["limits"]


def test_a_source_checkout_looks_in_build_sidecar_only(monkeypatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    recorder = Recorder(_missing)

    assert _refusal(recorder) == "missing"
    assert recorder.stat_paths == [SOURCE_PLACE]
    assert recorder.load_paths == []
    assert win32_library.library_path() == SOURCE_PLACE


def test_a_packaged_build_looks_beside_the_executable_only(monkeypatch, tmp_path: Path) -> None:
    executable = tmp_path / "resources" / "sidecar" / "sidecar.exe"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))
    recorder = Recorder()

    recorder.run()

    expected = executable.resolve().parent / "jenny_file_access.dll"
    assert recorder.stat_paths == [expected]
    assert recorder.load_paths == [expected]
    assert expected.is_absolute()


def test_no_environment_variable_is_read(monkeypatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)

    def refuse(*args, **kwargs):
        raise AssertionError("the loader read the environment")

    class Untouchable(dict):
        __getitem__ = get = __contains__ = __iter__ = keys = items = copy = refuse

    recorder = Recorder()
    with mock.patch.object(os, "environ", Untouchable()), \
            mock.patch.object(os, "getenv", refuse), \
            mock.patch.object(sidecar_config, "read_environment_value", refuse):
        recorder.run()
        assert _refusal(Recorder(_missing)) == "missing"
    assert recorder.load_paths == [SOURCE_PLACE]


def test_the_loader_names_the_full_path_and_limits_imports_to_system32(monkeypatch) -> None:
    calls: list[tuple] = []
    monkeypatch.setattr(ctypes, "CDLL", lambda *args, **kwargs: calls.append((args, kwargs)))

    win32_library.load_by_full_path(SOURCE_PLACE)

    assert calls == [((str(SOURCE_PLACE),), {"winmode": 0x00000800})]  # SEARCH_SYSTEM32


def test_the_process_loads_once_and_keeps_a_refusal(monkeypatch) -> None:
    attempts: list[int] = []
    loaded = Recorder().run()

    def refuse(**kwargs):
        attempts.append(1)
        raise win32_library.ComponentMissing("missing")

    monkeypatch.setattr(win32_library, "load_library", refuse)
    win32_library.reset_shared_library()
    try:
        for _ in range(3):
            with pytest.raises(win32_library.ComponentMissing) as caught:
                win32_library.shared_library()
            assert caught.value.detail == "missing"
        assert len(attempts) == 1

        def explode(**kwargs):
            raise RuntimeError("unexpected")

        monkeypatch.setattr(win32_library, "load_library", explode)
        win32_library.reset_shared_library()
        with pytest.raises(win32_library.ComponentMissing) as caught:
            win32_library.shared_library()
        assert caught.value.detail == "load_failed"

        monkeypatch.setattr(win32_library, "load_library", lambda **kwargs: loaded)
        win32_library.reset_shared_library()
        assert win32_library.shared_library() is win32_library.shared_library() is loaded
    finally:
        win32_library.reset_shared_library()


def test_a_caught_panic_latches_every_later_call() -> None:
    fake = FakeLibrary()
    loaded = Recorder(library=fake).run()
    fake.statuses["jfa_pin_close"] = [8]

    assert loaded.call("jfa_pin_close", 1) == 8
    before = list(fake.calls)
    assert loaded.call("jfa_file_check", 2) == 8
    assert loaded.latched is True
    assert fake.calls == before
