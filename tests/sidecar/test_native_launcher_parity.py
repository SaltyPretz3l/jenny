"""The native launcher must behave like the Python owned-process bootstrap child.

Every case sends the same framed request to both children and compares what
comes back: exit code, stdout bytes and stderr bytes. The Python child
(`sidecar/_owned_process_bootstrap.py`) is the reference; `jenny-launch.exe`
(`native/jenny-launch/`) is the drop-in. Skipped where the launcher has not
been built.
"""

from __future__ import annotations

import base64
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

import pytest

from sidecar._owned_process_bootstrap import BOOTSTRAP_FLAG, encode_windows_bootstrap_payload

ROOT = Path(__file__).resolve().parents[2]
_LAUNCHER_CANDIDATES = (
    ROOT / "build" / "sidecar" / "jenny-launch.exe",
    ROOT / "native" / "jenny-launch" / "target" / "release" / "jenny-launch.exe",
)
_LAUNCHER = next((path for path in _LAUNCHER_CANDIDATES if path.is_file()), None)

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or _LAUNCHER is None,
    reason="needs Windows and a built native launcher (scripts/packaging/build_native_launcher.py)",
)

_PYTHON_CHILD = [sys.executable, "-m", "sidecar", BOOTSTRAP_FLAG]
_REJECTED = b"owned process bootstrap rejected control payload\r\n"
_LAUNCH_FAILED = b"owned process bootstrap target launch failed\r\n"

_PROBE = r"""
import hashlib, json, os, subprocess, sys
mode = sys.argv[1]
if mode == "echo":
    data = sys.stdin.buffer.read() if sys.argv[2] == "read" else b""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("__PYVENV")}
    sys.stdout.write(json.dumps({
        "argv": sys.argv[3:], "cwd": os.getcwd(), "env": env,
        "stdin_len": len(data), "stdin_sha": hashlib.sha256(data).hexdigest(),
    }, sort_keys=True))
    sys.stderr.write("probe-stderr")
elif mode == "exit":
    import ctypes
    ctypes.windll.kernel32.ExitProcess(int(sys.argv[2]))
elif mode == "sleeper":
    quiet = subprocess.DEVNULL
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3)"],
                     close_fds=False, stdin=quiet, stdout=quiet, stderr=quiet)
"""


def _native_child() -> list[str]:
    assert _LAUNCHER is not None
    return [str(_LAUNCHER), BOOTSTRAP_FLAG]


def _raw_frame(payload: object) -> bytes:
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    return struct.pack("!I", len(raw)) + raw


def _run(child: list[str], frame: bytes, env: dict[str, str] | None = None) -> tuple[int, bytes, bytes]:
    done = subprocess.run(
        child, input=frame, capture_output=True, timeout=60, cwd=ROOT, env=env, check=False
    )
    return done.returncode & 0xFFFFFFFF, done.stdout, done.stderr


def _both(frame: bytes, env: dict[str, str] | None = None) -> tuple[tuple[int, bytes, bytes], ...]:
    return _run(_PYTHON_CHILD, frame, env), _run(_native_child(), frame, env)


@pytest.fixture
def probe(tmp_path: Path) -> Path:
    path = tmp_path / "probe.py"
    path.write_text(_PROBE, encoding="utf-8")
    return path


_ARGUMENT_SETS = [
    ["plain"],
    ["two words", "tab\there", ""],
    ['say "hi"', 'trailing\\', 'back\\"quote', "double\\\\"],
    ["C:\\Program Files\\x\\", "a\\\\b c\\", '"', "\\"],
    ["%PATH%", "^&|<>", "caf\u00e9 \u4e2d\u6587", "!bang!", "semi;colon,comma=eq"],
]


@pytest.mark.parametrize("arguments", _ARGUMENT_SETS)
def test_arguments_cwd_and_output_match(probe: Path, tmp_path: Path, arguments: list[str]) -> None:
    frame = encode_windows_bootstrap_payload(
        [sys.executable, str(probe), "echo", "skip", *arguments], cwd=tmp_path, env=None
    )
    python_result, native_result = _both(frame)

    assert python_result[0] == 0
    assert json.loads(python_result[1])["argv"] == arguments
    assert json.loads(python_result[1])["cwd"] == str(tmp_path)
    assert native_result == python_result


