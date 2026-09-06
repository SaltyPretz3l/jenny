"""Bootstrap pip into the bundled Windows embeddable interpreter.

The official embeddable distribution ships without ``pip`` or ``ensurepip``,
so the managed runtime installs pip from its own hash-verified wheel before
the normal ``python -m pip`` path can be used. Split out of ``interpreter``
to keep that module under the repository file-size ceiling.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import zipfile
from pathlib import Path

from sidecar.ai.tools.builtins.python_runtime import bootstrap_subprocess
from sidecar.ai.tools.builtins.python_runtime.errors import (
    PythonRuntimeOfflineInstallError,
    PythonRuntimeWheelhouseIntegrityError,
)

# Reserved DOS device names: a wheel entry called CON.txt or LPT1 resolves to a
# device, not a file, on Windows.
_WINDOWS_RESERVED_ARCHIVE_STEMS = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"{prefix}{index}" for prefix in ("COM", "LPT") for index in range(1, 10)}
)

MAX_BOOTSTRAP_PIP_UNPACKED_BYTES = 64 * 1024 * 1024
# The first Windows pip probe can incur cold filesystem and antivirus scanning
# costs, so a 60-second budget avoids false missing-pip failures.
PIP_PROBE_TIMEOUT_SECONDS = 60.0


def _probe_pip(python_executable: Path, *, timeout: float) -> tuple[bool, str]:
    """Probe ``python -m pip --version``, returning (ok, failure detail).

    The returned detail distinguishes timeouts, launch errors, and non-zero exits.
    """
    try:
        completed = bootstrap_subprocess.run(
            [str(python_executable), "-m", "pip", "--version"],
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, f"pip probe timed out after {timeout:.0f}s"
    except OSError as error:
        return False, f"pip probe could not start: {error}"
    except subprocess.SubprocessError as error:
        return False, f"pip probe failed: {error}"
    if completed.returncode == 0:
        return True, ""
    raw_detail = (completed.stderr or completed.stdout or "")
    detail = " ".join(raw_detail.split())[:400]
    return False, (
        f"pip probe exited {completed.returncode}"
        + (f": {detail}" if detail else " with no output")
    )


def _pip_is_available(python_executable: Path) -> bool:
    return _probe_pip(python_executable, timeout=PIP_PROBE_TIMEOUT_SECONDS)[0]


def _ensure_offline_pip(python_executable: Path, wheelhouse: Path) -> None:
    """Bootstrap pip from its verified wheel when an embeddable interpreter
    has no ensurepip module. The wheelhouse integrity gate has already run, so
    executing the sole pip wheel cannot bypass the release lock."""
    if _pip_is_available(python_executable):
        return
    pip_wheels = sorted(wheelhouse.glob("pip-*.whl"))
    if len(pip_wheels) != 1:
        raise PythonRuntimeWheelhouseIntegrityError(
            "Python runtime wheelhouse must contain exactly one pinned pip wheel"
        )
    site_packages = python_executable.parent / "Lib" / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)
    _extract_verified_pip_wheel(pip_wheels[0], site_packages)
    ok, detail = _probe_pip(python_executable, timeout=PIP_PROBE_TIMEOUT_SECONDS)
    if not ok and "timed out" in detail:
        # One retry: the first probe warms the file cache, so a cold-I/O
        # timeout usually clears on the second attempt.
        ok, detail = _probe_pip(
            python_executable,
            timeout=PIP_PROBE_TIMEOUT_SECONDS * 2,
        )
    if not ok:
        raise PythonRuntimeOfflineInstallError(
            "The verified pip wheel did not bootstrap the managed Python "
            f"runtime ({detail})"
        )


def _extract_verified_pip_wheel(pip_wheel: Path, site_packages: Path) -> None:
    """Install the already hash-verified pip wheel without invoking pip itself.

    Modern pip refuses to modify its own installation when launched through
    ``runpy``. The embeddable distribution has neither pip nor ensurepip, so the
    bootstrap step extracts the verified pure-Python wheel directly and only
    then uses the normal ``python -m pip`` path for the curated runtime closure.
    """
    destination_root = site_packages.resolve()
    seen_targets: set[str] = set()
    try:
        with zipfile.ZipFile(pip_wheel) as archive:
            total_size = sum(info.file_size for info in archive.infolist())
            if total_size > MAX_BOOTSTRAP_PIP_UNPACKED_BYTES:
                raise PythonRuntimeWheelhouseIntegrityError(
                    "Verified pip wheel exceeds the bootstrap extraction limit"
                )
            for info in archive.infolist():
                raw_name = info.filename
                if not raw_name or "\\" in raw_name:
                    raise PythonRuntimeWheelhouseIntegrityError(
                        "Verified pip wheel contains an unsafe archive path"
                    )
                relative_path = Path(raw_name)
                unsafe_windows_part = any(
                    ":" in part
                    or part.rstrip(" .") != part
                    or part.split(".", 1)[0].upper() in _WINDOWS_RESERVED_ARCHIVE_STEMS
                    for part in relative_path.parts
                )
                if (
                    relative_path.is_absolute()
                    or ".." in relative_path.parts
                    or unsafe_windows_part
                ):
                    raise PythonRuntimeWheelhouseIntegrityError(
                        "Verified pip wheel contains an unsafe archive path"
                    )
                target = (destination_root / relative_path).resolve()
                try:
                    target.relative_to(destination_root)
                except ValueError as error:
                    raise PythonRuntimeWheelhouseIntegrityError(
                        "Verified pip wheel contains an unsafe archive path"
                    ) from error
                target_key = os.path.normcase(str(target))
                if target_key in seen_targets:
                    raise PythonRuntimeWheelhouseIntegrityError(
                        "Verified pip wheel contains duplicate archive paths"
                    )
                seen_targets.add(target_key)
                unix_mode = info.external_attr >> 16
                if stat.S_ISLNK(unix_mode):
                    raise PythonRuntimeWheelhouseIntegrityError(
                        "Verified pip wheel contains an unsupported symbolic link"
                    )
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
    except (OSError, zipfile.BadZipFile) as error:
        raise PythonRuntimeWheelhouseIntegrityError(
            "Verified pip wheel could not be extracted"
        ) from error
