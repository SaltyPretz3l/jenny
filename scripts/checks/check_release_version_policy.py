"""Validate app release version, updater, diagnostics, and SBOM policy."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SEMVER_RE = re.compile(
    r"^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+(?P<buildmetadata>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)

RELEASE_WORKFLOWS = (
    Path(".github") / "workflows" / "release.yml",
    Path(".github") / "workflows" / "release-attestation.yml",
)
# Any one of these in an earlier ``run:`` step satisfies the preload
# requirement: the dedicated builder, or a pack/release npm script that
# already embeds it.
PRELOAD_BUILD_MARKERS = (
    "npm run build:preload",
    "npm run pack:",
    "npm run release:windows",
)

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.release_contract_versions import validate_contract_versions  # noqa: E402

REQUIRED_SCRIPTS = {
    "build:sidecar": "python scripts/packaging/build_sidecar_artifact.py",
    "build:restricted-host": "python scripts/packaging/build_restricted_host_artifact.py",
    "build:restricted-host:release": (
        "python scripts/packaging/build_restricted_host_artifact.py --release"
    ),
    "build:full-host-supervisor": (
        "python scripts/packaging/build_full_host_supervisor_artifact.py"
    ),
    "build:full-host-supervisor:release": (
        "python scripts/packaging/build_full_host_supervisor_artifact.py --release"
    ),
    "pack:dir": (
        "npm run build:preload && npm run check:python-runtime-bundle && "
        "npm run build:sidecar && npm run build:restricted-host && "
        "npm run build:full-host-supervisor && npm run sbom:sidecar && "
        "npm exec -- electron-builder --dir "
        "--config electron-builder.yml --publish never"
    ),
    "pack:release": (
        "npm run build:preload:force && npm run check:python-runtime-bundle && "
        "npm run build:sidecar && npm run build:restricted-host:release && "
        "npm run build:full-host-supervisor:release && npm run sbom:sidecar && "
        "npm exec -- electron-builder "
        "--config electron-builder.yml --publish never"
    ),
    "release:windows": (
        "npm run build:preload:force && npm run check:python-runtime-bundle && "
        "npm run build:sidecar && npm run build:restricted-host:release && "
        "npm run build:full-host-supervisor:release && npm run sbom:sidecar && "
        "npm exec -- electron-builder --win "
        "--config electron-builder.yml --publish always"
    ),
    "release:smoke": "python scripts/packaging/smoke_packaged_flow.py",
}


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _load_json(path: Path) -> dict[str, object]:
    payload = json.loads(_read_text(path))
    return payload if isinstance(payload, dict) else {}


def _package_version(root: Path) -> str:
    return str(_load_json(root / "package.json").get("version", "")).strip()


def _pyproject_version(root: Path) -> str:
    payload = tomllib.loads(_read_text(root / "pyproject.toml"))
    project = payload.get("project", {})
    return str(project.get("version", "")).strip() if isinstance(project, dict) else ""


def _managed_client_versions(root: Path) -> list[str]:
    text = _read_text(root / "services" / "backend" / "managed-sidecar-lifecycle.js")
    return [
        value.strip()
        for value in re.findall(r"clientVersion:\s*['\"]([^'\"]+)['\"]", text)
        if value.strip()
    ]


def _managed_uses_app_version(root: Path) -> bool:
    text = _read_text(root / "services" / "backend" / "managed-sidecar-lifecycle.js")
    return bool(re.search(r"clientVersion:\s*service\.appVersion\b", text))


def _quoted_schema_assignments(text: str) -> list[str]:
    violations: list[str] = []
    if re.search(r"SCHEMA_VERSION\s*=\s*['\"]", text):
        violations.append("sidecar runtime SCHEMA_VERSION must be an integer literal")
    if re.search(r"schema_version['\"]?\s*:\s*['\"]\d+['\"]", text):
        violations.append("diagnostics schema_version payloads must be integers")
    return violations


def _validate_release_notes(root: Path, package_version: str) -> list[str]:
    path = root / "RELEASE_NOTES.md"
    if not path.exists():
        return ["RELEASE_NOTES.md is missing"]
    text = _read_text(path)
    violations: list[str] = []
    if not re.search(rf"^##\s+{re.escape(package_version)}\b", text, re.MULTILINE):
        violations.append(f"RELEASE_NOTES.md missing section for version {package_version}")
    if "<!-- JENNY_RELEASE_SHA256_MANIFEST_START -->" not in text:
        violations.append("RELEASE_NOTES.md missing SHA256 manifest block")
    return violations


def _validate_package_lock(root: Path, package_version: str) -> list[str]:
    path = root / "package-lock.json"
    if not path.exists():
        return []
    payload = _load_json(path)
    top_level_version = str(payload.get("version", "")).strip()
    packages = payload.get("packages", {})
    root_package = packages.get("") if isinstance(packages, dict) else {}
    lock_version = (
        str(root_package.get("version", "")).strip()
        if isinstance(root_package, dict)
        else ""
    )
    violations: list[str] = []
    if top_level_version and top_level_version != package_version:
        violations.append(
            f"package-lock top-level version {top_level_version!r} does not match "
            f"{package_version!r}"
        )
    if lock_version and lock_version != package_version:
        violations.append(
            f"package-lock root version {lock_version!r} does not match {package_version!r}"
        )
    return violations


def _validate_sidecar_server_version(root: Path, package_version: str) -> list[str]:
    text = _read_text(root / "sidecar" / "runtime" / "capabilities.py")
    match = re.search(r'^SERVER_VERSION\s*=\s*["\']([^"\']+)["\']', text, re.MULTILINE)
    if match is None:
        return ["sidecar initialize response must use a SERVER_VERSION constant"]
    server_version = match.group(1).strip()
    if server_version != package_version:
        return [
            f"sidecar SERVER_VERSION {server_version!r} does not match "
            f"package version {package_version!r}"
        ]
    if not re.search(r'["\']server_version["\']\s*:\s*SERVER_VERSION\b', text):
        return ["sidecar initialize response must expose SERVER_VERSION"]
    return []


def _validate_versions(root: Path) -> tuple[str, list[str]]:
    violations: list[str] = []
    package_version = _package_version(root)
    pyproject_version = _pyproject_version(root)
    if not SEMVER_RE.fullmatch(package_version):
        violations.append(f"package.json version {package_version!r} is not semver")
    if package_version != pyproject_version:
        violations.append(
            f"package.json version {package_version!r} does not match "
            f"pyproject.toml {pyproject_version!r}"
        )
    return package_version, violations


def _validate_package_scripts_and_dependency(package: dict[str, object]) -> list[str]:
    violations: list[str] = []

    dependencies = package.get("dependencies", {})
    dev_dependencies = package.get("devDependencies", {})
    if not isinstance(dependencies, dict) or "electron-updater" not in dependencies:
        violations.append("electron-updater must be a runtime dependency")
    if isinstance(dev_dependencies, dict) and "electron-updater" in dev_dependencies:
        violations.append("electron-updater must not be a devDependency")

    scripts = package.get("scripts", {})
    if not isinstance(scripts, dict):
        scripts = {}
    for name, expected in REQUIRED_SCRIPTS.items():
        if scripts.get(name) != expected:
            violations.append(f"package.json script {name!r} is missing or drifted")
    return violations


def _workflow_jobs(workflow: dict[str, object]) -> list[tuple[str, list[dict[str, object]]]]:
    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict):
        return []
    collected: list[tuple[str, list[dict[str, object]]]] = []
    for job_name, job in jobs.items():
        steps = job.get("steps") if isinstance(job, dict) else None
        if isinstance(steps, list):
            collected.append((str(job_name), [s for s in steps if isinstance(s, dict)]))
    return collected


def _is_distribution_package(root: Path) -> bool:
    """The public source export stamps `"distribution": true` into package.json
    (see scripts/packaging/create_github_stage.py mark_distribution_package)."""
    try:
        package = _load_json(root / "package.json")
    except Exception:  # noqa: BLE001 - missing/invalid package.json is handled elsewhere.
        return False
    return isinstance(package, dict) and package.get("distribution") is True


def _validate_release_workflows(root: Path) -> list[str]:
    """Every electron-builder invocation needs an earlier preload build.

    ``preload.bundle.js`` is gitignored and untracked, ``electron-builder.yml``
    declares no ``beforeBuild``/``beforePack`` hook, and ``package.json`` has no
    ``prepack``/``prepare`` lifecycle script -- so a clean-checkout CI run that
    calls electron-builder directly packages an asar with no preload at all.
    The sandboxed window then boots with ``window.jennyShell`` undefined and
    the whole renderer is dead, while the build itself reports success.

    The npm ``pack:``/``release:`` scripts embed the preload build (pinned by
    ``REQUIRED_SCRIPTS`` above), but the workflows duplicate that sequence
    step-by-step and drifted away from it. This check pins the workflow side so
    the two cannot diverge again.
    """
    violations: list[str] = []
    required = RELEASE_WORKFLOWS
    if _is_distribution_package(root):
        # The public source export deliberately ships only release.yml; the
        # attestation workflow is a source-repo lane (and depends on source-repo
        # state). release.yml itself stays fully validated in the distribution.
        required = tuple(
            relative for relative in RELEASE_WORKFLOWS
            if relative.name != "release-attestation.yml"
        )
    for relative in required:
        path = root / relative
        if not path.exists():
            violations.append(f"{relative.as_posix()} is missing")
            continue
        workflow = yaml.safe_load(_read_text(path))
        if not isinstance(workflow, dict):
            violations.append(f"{relative.as_posix()} is not a YAML mapping")
            continue
        for job_name, steps in _workflow_jobs(workflow):
            preload_built = False
            for step in steps:
                run = str(step.get("run") or "")
                for builder in re.finditer("electron-builder", run):
                    preload_precedes_builder = preload_built or any(
                        0 <= run.find(marker) < builder.start()
                        for marker in PRELOAD_BUILD_MARKERS
                    )
                    if preload_precedes_builder:
                        continue
                    violations.append(
                        f"{relative.as_posix()} job {job_name!r} runs electron-builder "
                        "without a preceding 'npm run build:preload' command"
                    )
                if any(marker in run for marker in PRELOAD_BUILD_MARKERS):
                    preload_built = True
    return violations


def _validate_managed_client_versions(root: Path, package_version: str) -> list[str]:
    violations: list[str] = []
    client_versions = _managed_client_versions(root)
    if not client_versions and not _managed_uses_app_version(root):
        violations.append("managed-sidecar lifecycle has no clientVersion values")
    for client_version in client_versions:
        if client_version != package_version:
            violations.append(
                f"managed clientVersion {client_version!r} does not match "
                f"package version {package_version!r}"
            )
    return violations


def _validate_sbom_script(root: Path) -> list[str]:
    emit_sbom_text = _read_text(root / "scripts" / "packaging" / "emit_sbom.py")
    violations: list[str] = []
    if re.search(r'"version":\s*"0\.1\.0"', emit_sbom_text):
        violations.append("emit_sbom.py must read app version instead of hardcoding 0.1.0")
    if "package_version" not in emit_sbom_text and "read_package_version" not in emit_sbom_text:
        violations.append("emit_sbom.py must surface package version in SBOM metadata")
    return violations


def _validate_diagnostics_schema_versions(root: Path) -> list[str]:
    violations: list[str] = []

    diagnostics_text = _read_text(root / "sidecar" / "runtime" / "diagnostics.py")
    capabilities_text = _read_text(root / "sidecar" / "runtime" / "capabilities.py")
    violations.extend(_quoted_schema_assignments(diagnostics_text))
    violations.extend(_quoted_schema_assignments(capabilities_text))
    return violations


def validate_release_version_policy(
    root: Path = ROOT,
    *,
    strict: bool = False,
) -> list[str]:
    """Validate release-version policy.

    The default (non-strict) mode is safe to run on every PR/push. ``strict``
    additionally enforces the contract-version policy shared with the
    release cut (Q24): if ``API_VERSION`` or the
    diagnostics ``SCHEMA_VERSION`` moved since the previous release tag,
    ``RELEASE_NOTES.md`` must document the change. The release-attestation
    workflow runs this in strict mode so dev iteration does not get blocked
    while features are still landing.
    """
    violations: list[str] = []
    package = _load_json(root / "package.json")
    package_version, version_violations = _validate_versions(root)

    violations.extend(version_violations)
    violations.extend(_validate_package_scripts_and_dependency(package))
    violations.extend(_validate_release_workflows(root))
    violations.extend(_validate_managed_client_versions(root, package_version))
    violations.extend(_validate_sbom_script(root))
    violations.extend(_validate_diagnostics_schema_versions(root))
    violations.extend(_validate_release_notes(root, package_version))
    violations.extend(_validate_package_lock(root, package_version))
    violations.extend(_validate_sidecar_server_version(root, package_version))
    if strict:
        violations.extend(validate_contract_versions(root, package_version))
    return violations


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Also enforce contract-version policy (release-time gate).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    try:
        violations = validate_release_version_policy(ROOT, strict=args.strict)
    except Exception as exc:  # noqa: BLE001 - policy checks should fail with context.
        print(f"FAIL: release version policy check crashed: {exc}")
        return 1
    if violations:
        print("FAIL: release version policy drift detected")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    label = "release version policy (strict)" if args.strict else "release version policy"
    print(f"PASS: {label}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
