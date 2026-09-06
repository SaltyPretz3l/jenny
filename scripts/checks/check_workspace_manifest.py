"""Validate the workspace manifest contract and optional freshness expectations."""
from __future__ import annotations

import argparse
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Sequence

ROOT = Path(__file__).resolve().parents[2]
ROOT_MANIFEST = "WORKSPACE_MANIFEST.md"
ROOT_KIND = "workspace-manifest-root"
DOMAIN_KIND = "workspace-manifest-domain"
ROOT_FIELDS = ("kind", "version", "domains")
ROOT_OPTIONAL_FIELDS = ("last_reviewed",)
DOMAIN_FIELDS = ("kind", "domain", "summary", "paths", "entrypoints", "tests", "related_docs")
DOMAIN_OPTIONAL_FIELDS = ("last_reviewed",)
BODY_HEADINGS = (
    "## Owns",
    "## Start Here",
    "## Common Change Types",
    "## Consistency Rules",
    "## Verification",
    "## Update When",
)
# origin/main first: merge-base against local main is HEAD when running on
# main itself, which yields an empty changed set and a vacuous pass.
DEFAULT_MERGE_BASE_REFS = ("origin/main", "main")
CHANGED_FILES_ENV = "JENNYGC3_CHANGED_FILES"
LINK_PATTERN = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
FRONTMATTER_PATTERN = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)
REQUIRED_DOMAIN_MANIFESTS = {
    "ui-ux": "docs/manifests/ui-ux.md",
    "electron-wiring": "docs/manifests/electron-wiring.md",
    "sidecar-runtime": "docs/manifests/sidecar-runtime.md",
    "plugin-system": "docs/manifests/plugin-system.md",
}
# Domains whose 'paths:' are excluded from freshness enforcement. ui-ux is
# refreshed on explicit user request, not paired with each renderer edit;
# see docs/process/DOC_AS_CODE.md.
FRESHNESS_EXEMPT_DOMAINS = frozenset({"ui-ux"})
# Domains where references to since-deleted files surface as warnings instead
# of failures. Follows from the on-request refresh cadence: a session deleting
# renderer files must not be forced to touch ui-ux.md (a contended hot file)
# nor leave the gate red; stale references are pruned at the next requested
# refresh. Non-exempt domains keep missing-path references as hard failures.
MISSING_PATH_WARN_DOMAINS = frozenset({"ui-ux"})


@dataclass(frozen=True)
class ManifestDocument:
    relative_path: str
    frontmatter: dict[str, object]
    body: str


@dataclass(frozen=True)
class DomainDocument:
    domain: str
    manifest_path: str
    tracked_paths: tuple[str, ...]


def _normalize_repo_path(raw_path: str) -> str:
    token = str(raw_path or "").strip().replace("\\", "/")
    while token.startswith("./"):
        token = token[2:]
    return token


def _strip_quotes(value: str) -> str:
    token = value.strip()
    if len(token) >= 2 and token[0] == token[-1] and token[0] in {'"', "'"}:
        return token[1:-1]
    return token


def _is_repo_relative_path(path_text: str) -> bool:
    normalized = _normalize_repo_path(path_text)
    if not normalized:
        return False
    path = Path(normalized)
    # Check both flavors explicitly: on POSIX, Path("C:/x").is_absolute() is
    # False, which would let Windows-absolute paths through the gate.
    if PureWindowsPath(normalized).is_absolute() or PurePosixPath(normalized).is_absolute():
        return False
    try:
        (ROOT / path).resolve().relative_to(ROOT.resolve())
    except ValueError:
        return False
    return normalized != ".." and not normalized.startswith("../")


