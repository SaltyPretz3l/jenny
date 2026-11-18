"""The Windows hosted backend against the real `jenny_file_access.dll` (slice 3b-4b).

Windows only. The library is the one `npm run build:file-access` writes to
`build/sidecar/`. On a token the shipping library refuses (elevated, or holding
backup or restore rights, as a CI runner's may be) the tests load the test-seams
build that `cargo test --release --locked --features test-seams --target-dir
target/seams` leaves in the crate, through the loader's test-only argument, and
set a plain token state. Without the library they skip, or fail when
`JENNY_REQUIRE_FILE_ACCESS=1` (read by the tests only). The switch is turned on
through the facade's process setting, never an environment variable.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.builtin_request_scope import builtin_request_scope
from sidecar.ai.tools import hosted_file_io
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows only: the real library")

_REPO = Path(__file__).resolve().parents[2]
_BUILD = "npm run build:file-access"
_SEAMS_BUILD = "cargo test --release --locked --features test-seams --target-dir target/seams"
# Where that cargo command leaves the test-seams build (it links into deps/).
_SEAMS = tuple(_REPO / "native" / "jenny-file-access" / "target" / "seams" / "release" / sub
               / "jenny_file_access.dll" for sub in ("", "deps"))
_TOKEN_PLAIN, _TOKEN_ELEVATED = 1, 2  # jfa_test_set_token_state values (win::policy::seam)
_TOKEN_REASONS = frozenset({"file_access_elevated", "file_access_backup_privilege"})
_NO_EXPECTATION = object()
_PIN_TABLE = 32


def _unavailable(message: str):
    if os.environ.get("JENNY_REQUIRE_FILE_ACCESS") == "1":
        pytest.fail(message)
    pytest.skip(message)


def _seams_path() -> Path | None:
    return next((path for path in _SEAMS if path.is_file()), None)


def _library_for_this_token(probe: Path):
    """The shipping library, or on a token it refuses, the test-seams build with a
    plain token state, installed as the process's library."""
    from sidecar.ai.tools import hosted_file_io_win32 as client
    from sidecar.ai.tools import hosted_file_io_win32_library as library

    library.reset_shared_library()
    try:
        shipping = library.shared_library()
    except library.ComponentMissing as refusal:
        _unavailable(f"needs the built library ({refusal.detail}): run `{_BUILD}`")
    reason = client.unavailable_reason(probe, *_pair(probe))
    if reason not in _TOKEN_REASONS:
        return shipping
    path = _seams_path()
    if path is None:
        _unavailable(f"this token is refused ({reason}) and there is no test-seams build: "
                     f"run `{_SEAMS_BUILD}` in native/jenny-file-access")
    seams = library.load_library(test_seams_path=path)
    assert seams.call(library.TEST_EXPORT, _TOKEN_PLAIN) == 0
    library.reset_shared_library(seams)
    return seams


@pytest.fixture(autouse=True)
def _process_state_reset():
    """The switch, the root and the loaded library never outlive a test, even
    one that skipped or failed before its fixture yielded."""
    from sidecar.ai.tools import hosted_file_io_win32_library as library

    try:
        yield
    finally:
        hosted_file_io.configure_hosted_file_io(None, enabled=False)
        hosted_file_io.set_hosted_win32_files(False)
        library.reset_shared_library()


@pytest.fixture
def lib(tmp_path: Path):
    hosted_file_io.configure_hosted_file_io(None, enabled=False)
    probe = tmp_path / "token-probe"
    probe.mkdir()
    hosted_file_io.set_hosted_win32_files(True)
    try:
        yield _library_for_this_token(probe.resolve())
    finally:
        hosted_file_io.configure_hosted_file_io(None, enabled=False)
        hosted_file_io.set_hosted_win32_files(False)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    folder = (tmp_path / "project").resolve()
    folder.mkdir()
    return folder