def test_inherited_and_explicit_environment_match(probe: Path, tmp_path: Path) -> None:
    launcher_env = {**os.environ, "JENNY_PARITY_MARK": "from-launcher"}
    argv = [sys.executable, str(probe), "echo", "skip"]

    inherited = _both(encode_windows_bootstrap_payload(argv, cwd=tmp_path, env=None), launcher_env)
    assert json.loads(inherited[0][1])["env"]["JENNY_PARITY_MARK"] == "from-launcher"
    assert inherited[1] == inherited[0]

    explicit_env = {"SYSTEMROOT": os.environ["SYSTEMROOT"], "Zeta": "1", "alpha": "caf\u00e9"}
    explicit = _both(
        encode_windows_bootstrap_payload(argv, cwd=tmp_path, env=explicit_env), launcher_env
    )
    seen = json.loads(explicit[0][1])["env"]
    assert "JENNY_PARITY_MARK" not in seen
    # os.environ upper-cases names on Windows; the block order is checked by parity.
    assert seen["ALPHA"] == "caf\u00e9"
    assert seen["ZETA"] == "1"
    assert explicit[1] == explicit[0]


@pytest.mark.parametrize(
    "env",
    [{}, {"=C:": "C:\\"}, {"A=B": "x"}, {"": "x"}],
    ids=["empty", "leading-equals", "equals-inside", "empty-key"],
)
def test_unusual_environment_blocks_match(tmp_path: Path, env: dict[str, str]) -> None:
    comspec = os.environ.get("COMSPEC", "C:\\Windows\\System32\\cmd.exe")
    frame = _raw_frame(
        {"argv": [comspec, "/d", "/s", "/c", "echo ok"], "cwd": str(tmp_path), "env": env,
         "input_data_b64": None}
    )
    python_result, native_result = _both(frame)

    assert python_result[0] in {0, 126}
    assert native_result == python_result