def _parse_frontmatter_block(text: str) -> dict[str, object]:
    parsed: dict[str, object] = {}
    active_list_key: str | None = None

    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.rstrip()
        if not line.strip():
            continue
        if line.startswith("  - "):
            if active_list_key is None:
                raise ValueError(f"unexpected list entry at line {lineno}")
            item = _strip_quotes(line[4:].strip())
            if not item:
                raise ValueError(f"empty list entry at line {lineno}")
            current_value = parsed.get(active_list_key)
            if not isinstance(current_value, list):
                raise ValueError(f"list entry without list owner at line {lineno}")
            current_value.append(item)
            continue
        if line.startswith("- "):
            if active_list_key is None:
                raise ValueError(f"unexpected list entry at line {lineno}")
            item = _strip_quotes(line[2:].strip())
            if not item:
                raise ValueError(f"empty list entry at line {lineno}")
            current_value = parsed.get(active_list_key)
            if not isinstance(current_value, list):
                raise ValueError(f"list entry without list owner at line {lineno}")
            current_value.append(item)
            continue
        if line.startswith(" "):
            raise ValueError(f"unsupported indentation at line {lineno}")
        if ":" not in line:
            raise ValueError(f"expected key/value pair at line {lineno}")
        key, raw_value = line.split(":", maxsplit=1)
        key = key.strip()
        if not key:
            raise ValueError(f"empty key at line {lineno}")
        value = raw_value.strip()
        if not value:
            parsed[key] = []
            active_list_key = key
            continue
        parsed[key] = _strip_quotes(value)
        active_list_key = None

    return parsed


def _load_manifest(relative_path: str) -> tuple[ManifestDocument | None, list[str]]:
    manifest_path = ROOT / relative_path
    if not manifest_path.exists():
        return None, [f"missing manifest file: {relative_path}"]

    try:
        content = manifest_path.read_text(encoding="utf-8")
    except OSError as error:
        return None, [f"failed to read manifest file {relative_path}: {error}"]

    match = FRONTMATTER_PATTERN.match(content)
    if match is None:
        return None, [f"manifest missing YAML frontmatter block: {relative_path}"]

    try:
        frontmatter = _parse_frontmatter_block(match.group(1))
    except ValueError as error:
        return None, [f"invalid frontmatter in {relative_path}: {error}"]

    return ManifestDocument(
        relative_path=relative_path,
        frontmatter=frontmatter,
        body=content[match.end() :],
    ), []


def _as_non_empty_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    token = value.strip()
    return token or None


def _as_non_empty_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            items.append(_normalize_repo_path(item))
    return items


def _assert_allowed_fields(
    *,
    frontmatter: dict[str, object],
    allowed_fields: Sequence[str],
    relative_path: str,
    optional_fields: Sequence[str] = (),
) -> list[str]:
    violations: list[str] = []
    known = set(allowed_fields) | set(optional_fields)
    unexpected = sorted(set(frontmatter) - known)
    if unexpected:
        violations.append(
            f"{relative_path} contains unexpected frontmatter fields: {', '.join(unexpected)}"
        )
    for field in allowed_fields:
        if field not in frontmatter:
            violations.append(f"{relative_path} is missing frontmatter field: {field}")
    return violations


def _validate_path_entries(
    relative_path: str,
    field_name: str,
    values: list[str],
    *,
    warn_missing: bool = False,
) -> tuple[list[str], list[str]]:
    violations: list[str] = []
    warnings: list[str] = []
    if not values:
        violations.append(f"{relative_path} frontmatter field '{field_name}' must be a non-empty list")
        return violations, warnings
    for item in values:
        if not _is_repo_relative_path(item):
            violations.append(
                f"{relative_path} field '{field_name}' must use repo-relative paths only: {item}"
            )
            continue
        candidate = ROOT / item
        if not candidate.exists():
            message = f"{relative_path} references missing path in '{field_name}': {item}"
            if warn_missing:
                warnings.append(message)
            else:
                violations.append(message)
    return violations, warnings


def _extract_markdown_links(body: str) -> set[str]:
    return {_normalize_repo_path(match.group(1)) for match in LINK_PATTERN.finditer(body)}


