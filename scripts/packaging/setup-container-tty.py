#!/usr/bin/env python3
"""Exercise the image's actual wizard TTY; only disposable CI credentials."""
import os
import pty
import select
import subprocess
import sys
import time

MAX_OUTPUT_BYTES = 65536
PASSWORD = b"hosted-setup-test-password!"
KEY = b"setup-fixture-api-key"
LOCALHOST = "--localhost" in sys.argv[1:]
STEPS = [(b"Browser access:", b"1" if LOCALHOST else b"2")] + ([] if LOCALHOST else [
    (b"Private HTTPS address", b"https://jenny.test"),
]) + [
    (b"Model server: 1", b"2"),
    (b"Model server URL", b"http://model:8000/v1"),
    (b"require an API key", b"yes"),
    (b"Model API key (hidden):", KEY),
    (b"Model number or exact identifier", b"1"),
    ("Enable typed file tools".encode(), b"yes"),
    (b"Enable approved commands", b"yes" if LOCALHOST else b"no"),
    (b"Owner password:", PASSWORD),
    (b"Repeat owner password:", PASSWORD),
]


def main():
    master, slave = pty.openpty()
    process = subprocess.Popen(["node", "server/setup.js", "init"],
                               stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    transcript = bytearray()
    pending = bytearray()
    step = 0
    deadline = time.monotonic() + 45
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                transcript.extend(chunk)
                pending.extend(chunk)
                if len(transcript) > MAX_OUTPUT_BYTES:
                    raise RuntimeError("wizard output exceeded limit")
                if step < len(STEPS) and STEPS[step][0] in pending:
                    # readline/password handlers switch mode synchronously before
                    # the prompt reaches this PTY; send only the requested answer.
                    os.write(master, STEPS[step][1] + b"\n")
                    pending.clear()
                    step += 1
            elif process.poll() is not None:
                break
        if process.poll() is None:
            process.wait(timeout=2)
        if process.returncode != 0 or step != len(STEPS):
            raise RuntimeError("wizard failed at prompt " + str(step))
        if KEY in transcript or PASSWORD in transcript:
            raise RuntimeError("wizard echoed a credential")
        print("Real wizard TTY and hidden credentials passed.")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
