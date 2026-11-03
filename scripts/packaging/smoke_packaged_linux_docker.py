"""Run the Linux packaged-app smoke in a local Docker container.

On a Windows host where Smart App Control is enforcing, every freshly built
unsigned sidecar.exe gets its own cloud verdict, so the Windows packaged smoke
(smoke_packaged_flow.py) cannot pass reliably (its self-check was blocked with
WinError 4551 on 2026-10-28). This runs the ci-linux-package.yml steps instead:
build the sidecar artifact and the unpacked Linux app, then launch it under
Xvfb, inside an Ubuntu 22.04 container where Smart App Control does not apply.
It covers the packaging pipeline, not Windows-only packaging.

The checkout (tracked plus untracked, non-ignored files, as they are on disk)
streams into the container on stdin; nothing in the checkout is written except
the copied smoke log at artifacts/logs/packaging-smoke-docker-linux.log.
Named volumes keep the npm, pip and Electron download caches between runs.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
import tarfile
import threading
import time
from pathlib import Path
from typing import IO

ROOT = Path(__file__).resolve().parents[2]
CONTEXT_DIR = ROOT / "scripts" / "packaging" / "linux-smoke"
LOG_DIR = ROOT / "artifacts" / "logs"
LOG_NAME = "packaging-smoke-docker-linux.log"
IMAGE_REPOSITORY = "jenny-linux-smoke"
DEFAULT_TIMEOUT_SECONDS = 1800
CACHE_VOLUMES = {
    "jenny-linux-smoke-npm": "/root/.npm",
    "jenny-linux-smoke-pip": "/root/.cache/pip",
    "jenny-linux-smoke-electron": "/root/.cache/electron",
    "jenny-linux-smoke-electron-builder": "/root/.cache/electron-builder",
}
FAIL = "FAIL: Linux packaged smoke in Docker"


def node_version(root: Path = ROOT) -> str:
    return (root / ".nvmrc").read_text(encoding="utf-8").strip().lstrip("v")


def image_tag(root: Path = ROOT) -> str:
    """The tag changes whenever the image inputs do, so an edit rebuilds it."""
    digest = hashlib.sha256()
    context = root / "scripts" / "packaging" / "linux-smoke"
    for name in ("Dockerfile", "run-in-container.sh"):
        digest.update((context / name).read_bytes())
    digest.update(node_version(root).encode("utf-8"))
    return f"{IMAGE_REPOSITORY}:{digest.hexdigest()[:12]}"


def _git_z(root: Path, args: list[str]) -> list[str]:
    output = subprocess.run(["git", *args], cwd=root, capture_output=True, check=True).stdout
    return [entry.decode("utf-8") for entry in output.split(b"\0") if entry]


def source_entries(root: Path = ROOT) -> list[tuple[str, int]]:
    """(posix path, mode) for every tracked or untracked, non-ignored file on disk.

    Tracked files keep their index mode (100755 -> 0o755); a tracked file
    deleted on disk is skipped, as are gitlinks, links and anything else that
    is not a regular file.
    """
    entries: dict[str, int] = {}
    for line in _git_z(root, ["ls-files", "-z", "-s"]):
        meta, path = line.split("\t", 1)
        index_mode = meta.split(" ", 1)[0]
        if index_mode in {"100644", "100755"}:
            entries[path] = 0o755 if index_mode == "100755" else 0o644
    for path in _git_z(root, ["ls-files", "-z", "-o", "--exclude-standard"]):
        entries.setdefault(path, 0o644)
    on_disk = [
        (path, mode)
        for path, mode in entries.items()
        if (root / path).is_file() and not (root / path).is_symlink()
    ]
    return sorted(on_disk)


def write_source_tar(entries: list[tuple[str, int]], stream: IO[bytes], root: Path = ROOT) -> None:
    with tarfile.open(fileobj=stream, mode="w|") as archive:
        for path, mode in entries:
            info = archive.gettarinfo(str(root / path), arcname=path)
            info.mode = mode
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            with open(root / path, "rb") as handle:
                archive.addfile(info, handle)


def run_command(tag: str, container_name: str, log_dir: Path = LOG_DIR) -> list[str]:
    command = [
        "docker", "run", "--rm", "-i",
        "--name", container_name,
        # As in CI: Chromium's namespace sandbox needs clone() and a larger /dev/shm.
        "--security-opt", "seccomp=unconfined",
        "--shm-size=1g",
    ]
    for volume, target in CACHE_VOLUMES.items():
        command += ["--mount", f"type=volume,source={volume},target={target}"]
    command += ["--mount", f"type=bind,source={log_dir},target=/out", tag]
    return command


def docker_ready() -> str:
    """'' when a Linux-container daemon answers, else the reason it cannot run."""
    try:
        probe = subprocess.run(
            ["docker", "info", "--format", "{{.OSType}}"],
            capture_output=True, text=True, timeout=60, check=False,
        )
    except FileNotFoundError:
        return "the docker CLI is not on PATH (install Docker Desktop)"
    except subprocess.TimeoutExpired:
        return "docker info timed out"
    if probe.returncode != 0:
        return "the Docker daemon is not reachable (start Docker Desktop and retry)"
    os_type = probe.stdout.strip()
    if os_type != "linux":
        return f"Docker is serving {os_type or 'unknown'} containers; switch to Linux containers"
    return ""


def ensure_image(tag: str, *, rebuild: bool, timeout_seconds: float) -> int:
    if not rebuild:
        inspect = ["docker", "image", "inspect", tag]
        if subprocess.run(inspect, capture_output=True, check=False).returncode == 0:
            print(f"[linux-smoke] image {tag} is current", flush=True)
            return 0
    print(f"[linux-smoke] building image {tag}", flush=True)
    build = [
        "docker", "build", "--build-arg", f"NODE_VERSION={node_version()}", "-t", tag,
        *(["--no-cache"] if rebuild else []),
        str(CONTEXT_DIR),
    ]
    return subprocess.run(build, timeout=timeout_seconds, check=False).returncode


def _stream_source(
    entries: list[tuple[str, int]], process: subprocess.Popen[bytes], failure: list[Exception]
) -> None:
    try:
        assert process.stdin is not None
        write_source_tar(entries, process.stdin)
    except (OSError, tarfile.TarError) as error:  # a container that exits early closes the pipe
        failure.append(error)
    finally:
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass


def _prepare_image(rebuild: bool, deadline: float) -> str:
    """The image tag, or '' after printing why it is unavailable."""
    reason = docker_ready()
    if reason:
        print(f"{FAIL}: {reason}")
        return ""
    tag = image_tag()
    try:
        remaining = max(1.0, deadline - time.monotonic())
        built = ensure_image(tag, rebuild=rebuild, timeout_seconds=remaining)
    except subprocess.TimeoutExpired:
        print(f"{FAIL}: the image build timed out")
        return ""
    if built != 0:
        print(f"{FAIL}: the image build failed")
        return ""
    return tag


def _run_container(tag: str, deadline: float) -> int:
    entries = source_entries()
    head = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    ).stdout.strip()
    print(f"[linux-smoke] streaming {len(entries)} files from {ROOT} (HEAD {head}, as on disk)",
          flush=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / LOG_NAME
    log_path.unlink(missing_ok=True)
    container_name = f"jenny-linux-smoke-{os.getpid()}"
    process = subprocess.Popen(run_command(tag, container_name), stdin=subprocess.PIPE)
    failure: list[Exception] = []
    writer = threading.Thread(target=_stream_source, args=(entries, process, failure), daemon=True)
    writer.start()
    try:
        returncode = process.wait(timeout=max(1.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        # The container is named for this run, so this removes only it.
        remove = ["docker", "rm", "--force", container_name]
        subprocess.run(remove, capture_output=True, check=False)
        process.kill()
        print(f"{FAIL}: timed out")
        return 1
    writer.join(timeout=30)
    if failure:
        print(f"{FAIL}: streaming the checkout failed: {failure[0]}")
        return 1
    if returncode != 0:
        print(f"{FAIL} (exit {returncode}); smoke log: {log_path}")
        return returncode
    print(f"PASS: Linux packaged smoke in Docker; smoke log: {log_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n", 1)[0])
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS,
                        help="Budget for the image build and the container run together.")
    parser.add_argument("--rebuild-image", action="store_true",
                        help="Rebuild the toolchain image without the Docker layer cache.")
    args = parser.parse_args()
    deadline = time.monotonic() + max(1, args.timeout_seconds)
    tag = _prepare_image(args.rebuild_image, deadline)
    return _run_container(tag, deadline) if tag else 1


if __name__ == "__main__":
    sys.exit(main())