def _validate_root_manifest(root_doc: ManifestDocument) -> tuple[list[str], list[str]]:
    violations = _assert_allowed_fields(
        frontmatter=root_doc.frontmatter,
        allowed_fields=ROOT_FIELDS,
        optional_fields=ROOT_OPTIONAL_FIELDS,
        relative_path=root_doc.relative_path,
    )

    if _as_non_empty_string(root_doc.frontmatter.get("kind")) != ROOT_KIND:
        violations.append(f"{root_doc.relative_path} field 'kind' must be '{ROOT_KIND}'")
    if _as_non_empty_string(root_doc.frontmatter.get("version")) != "1":
        violations.append(f"{root_doc.relative_path} field 'version' must be '1'")

    domains = _as_non_empty_string_list(root_doc.frontmatter.get("domains"))
    expected_domains = list(REQUIRED_DOMAIN_MANIFESTS.values())
    if domains != expected_domains:
        violations.append(
            f"{root_doc.relative_path} field 'domains' must exactly match: {', '.join(expected_domains)}"
        )
    else:
        for domain_path in domains:
            if not _is_repo_relative_path(domain_path):
                violations.append(
                    f"{root_doc.relative_path} field 'domains' must use repo-relative paths only: {domain_path}"
                )
                continue
            if not (ROOT / domain_path).exists():
                violations.append(f"{root_doc.relative_path} references missing domain manifest: {domain_path}")

    linked_paths = _extract_markdown_links(root_doc.body)
    for domain_path in expected_domains:
        if domain_path not in linked_paths:
            violations.append(f"{root_doc.relative_path} must link to domain manifest: {domain_path}")

    return violations, domains


def _normalize_tracked_path(raw_path: str) -> str:
    normalized = _normalize_repo_path(raw_path)
    if not normalized:
        return ""
    candidate = ROOT / normalized
    if normalized.endswith("/") or candidate.is_dir():
        return normalized.rstrip("/") + "/"
    return normalized


def _validate_domain_manifest(
    domain_key: str,
    manifest_path: str,
) -> tuple[DomainDocument | None, list[str], list[str]]:
    doc, errors = _load_manifest(manifest_path)
    if doc is None:
        return None, errors, []

    violations = _assert_allowed_fields(
        frontmatter=doc.frontmatter,
        allowed_fields=DOMAIN_FIELDS,
        optional_fields=DOMAIN_OPTIONAL_FIELDS,
        relative_path=doc.relative_path,
    )

    if _as_non_empty_string(doc.frontmatter.get("kind")) != DOMAIN_KIND:
        violations.append(f"{doc.relative_path} field 'kind' must be '{DOMAIN_KIND}'")
    if _as_non_empty_string(doc.frontmatter.get("domain")) != domain_key:
        violations.append(f"{doc.relative_path} field 'domain' must be '{domain_key}'")
    if _as_non_empty_string(doc.frontmatter.get("summary")) is None:
        violations.append(f"{doc.relative_path} field 'summary' must be a non-empty string")

    paths = _as_non_empty_string_list(doc.frontmatter.get("paths"))
    entrypoints = _as_non_empty_string_list(doc.frontmatter.get("entrypoints"))
    tests = _as_non_empty_string_list(doc.frontmatter.get("tests"))
    related_docs = _as_non_empty_string_list(doc.frontmatter.get("related_docs"))

    warn_missing = domain_key in MISSING_PATH_WARN_DOMAINS
    warnings: list[str] = []
    for field_name, values in (
        ("paths", paths),
        ("entrypoints", entrypoints),
        ("tests", tests),
        ("related_docs", related_docs),
    ):
        field_violations, field_warnings = _validate_path_entries(
            doc.relative_path, field_name, values, warn_missing=warn_missing
        )
        violations.extend(field_violations)
        warnings.extend(field_warnings)

    for heading in BODY_HEADINGS:
        if heading not in doc.body:
            violations.append(f"{doc.relative_path} is missing required body section: {heading}")

    if violations:
        return None, violations, warnings

    tracked_paths = tuple(
        normalized for normalized in (_normalize_tracked_path(path) for path in paths) if normalized
    )
    return (
        DomainDocument(domain=domain_key, manifest_path=manifest_path, tracked_paths=tracked_paths),
        [],
        warnings,
    )


def _run_git_command(arguments: Sequence[str]) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError as error:
        return 1, "", str(error)
    return completed.returncode, completed.stdout, completed.stderr


def _parse_changed_paths(lines: str) -> list[str]:
    changed: list[str] = []
    seen: set[str] = set()
    for raw_line in lines.splitlines():
        normalized = _normalize_repo_path(raw_line)
        if not normalized or normalized in seen:
            continue
        changed.append(normalized)
        seen.add(normalized)
    return changed


