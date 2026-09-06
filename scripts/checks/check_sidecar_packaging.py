"""Validate sidecar packaging entrypoint viability."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.protocol import API_VERSION

COMMAND_TIMEOUT_SECONDS = 30


def _run_command(command: list[str]) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return 1, "", f"command timed out after {COMMAND_TIMEOUT_SECONDS}s: {' '.join(command)}"
    except OSError as error:
        return 1, "", f"command failed to start: {error}"
    return completed.returncode, completed.stdout, completed.stderr


def main() -> int:
    commands = [
        [sys.executable, "-m", "sidecar", "--self-check"],
        [sys.executable, "-m", "sidecar", "--version"],
    ]

    for command in commands:
        return_code, stdout, stderr = _run_command(command)
        if return_code != 0:
            print("FAIL: sidecar packaging proof")
            print(f"  - command failed: {' '.join(command)}")
            if stdout.strip():
                print(f"  - stdout: {stdout.strip()}")
            if stderr.strip():
                print(f"  - stderr: {stderr.strip()}")
            return return_code
        if command[-1] == "--version":
            output = f"{stdout}\n{stderr}"
            if API_VERSION not in output:
                print("FAIL: sidecar packaging proof")
                print(
                    f"  - command output missing expected api version '{API_VERSION}': "
                    f"{' '.join(command)}"
                )
                return 1

    print("PASS: sidecar packaging proof")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
