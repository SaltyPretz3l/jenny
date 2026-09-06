"""Build a packaged sidecar artifact for Electron resources."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.protocol import API_VERSION  # noqa: E402

ENTRYPOINT = ROOT / "sidecar" / "__main__.py"
ARTIFACT_DIR = ROOT / "build" / "sidecar"
TEMP_BUILD_DIR = ROOT / "build" / ".sidecar-packaging"
ARTIFACT_BASE_NAME = "sidecar"
MANIFEST_NAME = "manifest.json"
SOURCE_DATE_EPOCH_ENV = "SOURCE_DATE_EPOCH"
DEFAULT_TIMEOUT_SECONDS = 900
DEPENDENCY_LOCKS: tuple[tuple[str, str], ...] = (
    ("sidecar_runtime", "requirements-lock.txt"),
    ("sidecar_build", "requirements-build-lock.txt"),
    ("managed_python_runtime", "requirements-python-runtime-lock.txt"),
)
PYTHON_RUNTIME_BUNDLE_CONTRACT = Path("config/python-runtime-bundle-lock.json")

BUNDLED_DATA_FILES: tuple[tuple[Path, str], ...] = (
    (ROOT / "services" / "tools" / "tool-manifest.json", "services/tools"),
    # prompt_modes.py reads the plan-mode prompt contract through sys._MEIPASS
    # exactly like catalog.py reads the manifest; the packaged sidecar failed
    # initialize with FileNotFoundError when this entry was missing.
    (ROOT / "services" / "tools" / "plan-mode-contract.json", "services/tools"),
)
PYINSTALLER_EXCLUDED_MODULES: tuple[str, ...] = (
    # These optional stacks may be installed in a dev environment, but the
    # packaging extra does not require them. Excluding them keeps PyInstaller
    # from bundling dev-only ML/audio dependencies into the local-first sidecar.
    "accelerate",
    "av",
    "ctranslate2",
    "datasets",
    "diffusers",
    "faster_whisper",
    "huggingface_hub",
    "onnxruntime",
    "safetensors",
    "sentence_transformers",
    "sentencepiece",
    "tensorflow",
    "tokenizers",
    "torch",
    "torchaudio",
    "torchvision",
    "transformers",
)


def _artifact_name_for_platform(platform_name: str) -> str:
    return f"{ARTIFACT_BASE_NAME}.exe" if platform_name.startswith("win") else ARTIFACT_BASE_NAME


def _artifact_candidates() -> list[Path]:
    preferred_name = _artifact_name_for_platform(sys.platform)
    preferred = ARTIFACT_DIR / preferred_name
    alternate = ARTIFACT_DIR / (
        ARTIFACT_BASE_NAME if preferred_name.endswith(".exe") else f"{ARTIFACT_BASE_NAME}.exe"
    )
    if preferred == alternate:
        return [preferred]
    return [preferred, alternate]


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build build/sidecar/sidecar(.exe) via PyInstaller."
    )
    parser.add_argument(
        "--python-executable",
        default=sys.executable,
        help="Python executable used to run PyInstaller.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Timeout for each spawned command.",
    )
    parser.add_argument(
        "--source-date-epoch",
        default=os.environ.get(SOURCE_DATE_EPOCH_ENV, "").strip(),
        help=(
            "Optional SOURCE_DATE_EPOCH value for reproducible build metadata. "
            "Defaults to environment SOURCE_DATE_EPOCH when set."
        ),
    )
    parser.add_argument(
        "--skip-clean",
        action="store_true",
        help="Preserve existing build temp and artifact directories before building.",
    )
    return parser.parse_args(list(argv) if argv is not None else None)


# Ceiling for draining a child's pipes after it has already been killed. The
# pipes are closed by a process that is supposed to be gone, so this only ever
# fires when the kill itself did not take.
DRAIN_TIMEOUT_SECONDS = 30


def _subprocess_group_kwargs() -> dict[str, object]:
    if sys.platform.startswith("win"):
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return

    if sys.platform.startswith("win"):
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
        )
    else:
        killpg = getattr(os, "killpg", None)
        if callable(killpg):
            killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()

    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _run_command(
    command: list[str],
    *,
    timeout_seconds: int,
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        text=True,
        env=env,
        **_subprocess_group_kwargs(),
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        try:
            # Bounded. _terminate_process_tree can fail (a denied taskkill, a
            # descendant that outlived its group), and an unbounded drain then
            # hangs the packaging build forever on the exact branch that exists
            # to stop a runaway one.
            stdout, stderr = process.communicate(timeout=DRAIN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            stdout, stderr = "", ""
        raise subprocess.TimeoutExpired(
            command,
            timeout_seconds,
            output=stdout,
            stderr=stderr,
        ) from error
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def _python_candidates(preferred: str) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    for candidate in [
        preferred,
        str(ROOT / ".venv" / "Scripts" / "python.exe"),
        str(ROOT / ".venv" / "bin" / "python"),
        sys.executable,
        "python",
    ]:
        value = str(candidate or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        candidates.append(value)
    return candidates


def _resolve_pyinstaller_python(
    *, preferred: str, timeout_seconds: int, env: dict[str, str]
) -> str:
    for candidate in _python_candidates(preferred):
        version_command = [candidate, "-m", "PyInstaller", "--version"]
        try:
            completed = _run_command(version_command, timeout_seconds=timeout_seconds, env=env)
        except subprocess.TimeoutExpired:
            continue
        if completed.returncode == 0:
            return candidate
    return preferred


def _resolve_artifact_path() -> Path | None:
    for candidate in _artifact_candidates():
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _pyinstaller_exclude_args() -> list[str]:
    args: list[str] = []
    for module_name in PYINSTALLER_EXCLUDED_MODULES:
        args.extend(["--exclude-module", module_name])
    return args


def _create_temp_build_run_dir() -> Path:
    TEMP_BUILD_DIR.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="run-", dir=str(TEMP_BUILD_DIR)))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_build_timestamp(source_date_epoch: str) -> str:
    if source_date_epoch.isdigit():
        timestamp = datetime.fromtimestamp(int(source_date_epoch), tz=timezone.utc)
    else:
        timestamp = datetime.now(timezone.utc)
    return timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_pyinstaller_version(
    *, python_executable: str, timeout_seconds: int, env: dict[str, str]
) -> str:
    version_command = [python_executable, "-m", "PyInstaller", "--version"]
    completed = _run_command(version_command, timeout_seconds=timeout_seconds, env=env)
    if completed.returncode != 0:
        return "unknown"
    value = completed.stdout.strip() or completed.stderr.strip()
    return value or "unknown"


def _read_python_version(
    *, python_executable: str, timeout_seconds: int, env: dict[str, str]
) -> str:
    version_command = [python_executable, "-c", "import platform; print(platform.python_version())"]
    completed = _run_command(version_command, timeout_seconds=timeout_seconds, env=env)
    if completed.returncode != 0:
        return "unknown"
    value = completed.stdout.strip() or completed.stderr.strip()
    return value or "unknown"


def _git_output(args: Sequence[str]) -> tuple[bool, str]:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, ""
    if completed.returncode != 0:
        return False, ""
    return True, completed.stdout.strip()


def _git_commit() -> str:
    succeeded, output = _git_output(["rev-parse", "HEAD"])
    return output if succeeded else ""


def _git_metadata() -> dict[str, object]:
    commit_succeeded, commit = _git_output(["rev-parse", "HEAD"])
    status_succeeded, dirty_output = (
        _git_output(["status", "--porcelain"])
        if commit_succeeded and commit
        else (False, "")
    )
    return {
        "git_commit": commit if commit_succeeded and commit else None,
        "git_dirty": bool(dirty_output) if status_succeeded else None,
    }


def _dependency_provenance() -> dict[str, object]:
    locks: dict[str, dict[str, str]] = {}
    for name, relative_path in DEPENDENCY_LOCKS:
        path = ROOT / relative_path
        if not path.is_file():
            raise RuntimeError(f"dependency lock is missing: {path}")
        locks[name] = {
            "path": path.relative_to(ROOT).as_posix(),
            "sha256": _sha256(path),
        }
    bundle_contract: dict[str, object] = {}
    bundle_contract_path = ROOT / PYTHON_RUNTIME_BUNDLE_CONTRACT
    if not bundle_contract_path.is_file():
        raise RuntimeError(f"managed Python bundle contract is missing: {bundle_contract_path}")
    bundle_contract = {
        "path": PYTHON_RUNTIME_BUNDLE_CONTRACT.as_posix(),
        "sha256": _sha256(bundle_contract_path),
    }
    try:
        payload = json.loads(bundle_contract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"managed Python bundle contract is invalid: {error}") from error
    python = payload.get("python") if isinstance(payload, dict) else None
    if not isinstance(python, dict):
        raise RuntimeError("managed Python bundle contract has no python object")
    bundle_contract["python_version"] = python.get("version")
    bundle_contract["source_sha256"] = python.get("embed_sha256")
    return {
        "build_isolation": False,
        "dependency_locks": locks,
        "managed_python_bundle_contract": bundle_contract,
    }


def _required_dependency_provenance() -> dict[str, object]:
    try:
        return _dependency_provenance()
    except RuntimeError as error:
        print("FAIL: sidecar artifact build")
        print(f"  - {error}")
        raise SystemExit(1) from error


def _write_manifest(
    artifact_path: Path,
    *,
    python_executable: str,
    python_version: str,
    source_date_epoch: str,
    pyinstaller_version: str,
    dependency_provenance: dict[str, object],
) -> Path:
    manifest_path = ARTIFACT_DIR / MANIFEST_NAME
    manifest = {
        "api_version": API_VERSION,
        "artifact_name": artifact_path.name,
        "build_platform": sys.platform,
        "generated_at_utc": _resolve_build_timestamp(source_date_epoch),
        **_git_metadata(),
        **dependency_provenance,
        "pyinstaller_version": pyinstaller_version,
        "python_executable": python_executable,
        "python_version": python_version,
        "sha256": _sha256(artifact_path),
        "source_date_epoch": source_date_epoch or None,
    }
    manifest_path.write_text(
        f"{json.dumps(manifest, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    return manifest_path


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)

    if args.timeout_seconds <= 0:
        print("FAIL: sidecar artifact build")
        print("  - timeout must be greater than zero")
        return 1

    dependency_provenance = _required_dependency_provenance()

    if not args.skip_clean:
        shutil.rmtree(ARTIFACT_DIR, ignore_errors=True)
        shutil.rmtree(TEMP_BUILD_DIR, ignore_errors=True)

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    temp_run_dir = _create_temp_build_run_dir()
    work_path = temp_run_dir / "work"
    spec_path = temp_run_dir / "spec"
    work_path.mkdir(parents=True, exist_ok=True)
    spec_path.mkdir(parents=True, exist_ok=True)

    build_env = os.environ.copy()
    if args.source_date_epoch:
        build_env[SOURCE_DATE_EPOCH_ENV] = args.source_date_epoch

    python_executable = _resolve_pyinstaller_python(
        preferred=args.python_executable,
        timeout_seconds=args.timeout_seconds,
        env=build_env,
    )
    add_data_separator = ";" if sys.platform.startswith("win") else ":"
    add_data_args: list[str] = []
    for source_path, dest_dir in BUNDLED_DATA_FILES:
        if not source_path.exists():
            print("FAIL: sidecar artifact build")
            print(f"  - bundled data file missing: {source_path}")
            return 1
        add_data_args.extend(["--add-data", f"{source_path}{add_data_separator}{dest_dir}"])

    command = [
        python_executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        ARTIFACT_BASE_NAME,
        "--distpath",
        str(ARTIFACT_DIR),
        "--workpath",
        str(work_path),
        "--specpath",
        str(spec_path),
        *add_data_args,
        *_pyinstaller_exclude_args(),
        str(ENTRYPOINT),
    ]

    try:
        build_result = _run_command(command, timeout_seconds=args.timeout_seconds, env=build_env)
    except subprocess.TimeoutExpired:
        print("FAIL: sidecar artifact build")
        print(f"  - build timed out after {args.timeout_seconds}s")
        return 1

    if build_result.returncode != 0:
        print("FAIL: sidecar artifact build")
        print(f"  - command failed: {' '.join(command)}")
        if build_result.stdout.strip():
            print(f"  - stdout: {build_result.stdout.strip()}")
        if build_result.stderr.strip():
            print(f"  - stderr: {build_result.stderr.strip()}")
        return build_result.returncode

    artifact_path = _resolve_artifact_path()
    if artifact_path is None:
        print("FAIL: sidecar artifact build")
        print("  - build completed but sidecar artifact was not found in build/sidecar")
        return 1

    pyinstaller_version = _read_pyinstaller_version(
        python_executable=python_executable,
        timeout_seconds=args.timeout_seconds,
        env=build_env,
    )
    manifest_path = _write_manifest(
        artifact_path,
        python_executable=python_executable,
        python_version=_read_python_version(
            python_executable=python_executable,
            timeout_seconds=args.timeout_seconds,
            env=build_env,
        ),
        source_date_epoch=args.source_date_epoch,
        pyinstaller_version=pyinstaller_version,
        dependency_provenance=dependency_provenance,
    )

    print("PASS: sidecar artifact build")
    print(f"  - artifact: {artifact_path.relative_to(ROOT)}")
    print(f"  - manifest: {manifest_path.relative_to(ROOT)}")
    print(f"  - api_version: {API_VERSION}")
    print(f"  - pyinstaller_version: {pyinstaller_version}")
    if args.source_date_epoch:
        print(f"  - source_date_epoch: {args.source_date_epoch}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