def _parse_status_paths(lines: str) -> list[str]:
    changed: list[str] = []
    seen: set[str] = set()
    for raw_line in lines.splitlines():
        line = raw_line.rstrip("\n")
        if len(line) < 4:
            continue
        path_text = line[3:].strip()
        if not path_text:
            continue
        if " -> " in path_text:
            path_text = path_text.split(" -> ", maxsplit=1)[1]
        normalized = _normalize_repo_path(path_text)
        if not normalized or normalized in seen:
            continue
        candidate = ROOT / normalized
        if candidate.is_dir():
            for child in candidate.rglob("*"):
                if not child.is_file():
                    continue
                child_normalized = _normalize_repo_path(child.relative_to(ROOT))
                if not child_normalized or child_normalized in seen:
                    continue
                changed.append(child_normalized)
                seen.add(child_normalized)
            continue
        changed.append(normalized)
        seen.add(normalized)
    return changed


def _collect_git_changed_files(base_ref: str | None, head_ref: str | None) -> tuple[list[str], str | None]:
    if not (ROOT / ".git").exists():
        return [], f"no .git metadata under {_normalize_repo_path(str(ROOT))}"

    return_code, stdout, stderr = _run_git_command(["rev-parse", "--is-inside-work-tree"])
    if return_code != 0 or stdout.strip().lower() != "true":
        detail = stderr.strip() or stdout.strip() or "not a git work tree"
        return [], f"git repository check failed: {detail}"

    if base_ref or head_ref:
        base = (base_ref or "HEAD~1").strip() or "HEAD~1"
        head = (head_ref or "HEAD").strip() or "HEAD"
        return_code, stdout, stderr = _run_git_command(
            ["diff", "--name-only", "--diff-filter=ACDMR", f"{base}...{head}"]
        )
        if return_code != 0:
            detail = stderr.strip() or stdout.strip() or "git diff failed"
            return [], f"git diff failed for range {base}...{head}: {detail}"
        return _parse_changed_paths(stdout), None

    merge_base_changed: list[str] = []
    merge_base_errors: list[str] = []
    merge_base_diff_succeeded = False
    for merge_base_ref in DEFAULT_MERGE_BASE_REFS:
        merge_base_code, merge_base_stdout, merge_base_stderr = _run_git_command(
            ["merge-base", merge_base_ref, "HEAD"]
        )
        if merge_base_code != 0 or not merge_base_stdout.strip():
            detail = merge_base_stderr.strip() or merge_base_stdout.strip() or "git merge-base failed"
            merge_base_errors.append(
                f"git merge-base failed for {merge_base_ref} and HEAD: {detail}"
            )
            continue

        merge_base_commit = merge_base_stdout.strip()
        diff_code, diff_stdout, diff_stderr = _run_git_command(
            ["diff", "--name-only", "--diff-filter=ACDMR", f"{merge_base_commit}...HEAD"]
        )
        if diff_code == 0:
            merge_base_changed = _parse_changed_paths(diff_stdout)
            merge_base_errors = []
            merge_base_diff_succeeded = True
            break
        detail = diff_stderr.strip() or diff_stdout.strip() or "git diff failed"
        merge_base_errors.append(
            f"git diff from merge-base {merge_base_commit}...HEAD failed: {detail}"
        )
    merge_base_error = "; ".join(merge_base_errors) or None

    status_code, status_stdout, status_stderr = _run_git_command(
        ["status", "--porcelain", "--untracked-files=normal"]
    )
    if status_code != 0:
        if merge_base_changed:
            return merge_base_changed, None
        detail = status_stderr.strip() or status_stdout.strip() or "git status failed"
        if merge_base_error is not None:
            return [], f"{merge_base_error}; git status failed: {detail}"
        return [], f"git status failed: {detail}"

    status_changed = _parse_status_paths(status_stdout)
    if merge_base_changed:
        combined: list[str] = []
        seen: set[str] = set()
        for item in [*merge_base_changed, *status_changed]:
            if item and item not in seen:
                combined.append(item)
                seen.add(item)
        return combined, None
    if not merge_base_diff_succeeded and merge_base_error is not None:
        return status_changed, merge_base_error
    return status_changed, None


def _path_matches_target(changed_path: str, target: str) -> bool:
    if target.endswith("/"):
        return changed_path.startswith(target)
    return changed_path == target


