"""Fail if source files contain UTF-8 BOM bytes."""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIRS = (
    "sidecar",
    "renderer",
    "services",
    "scripts",
    "tests",
    "styles",
    "docs",
    "comet",
    "plugins",
    "content",
)
ROOT_SOURCE_FILES = ("main.js", "preload.js", "start.js")
# Vendored upstream source has its own LICENSE; its provenance-relevant bytes stay intact.
SKIP_RELATIVE_PREFIXES = {
    "plugins/official/local-image-generation/runtime/upstream",
}
SOURCE_SUFFIXES = {
    ".cjs",
    ".js",
    ".mjs",
    ".py",
    ".ts",
    ".tsx",
    ".css",
    ".json",
    ".toml",
    ".md",
    ".txt",
}
UTF8_BOM = b"\xef\xbb\xbf"


def has_utf8_bom(path: Path) -> bool:
    try:
        return path.read_bytes().startswith(UTF8_BOM)
    except OSError:
        return False


def _git_visible_paths() -> list[Path] | None:
    """Return tracked and non-ignored untracked paths, or None without git."""
    try:
        completed = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="surrogateescape",
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None

    root = ROOT.resolve()
    paths: list[Path] = []
    for relative_path in completed.stdout.split("\0"):
        if not relative_path:
            continue
        candidate = (ROOT / relative_path).resolve(strict=False)
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        paths.append(candidate)
    return paths


def main() -> int:
    violations: list[str] = []
    source_files = _git_visible_paths()
    if source_files is None:
        source_files = [ROOT / file_name for file_name in ROOT_SOURCE_FILES]
        for source_dir in SOURCE_DIRS:
            root = ROOT / source_dir
            if not root.exists():
                continue
            source_files.extend(root.rglob("*"))

    for path in source_files:
        if not path.is_file():
            continue
        relative_path = path.relative_to(ROOT).as_posix()
        if not (
            relative_path in ROOT_SOURCE_FILES
            or relative_path.split("/", 1)[0] in SOURCE_DIRS
        ):
            continue
        if any(
            relative_path == prefix or relative_path.startswith(f"{prefix}/")
            for prefix in SKIP_RELATIVE_PREFIXES
        ):
            continue
        if path.suffix not in SOURCE_SUFFIXES:
            continue
        if has_utf8_bom(path):
            violations.append(str(path.relative_to(ROOT)))

    if violations:
        print("FAIL: UTF-8 BOM detected")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: no UTF-8 BOM detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
