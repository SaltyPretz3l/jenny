"""Interpreter discovery and venv setup for the Python runtime tool."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import stat
import subprocess
import sys
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any, Iterator

from sidecar.ai.config import read_environment_value
from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.python_runtime.bootstrap_telemetry import (
    BootstrapTelemetry,
    bootstrap_phase_label,  # noqa: F401 -- retained re-export
    redact_paths,  # noqa: F401 -- re-exported so tool.py stays under the import fan-out cap
)
from sidecar.ai.tools.config_utils import config_value
from sidecar.ai.tools.contracts import ToolExecutionFailure

RUNTIME_READY_MARKER = ".jenny-ready"
RUNTIME_INSTALL_SENTINEL = ".jenny-installed"
_SIDECAR_PACKAGE_DIR = next(
    parent for parent in Path(__file__).resolve().parents if parent.name == "sidecar"
)
# Development-tree default; packaged builds supply the wheelhouse through config.
DEFAULT_RUNTIME_WHEELHOUSE = _SIDECAR_PACKAGE_DIR.parent / "vendor" / "python-runtime-wheels"
WHEELHOUSE_MANIFEST_FILENAME = "wheelhouse-manifest.json"
EMBED_MANIFEST_FILENAME = "python-embed-manifest.json"
RUNTIME_PACKAGES = (
    "pandas==3.0.1",
    "numpy==2.4.3",
    "matplotlib==3.10.8",
    "seaborn==0.13.2",
    "scipy==1.17.1",
    "tabulate==0.10.0",
)
# Readiness marker schema. Bump this whenever the fields below change shape so
# environments built by an older sidecar are treated as stale rather than
# silently misread.
RUNTIME_MARKER_SCHEMA_VERSION = 2
# Every RUNTIME_PACKAGES entry here happens to import under its own lowercase
# package name (pandas, numpy, matplotlib, seaborn, scipy, tabulate) — no
# distribution-name-to-import-name remapping (e.g. Pillow -> PIL) is needed
# for this fixed set. If a future package breaks that assumption, add an
# explicit mapping table rather than deriving the import name from the pin.
_REQUIRED_IMPORT_NAMES: tuple[str, ...] = tuple(
    sorted({package.split("==", 1)[0] for package in RUNTIME_PACKAGES})
)
# A first bootstrap copies CPython, verifies and installs about 78 MB of wheels,
# then validates cold imports; ten minutes gives both stages headroom but is bounded.
MIN_BOOTSTRAP_BUDGET_SECONDS = 60
BOOTSTRAP_BUDGET_SECONDS = 600
MAX_BOOTSTRAP_BUDGET_SECONDS = 1800
# Thirty seconds is too short when cold --no-compile imports byte-compile this tree.
RUNTIME_IMPORT_VALIDATION_TIMEOUT_SECONDS = 180
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 600
MIN_MEMORY_LIMIT_MB = 1
MAX_MEMORY_LIMIT_MB = 8192
SHA256_HEX_LENGTH = 64
# Bootstrap locking, pip bootstrap, and the typed runtime errors live in sibling
# modules so this file stays under the repository file-size ceiling. Re-exported
# here because their ``interpreter`` names are established entry points for
# callers and tests.
from sidecar.ai.tools.builtins.python_runtime import bootstrap_subprocess  # noqa: E402
from sidecar.ai.tools.builtins.python_runtime.bootstrap_lock import (  # noqa: E402, F401
    _BOOTSTRAP_THREAD_LOCKS,
    _BOOTSTRAP_THREAD_LOCKS_GUARD,
    _LOCK_UNLINK_RETRY_ATTEMPTS,
    _LOCK_UNLINK_RETRY_SLEEP_SECONDS,
    BOOTSTRAP_LOCK_POLL_SECONDS,
    BOOTSTRAP_LOCK_STALE_SECONDS,
    BOOTSTRAP_LOCK_TIMEOUT_SECONDS,
    _bootstrap_file_lock,
    _bootstrap_lock,
    _bootstrap_lock_payload,
    _bootstrap_thread_lock,
    _process_exists,
    _read_bootstrap_lock,
    _should_recover_bootstrap_lock,
    _unlink_lock_best_effort,
    _write_bootstrap_lock,
)
from sidecar.ai.tools.builtins.python_runtime.errors import (  # noqa: E402
    PythonRuntimeError,
    PythonRuntimeOfflineInstallError,
    PythonRuntimeWheelhouseIntegrityError,
)
from sidecar.ai.tools.builtins.python_runtime.pip_bootstrap import (  # noqa: E402
    MAX_BOOTSTRAP_PIP_UNPACKED_BYTES,
    PIP_PROBE_TIMEOUT_SECONDS,
    _ensure_offline_pip,
    _extract_verified_pip_wheel,  # noqa: F401 -- retained test seam
)

__all__ = [
    "MAX_BOOTSTRAP_PIP_UNPACKED_BYTES",
    "PIP_PROBE_TIMEOUT_SECONDS",
    "PythonRuntimeError",
    "PythonRuntimeOfflineInstallError",
    "PythonRuntimeWheelhouseIntegrityError",
]

_VALIDATED_INTERPRETER_CACHE: dict[str, Path] = {}
_VALIDATED_INTERPRETER_SOURCES: dict[str, str] = {}
_VALIDATED_INTERPRETER_VERSIONS: dict[str, str] = {}
_READY_VENV_CACHE: dict[str, Path] = {}
logger = logging.getLogger(__name__)



def _string_config_value(config: Any, key: str) -> str | None:
    value = config_value(config, key)
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _int_config_value(config: Any, key: str, default: int) -> int:
    value = config_value(config, key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def _clamped_int_config_value(
    config: Any,
    key: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
) -> int:
    value = _int_config_value(config, key, default)
    return min(max(int(value), minimum), maximum)


def _venv_root(config: Any) -> Path:
    configured = _string_config_value(config, "tools_python_runtime_root")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".companion" / "python-runtime"


def _venv_dir(config: Any) -> Path:
    return _venv_root(config) / "venv"


def _venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        embedded_python = venv_dir / "python.exe"
        if embedded_python.is_file():
            return embedded_python
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _ready_marker(venv_dir: Path) -> Path:
    return venv_dir / RUNTIME_READY_MARKER


def _staging_dir(venv_dir: Path) -> Path:
    return venv_dir.with_name(f"{venv_dir.name}.build")


def _lock_path(venv_dir: Path) -> Path:
    return venv_dir.parent / ".bootstrap.lock"


def _force_remove_readonly(func, path, _excinfo) -> None:
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, onerror=_force_remove_readonly)


def _requirements_fingerprint(packages: tuple[str, ...] = RUNTIME_PACKAGES) -> str:
    """Hash of the exact pinned requirement set the managed venv installs.

    Changing any pin (version bump, added/removed package) changes this
    fingerprint, which makes a previously-ready environment stale until it is
    rebuilt against the new lock.
    """
    payload = "\n".join(sorted(packages)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _interpreter_identity(venv_python: Path) -> str:
    completed = bootstrap_subprocess.run(
        [str(venv_python), "-c", "import sys; print(sys.version.split()[0])"],
        timeout=10,
        check=True,
    )
    return completed.stdout.strip()


def _validate_runtime_imports(
    venv_python: Path,
    modules: tuple[str, ...] = _REQUIRED_IMPORT_NAMES,
    *,
    detail_sink: list[str] | None = None,
    error_sink: list[BaseException] | None = None,
) -> bool:
    """Actually import every required top-level module in the managed
    interpreter. Returns False (never raises) so callers can treat a failed
    import as "not ready" rather than an unhandled crash."""
    if not modules:
        return True
    import_statement = "; ".join(f"import {module}" for module in modules)
    try:
        bootstrap_subprocess.run(
            [str(venv_python), "-c", import_statement],
            timeout=RUNTIME_IMPORT_VALIDATION_TIMEOUT_SECONDS,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        if detail_sink is not None:
            detail_sink.append(BootstrapTelemetry.error_detail(error))
        if error_sink is not None:
            error_sink.append(error)
        return False
    return True


def _read_runtime_marker(marker_path: Path) -> dict[str, Any] | None:
    try:
        raw = marker_path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _marker_matches_expected(
    marker: dict[str, Any] | None,
    requirements_fingerprint: str | None = None,
) -> bool:
    """Validate every field a fresh marker must carry: schema version,
    dependency-lock fingerprint, a non-empty interpreter identity, and a
    recorded import-validation pass covering every required package. Missing
    or mismatched fields all mean "not ready"."""
    if marker is None:
        return False
    expected_fingerprint = requirements_fingerprint or _requirements_fingerprint()
    interpreter_identity = marker.get("interpreter_identity")
    validated_imports = marker.get("validated_imports")
    if not isinstance(validated_imports, list):
        return False
    return all(
        (
            marker.get("schema_version") == RUNTIME_MARKER_SCHEMA_VERSION,
            marker.get("requirements_fingerprint") == expected_fingerprint,
            isinstance(interpreter_identity, str) and bool(interpreter_identity),
            not (set(_REQUIRED_IMPORT_NAMES) - {str(item) for item in validated_imports}),
        )
    )


def _write_runtime_marker(
    marker_path: Path,
    *,
    interpreter_identity: str | None = None,
    venv_python: Path | None = None,
    requirements_fingerprint: str | None = None,
) -> None:
    if interpreter_identity is None:
        if venv_python is None:
            raise ValueError("venv_python is required when interpreter identity is omitted")
        interpreter_identity = _interpreter_identity(venv_python)
    payload = {
        "schema_version": RUNTIME_MARKER_SCHEMA_VERSION,
        "interpreter_identity": interpreter_identity,
        "requirements_fingerprint": requirements_fingerprint or _requirements_fingerprint(),
        "validated_imports": list(_REQUIRED_IMPORT_NAMES),
        "created_at": time.time(),
    }
    marker_path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def _venv_is_ready(
    venv_dir: Path,
    *,
    requirements_fingerprint: str | None = None,
) -> Path | None:
    """Full readiness gate: interpreter must exist, the marker must be a
    fresh fingerprint match, and the required packages must actually import
    right now. Returns the venv's python path when ready, else None so the
    caller rebuilds/repairs deterministically."""
    venv_python = _venv_python(venv_dir)
    if not venv_python.exists():
        return None
    marker = _read_runtime_marker(_ready_marker(venv_dir))
    if not _marker_matches_expected(marker, requirements_fingerprint):
        return None
    if not _validate_runtime_imports(venv_python):
        return None
    return venv_python


_VERSION_PROBE_SOURCE = "import sys; print(sys.version.split()[0])"


def _validated_interpreter(candidate: Path) -> Path:
    cache_key = str(candidate)
    cached = _VALIDATED_INTERPRETER_CACHE.get(cache_key)
    if cached is not None:
        return cached
    # ``--version`` proves nothing: the frozen sidecar binary answers it too
    # and exits 0. Only a process that evaluates Python is a base interpreter.
    completed = bootstrap_subprocess.run(
        [str(candidate), "-c", _VERSION_PROBE_SOURCE],
        timeout=5,
        check=True,
    )
    _VALIDATED_INTERPRETER_CACHE[cache_key] = candidate
    _VALIDATED_INTERPRETER_VERSIONS[cache_key] = completed.stdout.strip() or "unknown"
    return candidate


def _resolved_path(path: Path) -> Path:
    try:
        return path.expanduser().resolve(strict=False)
    except OSError:
        return path.expanduser().absolute()


def _trusted_env_interpreter_roots(config: Any) -> tuple[Path, ...]:
    roots: list[Path] = []
    bundled = _string_config_value(config, "tools_python_runtime_bundled_python")
    if bundled:
        roots.append(_resolved_path(Path(bundled)).parent)
    for root in (sys.prefix, sys.base_prefix, Path(sys.executable).parent):
        if root:
            roots.append(_resolved_path(Path(root)))
    return tuple(dict.fromkeys(roots))


def _trusted_env_interpreter_candidate(config: Any, raw_candidate: str | None) -> str | None:
    if not raw_candidate:
        return None
    candidate = _resolved_path(Path(raw_candidate))
    if not candidate.is_absolute() or not candidate.exists():
        logger.warning("Ignoring untrusted JENNY_PYTHON_RUNTIME candidate: path is not executable")
        return None
    trusted_roots = _trusted_env_interpreter_roots(config)
    if any(candidate == root or candidate.is_relative_to(root) for root in trusted_roots):
        return str(candidate)
    logger.warning("Ignoring untrusted JENNY_PYTHON_RUNTIME candidate outside trusted roots")
    return None


def discover_base_interpreter(config: Any) -> Path:
    candidates: list[tuple[str, str]] = []
    explicit = _string_config_value(config, "tools_python_runtime_interpreter")
    if explicit:
        candidates.append(("config", explicit))
    env_override = _trusted_env_interpreter_candidate(
        config,
        read_environment_value("JENNY_PYTHON_RUNTIME"),
    )
    if env_override:
        candidates.append(("env", env_override))
    bundled = _string_config_value(config, "tools_python_runtime_bundled_python")
    if bundled:
        candidates.append(("bundled", bundled))
    # The sidecar's interpreter is controlled; environment-controlled PATH is
    # the least predictable source, so keep it only as the final fallback.
    # A frozen sidecar (PyInstaller onefile) reports itself as sys.executable,
    # and that binary is not an interpreter -- offer it only when it is one.
    if not getattr(sys, "frozen", False):
        candidates.append(("sys_executable", sys.executable))
    for command_name in ("python3", "python"):
        resolved = shutil.which(command_name)
        if resolved:
            candidates.append(("path", resolved))

    errors: list[str] = []
    seen: set[str] = set()
    for source, raw_candidate in candidates:
        candidate = str(raw_candidate or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            selected = _validated_interpreter(Path(candidate).expanduser())
            _VALIDATED_INTERPRETER_SOURCES[str(selected)] = source
            return selected
        except (OSError, subprocess.SubprocessError) as error:
            errors.append(f"{candidate}: {error}")
    raise RuntimeError(
        "No usable Python interpreter found for python runtime. "
        + ("; ".join(errors) if errors else "No candidates were available.")
    )


def _runtime_wheelhouse(config: Any | None) -> Path | None:
    configured = _string_config_value(config or {}, "tools_python_runtime_wheelhouse_dir")
    if configured:
        wheelhouse = Path(configured).expanduser()
        if not wheelhouse.is_dir():
            raise FileNotFoundError(
                f"Configured python runtime wheelhouse not found: {wheelhouse}. "
                "Build or restore the verified offline bundle with "
                "scripts/build-python-runtime-bundle.py; Jenny will not fall back "
                "to an unverified wheelhouse."
            )
        return wheelhouse
    # The source tree tracks an otherwise-empty .gitignore sentinel so static
    # electron-builder paths exist on clean checkouts. Treat that directory as
    # absent in development until the owner-generated manifest is present.
    if (
        DEFAULT_RUNTIME_WHEELHOUSE.is_dir()
        and _wheelhouse_manifest_path(DEFAULT_RUNTIME_WHEELHOUSE).is_file()
    ):
        return DEFAULT_RUNTIME_WHEELHOUSE
    return None


def _runtime_requirements_fingerprint(config: Any | None) -> str:
    """Bind readiness to both top-level pins and the generated transitive lock.

    Legacy/dev wheelhouse fixtures without ``runtime_lock_sha256`` retain the
    top-level fingerprint. Release bundles always carry the field and are
    independently checked before packaging.
    """
    return _runtime_requirements_fingerprint_for_wheelhouse(_runtime_wheelhouse(config))


def _runtime_requirements_fingerprint_for_wheelhouse(wheelhouse: Path | None) -> str:
    base_fingerprint = _requirements_fingerprint()
    if wheelhouse is None:
        return base_fingerprint
    manifest_path = _wheelhouse_manifest_path(wheelhouse)
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse checksum manifest is unreadable: {manifest_path}"
        ) from error
    lock_digest = payload.get("runtime_lock_sha256") if isinstance(payload, dict) else None
    if not isinstance(lock_digest, str):
        return base_fingerprint
    normalized = lock_digest.lower()
    if len(normalized) != SHA256_HEX_LENGTH or any(
        character not in "0123456789abcdef" for character in normalized
    ):
        raise PythonRuntimeWheelhouseIntegrityError(
            "Python runtime wheelhouse has an invalid runtime lock fingerprint"
        )
    return hashlib.sha256(f"{base_fingerprint}\n{normalized}".encode("utf-8")).hexdigest()


def _wheelhouse_manifest_path(wheelhouse: Path) -> Path:
    return wheelhouse / WHEELHOUSE_MANIFEST_FILENAME


def _load_wheelhouse_manifest(wheelhouse: Path) -> dict[str, str]:
    manifest_path = _wheelhouse_manifest_path(wheelhouse)
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except OSError as error:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse is missing its checksum manifest: {manifest_path}"
        ) from error
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse checksum manifest is not valid JSON: {manifest_path}"
        ) from error
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, dict) or not files:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse checksum manifest has no file entries: {manifest_path}"
        )
    normalized: dict[str, str] = {}
    for name, digest in files.items():
        if isinstance(name, str) and name and isinstance(digest, str) and digest:
            normalized[name] = digest.lower()
    if not normalized:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse checksum manifest has no valid entries: {manifest_path}"
        )
    return normalized


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_wheelhouse_integrity(wheelhouse: Path) -> None:
    """Verify the wheelhouse's wheel files exactly match a checksum manifest
    before anything is installed from it. Any mismatch — missing manifest,
    missing wheel, unexpected extra wheel, or a bad checksum — raises
    PythonRuntimeWheelhouseIntegrityError. Callers must not catch this to
    fall back to a network install: an untrustworthy wheelhouse fails closed.
    """
    manifest = _load_wheelhouse_manifest(wheelhouse)
    on_disk = sorted(path.name for path in wheelhouse.glob("*.whl"))
    manifest_names = sorted(manifest)
    if on_disk != manifest_names:
        missing = sorted(set(manifest_names) - set(on_disk))
        unexpected = sorted(set(on_disk) - set(manifest_names))
        raise PythonRuntimeWheelhouseIntegrityError(
            "Python runtime wheelhouse contents do not match its checksum manifest "
            f"(missing={missing}, unexpected={unexpected})"
        )
    for name, expected_digest in manifest.items():
        actual_digest = _sha256_file(wheelhouse / name)
        if actual_digest != expected_digest:
            raise PythonRuntimeWheelhouseIntegrityError(
                f"Python runtime wheelhouse file failed checksum verification: {name}"
            )


def _install_from_wheelhouse(venv_python: Path, wheelhouse: Path) -> None:
    constraining_wheels: list[tuple[str, str]] = []
    for wheel_path in wheelhouse.glob("*.whl"):
        try:
            _, python_tag, abi_tag, platform_tag = wheel_path.stem.rsplit("-", 3)
        except ValueError:
            continue
        is_pure_python = abi_tag == "none" and platform_tag == "any"
        # abi3 supports later CPython releases; fail open rather than reject a
        # valid future interpreter with version logic this wheelhouse does not need.
        if is_pure_python or abi_tag == "abi3":
            continue
        constraining_wheels.extend(
            (wheel_path.name, tag)
            for tag in python_tag.split(".")
            if tag.startswith("cp")
        )
    if constraining_wheels:
        interpreter_version = _interpreter_identity(venv_python)
        major, separator, remainder = interpreter_version.partition(".")
        minor = remainder.partition(".")[0]
        interpreter_tag = f"cp{major}{minor}" if separator and minor else ""
        tags_by_wheel: dict[str, set[str]] = {}
        for wheel_name, tag in constraining_wheels:
            tags_by_wheel.setdefault(wheel_name, set()).add(tag)
        # A wheel is installable when any of its own tags matches; the
        # wheelhouse is installable only when every wheel is. Checking for
        # one match anywhere let a mixed bundle fail late inside pip.
        offending = [
            (wheel_name, "/".join(sorted(tags)))
            for wheel_name, tags in sorted(tags_by_wheel.items())
            if interpreter_tag not in tags
        ]
        if offending:
            offending_wheel, offending_tag = offending[0]
            remediation = (
                f"Restore or select an interpreter matching {offending_tag}, or rebuild "
                f"the wheelhouse with wheels matching {interpreter_tag or interpreter_version}."
            )
            raise PythonRuntimeError(
                "Managed Python runtime interpreter "
                f"{interpreter_version} cannot install wheel {offending_wheel} "
                f"with tag {offending_tag}. "
                f"{remediation}",
                failed_phase="install_finished",
                remediation=remediation,
            )
    if (venv_python.parent / EMBED_MANIFEST_FILENAME).is_file():
        _ensure_offline_pip(venv_python, wheelhouse)
    bootstrap_subprocess.run(
        [
            str(venv_python),
            "-m",
            "pip",
            "install",
            "--no-input",
            "--no-index",
            "--find-links",
            str(wheelhouse),
            "--only-binary=:all:",
            "--no-compile",
            *RUNTIME_PACKAGES,
        ],
        timeout=120,
        check=True,
    )


def _is_bundled_embeddable_interpreter(candidate: Path) -> bool:
    if candidate.name.lower() != "python.exe":
        return False
    return (candidate.parent / EMBED_MANIFEST_FILENAME).is_file() and any(
        candidate.parent.glob("python*._pth")
    )


def _copy_embeddable_runtime(base_interpreter: Path, staging_dir: Path) -> Path:
    source_dir = base_interpreter.parent.resolve()
    destination = staging_dir.resolve()
    try:
        destination.relative_to(source_dir)
    except ValueError:
        pass
    else:
        raise PythonRuntimeError("Managed Python runtime destination overlaps its bundled source")
    shutil.copytree(source_dir, staging_dir)
    staging_python = staging_dir / base_interpreter.name
    if not staging_python.is_file():
        raise PythonRuntimeError(
            f"Bundled Python copy did not create an executable at {staging_python}"
        )
    return staging_python


def _create_runtime_venv(
    config: Any,
    staging_dir: Path,
    *,
    telemetry: BootstrapTelemetry,
    deadline_monotonic: float | None,
    requirements_fingerprint: str,
) -> Path:
    try:
        selection_data: dict[str, object] = {}
        with telemetry.phase("interpreter_selected", data=selection_data):
            base_interpreter = discover_base_interpreter(config)
            selection_data.update(
                version=_VALIDATED_INTERPRETER_VERSIONS.get(str(base_interpreter), "unknown"),
                source=_VALIDATED_INTERPRETER_SOURCES.get(
                    str(base_interpreter), "sys_executable"
                ),
            )
        _raise_if_bootstrap_deadline_elapsed(deadline_monotonic)
        uses_embeddable = _is_bundled_embeddable_interpreter(base_interpreter)
        venv_data = {"creation_path": "bundled_embeddable" if uses_embeddable else "venv"}
        staging_dir.parent.mkdir(parents=True, exist_ok=True)
        with telemetry.phase("venv_created", data=venv_data):
            if uses_embeddable:
                # The official Windows embeddable distribution intentionally omits
                # venv/ensurepip. Copy it into the user-owned runtime root and
                # bootstrap pip from the already verified offline wheel instead.
                staging_python = _copy_embeddable_runtime(base_interpreter, staging_dir)
            else:
                bootstrap_subprocess.run(
                    [str(base_interpreter), "-m", "venv", str(staging_dir)],
                    timeout=120,
                    check=True,
                )
                staging_python = _venv_python(staging_dir)
            if not staging_python.exists():
                raise RuntimeError(
                    "Python runtime staging venv did not create a python executable at "
                    f"{staging_python}"
                )
        _raise_if_bootstrap_deadline_elapsed(deadline_monotonic)
        install_data: dict[str, object] = {"strategy": "unknown"}
        with telemetry.phase("install_finished", data=install_data):
            install_data["strategy"] = _install_runtime_packages(staging_python, config)
            (staging_dir / RUNTIME_INSTALL_SENTINEL).write_text(
                json.dumps(
                    {
                        "requirements_fingerprint": requirements_fingerprint,
                        "base_interpreter": str(base_interpreter),
                        "created_at": time.time(),
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
        return staging_python
    except Exception:
        _remove_tree(staging_dir)
        raise


def _install_via_uv(venv_python: Path) -> bool:
    """Attempt a network install via `uv`. Returns False (without attempting
    anything) when `uv` isn't on PATH, so the caller can fall through to
    pip. Raises on a real `uv` failure — that is a network-install failure,
    not a "try the next thing" signal."""
    uv_binary = shutil.which("uv")
    if not uv_binary:
        return False
    bootstrap_subprocess.run(
        [uv_binary, "pip", "install", "--python", str(venv_python), *RUNTIME_PACKAGES],
        timeout=120,
        check=True,
    )
    return True


def _install_via_network_pip(venv_python: Path) -> None:
    bootstrap_subprocess.run(
        [
            str(venv_python),
            "-m",
            "pip",
            "install",
            "--no-input",
            *RUNTIME_PACKAGES,
        ],
        timeout=120,
        check=True,
    )


def _install_runtime_packages(venv_python: Path, config: Any | None = None) -> str:
    wheelhouse = _runtime_wheelhouse(config)
    if wheelhouse is not None:
        # Fail closed: a corrupt/tampered wheelhouse must never silently fall
        # through to a network install below. Any integrity failure here
        # propagates as PythonRuntimeWheelhouseIntegrityError and this
        # function returns/raises without touching uv or network pip.
        _verify_wheelhouse_integrity(wheelhouse)
        _install_from_wheelhouse(venv_python, wheelhouse)
        return "wheelhouse"

    try:
        if _install_via_uv(venv_python):
            return "uv"
        _install_via_network_pip(venv_python)
        return "network_pip"
    except (OSError, subprocess.SubprocessError) as error:
        raise PythonRuntimeOfflineInstallError(
            "Managed Python runtime has no offline wheelhouse and installing its "
            "packages over the network failed or is unavailable. Run "
            "scripts/build-python-runtime-bundle.py (owner, with network access) to "
            f"vendor the offline runtime, or restore network access. Underlying error: {error}"
        ) from error


def _validate_installed_runtime(
    staging_python: Path,
    staging_dir: Path,
    telemetry: BootstrapTelemetry,
    *,
    resumed: bool,
) -> bool:
    data: dict[str, object] = {
        "outcome": "passed",
        "source": "retained_staging" if resumed else "fresh_install",
    }
    try:
        with telemetry.phase("imports_validated", data=data):
            details: list[str] = []
            errors: list[BaseException] = []
            if _validate_runtime_imports(
                staging_python,
                detail_sink=details,
                error_sink=errors,
            ):
                return True
            detail = details[0] if details else "unknown import failure"
            data.update(outcome="failed", detail=detail)
            failure = PythonRuntimeError(
                "Managed Python runtime install completed but failed import validation for "
                f"required packages: {', '.join(_REQUIRED_IMPORT_NAMES)}. {detail}",
                failed_phase="imports_validated",
            )
            failure.validation_timed_out = bool(  # type: ignore[attr-defined]
                errors and isinstance(errors[0], subprocess.TimeoutExpired)
            )
            raise failure
    except PythonRuntimeError as error:
        if resumed and not getattr(error, "validation_timed_out", False):
            _remove_tree(staging_dir)
            return False
        raise


def _raise_if_bootstrap_deadline_elapsed(deadline_monotonic: float | None) -> None:
    if deadline_monotonic is None or time.monotonic() < deadline_monotonic:
        return
    raise ToolExecutionFailure(
        code=CMP_TOOL_IO_FAILED,
        message="Python runtime bootstrap deadline elapsed before setup could continue",
        retryable=False,
        error_details={
            "failure_class": "limit_exceeded",
            "failed_phase": "bootstrap",
        },
    )


@contextmanager
def _acquire_bootstrap_lock(venv_dir: Path, deadline_monotonic: float | None) -> Iterator[None]:
    """Take the cross-process bootstrap lock without outliving the deadline.

    The lock has its own wait budget; the caller's deadline caps it, and a
    wait that ends because the deadline passed reports ``limit_exceeded``
    rather than a bare lock timeout.
    """
    with ExitStack() as stack:
        try:
            stack.enter_context(
                _bootstrap_lock(_lock_path(venv_dir), deadline_monotonic=deadline_monotonic)
            )
        except TimeoutError:
            _raise_if_bootstrap_deadline_elapsed(deadline_monotonic)
            raise
        yield


def ensure_runtime_venv(
    config: Any,
    *,
    deadline_monotonic: float | None = None,
) -> Path:
    with bootstrap_subprocess.bootstrap_deadline(deadline_monotonic):
        return _ensure_runtime_venv(config, deadline_monotonic=deadline_monotonic)


def _retained_staging_is_resumable(
    config: Any, staging_dir: Path, *, requirements_fingerprint: str
) -> bool:
    """Whether a retained staging tree is worth revalidating instead of rebuilding.

    A tree that is not (expired, a different requirement set, an unfinished
    install, or built by another interpreter) is removed here with the
    reason logged, so the caller only ever resumes a tree that can pass.
    """
    installed_marker = _read_runtime_marker(staging_dir / RUNTIME_INSTALL_SENTINEL) or {}
    installed_at = installed_marker.get("created_at")
    staging_expired = isinstance(installed_at, (int, float)) and (
        time.time() - float(installed_at)
    ) >= BOOTSTRAP_LOCK_STALE_SECONDS
    resumable = bool(
        installed_marker.get("requirements_fingerprint") == requirements_fingerprint
        and isinstance(installed_at, (int, float))
        and not staging_expired
        and _venv_python(staging_dir).is_file()
    )
    reclaim_reason = "expired" if staging_expired else ""
    if resumable:
        # A retained tree is only worth revalidating behind the interpreter
        # that built it; a changed config or bundle must rebuild, or the
        # change appears to have had no effect until the tree expires.
        try:
            current_interpreter: str | None = str(discover_base_interpreter(config))
        except (OSError, RuntimeError, subprocess.SubprocessError):
            current_interpreter = None
        if installed_marker.get("base_interpreter") != current_interpreter:
            resumable = False
            reclaim_reason = "interpreter_changed"
    if not resumable:
        _remove_tree(staging_dir)
        if reclaim_reason:
            logger.info(
                "Reclaimed retained Python runtime staging tree.",
                extra={
                    "component": "ai.tools.python_runtime",
                    "event": "ai.tools.python_runtime.bootstrap.staging_reclaimed",
                    "status": "ok",
                    "data": {"reason": reclaim_reason},
                },
            )
    return resumable


def _ensure_runtime_venv(
    config: Any,
    *,
    deadline_monotonic: float | None,
) -> Path:
    telemetry = BootstrapTelemetry(logger)
    venv_dir = _venv_dir(config)
    configured_wheelhouse = _string_config_value(config, "tools_python_runtime_wheelhouse_dir")
    wheelhouse_data: dict[str, object] = {
        "found": False,
        "source": "config" if configured_wheelhouse else "default",
    }
    with telemetry.phase("wheelhouse_resolved", data=wheelhouse_data):
        requirements_fingerprint = _runtime_requirements_fingerprint_for_wheelhouse(
            wheelhouse := _runtime_wheelhouse(config)
        )
        wheelhouse_data.update(
            found=wheelhouse is not None,
            source="config" if configured_wheelhouse else "default",
        )
    cache_key = f"{venv_dir}|{requirements_fingerprint}"

    cached = _READY_VENV_CACHE.get(cache_key)
    if cached is not None and cached.exists():
        return cached

    ready = _venv_is_ready(
        venv_dir,
        requirements_fingerprint=requirements_fingerprint,
    )
    if ready is not None:
        _READY_VENV_CACHE[cache_key] = ready
        return ready

    _raise_if_bootstrap_deadline_elapsed(deadline_monotonic)
    with _acquire_bootstrap_lock(venv_dir, deadline_monotonic):
        # Re-check under the lock: a concurrent first invocation may have
        # already built (and this waiter only needed the lock to observe
        # that), or may have left the marker fresh from the in-process cache.
        cached = _READY_VENV_CACHE.get(cache_key)
        if cached is not None and cached.exists():
            return cached
        ready = _venv_is_ready(
            venv_dir,
            requirements_fingerprint=requirements_fingerprint,
        )
        if ready is not None:
            _READY_VENV_CACHE[cache_key] = ready
            return ready

        _raise_if_bootstrap_deadline_elapsed(deadline_monotonic)
        staging_dir = _staging_dir(venv_dir)
        resume_installed = _retained_staging_is_resumable(
            config, staging_dir, requirements_fingerprint=requirements_fingerprint
        )
        _remove_tree(venv_dir)

        staging_python = _venv_python(staging_dir)
        while True:
            if not resume_installed:
                _raise_if_bootstrap_deadline_elapsed(deadline_monotonic)
                staging_python = _create_runtime_venv(
                    config,
                    staging_dir,
                    telemetry=telemetry,
                    deadline_monotonic=deadline_monotonic,
                    requirements_fingerprint=requirements_fingerprint,
                )

            _raise_if_bootstrap_deadline_elapsed(deadline_monotonic)
            if not _validate_installed_runtime(
                staging_python,
                staging_dir,
                telemetry,
                resumed=resume_installed,
            ):
                resume_installed = False
                continue
            break

        with telemetry.phase("published", data={}):
            _write_runtime_marker(
                _ready_marker(staging_dir),
                venv_python=staging_python,
                requirements_fingerprint=requirements_fingerprint,
            )
            # The marker is written into staging_dir, where it is invisible at the
            # final venv_dir path. The directory rename is the single atomic step
            # that publishes it, so an interrupted install can never look ready.
            try:
                staging_dir.replace(venv_dir)
            except Exception:
                _remove_tree(staging_dir)
                raise
        _READY_VENV_CACHE[cache_key] = _venv_python(venv_dir)
        return _READY_VENV_CACHE[cache_key]


def configured_timeout_seconds(config: Any) -> int:
    return _clamped_int_config_value(
        config,
        "tools_python_runtime_timeout_seconds",
        30,
        minimum=MIN_TIMEOUT_SECONDS,
        maximum=MAX_TIMEOUT_SECONDS,
    )


def configured_bootstrap_budget_seconds(config: Any) -> int:
    return _clamped_int_config_value(
        config,
        "tools_python_runtime_bootstrap_budget_seconds",
        BOOTSTRAP_BUDGET_SECONDS,
        minimum=MIN_BOOTSTRAP_BUDGET_SECONDS,
        maximum=MAX_BOOTSTRAP_BUDGET_SECONDS,
    )


def configured_memory_limit_mb(config: Any) -> int:
    return _clamped_int_config_value(
        config,
        "tools_python_runtime_max_memory_mb",
        512,
        minimum=MIN_MEMORY_LIMIT_MB,
        maximum=MAX_MEMORY_LIMIT_MB,
    )