def _pair(path: Path) -> tuple[str, str]:
    status = os.stat(path)
    return str(status.st_dev), str(status.st_ino)


def _scope(path: Path, pair: tuple[str, str] | tuple[None, None]):
    return hosted_file_io.scoped_hosted_file_io(
        str(path), enabled=True, expected_device_id=pair[0], expected_inode=pair[1])


def _read(path: Path) -> bytes:
    with hosted_file_io.open_regular_file(path, "rb") as handle:
        return bytes(handle.read())


def _assert_no_path(text: str, *paths: Path) -> None:
    for path in paths:
        for secret in (str(path), path.name, str(path).replace("\\", "/")):
            assert secret not in text, "a path or file name reached a log line or failure"


def test_read_list_and_write_through_the_facade_keep_crlf_and_ctrl_z(lib, root: Path) -> None:
    content = b"one\r\ntwo\x1athree\r\n"
    (root / "crlf.txt").write_bytes(content)
    (root / "sub").mkdir()

    with _scope(root, _pair(root)):
        assert _read(root / "crlf.txt") == content
        with hosted_file_io.open_regular_file(root / "crlf.txt", "r", newline="") as text:
            assert text.read() == content.decode()
        with hosted_file_io.open_hosted_directory(root) as directory:
            entries = {entry.name: entry for entry in directory.scan(100)}
        assert set(entries) == {"crlf.txt", "sub"}
        assert entries["sub"].is_dir(follow_symlinks=False) is True
        assert entries["crlf.txt"].stat(follow_symlinks=False).st_size == len(content)
        written = b"new\r\nline\x1a\r\n"
        assert hosted_file_io.write_hosted_bytes_atomic(
            root / "sub" / "made.txt", written, expected=None,
            no_expectation=_NO_EXPECTATION, mode=None) is True
        assert _read(root / "sub" / "made.txt") == written
        assert hosted_file_io.write_hosted_bytes_atomic(
            root / "crlf.txt", b"changed", expected=b"stale",
            no_expectation=_NO_EXPECTATION, mode=None) is False
        with hosted_file_io.open_hosted_directory(root / "sub") as directory:
            [made] = directory.scan(10)
        assert made.stat(follow_symlinks=False).st_size == len(written)
    assert (root / "sub" / "made.txt").read_bytes() == written
    assert (root / "crlf.txt").read_bytes() == content


def test_the_trusted_request_scope_pins_through_the_library(lib, root: Path) -> None:
    (root / "a.txt").write_bytes(b"alpha")
    device, inode = _pair(root)
    identity = str(root).lower()
    arguments = {"_jenny_execution_context": {
        "schema_version": 1, "authority_revision": "rev", "project_id": "project_alpha",
        "root_path": str(root), "root_id": "root_" + hashlib.sha256(identity.encode()).hexdigest()[:24],
        "root_revision": 1, "device_id": device, "inode": inode,
        "tool_policy_snapshot": {"version": 1}, "knowledge_roots": [],
    }}
    scope = builtin_request_scope(arguments, legacy_workspace=WorkspaceGuard(None),
                                  host_config={"host_mode": "server"})
    assert scope is not None
    with scope:
        assert _read(root / "a.txt") == b"alpha"
        with pytest.raises(OSError):
            (root).rename(root.with_name("moved"))  # W3: the pin denies renaming the root
    root.rename(root.with_name("moved"))  # released with the scope


def test_configure_on_win32_pins_nothing_and_operations_outside_a_scope_fail(lib, root: Path) -> None:
    (root / "a.txt").write_bytes(b"alpha")
    hosted_file_io.configure_hosted_file_io(str(root), enabled=True)

    assert hosted_file_io.hosted_file_io_root() == str(root)
    root.rename(root.with_name("renamed"))  # no process-level pin holds it
    root.with_name("renamed").rename(root)
    with pytest.raises(ToolExecutionFailure):
        _read(root / "a.txt")
    with pytest.raises(ToolExecutionFailure), _scope(root, (None, None)):
        pytest.fail("a root without an identity was pinned")


