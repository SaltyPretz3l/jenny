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
    Path(".github") / "workflows" / "ci-linux-package.yml",
)
# Source-repo-only lanes; the public source export ships release.yml alone.
PRIVATE_RELEASE_WORKFLOWS = frozenset({"ci-linux-package.yml"})
# Any one of these in an earlier ``run:`` step satisfies the preload
# requirement: the dedicated builder, or a pack/release npm script that
# already embeds it.
PRELOAD_BUILD_MARKERS = (
    "npm run build:preload",
    "npm run pack:",
    "npm run release:windows",
)
NATIVE_RELEASE_BUILD_COMMANDS = {
    "build:restricted-host:release", "build:full-host-supervisor:release",
}

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
    "pack:linux": (
        "npm run build:preload:force && npm run check:python-runtime-bundle && "
        "npm run build:sidecar && npm run sbom:sidecar && "
        "npm exec -- electron-builder --linux "
        "--config electron-builder.yml --publish never"
    ),
    "release:windows": (
        "npm run build:preload:force && npm run check:python-runtime-bundle && "
        "npm run build:sidecar && npm run build:restricted-host:release && "
        "npm run build:full-host-supervisor:release && npm run sbom:sidecar && "
        "npm exec -- electron-builder --win "
        "--config electron-builder.yml --publish never"
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


def _validate_draft_upload_step(
    run: str, guard: str, platforms: set[str], mac_verified: bool, linux_verified: bool
) -> list[str]:
    violations: list[str] = []
    if "release_assets.py prepare" in run or "release_assets.py upload" in run:
        if ("github.event_name == 'push'" not in guard
                or "github.repository == 'SaltyPretz3l/jenny'" not in guard):
            violations.append(
                "release.yml publishing must be restricted to public-repository pushes"
            )
    if "release_assets.py upload" in run:
        if not platforms:
            violations.append("release.yml upload platform must be explicitly validated")
        if "mac" in platforms and not mac_verified:
            violations.append("release.yml uploads before mandatory macOS verification")
        if "linux" in platforms and not linux_verified:
            violations.append("release.yml Linux uploads require mandatory package smoke")
    if "gh release upload" in run or "gh release create" in run or "--clobber" in run:
        violations.append("release.yml writes must use the draft-only release_assets helper")
    return violations


def _upload_platforms(run: str, job: dict[str, object]) -> set[str]:
    platforms = {value for value in ("linux", "mac", "windows")
                 if _has_cli_option(run, "--platform", value)}
    if re.search(r"--platform(?:\s+|=)\$\{\{\s*matrix\.release_platform\s*\}\}", run):
        matrix = job.get("strategy", {}).get("matrix", {})
        platforms.update(row.get("release_platform") for row in matrix.get("include", []))
    return platforms if platforms <= {"linux", "mac", "windows"} else set()


def _validate_prepare_dependency(job: dict[str, object], name: str) -> list[str]:
    needs = job.get("needs", [])
    if needs == "prepare" or isinstance(needs, list) and "prepare" in needs:
        guard = str(job.get("if", ""))
        if not all(part in guard for part in (
            "always()", "!cancelled()", "github.event_name == 'workflow_dispatch'",
            "needs.prepare.result == 'success'",
        )):
            return [f"release.yml {name} must run after skipped prepare on manual dispatch"]
    return []


def _validate_public_release_safety(workflow: dict[str, object]) -> list[str]:
    """Manual runs cannot publish; Mac upload follows native package verification."""
    violations: list[str] = []
    concurrency = workflow.get("concurrency", {})
    if (not isinstance(concurrency, dict) or concurrency.get("cancel-in-progress") is not False
            or "github.ref" not in str(concurrency.get("group", ""))):
        violations.append("release.yml must serialize release runs by ref without cancellation")
    jobs = workflow.get("jobs", {})
    for name, steps in _workflow_jobs(workflow):
        job = jobs[name]
        violations.extend(_validate_prepare_dependency(job, name))
        verified = False
        linux_verified = False
        upload_platforms = set().union(*(
            _upload_platforms(str(step.get("run") or ""), job) for step in steps
            if "release_assets.py upload" in str(step.get("run") or "")
        ))
        native_builds = set()
        for step in steps:
            run = str(step.get("run") or "")
            guard = f"{job.get('if', '')} {step.get('if', '')}"
            violations.extend(_validate_draft_upload_step(
                run, guard, _upload_platforms(run, job), verified, linux_verified
            ))
            if "electron-builder" in run and not _has_cli_option(run, "--publish", "never"):
                violations.append("release.yml must build with --publish never before verification")
            if ("mac" in upload_platforms and "electron-builder" in run
                    and native_builds != NATIVE_RELEASE_BUILD_COMMANDS):
                violations.append(
                    "release.yml must build both native plugin hosts before packaging"
                )
            if step.get("continue-on-error") is not True and not step.get("if"):
                for command in NATIVE_RELEASE_BUILD_COMMANDS:
                    if f"npm run {command}" in run:
                        native_builds.add(command)
            if ("scripts/packaging/smoke_packaged_flow.py" in run
                    and _has_cli_option(run, "--existing-artifacts")
                    and _has_cli_option(run, "--composition", "release")
                    and step.get("continue-on-error") is not True and not step.get("if")):
                linux_verified = True
            if "verify_macos_release.py" in run:
                verified = (step.get("continue-on-error") is not True
                            and step.get("if") in (None, "runner.os == 'macOS'"))
    if "release_assets.py prepare" not in str(jobs.get("prepare", {})):
        violations.append("release.yml must require an unpublished draft before building")
    return violations


def _has_cli_option(run: str, option: str, value: str | None = None) -> bool:
    """Recognize separate or equals-form flags without depending on ordering."""
    pattern = r"(?<!\S)" + re.escape(option)
    if value is not None:
        pattern += r"(?:[ \t]+|=)[\"']?" + re.escape(value) + r"[\"']?"
    return re.search(pattern + r"(?=\s|$)", run) is not None


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
        # private Linux-package workflow is a source-repo lane
        # (and depend on source-repo state). release.yml itself stays fully
        # validated in the distribution.
        required = tuple(
            relative for relative in RELEASE_WORKFLOWS
            if relative.name not in PRIVATE_RELEASE_WORKFLOWS
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
        if relative.name == 'release.yml':
            violations.extend(_validate_public_release_safety(workflow))
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
    ``RELEASE_NOTES.md`` must document the change. Owners run strict mode
    before publication; the retired private attestation job no longer runs it.
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
