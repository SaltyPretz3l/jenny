#!/usr/bin/env python3
"""Drive the interactive owner CLI through a real container TTY for CI smoke."""

from __future__ import annotations

import os
import pty
import re
import select
import subprocess
import sys
import time

EXPECTED_ARG_COUNT = 5
PASSWORD = b"hosted-ci-password-123!"
SAFE_IMAGE = re.compile(r"^[A-Za-z0-9._:/@-]{1,256}$")


def main() -> int:
    if len(sys.argv) != EXPECTED_ARG_COUNT or not SAFE_IMAGE.fullmatch(sys.argv[1]):
        raise SystemExit("usage: owner-init-container.py IMAGE VOLUME CONFIG SECRETS")
    image, volume, config_path, secrets_path = sys.argv[1:]
    command = [
        "docker", "run", "--rm", "-it", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--pids-limit", "256",
        "--memory", "2g", "--cpus", "2", "--tmpfs", "/tmp:size=268435456,mode=1777",
        "--mount", f"type=volume,src={volume},dst=/data",
        "--mount", f"type=bind,src={config_path},dst=/etc/jenny/host.json,readonly",
        "--mount", f"type=bind,src={secrets_path},dst=/run/jenny-secrets,readonly",
        "--entrypoint", "node", image, "server/cli.js", "owner-init",
        "--config", "/etc/jenny/host.json",
    ]
    master, slave = pty.openpty()
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    output = bytearray()
    sent_first = False
    sent_second = False
    deadline = time.monotonic() + 60
    try:
        while process.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.25)
            if not ready:
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            output.extend(chunk)
            if not sent_first and b"Owner password:" in output:
                os.write(master, PASSWORD + b"\n")
                sent_first = True
                output.clear()
            elif sent_first and not sent_second and b"Repeat owner password:" in output:
                os.write(master, PASSWORD + b"\n")
                sent_second = True
                output.clear()
        if process.poll() is None:
            process.kill()
            raise RuntimeError("owner initialization timed out")
        if process.wait() != 0 or not sent_second:
            raise RuntimeError("owner initialization failed")
        return 0
    finally:
        os.close(master)


if __name__ == "__main__":
    raise SystemExit(main())