def test_library_python_and_node_agree_on_the_identity(lib, root: Path) -> None:
    from sidecar.ai.tools import hosted_file_io_win32 as client

    node = shutil.which("node")
    assert node, "the identity test needs Node on PATH"
    pool = _REPO / "services" / "projects" / "project-workspace-pool.js"
    script = ("const {captureFilesystemIdentity}=require(process.argv[1]);"
              "process.stdout.write(JSON.stringify(captureFilesystemIdentity(process.argv[2], require('fs'))))")
    completed = subprocess.run([node, "-e", script, str(pool), str(root)], capture_output=True,
                               text=True, timeout=60, check=True)
    from_node = json.loads(completed.stdout)
    device, inode = _pair(root)

    pin = client.open_root(root, device, inode)
    try:
        out_device, out_inode = ctypes.c_uint64(), ctypes.c_uint64()
        assert lib.call("jfa_pin_identity", pin.token, out_device, out_inode) == 0
        from_library = (str(out_device.value), str(out_inode.value))
    finally:
        pin.close()

    assert from_library == (device, inode) == (from_node["device_id"], from_node["inode"])
    assert client.unavailable_reason(root, device, str(int(inode) + 1)) == "file_access_root_identity"
    assert client.unavailable_reason(root, None, None) == "file_access_root_identity"
    assert client.unavailable_reason(root, "0", "0") == "file_access_root_identity"
    for refused in ((device, str(int(inode) + 1)), ("0", "0"), (None, None)):
        with pytest.raises(ToolExecutionFailure), _scope(root, refused):
            pytest.fail("a wrong or absent identity was pinned")
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(root)) is None


def test_a_root_replaced_between_two_requests_is_refused_by_the_second(lib, root: Path) -> None:
    (root / "a.txt").write_bytes(b"first")
    pair = _pair(root)
    with _scope(root, pair):
        assert _read(root / "a.txt") == b"first"
    root.rename(root.with_name("old"))
    root.mkdir()
    (root / "a.txt").write_bytes(b"second")

    with pytest.raises(ToolExecutionFailure) as refused, _scope(root, pair):
        pytest.fail("a replaced root was pinned")
    _assert_no_path(str(refused.value.message), root)


def _grep_request(root: Path, **changes: object) -> dict[str, object]:
    device, inode = _pair(root)
    return {"path": str(root / "a.txt"), "pattern": "needle", "flags": 0,
            "workspace_root": str(root), "hosted_file_io": True, "hosted_win32_files": True,
            "workspace_device_id": device, "workspace_inode": inode,
            "context_lines": 0, "max_output_matches": 10, "max_output_bytes": 4096, **changes}


def test_the_grep_worker_pins_and_releases_its_own_handle(lib, root: Path, monkeypatch) -> None:
    from sidecar.ai.tools.builtins import grep_search_worker as worker

    (root / "a.txt").write_bytes(b"alpha\r\nneedle\r\n")
    held: list[bool] = []
    real_search, real_scan = worker.search_file, worker.scan_one_file

    def probe_rename() -> None:
        try:
            root.rename(root.with_name("away"))
        except OSError:
            held.append(True)
        else:
            root.with_name("away").rename(root)
            held.append(False)

    def searching(*args, **kwargs):
        probe_rename()
        return real_search(*args, **kwargs)

    def scanning(*args, **kwargs):
        probe_rename()
        return real_scan(*args, **kwargs)

    monkeypatch.setattr(worker, "search_file", searching)
    monkeypatch.setattr(worker, "scan_one_file", scanning)
    hosted_file_io.set_hosted_win32_files(False)  # the request alone turns the switch on

    single = worker.run_worker_request(_grep_request(root))
    answers: list[object] = []
    batch = _grep_request(root, op=worker.SCAN_BATCH_OP, files=[str(root / "a.txt")],
                          max_file_bytes=4096)
    worker.run_scan_batch_request(batch, answers.append)

    assert single.get("status") == "ok" and single.get("total_match_count") == 1, single
    assert len(answers) == 1 and answers[0].get("status") == "ok", answers
    assert held == [True, True], "the worker held its own pin during each request"
    root.rename(root.with_name("free"))  # and released it afterwards
    root.with_name("free").rename(root)
    refusals = [
        worker.run_worker_request(_grep_request(root, workspace_inode=None, workspace_device_id=None)),
        worker.run_worker_request(_grep_request(root, workspace_inode=str(int(_pair(root)[1]) + 1))),
        worker.run_worker_request(_grep_request(root, hosted_win32_files=False)),
    ]
    assert hosted_file_io.hosted_win32_files_enabled() is False, "the last request turned it off"
    for refused in refusals:
        assert refused.get("status") == "error", refused
        assert refused.get("error_code") == CMP_TOOL_INVALID_PATH, refused
        _assert_no_path(json.dumps(refused), root, root / "a.txt")


