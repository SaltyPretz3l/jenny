"""Remove build caches and opt-in local clutter in a cross-platform way."""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOP_LEVEL_DIR_NAMES = {"build", "dist", "out"}
CACHE_DIR_NAMES = {"__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache"}
ROOT_CLUTTER_DIR_NAMES = {"%SystemDrive%"}
ROOT_CLUTTER_FILE_GLOBS = ("tmp-*.log", "repomix*.log")
LOCAL_MODEL_FILE_GLOBS = ("*.gguf",)
SKIP_SUBTREES = {
    ".git",
    ".venv",
    ".claude",
    ".jenny",
    ".tmp",
    "archive",
    "artifacts",
    "llama_server_extract",
    "node_modules",
    "repomix",
    "vendor",
}


def _repo_relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _assert_safe_target(path: Path) -> None:
    resolved_root = ROOT.resolve()
    resolved_path = path.resolve()
    if resolved_path == resolved_root or resolved_root not in resolved_path.parents:
        raise RuntimeError(f"refusing cleanup target outside workspace: {path}")


def _is_under_skipped_subtree(path: Path) -> bool:
    return any(part in SKIP_SUBTREES for part in path.relative_to(ROOT).parts)


def _cleanup_targets(*, include_root_clutter: bool = False, include_local_models: bool = False) -> list[Path]:
    targets = [ROOT / name for name in TOP_LEVEL_DIR_NAMES if (ROOT / name).is_dir()]
    for path in ROOT.rglob("*"):
        if not path.is_dir() or path.name not in CACHE_DIR_NAMES:
            continue
        if _is_under_skipped_subtree(path):
            continue
        targets.append(path)

    if include_root_clutter:
        targets.extend(ROOT / name for name in ROOT_CLUTTER_DIR_NAMES if (ROOT / name).is_dir())
        for pattern in ROOT_CLUTTER_FILE_GLOBS:
            targets.extend(path for path in ROOT.glob(pattern) if path.is_file())

    if include_local_models:
        for pattern in LOCAL_MODEL_FILE_GLOBS:
            targets.extend(path for path in ROOT.glob(pattern) if path.is_file())

    for path in targets:
        _assert_safe_target(path)
    return sorted(set(targets), key=lambda candidate: len(candidate.parts), reverse=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print cleanup targets without removing them",
    )
    parser.add_argument(
        "--include-root-clutter",
        action="store_true",
        help="include ignored top-level clutter such as %SystemDrive%, tmp-*.log, and repomix*.log",
    )
    parser.add_argument(
        "--include-local-models",
        action="store_true",
        help="include top-level local model files such as *.gguf",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args([] if argv is None else argv)
    targets = _cleanup_targets(
        include_root_clutter=args.include_root_clutter,
        include_local_models=args.include_local_models,
    )

    if args.dry_run:
        print(f"PASS: clean dry-run ({len(targets)} targets)")
        for path in targets:
            print(f"  - {_repo_relative(path)}")
        return 0

    removed = 0
    failures = 0
    for path in targets:
        try:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.is_file():
                path.unlink(missing_ok=True)
        except OSError as error:
            failures += 1
            print(f"FAIL: could not remove {_repo_relative(path)}: {error}")
            continue
        if path.exists():
            failures += 1
            print(f"FAIL: cleanup target remains: {_repo_relative(path)}")
        else:
            removed += 1
    if failures:
        print(f"FAIL: clean incomplete ({removed} targets removed, {failures} failed)")
        return 1
    print(f"PASS: clean complete ({removed} targets removed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