def _collect_changed_files(args: argparse.Namespace) -> tuple[str, list[str], str | None]:
    explicit = [_normalize_repo_path(path) for path in args.changed_file if _normalize_repo_path(path)]
    if explicit:
        deduped: list[str] = []
        seen: set[str] = set()
        for item in explicit:
            if item in seen:
                continue
            deduped.append(item)
            seen.add(item)
        return "explicit", deduped, None

    env_changed = _parse_changed_paths(os.environ.get(CHANGED_FILES_ENV, ""))
    if env_changed:
        return "env", env_changed, None

    changed, fallback_reason = _collect_git_changed_files(args.base_ref, args.head_ref)
    return "git", changed, fallback_reason


def _validate_freshness(
    domains: Sequence[DomainDocument],
    changed_files: Sequence[str],
) -> list[str]:
    violations: list[str] = []
    changed_set = set(changed_files)
    for domain in domains:
        if domain.domain in FRESHNESS_EXEMPT_DOMAINS:
            continue
        matched_files = [
            path
            for path in changed_files
            if any(_path_matches_target(path, target) for target in domain.tracked_paths)
        ]
        if matched_files and domain.manifest_path not in changed_set:
            joined_matches = ", ".join(matched_files[:3])
            violations.append(
                f"{domain.domain} domain changed ({joined_matches}) but {domain.manifest_path} was not updated"
            )
    return violations


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--changed-file", action="append", default=[], help="Explicit changed repo-relative path")
    parser.add_argument("--base-ref", default=None, help="Optional git base ref for diff collection")
    parser.add_argument("--head-ref", default=None, help="Optional git head ref for diff collection")
    return parser


def _is_distribution_package() -> bool:
    """The public source export drops the workspace-manifest contract by design
    (WORKSPACE_MANIFEST.md and docs/manifests/** are source-repo process docs).
    The exporter stamps `"distribution": true` into the staged package.json;
    treat that as authoritative so run_all stays green on a distribution clone."""
    try:
        import json

        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return package.get("distribution") is True


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)

    if _is_distribution_package():
        print("SKIP: workspace manifest contract (distribution package; source-repo-only gate)")
        return 0

    root_doc, root_errors = _load_manifest(ROOT_MANIFEST)
    if root_doc is None:
        print("FAIL: workspace manifest contract")
        for error in root_errors:
            print(f"  - {error}")
        return 1

    violations, _root_domains = _validate_root_manifest(root_doc)
    domain_documents: list[DomainDocument] = []
    warnings: list[str] = []
    for domain_key, manifest_path in REQUIRED_DOMAIN_MANIFESTS.items():
        domain_doc, domain_errors, domain_warnings = _validate_domain_manifest(domain_key, manifest_path)
        warnings.extend(domain_warnings)
        if domain_errors:
            violations.extend(domain_errors)
            continue
        if domain_doc is not None:
            domain_documents.append(domain_doc)

    def _print_warnings() -> None:
        for warning in warnings:
            print(f"WARN: {warning} (stale reference; pruned at the next on-request refresh)")

    if violations:
        print("FAIL: workspace manifest contract")
        for violation in violations:
            print(f"  - {violation}")
        _print_warnings()
        return 1

    source, changed_files, fallback_reason = _collect_changed_files(args)
    if fallback_reason is not None:
        print("PASS: workspace manifest contract")
        _print_warnings()
        print(
            "WARN: workspace manifest freshness not enforced: "
            f"{fallback_reason}; provide --changed-file or {CHANGED_FILES_ENV} "
            "to validate touched domains in exported/no-git workspaces"
        )
        return 0

    freshness_violations = _validate_freshness(domain_documents, changed_files)
    if freshness_violations:
        print("FAIL: workspace manifest freshness")
        for violation in freshness_violations:
            print(f"  - {violation}")
        _print_warnings()
        return 1

    print("PASS: workspace manifest contract")
    _print_warnings()
    if changed_files:
        print(
            "INFO: workspace manifest freshness validated "
            f"for {len(changed_files)} changed file(s) from {source}"
        )
    else:
        print(f"INFO: workspace manifest freshness found no changed files from {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