def test_closing_and_reopening_a_pin_64_times_leaves_the_table_usable(lib, root: Path) -> None:
    from sidecar.ai.tools import hosted_file_io_win32 as client

    pair = _pair(root)
    for _ in range(2 * _PIN_TABLE):
        client.open_root(root, *pair).close()
    pins = [client.open_root(root, *pair) for _ in range(_PIN_TABLE)]
    try:
        with pytest.raises(ToolExecutionFailure):
            client.open_root(root, *pair)  # the 33rd: the table is full
    finally:
        for pin in pins:
            pin.close()
    client.open_root(root, *pair).close()


def test_refusals_put_no_path_in_a_log_line_or_failure(lib, root: Path, caplog) -> None:
    (root / "secret-name.txt").write_bytes(b"x")
    failures: list[str] = []
    with caplog.at_level(logging.DEBUG):
        with _scope(root, _pair(root)):
            for path in (root / "missing-name.txt", root / "secret-name.txt:stream", root / ".."):
                try:
                    _read(path)
                except (ToolExecutionFailure, OSError) as error:
                    failures.append(repr(error))
        for pair in (("1", "1"), (None, None)):
            try:
                with _scope(root, pair):
                    pass
            except ToolExecutionFailure as error:
                failures.append(repr(error))
    assert len(failures) == 5
    _assert_no_path(caplog.text + "\n".join(failures), root, root / "secret-name.txt",
                    root / "missing-name.txt")


def test_the_seams_build_loads_only_by_its_test_argument_and_its_token_state_is_honoured(
    lib, root: Path,
) -> None:
    """The production loader refuses a test-seams build; the test argument loads it,
    and the token state it sets reaches the start decision (Test seams)."""
    from sidecar.ai.tools import hosted_file_io_win32 as client
    from sidecar.ai.tools import hosted_file_io_win32_library as library

    path = _seams_path()
    if path is None:
        _unavailable(f"no test-seams build: run `{_SEAMS_BUILD}` in native/jenny-file-access")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(library, "library_path", lambda: path)
        with pytest.raises(library.ComponentMissing) as refused:
            library.load_library()
    assert refused.value.detail == "test_build"
    shipping = library.library_path()
    with pytest.raises(library.ComponentMissing) as not_seams:
        library.load_library(test_seams_path=shipping)
    assert not_seams.value.detail == "not_test_build"

    seams = library.load_library(test_seams_path=path)
    library.reset_shared_library(seams)
    pair = _pair(root)
    try:
        assert seams.call(library.TEST_EXPORT, _TOKEN_ELEVATED) == 0
        assert client.unavailable_reason(root, *pair) == "file_access_elevated"
        assert seams.call(library.TEST_EXPORT, _TOKEN_PLAIN) == 0
        assert client.unavailable_reason(root, *pair) is None
    finally:
        seams.call(library.TEST_EXPORT, _TOKEN_PLAIN)


