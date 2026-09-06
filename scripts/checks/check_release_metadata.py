"""Validate release and protocol metadata alignment."""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_GITHUB_OWNER = "SaltyPretz3l"
EXPECTED_GITHUB_REPO = "jenny"


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"unable to read {path}: {exc}") from exc


def _extract_regex(text: str, pattern: str, label: str) -> str:
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        raise RuntimeError(f"unable to locate {label}")
    return str(match.group(1)).strip()


def _package_metadata(root: Path) -> tuple[str, str, dict[str, object]]:
    payload = json.loads(_read_text(root / "package.json"))
    version = str(payload.get("version", "")).strip()
    repository = payload.get("repository", "")
    if isinstance(repository, dict):
        repository_url = str(repository.get("url", "")).strip()
    else:
        repository_url = str(repository).strip()
    return version, repository_url, payload


def _repository_identity(repository_url: str) -> tuple[str, str, str] | None:
    value = repository_url.strip()
    if value.startswith("github:"):
        value = f"https://github.com/{value.removeprefix('github:')}"
    elif re.fullmatch(r"[^/@\s]+@[^:/\s]+:.+", value):
        user_host, path = value.split(":", 1)
        value = f"ssh://{user_host}/{path}"
    if value.startswith("git+"):
        value = value.removeprefix("git+")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https", "git", "ssh"}
        or parsed.query
        or parsed.fragment
    ):
        return None
    try:
        if parsed.port is not None:
            return None
    except ValueError:
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if not parsed.hostname:
        return None
    try:
        owner, repository = parts
    except ValueError:
        return None
    if repository.endswith(".git"):
        repository = repository[:-4]
    return parsed.hostname.lower(), owner, repository


def _pyproject_version(root: Path) -> str:
    payload = tomllib.loads(_read_text(root / "pyproject.toml"))
    project = payload.get("project", {})
    if not isinstance(project, dict):
        return ""
    return str(project.get("version", "")).strip()


def _python_api_version(root: Path) -> str:
    return _extract_regex(
        _read_text(root / "sidecar" / "protocol.py"),
        r'^API_VERSION\s*=\s*["\']([^"\']+)["\']',
        "sidecar.protocol API_VERSION",
    )


def _electron_api_version(root: Path) -> str:
    return _extract_regex(
        _read_text(root / "services" / "backend" / "sidecar-client.js"),
        r'^const\s+API_VERSION\s*=\s*["\']([^"\']+)["\']',
        "sidecar-client API_VERSION",
    )


def _managed_client_versions(root: Path) -> list[str]:
    text = _read_text(root / "services" / "backend" / "managed-sidecar-lifecycle.js")
    return [
        value.strip()
        for value in re.findall(
            r"clientVersion:\s*[\"']([^\"']+)[\"']",
            text,
        )
        if value.strip()
    ]


def _managed_uses_app_version(root: Path) -> bool:
    text = _read_text(root / "services" / "backend" / "managed-sidecar-lifecycle.js")
    return bool(re.search(r"clientVersion:\s*service\.appVersion\b", text))


def _electron_builder_publish(root: Path) -> tuple[str, str, bool]:
    text = _read_text(root / "electron-builder.yml")
    provider_is_github = bool(re.search(r"provider:\s*github\b", text))
    owner = _extract_regex(text, r"owner:\s*([^\s#]+)", "electron-builder publish owner")
    repo = _extract_regex(text, r"repo:\s*([^\s#]+)", "electron-builder publish repo")
    return owner, repo, provider_is_github


def _release_notes_has_version(root: Path, version: str) -> bool:
    path = root / "RELEASE_NOTES.md"
    if not path.exists() or not version:
        return False
    return bool(re.search(rf"^##\s+{re.escape(version)}\b", _read_text(path), re.MULTILINE))


def _validate_updater_release_notes(
    root: Path,
    *,
    package_payload: dict[str, object],
    package_version: str,
) -> list[str]:
    violations: list[str] = []
    dependencies = package_payload.get("dependencies", {})
    dev_dependencies = package_payload.get("devDependencies", {})
    if not isinstance(dependencies, dict) or "electron-updater" not in dependencies:
        violations.append("electron-updater must be declared in runtime dependencies")
    if isinstance(dev_dependencies, dict) and "electron-updater" in dev_dependencies:
        violations.append("electron-updater must not be declared as a devDependency")
    if not _release_notes_has_version(root, package_version):
        violations.append(f"RELEASE_NOTES.md is missing a {package_version!r} release section")
    return violations


def validate_release_metadata(root: Path = ROOT) -> list[str]:
    violations: list[str] = []
    package_version, repository_url, package_payload = _package_metadata(root)
    pyproject_version = _pyproject_version(root)
    python_api_version = _python_api_version(root)
    electron_api_version = _electron_api_version(root)
    managed_client_versions = _managed_client_versions(root)
    managed_uses_app_version = _managed_uses_app_version(root)
    publish_owner, publish_repo, publish_is_github = _electron_builder_publish(root)

    if not package_version:
        violations.append("package.json version is missing")
    if package_version != pyproject_version:
        violations.append(
            f"package.json version {package_version!r} does not match pyproject.toml "
            f"version {pyproject_version!r}"
        )
    if python_api_version != electron_api_version:
        violations.append(
            f"sidecar API_VERSION {python_api_version!r} does not match Electron "
            f"API_VERSION {electron_api_version!r}"
        )
    if not managed_client_versions and not managed_uses_app_version:
        violations.append("managed-sidecar lifecycle has no clientVersion values")
    for client_version in managed_client_versions:
        if client_version != package_version:
            violations.append(
                f"managed clientVersion {client_version!r} does not match package "
                f"version {package_version!r}"
            )
    expected_slug = f"{EXPECTED_GITHUB_OWNER}/{EXPECTED_GITHUB_REPO}"
    if _repository_identity(repository_url) != (
        "github.com",
        EXPECTED_GITHUB_OWNER,
        EXPECTED_GITHUB_REPO,
    ):
        violations.append(
            f"package repository {repository_url!r} does not point at {expected_slug}"
        )
    if not publish_is_github:
        violations.append("electron-builder publish provider must be github")
    if publish_owner != EXPECTED_GITHUB_OWNER or publish_repo != EXPECTED_GITHUB_REPO:
        violations.append(
            "electron-builder publish target "
            f"{publish_owner}/{publish_repo} does not match {expected_slug}"
        )
    violations.extend(
        _validate_updater_release_notes(
            root,
            package_payload=package_payload,
            package_version=package_version,
        )
    )
    return violations


def main() -> int:
    try:
        violations = validate_release_metadata(ROOT)
    except Exception as exc:  # noqa: BLE001 - policy check should fail with context.
        print(f"FAIL: release metadata check crashed: {exc}")
        return 1

    if violations:
        print("FAIL: release metadata drift detected")
        for violation in violations:
            print(f"  - {violation}")
        return 1

    print("PASS: release metadata check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
