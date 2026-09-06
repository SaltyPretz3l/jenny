"""Validate local Markdown links without checking external URLs."""
from __future__ import annotations

import json
import re
from fnmatch import fnmatch
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[2]
STAGE_MANIFEST_PATH = ROOT / "scripts" / "packaging" / "github_stage_manifest.json"
REPO_ABSOLUTE_PREFIX = f"{ROOT.as_posix().rstrip('/')}/"
LINK_RE = re.compile(r"!?\[[^\]]*]\(([^)\n]+)\)")
EXCLUDE_GLOBS = (
    ".git/**",
    ".jenny/**",
    ".mypy_cache/**",
    ".pytest_cache/**",
    ".ruff_cache/**",
    ".tmp/**",
    "archive/**",
    "artifacts/**",
    "build/**",
    "dist/**",
    "docs/archive/**",
    "docs/plans/**",
    "docs/reports/**",
    "docs/ui/**",
    "node_modules/**",
    "repomix/**",
    "vendor/**",
)
EXTERNAL_SCHEMES = {"http", "https", "mailto", "app"}


def _repo_path(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _is_excluded(relative_path: str) -> bool:
    return any(fnmatch(relative_path, pattern) for pattern in EXCLUDE_GLOBS)


def _normalized_patterns(values: object) -> tuple[str, ...]:
    if not isinstance(values, list):
        return ()
    return tuple(str(value).replace("\\", "/") for value in values)


def _matches_any(relative_path: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch(relative_path, pattern) for pattern in patterns)


def _is_stage_markdown(candidate: Path, relative_path: str, exclude_globs: tuple[str, ...]) -> bool:
    return (
        candidate.is_file()
        and candidate.suffix.lower() == ".md"
        and not _is_excluded(relative_path)
        and not _matches_any(relative_path, exclude_globs)
    )


def _stage_markdown_files(root: Path) -> list[Path] | None:
    manifest_path = root / STAGE_MANIFEST_PATH.relative_to(ROOT)
    if not manifest_path.is_file():
        return None
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    include_paths = _normalized_patterns(payload.get("include_paths", []))
    include_globs = _normalized_patterns(payload.get("include_globs", []))
    exclude_globs = _normalized_patterns(payload.get("exclude_globs", []))

    markdown_files: set[Path] = set()
    for relative_path in include_paths:
        candidate = root / relative_path
        if _is_stage_markdown(candidate, relative_path, exclude_globs):
            markdown_files.add(candidate)
    for pattern in include_globs:
        for candidate in root.glob(pattern):
            relative_path = _repo_path(candidate, root)
            if not _is_stage_markdown(candidate, relative_path, exclude_globs):
                continue
            markdown_files.add(candidate)
    return sorted(markdown_files)


def _iter_markdown_files(root: Path) -> list[Path]:
    stage_files = _stage_markdown_files(root)
    if stage_files is not None:
        return stage_files
    files: list[Path] = []
    for candidate in root.rglob("*.md"):
        relative_path = _repo_path(candidate, root)
        if not _is_excluded(relative_path):
            files.append(candidate)
    return sorted(files)


def _strip_optional_title(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        return target[1 : target.index(">")].strip()
    return target.split()[0].strip()


def _strip_fragment_and_line_suffix(target: str) -> str:
    without_fragment = target.split("#", 1)[0]
    return re.sub(r":\d+(?:-\d+)?$", "", without_fragment)


def _target_to_paths(source_file: Path, raw_target: str, root: Path) -> list[Path]:
    target = unquote(_strip_optional_title(raw_target))
    target_paths: list[Path] = []
    if not target or target.startswith("#"):
        return target_paths

    parsed = urlparse(target)
    if parsed.scheme in EXTERNAL_SCHEMES:
        return target_paths

    if parsed.scheme == "file":
        path_target = unquote(parsed.path).lstrip("/")
        if path_target.lower().startswith(REPO_ABSOLUTE_PREFIX.lower()):
            relative_target = path_target[len(REPO_ABSOLUTE_PREFIX) :]
            target_paths.append(root / _strip_fragment_and_line_suffix(relative_target))
        return target_paths

    is_windows_absolute = bool(re.match(r"^[A-Za-z]:/", target))
    if is_windows_absolute:
        if target.lower().startswith(REPO_ABSOLUTE_PREFIX.lower()):
            relative_target = target[len(REPO_ABSOLUTE_PREFIX) :]
            target_paths.append(root / _strip_fragment_and_line_suffix(relative_target))
        return target_paths

    if parsed.scheme:
        return target_paths

    path_target = _strip_fragment_and_line_suffix(target)
    if path_target:
        if path_target.startswith("/"):
            target_paths.append(root / path_target.lstrip("/"))
        else:
            relative_candidate = (source_file.parent / path_target).resolve()
            root_candidate = (root / path_target).resolve()
            target_paths.append(relative_candidate)
            if relative_candidate != root_candidate:
                target_paths.append(root_candidate)

    return target_paths


def validate_markdown_links(root: Path = ROOT) -> list[str]:
    violations: list[str] = []
    root_resolved = root.resolve()
    for markdown_file in _iter_markdown_files(root_resolved):
        relative_source = _repo_path(markdown_file, root_resolved)
        try:
            text = markdown_file.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            violations.append(f"{relative_source}: unable to decode as UTF-8: {exc}")
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            for match in LINK_RE.finditer(line):
                raw_target = match.group(1)
                target_paths = _target_to_paths(markdown_file, raw_target, root_resolved)
                if not target_paths:
                    continue
                local_paths = []
                for target_path in target_paths:
                    try:
                        target_path.relative_to(root_resolved)
                    except ValueError:
                        continue
                    local_paths.append(target_path)
                if not local_paths:
                    continue
                if not any(target_path.exists() for target_path in local_paths):
                    display_target = _strip_fragment_and_line_suffix(
                        _strip_optional_title(raw_target)
                    )
                    violations.append(
                        f"{relative_source}:{line_number} broken local markdown link: "
                        f"{display_target}"
                    )
    return violations


def main() -> int:
    violations = validate_markdown_links(ROOT)
    if violations:
        print("FAIL: broken local markdown links detected")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    print("PASS: markdown link check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