def test_the_start_reason_names_a_missing_root_and_passes_on_the_librarys_refusal(
    lib, root: Path,
) -> None:
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(root / "absent")) == (
        "file_access_root_invalid")
    drive_root = Path(root.anchor)
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(drive_root)) == (
        "file_access_root_invalid"), "the library refuses a drive root; its reason is passed on"
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(root)) is None


def test_main_registers_the_file_tools_with_the_switch_on_and_a_good_root(
    lib, root: Path, monkeypatch,
) -> None:
    seen: dict[str, object] = {}
    real_default_tools = builtin_server._default_tools

    def recording_default_tools(config=None, **kwargs):
        tools = real_default_tools(config, **kwargs)
        seen.update(kwargs, tools=tools)
        return tools

    monkeypatch.setattr(builtin_server, "_default_tools", recording_default_tools)
    monkeypatch.setattr(builtin_server.sys, "stdin",
                        type("EmptyStdin", (), {"readline": staticmethod(lambda: "")})())
    builtin_server.main(["--workspace-root", str(root), "--host-mode", "server",
                         "--host-execution-policy-version", "1", "--hosted-win32-files"])

    assert seen["workspace_root_present"] is True
    assert {"read_file", "write_file", "edit_file", "list_dir", "glob_files",
            "grep_search"} <= set(seen["tools"])  # type: ignore[arg-type]
    assert hosted_file_io.hosted_file_io_root() == str(root)


def _swap_before_write(monkeypatch, directory: Path, outside: Path) -> list[str]:
    """The other party wins the window right before the first write in `directory`:
    the directory is renamed away and a junction to `outside` takes its name, never
    undone. Hooked where the store makes its temp file by path (the old path) and
    where the pinned backend is asked to write (R12-F01)."""
    import _winapi

    from sidecar.ai.tools import hosted_file_io_win32 as client
    from sidecar.ai.tools import workspace_store

    swapped: list[str] = []

    def swap(parent: Path) -> None:
        if not swapped and parent == directory:
            directory.rename(directory.with_name(directory.name + ".moved"))
            _winapi.CreateJunction(str(outside), str(directory))
            swapped.append(directory.name)

    real_mkstemp, real_write = workspace_store.tempfile.mkstemp, client.write_atomic

    def racing_mkstemp(*args, **kwargs):
        swap(Path(kwargs["dir"]))
        return real_mkstemp(*args, **kwargs)

    def racing_write(pin, root, path, *args, **kwargs):
        swap(Path(path).parent)
        return real_write(pin, root, path, *args, **kwargs)

    monkeypatch.setattr(workspace_store.tempfile, "mkstemp", racing_mkstemp)
    monkeypatch.setattr(client, "write_atomic", racing_write)
    return swapped


def _hosted_write(root: Path, arguments: dict[str, object]):
    from sidecar.ai.tools.builtins.filesystem import write_file_tool

    with _scope(root, _pair(root)):
        assert hosted_file_io.hosted_file_io_enabled()
        try:
            return write_file_tool(arguments, WorkspaceGuard(str(root)))
        except ToolExecutionFailure as error:
            return error


def test_a_hosted_artifact_write_leaves_nothing_outside_when_its_folder_is_swapped(
    lib, root: Path, tmp_path: Path, monkeypatch,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / ".jenny" / "artifacts" / "s1").mkdir(parents=True)
    swapped = _swap_before_write(monkeypatch, root / ".jenny" / "artifacts" / "s1", outside)
    outcome = _hosted_write(root, {"path": ".jenny/artifacts/s1/note.md",
                                   "content": "MODEL-CONTROLLED"})
    left = {name: (outside / name).read_bytes() for name in os.listdir(outside)}
    assert swapped, "the write never reached the swapped folder"
    assert left == {}, f"a hosted tool write left bytes outside the pinned root: {outcome!r}"
    assert getattr(outcome, "success", False) is False


