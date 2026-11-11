"""Opt-in Azure Artifact Signing for the Windows release build.

Signing is on only when every setting below is present in the environment (the
release workflow fills them from GitHub repository variables and secrets). With
none present the build stays unsigned, as local and fork builds are; with only
some present the build fails, because a half-configured release would ship
unsigned without anyone noticing.

``config`` writes an electron-builder config that extends electron-builder.yml
and adds the Azure signing options; the build step passes it as ``--config``.
An overlay file rather than ``-c.`` command-line overrides, because the CLI
turns those into strings ("true") and makes electron-builder load
electron-builder.yml twice, duplicating its resource lists. ``verify`` reads
the publisher from that config and checks after the build that every shipped
executable carries a valid Authenticode signature: Jenny's own files signed by
that publisher, vendor-signed executables by their vendor.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path, PureWindowsPath

ENDPOINT = "JENNY_AZURE_SIGNING_ENDPOINT"
ACCOUNT = "JENNY_AZURE_SIGNING_ACCOUNT"
PROFILE = "JENNY_AZURE_SIGNING_PROFILE"
PUBLISHER = "JENNY_AZURE_SIGNING_PUBLISHER"
CREDENTIALS = ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET")
SETTINGS = (ENDPOINT, ACCOUNT, PROFILE, PUBLISHER, *CREDENTIALS)

ENDPOINT_RE = re.compile(r"https://[a-z0-9]+\.codesigning\.azure\.net/?")
RESOURCE_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{1,99}")
MAX_PUBLISHER_LENGTH = 200
FIRST_PRINTABLE = 32
# Shipped already signed by their vendor (CPython by the PSF, node-pty's ConPTY
# host by Microsoft) and left that way; mirrors the negatives in win.signExts.
THIRD_PARTY_SIGNED = frozenset({"python.exe", "pythonw.exe", "openconsole.exe"})
INSTALLER = "Jenny-Setup-x64.exe"
BASE_CONFIG = "electron-builder.yml"

Runner = Callable[[Sequence[str], Mapping[str, str]], str]


class SigningConfigError(ValueError):
    """The signing settings are incomplete or malformed."""


def signing_settings(env: Mapping[str, str]) -> dict[str, str] | None:
    """Return the settings when all are present, None when none are, else raise."""
    present = {name: env.get(name, "").strip() for name in SETTINGS}
    missing = [name for name, value in present.items() if not value]
    if len(missing) == len(SETTINGS):
        return None
    if missing:
        raise SigningConfigError(
            "Windows signing is partly configured; missing: " + ", ".join(missing)
        )
    if not ENDPOINT_RE.fullmatch(present[ENDPOINT]):
        raise SigningConfigError(
            f"{ENDPOINT} must look like https://<region>.codesigning.azure.net/"
        )
    for name in (ACCOUNT, PROFILE):
        if not RESOURCE_NAME_RE.fullmatch(present[name]):
            raise SigningConfigError(f"{name} must be letters, digits and hyphens")
    publisher = present[PUBLISHER]
    if (
        len(publisher) > MAX_PUBLISHER_LENGTH
        or publisher.startswith("-")
        or any(ord(ch) < FIRST_PRINTABLE for ch in publisher)
    ):
        raise SigningConfigError(f"{PUBLISHER} must be one printable line")
    return present


def signed_config(settings: Mapping[str, str]) -> dict:
    """electron-builder config that switches the Windows build to Azure signing."""
    return {
        # Resolved against the project directory, so the base config loads once.
        "extends": f"file:{BASE_CONFIG}",
        "win": {
            "azureSignOptions": {
                "publisherName": settings[PUBLISHER],
                "endpoint": settings[ENDPOINT],
                "codeSigningAccountName": settings[ACCOUNT],
                "certificateProfileName": settings[PROFILE],
            },
            # Signed installs then accept only updates signed by the same publisher.
            "verifyUpdateCodeSignature": True,
            # Any file that fails to sign fails the build instead of shipping unsigned.
            "forceCodeSigning": True,
        },
    }


def signature_targets(dist: Path) -> list[Path]:
    """The installer plus every executable in the unpacked app."""
    installer = dist / INSTALLER
    unpacked = dist / "win-unpacked"
    if not installer.is_file() or not unpacked.is_dir():
        raise FileNotFoundError(f"Windows build output not found under {dist}")
    return [installer, *sorted(unpacked.rglob("*.exe"))]


def _powershell_runner(command: Sequence[str], env: Mapping[str, str]) -> str:
    completed = subprocess.run(
        list(command),
        env={**os.environ, **env},
        capture_output=True,
        encoding="utf-8",
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Get-AuthenticodeSignature failed: {completed.stderr.strip()}")
    return completed.stdout


# UTF-8 output so an accented publisher name survives Windows PowerShell 5.1;
# GetNameInfo(SimpleName) is the certificate's CN, the name the updater checks.
_READ_SIGNATURES = (
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
    "$paths = $env:JENNY_SIGNATURE_PATHS | ConvertFrom-Json; "
    "$rows = @(foreach ($p in $paths) { $s = Get-AuthenticodeSignature -LiteralPath $p; "
    "$c = $s.SignerCertificate; "
    "[pscustomobject]@{ Path = $p; Status = [string]$s.Status; "
    "Signer = $(if ($c) { $c.GetNameInfo('SimpleName', $false) } else { '' }) } }); "
    "ConvertTo-Json -InputObject $rows -Compress"
)


def read_signatures(paths: Sequence[Path], runner: Runner = _powershell_runner) -> list[dict]:
    command = ["powershell", "-NoProfile", "-NonInteractive", "-Command", _READ_SIGNATURES]
    output = runner(command, {"JENNY_SIGNATURE_PATHS": json.dumps([str(p) for p in paths])})
    return json.loads(output or "[]")


def signature_problems(rows: Sequence[Mapping[str, str]], publisher: str) -> list[str]:
    problems = []
    for row in rows:
        path = str(row.get("Path", ""))
        status = str(row.get("Status", ""))
        if status != "Valid":
            problems.append(f"{path}: signature status {status or 'missing'}")
            continue
        if PureWindowsPath(path).name.lower() in THIRD_PARTY_SIGNED:
            continue
        signer = str(row.get("Signer", ""))
        if signer != publisher:
            problems.append(f"{path}: signed by {signer!r}, expected {publisher!r}")
    return problems


def publisher_from_config(config_path: Path) -> str:
    """The publisher the signed build was configured with."""
    config = json.loads(config_path.read_text(encoding="utf-8"))
    return config["win"]["azureSignOptions"]["publisherName"]


def verify(dist: Path, publisher: str, runner: Runner = _powershell_runner) -> list[Path]:
    targets = signature_targets(dist)
    rows = read_signatures(targets, runner)
    if not isinstance(rows, list) or len(rows) != len(targets):
        raise RuntimeError(f"Could not read a signature for each of {len(targets)} files")
    problems = signature_problems(rows, publisher)
    if problems:
        raise RuntimeError("Unsigned or mis-signed Windows files:\n" + "\n".join(problems))
    return targets


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="action", required=True)
    config_cmd = sub.add_parser("config", help="write the signed electron-builder config")
    config_cmd.add_argument("--out", type=Path, required=True)
    verify_cmd = sub.add_parser("verify", help="check signatures on the built output")
    verify_cmd.add_argument("--config", type=Path, required=True)
    verify_cmd.add_argument("--dist", type=Path, default=Path("dist"))
    options = parser.parse_args(argv)

    if options.action == "verify":
        # The config step wrote this file only for a complete, valid setting set.
        if not options.config.is_file():
            print("Windows signing is off; nothing to verify")
            return 0
        checked = verify(options.dist, publisher_from_config(options.config))
        print(f"Verified Authenticode signatures on {len(checked)} Windows files")
        return 0
    settings = signing_settings(os.environ)
    if options.action == "config":
        if settings is None:
            options.out.unlink(missing_ok=True)
            print("Windows signing: off (no Azure signing settings); building unsigned")
            return 0
        options.out.write_text(
            json.dumps(signed_config(settings), indent=2) + "\n", encoding="utf-8"
        )
        print(f"Windows signing: Azure Artifact Signing; config written to {options.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
