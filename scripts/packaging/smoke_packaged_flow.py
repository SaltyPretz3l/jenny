"""Packaging smoke test for the packaged Electron + sidecar flow."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from packaged_probe_payloads import (  # noqa: E402, F401
    REQUIRED_PACKAGED_BUILTIN_TOOLS,
    _append_bounded_tail,
    _available_tool_names,
    _decode_stderr_tail,
    _format_mcp_failure_detail,
    _format_probe_read_error,
    _load_packaged_smoke_payload,
    _packaged_tool_unavailable_detail,
    _raise_probe_response_error,
    _validate_packaged_initialize_payload,
    _validate_packaged_smoke_payload,
)

from sidecar.protocol import API_VERSION, CONTENT_LENGTH_HEADER  # noqa: E402
from sidecar.runtime.framing import read_framed_message, write_framed_message  # noqa: E402

NPM_COMMAND = "npm.cmd" if sys.platform.startswith("win") else "npm"
DEFAULT_TIMEOUT_SECONDS = 1800
DEFAULT_STEP_TIMEOUT_SECONDS = 900
MANIFEST_NAME = "manifest.json"
PACKAGING_LOG = ROOT / "artifacts" / "logs" / "packaging-smoke-phase4.log"
PACKAGED_RESOURCE_SYNC_TIMEOUT_SECONDS = 10.0
PACKAGED_RESOURCE_SYNC_POLL_SECONDS = 0.25
PACKAGED_APP_SMOKE_TIMEOUT_SECONDS = 120
PACKAGED_APP_SMOKE_EXIT_GRACE_SECONDS = 15
PACKAGED_APP_SMOKE_POLL_SECONDS = 0.25
PACKAGED_SMOKE_REQUEST_FILENAME = "packaged-smoke-request.json"
MAX_PACKAGED_PROBE_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024
MAX_PACKAGED_PROBE_STDERR_TAIL_BYTES = 4096
SHA256_HEX_RE = re.compile(r"^[a-f0-9]{64}$")
RESTRICTED_HOST_MANIFEST = "jenny-plugin-host.manifest.json"


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a packaged-flow smoke check using built sidecar artifacts."
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Global timeout budget for the full smoke workflow.",
    )
    parser.add_argument(
        "--step-timeout-seconds",
        type=int,
        default=DEFAULT_STEP_TIMEOUT_SECONDS,
        help="Timeout budget for each individual command.",
    )
    parser.add_argument(
        "--log-path",
        default=str(PACKAGING_LOG),
        help="Output log file for command evidence.",
    )
    parser.add_argument(
        "--source-date-epoch",
        default=os.environ.get("SOURCE_DATE_EPOCH", "").strip(),
        help="Optional SOURCE_DATE_EPOCH forwarded to sidecar artifact build.",
    )
    parser.add_argument(
        "--allow-stale-source",
        action="store_true",
        help="Allow packaged sidecar manifest git_commit to differ from the current checkout.",
    )
    return parser.parse_args(list(argv) if argv is not None else None)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _display_path(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(ROOT.resolve()))
    except ValueError:
        return str(Path(path).resolve())


def collect_windows_signing_status(app_path: Path) -> dict[str, str]:
    resolved = Path(app_path)
    if not sys.platform.startswith("win"):
        return {"status": "skipped", "reason": "non-windows host"}
    if resolved.suffix.lower() != ".exe":
        return {"status": "skipped", "reason": "not a Windows executable"}
    signtool = shutil.which("signtool")
    if not signtool:
        return {"status": "unavailable", "reason": "signtool not found"}
    completed = subprocess.run(
        [signtool, "verify", "/pa", str(resolved)],
        cwd=ROOT,
        capture_output=True,
        check=False,
        text=True,
        timeout=60,
    )
    return {
        "status": "passed" if completed.returncode == 0 else "failed",
        "reason": (completed.stderr or completed.stdout or "").strip()[-512:],
    }


def _current_git_commit() -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout.strip()


def _subprocess_group_kwargs() -> dict[str, object]:
    if sys.platform.startswith("win"):
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return

    if sys.platform.startswith("win"):
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
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
    log_path: Path,
    timeout_seconds: int,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    stdout = ""
    stderr = ""
    try:
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
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        stdout, stderr = process.communicate()
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"\n$ {' '.join(command)}\n")
            if stdout:
                handle.write("[stdout]\n")
                handle.write(stdout)
                if not stdout.endswith("\n"):
                    handle.write("\n")
            if stderr:
                handle.write("[stderr]\n")
                handle.write(stderr)
                if not stderr.endswith("\n"):
                    handle.write("\n")
            handle.write(f"[timeout after {timeout_seconds}s]\n")
        command_text = " ".join(command)
        raise RuntimeError(f"command timed out after {timeout_seconds}s: {command_text}") from error

    result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"\n$ {' '.join(command)}\n")
        if result.stdout:
            handle.write("[stdout]\n")
            handle.write(result.stdout)
            if not result.stdout.endswith("\n"):
                handle.write("\n")
        if result.stderr:
            handle.write("[stderr]\n")
            handle.write(result.stderr)
            if not result.stderr.endswith("\n"):
                handle.write("\n")
        handle.write(f"[exit_code] {result.returncode}\n")

    if result.returncode != 0:
        raise RuntimeError(
            "command failed "
            f"(exit_code={result.returncode}): {' '.join(command)}; "
            f"see {_display_path(log_path)}"
        )
    return result


def _append_log(log_path: Path, text: str) -> None:
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(text)
        if not text.endswith("\n"):
            handle.write("\n")


def _remaining_timeout_seconds(*, deadline: float, step_cap: int) -> int:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("packaged flow smoke global timeout exhausted")
    return max(1, min(int(step_cap), math.ceil(remaining)))


# HOST-platform layouts only, so a stale foreign dist/ tree from another build cannot
# be reported as the thing just packaged. Names track electron-builder.yml productName.
def _platform_packaged_candidates() -> tuple[list[Path], list[Path]]:
    dist = ROOT / "dist"
    if sys.platform.startswith("win"):
        dirs, names = ("win-unpacked", "win-arm64-unpacked"), ("Jenny.exe",)
    elif sys.platform.startswith("linux"):
        dirs, names = ("linux-unpacked", "linux-arm64-unpacked"), ("Jenny", "jenny")
    elif sys.platform == "darwin":
        mac = [dist / d / "Jenny.app/Contents" for d in ("mac", "mac-arm64", "mac-universal")]
        return [r / "Resources" for r in mac], [r / "MacOS" / "Jenny" for r in mac]
    else:
        raise RuntimeError(f"unsupported packaged smoke platform: {sys.platform}")
    roots = [dist / d for d in dirs]
    return [r / "resources" for r in roots], [r / n for r in roots for n in names]


def _resolve_platform_path(candidates: Sequence[Path], label: str) -> Path:
    matches = list(dict.fromkeys(path for path in candidates if path.exists()))
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise RuntimeError(f"ambiguous {label}: {', '.join(map(_display_path, matches))}")
    expected = ", ".join(map(_display_path, candidates))
    raise RuntimeError(f"unable to locate {label}; expected one of: {expected}")


def _resolve_resources_dir() -> Path:
    return _resolve_platform_path(_platform_packaged_candidates()[0], "packaged resources dir")


def _resolve_packaged_app_path() -> Path:
    return _resolve_platform_path(_platform_packaged_candidates()[1], "packaged app executable")


def _resolve_artifact_path(sidecar_dir: Path, artifact_name: str) -> Path:
    normalized_name = str(artifact_name or "").strip()
    if not normalized_name:
        raise RuntimeError("packaged sidecar manifest missing artifact_name")

    candidate_name = Path(normalized_name)
    if candidate_name.name != normalized_name:
        raise RuntimeError("packaged sidecar manifest artifact_name must be a filename")

    artifact_path = (sidecar_dir / normalized_name).resolve()
    if artifact_path.parent != sidecar_dir.resolve():
        raise RuntimeError("packaged sidecar artifact_name escapes the sidecar directory")
    return artifact_path


def _validate_packaged_source_fresh(
    manifest_data: dict[str, object],
    *,
    allow_stale_source: bool,
) -> None:
    if allow_stale_source:
        return
    if manifest_data.get("git_dirty") is True:
        raise RuntimeError("stale packaged sidecar artifact: manifest reports dirty source")
    current_commit = _current_git_commit()
    if not current_commit:
        return
    manifest_commit = str(manifest_data.get("git_commit") or "").strip()
    if manifest_commit != current_commit:
        detail = f"{manifest_commit or 'missing'} != {current_commit}"
        raise RuntimeError(f"stale packaged sidecar artifact: manifest git_commit {detail}")


def _validate_packaged_artifact(
    resources_dir: Path,
    *,
    log_path: Path,
    allow_stale_source: bool = False,
) -> tuple[Path, Path]:
    sidecar_dir = resources_dir / "sidecar"
    manifest_path = sidecar_dir / MANIFEST_NAME
    if not manifest_path.exists():
        raise RuntimeError(f"packaged sidecar manifest missing: {manifest_path}")

    manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest_data, dict):
        raise RuntimeError("packaged sidecar manifest is not an object")

    artifact_name = str(manifest_data.get("artifact_name", "")).strip()
    manifest_api_version = str(manifest_data.get("api_version", "")).strip()
    manifest_sha256 = str(manifest_data.get("sha256", "")).strip().lower()
    if manifest_api_version != API_VERSION:
        raise RuntimeError(
            "packaged sidecar manifest api_version mismatch: "
            f"{manifest_api_version} != {API_VERSION}"
        )
    if not SHA256_HEX_RE.fullmatch(manifest_sha256):
        raise RuntimeError("packaged sidecar manifest sha256 is invalid")

    artifact_path = _resolve_artifact_path(sidecar_dir, artifact_name)
    if not artifact_path.exists():
        raise RuntimeError(f"packaged sidecar artifact missing: {artifact_path}")

    actual_sha = _sha256(artifact_path)
    if actual_sha != manifest_sha256:
        raise RuntimeError("packaged sidecar artifact sha256 does not match manifest")

    _validate_packaged_source_fresh(
        manifest_data,
        allow_stale_source=allow_stale_source,
    )

    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("\n[packaged-artifact]\n")
        handle.write(f"resources_dir={resources_dir}\n")
        handle.write(f"artifact_path={artifact_path}\n")
        handle.write(f"manifest_path={manifest_path}\n")
        handle.write(f"api_version={manifest_api_version}\n")
        handle.write(f"git_commit={str(manifest_data.get('git_commit') or '').strip()}\n")
        handle.write(f"sha256={actual_sha}\n")

    return artifact_path, manifest_path


def _wait_for_packaged_artifact_validation(
    resources_dir: Path,
    *,
    log_path: Path,
    allow_stale_source: bool = False,
    timeout_seconds: float = PACKAGED_RESOURCE_SYNC_TIMEOUT_SECONDS,
    poll_seconds: float = PACKAGED_RESOURCE_SYNC_POLL_SECONDS,
) -> tuple[Path, Path]:
    deadline = time.monotonic() + timeout_seconds
    last_error: RuntimeError | None = None
    while True:
        try:
            return _validate_packaged_artifact(
                resources_dir,
                log_path=log_path,
                allow_stale_source=allow_stale_source,
            )
        except RuntimeError as error:
            last_error = error
            if time.monotonic() >= deadline:
                raise last_error from None
            time.sleep(poll_seconds)


def _validate_packaged_restricted_host(
    resources_dir: Path,
    *,
    log_path: Path,
    allow_stale_source: bool = False,
) -> tuple[Path, Path]:
    host_dir = resources_dir / "restricted-host"
    manifest_path = host_dir / RESTRICTED_HOST_MANIFEST
    if not manifest_path.is_file():
        raise RuntimeError(f"packaged restricted-host manifest missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("api_version") != 1:
        raise RuntimeError("packaged restricted-host manifest is incompatible")
    binary_name = str(manifest.get("binary_filename") or "")
    if Path(binary_name).name != binary_name or not binary_name:
        raise RuntimeError("packaged restricted-host binary filename is invalid")
    binary_path = host_dir / binary_name
    if not binary_path.is_file() or _sha256(binary_path) != manifest.get("binary_sha256"):
        raise RuntimeError("packaged restricted-host binary digest mismatch")
    if manifest.get("abi_sha256") != _sha256(
        ROOT / "config" / "plugins" / "capability-abi" / "v1" / "jenny-restricted-host.wit"
    ):
        raise RuntimeError("packaged restricted-host ABI digest mismatch")
    if manifest.get("protocol_sha256") != _sha256(
        ROOT / "config" / "plugins" / "contract-lock-v4.json"
    ):
        raise RuntimeError("packaged restricted-host protocol digest mismatch")
    if not allow_stale_source and (commit := _current_git_commit()):
        if manifest.get("commit") != commit:
            raise RuntimeError("stale packaged restricted-host artifact")
    sbom_path = host_dir / str(manifest.get("sbom_filename") or "")
    if not sbom_path.is_file():
        raise RuntimeError("packaged restricted-host SBOM missing")
    _append_log(
        log_path,
        "\n[packaged-restricted-host]\n"
        f"binary_path={binary_path}\nmanifest_path={manifest_path}\n"
        f"sha256={manifest.get('binary_sha256', '')}\n",
    )
    return binary_path, manifest_path


def _validate_packaged_full_host_supervisor(
    resources_dir: Path, *, log_path: Path, allow_stale_source: bool,
) -> tuple[Path, Path]:
    native_dir = resources_dir / "native"
    manifest_path = native_dir / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"packaged full-host supervisor manifest missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    binary_name = str(manifest.get("binary_filename") or "")
    binary_path = native_dir / binary_name
    if not binary_name or not binary_path.is_file():
        raise RuntimeError("packaged full-host supervisor binary missing")
    if _sha256(binary_path) != manifest.get("binary_sha256"):
        raise RuntimeError("packaged full-host supervisor digest mismatch")
    if _sha256(ROOT / "config" / "plugins" / "contract-lock-v6.json") \
            != manifest.get("contract_lock_v6_sha256"):
        raise RuntimeError("packaged full-host supervisor contract digest mismatch")
    if manifest.get("authenticated_private_pipe") is not True:
        raise RuntimeError("packaged full-host supervisor transport provenance invalid")
    source_tree_digest = manifest.get("source_tree_digest")
    if manifest.get("source_state") not in {"clean", "dirty"} \
            or not isinstance(source_tree_digest, str) \
            or not SHA256_HEX_RE.fullmatch(source_tree_digest):
        raise RuntimeError("packaged full-host supervisor source provenance invalid")
    if not allow_stale_source and manifest.get("source_commit") != _current_git_commit():
        raise RuntimeError("stale packaged full-host supervisor artifact")
    if not allow_stale_source and (manifest.get("source_state") != "clean"
                                   or manifest.get("release_eligible") is not True):
        raise RuntimeError("release packaged full-host supervisor is not clean-source eligible")
    _append_log(log_path, f"\n[packaged-full-host-supervisor]\npath={binary_path}\n")
    return binary_path, manifest_path


def _run_packaged_launch_probe(
    resources_dir: Path,
    artifact_path: Path,
    *,
    log_path: Path,
    timeout_seconds: int = 60,
) -> None:
    probe_module_path = ROOT / "dist" / "electron" / "packaging-launch-probe.js"
    if not probe_module_path.exists():
        probe_module_path = ROOT / "scripts" / "packaging" / "packaging-launch-probe.js"
    if not probe_module_path.exists():
        raise RuntimeError(
            "packaging launch probe module is missing: "
            f"{_display_path(probe_module_path)}"
        )

    probe_script = (
        "const path=require('node:path');"
        f"const probe=require({json.dumps(str(probe_module_path))});"
        "const result=probe.resolvePackagedLaunchProbe(process.argv[1], process.cwd());"
        "process.stdout.write(JSON.stringify(result));"
    )
    result = _run_command(
        ["node", "-e", probe_script, str(resources_dir)],
        log_path=log_path,
        timeout_seconds=timeout_seconds,
    )
    payload = json.loads(result.stdout.strip() or "{}")
    source = str(payload.get("source", "")).strip()
    command = Path(str(payload.get("command", "")).strip())
    if source != "packaged-binary":
        raise RuntimeError(f"launch probe expected source=packaged-binary, got: {source!r}")
    if command.resolve() != artifact_path.resolve():
        raise RuntimeError(
            "launch probe command path mismatch: "
            f"{command} != {artifact_path.resolve()}"
        )


def _run_packaged_sidecar_initialize_probe(
    artifact_path: Path,
    *,
    log_path: Path,
    timeout_seconds: int,
) -> None:
    with tempfile.TemporaryDirectory(prefix="jenny-packaged-sidecar-probe-") as temp_dir:
        process = subprocess.Popen(
            [str(artifact_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=ROOT,
            **_subprocess_group_kwargs(),
        )
        request = {
            "jsonrpc": "2.0",
            "id": "packaged-initialize-probe",
            "method": "initialize",
            "params": {
                "accept_version": API_VERSION,
                "config": {
                    "engine_type": "mock",
                    "model": "mock-v1",
                    "user_data_dir": temp_dir,
                    "tools_workspace_root": str(ROOT),
                    "tools_enabled": True,
                    "tools_web_enabled": True,
                    "tools_mermaid_enabled": True,
                }
            },
        }
        try:
            assert process.stdin is not None
            assert process.stdout is not None
            write_framed_message(
                stdout_buffer=process.stdin,
                content_length_header=CONTENT_LENGTH_HEADER,
                message=request,
            )
            response_payloads: list[dict[str, object]] = []
            response_errors: list[BaseException] = []
            stderr_tail = bytearray()

            def _read_response_payload() -> None:
                try:
                    response_payloads.append(
                        read_framed_message(
                            stdin_buffer=process.stdout,
                            content_length_header=CONTENT_LENGTH_HEADER,
                            max_content_length_bytes=MAX_PACKAGED_PROBE_CONTENT_LENGTH_BYTES,
                        )
                    )
                except BaseException as error:  # noqa: BLE001 - surfaced below with context.
                    response_errors.append(error)

            def _drain_stderr() -> None:
                if process.stderr is None:
                    return
                for chunk in iter(lambda: process.stderr.read(4096), b""):
                    _append_bounded_tail(
                        stderr_tail,
                        chunk,
                        limit=MAX_PACKAGED_PROBE_STDERR_TAIL_BYTES,
                    )

            stderr_reader = threading.Thread(target=_drain_stderr, daemon=True)
            stderr_reader.start()
            reader = threading.Thread(target=_read_response_payload, daemon=True)
            reader.start()
            reader.join(timeout=max(1, timeout_seconds))
            if not response_payloads:
                _raise_probe_response_error(response_errors, stderr_tail)
            payload = response_payloads[0]
            _validate_packaged_initialize_payload(payload)
            with log_path.open("a", encoding="utf-8") as handle:
                result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
                handle.write("\n[packaged-sidecar-initialize-probe]\n")
                handle.write(f"artifact_path={artifact_path}\n")
                handle.write(
                    "tools_available="
                    f"{json.dumps(result.get('tools_available', []), sort_keys=True)}\n"
                )
        finally:
            try:
                if process.stdin is not None and process.poll() is None:
                    write_framed_message(
                        stdout_buffer=process.stdin,
                        content_length_header=CONTENT_LENGTH_HEADER,
                        message={
                            "jsonrpc": "2.0",
                            "id": "packaged-shutdown-probe",
                            "method": "shutdown",
                            "params": {"accept_version": API_VERSION},
                        },
                    )
            except (BrokenPipeError, OSError):
                pass
            if process.poll() is None:
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    _terminate_process_tree(process)


def _run_packaged_app_smoke(  # noqa: C901, PLR0912, PLR0915
    app_path: Path,
    *,
    log_path: Path,
    timeout_seconds: int,
    output_path: Path | None = None,
) -> dict[str, object]:
    resolved_app_path = Path(app_path).resolve()
    if not resolved_app_path.exists():
        raise RuntimeError(f"packaged app executable missing: {resolved_app_path}")

    if output_path is None:
        output_path = log_path.with_suffix(".result.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        output_path.unlink()
    except FileNotFoundError:
        pass

    smoke_timeout_seconds = max(1, min(timeout_seconds, PACKAGED_APP_SMOKE_TIMEOUT_SECONDS))
    request_path = resolved_app_path.parent / PACKAGED_SMOKE_REQUEST_FILENAME
    request_path.write_text(
        json.dumps(
            {
                "outputPath": str(output_path),
                "timeoutMs": smoke_timeout_seconds * 1000,
            }
        ),
        encoding="utf-8",
    )
    smoke_env = os.environ.copy()
    smoke_env["JENNY_PACKAGED_SMOKE_OUTPUT"] = str(output_path)
    smoke_env["JENNY_PACKAGED_SMOKE_TIMEOUT_MS"] = str(smoke_timeout_seconds * 1000)
    smoke_env["JENNY_PACKAGED_SMOKE_REQUEST"] = str(request_path)
    smoke_profile_path = output_path.parent / "user-data"
    smoke_env["JENNY_USER_DATA_DIR"] = str(smoke_profile_path)
    smoke_env.pop("ELECTRON_RUN_AS_NODE", None)

    # Electron consumes --user-data-dir before application JavaScript runs.
    # Keep the env override for Jenny's own early main-process path, but also
    # isolate Chromium's pre-main singleton/profile state so a live installed
    # or development instance cannot absorb or stall this release probe.
    process = subprocess.Popen(
        [str(resolved_app_path), f"--user-data-dir={smoke_profile_path}"],
        cwd=ROOT,
        env=smoke_env,
        **({} if sys.platform.startswith("win") else _subprocess_group_kwargs()),
    )
    _append_log(
        log_path,
        (
            f"\n$ {resolved_app_path}\n"
            "[packaged-app-smoke]\n"
            f"request_path={request_path}\n"
            f"output_path={output_path}\n"
            f"user_data_path={smoke_profile_path}\n"
            f"timeout_seconds={smoke_timeout_seconds}\n"
            f"pid={process.pid}\n"
        ),
    )

    try:
        deadline = time.monotonic() + smoke_timeout_seconds
        exit_grace_deadline: float | None = None
        while time.monotonic() < deadline:
            if output_path.exists():
                break
            if process.poll() is not None:
                if exit_grace_deadline is None:
                    exit_grace_deadline = min(deadline, time.monotonic() + 2.0)
                elif time.monotonic() >= exit_grace_deadline:
                    break
            time.sleep(PACKAGED_APP_SMOKE_POLL_SECONDS)

        if not output_path.exists():
            return_code = process.poll()
            if return_code is None:
                _terminate_process_tree(process)
                return_code = process.poll()
            _append_log(log_path, f"[packaged-app-smoke-exit] exit_code={return_code}\n")
            raise RuntimeError(f"packaged app smoke did not produce output: {output_path}")

        payload = _load_packaged_smoke_payload(output_path)
        validated_payload = _validate_packaged_smoke_payload(payload)

        try:
            return_code = process.wait(timeout=PACKAGED_APP_SMOKE_EXIT_GRACE_SECONDS)
        except subprocess.TimeoutExpired as error:
            _terminate_process_tree(process)
            raise RuntimeError(
                "packaged app smoke did not exit cleanly after producing output"
            ) from error

        _append_log(log_path, f"[packaged-app-smoke-exit] exit_code={return_code}\n")
        if return_code != 0:
            raise RuntimeError(f"packaged app smoke exited with code {return_code}")
        return validated_payload
    finally:
        try:
            request_path.unlink()
        except FileNotFoundError:
            pass
        if process.poll() is None:
            _terminate_process_tree(process)


def _build_packaged_directory(
    *,
    log_path: Path,
    timeout_seconds: int,
    env: dict[str, str],
    deadline: float | None = None,
) -> None:
    workflow_deadline = deadline or (time.monotonic() + timeout_seconds)
    commands = (
        [NPM_COMMAND, "run", "build:preload"],
        [sys.executable, "scripts/packaging/build_sidecar_artifact.py"],
        [sys.executable, "scripts/packaging/build_restricted_host_artifact.py"],
        [sys.executable, "scripts/packaging/build_full_host_supervisor_artifact.py"],
        [
            NPM_COMMAND,
            "exec",
            "--",
            "electron-builder",
            "--dir",
            "--config",
            "electron-builder.yml",
            "--publish",
            "never",
        ],
    )
    for command in commands:
        _run_command(
            command,
            log_path=log_path,
            timeout_seconds=_remaining_timeout_seconds(
                deadline=workflow_deadline,
                step_cap=timeout_seconds,
            ),
            env=env,
        )


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    log_path = Path(args.log_path).resolve()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        "Packaging smoke log\n",
        encoding="utf-8",
    )

    if args.timeout_seconds <= 0 or args.step_timeout_seconds <= 0:
        print("FAIL: packaged flow smoke")
        print("  - timeout values must be greater than zero")
        return 1

    smoke_env = os.environ.copy()
    workflow_deadline = time.monotonic() + args.timeout_seconds
    if args.source_date_epoch:
        smoke_env["SOURCE_DATE_EPOCH"] = args.source_date_epoch

    try:
        _build_packaged_directory(
            log_path=log_path,
            timeout_seconds=args.step_timeout_seconds,
            env=smoke_env,
            deadline=workflow_deadline,
        )
        resources_dir = _resolve_resources_dir()
        artifact_path, manifest_path = _wait_for_packaged_artifact_validation(
            resources_dir,
            log_path=log_path,
            allow_stale_source=args.allow_stale_source,
            timeout_seconds=min(
                PACKAGED_RESOURCE_SYNC_TIMEOUT_SECONDS,
                _remaining_timeout_seconds(
                    deadline=workflow_deadline,
                    step_cap=args.step_timeout_seconds,
                ),
            ),
        )
        restricted_host_path, restricted_host_manifest = _validate_packaged_restricted_host(
            resources_dir,
            log_path=log_path,
            allow_stale_source=args.allow_stale_source,
        )

        version_result = _run_command(
            [str(artifact_path), "--version"],
            log_path=log_path,
            timeout_seconds=_remaining_timeout_seconds(
                deadline=workflow_deadline,
                step_cap=60,
            ),
        )
        full_host_path, full_host_manifest = _validate_packaged_full_host_supervisor(
            resources_dir,
            log_path=log_path,
            allow_stale_source=args.allow_stale_source,
        )
        version_output = f"{version_result.stdout}\n{version_result.stderr}"
        if API_VERSION not in version_output:
            raise RuntimeError(
                "packaged artifact --version output missing expected API version "
                f"{API_VERSION!r}"
            )

        _run_packaged_launch_probe(
            resources_dir,
            artifact_path,
            log_path=log_path,
            timeout_seconds=_remaining_timeout_seconds(
                deadline=workflow_deadline,
                step_cap=60,
            ),
        )
        _run_packaged_sidecar_initialize_probe(
            artifact_path,
            log_path=log_path,
            timeout_seconds=_remaining_timeout_seconds(
                deadline=workflow_deadline,
                step_cap=min(args.step_timeout_seconds, 120),
            ),
        )
        packaged_app_path = _resolve_packaged_app_path()
        signing_status = collect_windows_signing_status(packaged_app_path)
        _append_log(
            log_path,
            "\n[packaged-app-signing]\n"
            f"status={signing_status.get('status', '')}\n"
            f"reason={signing_status.get('reason', '')}\n",
        )
        with tempfile.TemporaryDirectory(prefix="jenny-packaged-smoke-") as temp_dir:
            smoke_result_path = Path(temp_dir) / "packaged-smoke-output.json"
            _run_packaged_app_smoke(
                packaged_app_path,
                log_path=log_path,
                timeout_seconds=_remaining_timeout_seconds(
                    deadline=workflow_deadline,
                    step_cap=args.step_timeout_seconds,
                ),
                output_path=smoke_result_path,
            )
    except RuntimeError as error:
        print("FAIL: packaged flow smoke")
        print(f"  - {error}")
        print(f"  - log: {log_path}")
        return 1

    print("PASS: packaged flow smoke")
    print(f"  - resources_dir: {_display_path(resources_dir)}")
    print(f"  - artifact: {_display_path(artifact_path)}")
    print(f"  - manifest: {_display_path(manifest_path)}")
    print(f"  - restricted host: {_display_path(restricted_host_path)}")
    print(f"  - restricted host manifest: {_display_path(restricted_host_manifest)}")
    print(f"  - full-host supervisor: {_display_path(full_host_path)}")
    print(f"  - full-host supervisor manifest: {_display_path(full_host_manifest)}")
    print(f"  - app: {_display_path(packaged_app_path)}")
    print(f"  - log: {_display_path(log_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