def test_a_hosted_overwrite_backup_leaves_nothing_outside_when_backups_is_swapped(
    lib, root: Path, tmp_path: Path, monkeypatch,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "notes.txt").write_bytes(b"PRIOR PROJECT CONTENT")
    (root / ".jenny" / "backups").mkdir(parents=True)
    swapped = _swap_before_write(monkeypatch, root / ".jenny" / "backups", outside)
    outcome = _hosted_write(root, {"path": "notes.txt", "content": "new"})
    left = {name: (outside / name).read_bytes() for name in os.listdir(outside)}
    assert swapped, "the hosted overwrite never wrote a backup"
    assert left == {}, f"a hosted tool write left bytes outside the pinned root: {outcome!r}"
    assert getattr(outcome, "success", False) is False
    assert (root / "notes.txt").read_bytes() == b"PRIOR PROJECT CONTENT"


def test_hosted_write_edit_and_create_artifact_keep_backups_and_artifacts_in_the_root(
    lib, root: Path,
) -> None:
    from sidecar.ai.tools.builtins.artifacts import create_artifact_tool
    from sidecar.ai.tools.builtins.edit_file import edit_file_tool
    from sidecar.ai.tools.builtins.filesystem import read_file_tool, write_file_tool

    (root / "notes.txt").write_bytes(b"first line\n")
    workspace = WorkspaceGuard(str(root))
    with _scope(root, _pair(root)):
        snapshot = read_file_tool({"path": "notes.txt"}, workspace).metadata["read_snapshot"]
        written = write_file_tool({"path": "notes.txt", "content": "second line\n",
                                   "expected_read_snapshot": snapshot}, workspace)
        edited = edit_file_tool({"file_path": "notes.txt", "old_string": "second",
                                 "new_string": "third"}, workspace)
        artifact = write_file_tool({"path": ".jenny/artifacts/s1/note.md", "content": "A"},
                                   workspace)
        created = create_artifact_tool({"_jenny_session_id": "s1", "title": "Plan",
                                        "artifact_kind": "document", "content": "B",
                                        "file_name": "plan.md"}, workspace)
    assert written.success and edited.success and artifact.success, (written, edited, artifact)
    assert created.success, created
    assert (root / "notes.txt").read_bytes() == b"third line\n"
    backups = sorted(os.listdir(root / ".jenny" / "backups"))
    assert any(name.endswith("@v1.bak") for name in backups), backups
    assert any(name.endswith(".json") for name in backups), backups
    assert (root / ".jenny" / "artifacts" / "s1" / "note.md").read_bytes() == b"A"
    assert (root / ".jenny" / "artifacts" / "s1" / "plan.md").read_bytes() == b"B"
    assert not [name for name in os.listdir(root / ".jenny" / "artifacts" / "s1")
                if name.endswith(".tmp")]


def test_one_root_pin_open_and_close_costs_milliseconds_at_most(lib, root: Path) -> None:
    """Every tool call and every search batch pays one pin; recorded in the spec."""
    import time

    from sidecar.ai.tools import hosted_file_io_win32 as client

    pair = _pair(root)
    started = time.perf_counter()
    for _ in range(100):
        client.open_root(root, *pair).close()
    per_pin = (time.perf_counter() - started) / 100
    assert per_pin < 0.05, f"{per_pin * 1e3:.2f} ms per pin"


def test_a_team_worker_reads_lists_writes_and_edits_one_project_with_no_process_root(
    lib, tmp_path: Path, monkeypatch,
) -> None:
    """Team host file tools (row 123): `main()` with an empty workspace root, a root
    boundary and the switch, then read, list, write and edit through a request scope
    with the real library. Nothing lands outside the request root but the worker's
    ledger (D8, I10), and a second project's file is refused."""
    from tests.sidecar.test_builtin_server_hosted_degrade import exercise_one_project

    exercise_one_project(monkeypatch, tmp_path, "--hosted-win32-files")