@pytest.mark.parametrize("size", [0, 19, 300_000])
def test_input_reaches_target_stdin(probe: Path, tmp_path: Path, size: int) -> None:
    data = (b"alpha.txt\0beta.txt\0" * (size // 19 + 1))[:size]
    frame = encode_windows_bootstrap_payload(
        [sys.executable, str(probe), "echo", "read"], cwd=tmp_path, env=None, input_data=data
    )
    python_result, native_result = _both(frame)

    assert json.loads(python_result[1])["stdin_len"] == size
    assert native_result == python_result


def test_unread_input_does_not_fail_the_target(probe: Path, tmp_path: Path) -> None:
    frame = encode_windows_bootstrap_payload(
        [sys.executable, str(probe), "echo", "skip"], cwd=tmp_path, env=None,
        input_data=b"x" * 600_000,
    )
    python_result, native_result = _both(frame)

    assert python_result[0] == 0
    assert native_result == python_result


@pytest.mark.parametrize("code", [0, 7, 255, 2147483647])
def test_exit_codes_match(probe: Path, tmp_path: Path, code: int) -> None:
    frame = encode_windows_bootstrap_payload(
        [sys.executable, str(probe), "exit", str(code)], cwd=tmp_path, env=None
    )
    python_result, native_result = _both(frame)

    assert python_result[0] == code
    assert native_result == python_result


def test_native_reports_the_true_code_of_a_crashed_target(probe: Path, tmp_path: Path) -> None:
    """Intended difference: the Python child collapses codes above 2**31 - 1 to 0xFFFFFFFF."""
    access_violation = 0xC0000005
    frame = encode_windows_bootstrap_payload(
        [sys.executable, str(probe), "exit", str(access_violation)], cwd=tmp_path, env=None
    )

    assert _run(_native_child(), frame)[0] == access_violation


def test_cmd_command_string_and_batch_target_match(probe: Path, tmp_path: Path) -> None:
    comspec = os.environ.get("COMSPEC", "C:\\Windows\\System32\\cmd.exe")
    command = f'"{sys.executable}" "{probe}" echo skip "a b" && echo done'
    shell = _both(
        encode_windows_bootstrap_payload([comspec, "/d", "/s", "/c", command], cwd=tmp_path, env=None)
    )
    assert shell[0][0] == 0
    assert shell[0][1].endswith(b"done\r\n")
    assert shell[1] == shell[0]

    batch = tmp_path / "show args.cmd"
    batch.write_text("@echo [%~1] [%~2]\r\n@exit /b 5\r\n", encoding="ascii")
    scripted = _both(
        encode_windows_bootstrap_payload([str(batch), "a b", "c"], cwd=tmp_path, env=None)
    )
    assert scripted[0][0] == 5
    assert scripted[0][1] == b"[a b] [c]\r\n"
    assert scripted[1] == scripted[0]


def _valid(tmp_path: Path, **overrides: object) -> dict[str, object]:
    return {"argv": ["cmd.exe"], "cwd": str(tmp_path), "env": None, "input_data_b64": None,
            **overrides}


def test_malformed_requests_are_rejected_alike(tmp_path: Path) -> None:
    missing_key = _valid(tmp_path)
    del missing_key["env"]
    frames = {
        "no bytes": b"",
        "short header": b"\x00\x00",
        "zero length": struct.pack("!I", 0),
        "over the limit": struct.pack("!I", 1024 * 1024 + 1) + b"{}",
        "short body": struct.pack("!I", 64) + b"{}",
        "bad utf-8": _raw_frame(b"\xff\xfe{}"),
        "bad json": _raw_frame(b"{not json"),
        "not an object": _raw_frame([1, 2]),
        "missing key": _raw_frame(missing_key),
        "extra key": _raw_frame(_valid(tmp_path, extra=1)),
        "argv not a list": _raw_frame(_valid(tmp_path, argv="cmd.exe")),
        "argv holds a number": _raw_frame(_valid(tmp_path, argv=["cmd.exe", 1])),
        "empty argv": _raw_frame(_valid(tmp_path, argv=[])),
        "empty program": _raw_frame(_valid(tmp_path, argv=[""])),
        "nul in argv": _raw_frame(_valid(tmp_path, argv=["cmd.exe", "a\x00b"])),
        "nul in cwd": _raw_frame(_valid(tmp_path, cwd="C:\\\x00")),
        "nul in env": _raw_frame(_valid(tmp_path, env={"A": "b\x00"})),
        "cwd not a string": _raw_frame(_valid(tmp_path, cwd=None)),
        "env value not a string": _raw_frame(_valid(tmp_path, env={"A": 1})),
        "input not a string": _raw_frame(_valid(tmp_path, input_data_b64=17)),
        "input not base64": _raw_frame(_valid(tmp_path, input_data_b64="%%%not-base64%%%")),
    }
    for label, frame in frames.items():
        python_result, native_result = _both(frame)
        assert python_result == (125, b"", _REJECTED), label
        assert native_result == python_result, label


def test_native_is_stricter_on_two_malformed_shapes(tmp_path: Path) -> None:
    """Intended differences: a duplicate key and non-canonical base64 are refused."""
    duplicate = b'{"argv":["cmd.exe"],"argv":["cmd.exe"],"cwd":".","env":null,"input_data_b64":null}'
    loose = _valid(tmp_path, input_data_b64=base64.b64encode(b"A").decode("ascii")[:-3] + "R==")

    assert _run(_native_child(), _raw_frame(duplicate)) == (125, b"", _REJECTED)
    assert _run(_native_child(), _raw_frame(loose)) == (125, b"", _REJECTED)


def test_launch_failure_matches(tmp_path: Path) -> None:
    missing = _both(
        encode_windows_bootstrap_payload(
            [str(tmp_path / "no such program.exe")], cwd=tmp_path, env=None
        )
    )
    assert missing[0] == (126, b"", _LAUNCH_FAILED)
    assert missing[1] == missing[0]

    bad_cwd = _both(
        encode_windows_bootstrap_payload(["cmd.exe", "/c", "exit"], cwd=tmp_path / "gone", env=None)
    )
    assert bad_cwd[0] == (126, b"", _LAUNCH_FAILED)
    assert bad_cwd[1] == bad_cwd[0]


@pytest.mark.parametrize("child_name", ["python", "native"])
def test_target_inherits_only_its_standard_handles(
    probe: Path, tmp_path: Path, child_name: str
) -> None:
    """A handle the child itself inherited must not reach the target.

    The target starts a three second sleeper that inherits everything the
    target holds. If the target had received the pipe's write end, the read end
    would stay open until the sleeper exits.
    """
    child = _PYTHON_CHILD if child_name == "python" else _native_child()
    read_fd, write_fd = os.pipe()
    os.set_inheritable(write_fd, True)
    quiet = subprocess.DEVNULL
    try:
        process = subprocess.Popen(
            child, stdin=subprocess.PIPE, stdout=quiet, stderr=quiet, cwd=ROOT, close_fds=False
        )
    finally:
        os.close(write_fd)
    try:
        assert process.stdin is not None
        process.stdin.write(
            encode_windows_bootstrap_payload(
                [sys.executable, str(probe), "sleeper"], cwd=tmp_path, env=None
            )
        )
        process.stdin.close()
        assert process.wait(timeout=30) == 0
        started = time.monotonic()
        assert os.read(read_fd, 1) == b""
        assert time.monotonic() - started < 1.5
    finally:
        os.close(read_fd)
        if process.poll() is None:
            process.kill()
            process.wait()


def test_the_sidecar_health_probe_accepts_the_built_launcher() -> None:
    from sidecar.ai.tools.builtins import owned_process_native as native

    assert _LAUNCHER is not None
    assert native._probe(_LAUNCHER) is True
