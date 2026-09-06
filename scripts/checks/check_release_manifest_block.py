"""Validate that release notes carry a SHA256 manifest block."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.release_manifest_block import validate_manifest_block  # noqa: E402

DEFAULT_RELEASE_NOTES = ROOT / "RELEASE_NOTES.md"


def validate_release_manifest_block(
    root: Path = ROOT,
    *,
    require_assets: bool = False,
) -> list[str]:
    path = root / "RELEASE_NOTES.md"
    if not path.exists():
        return ["RELEASE_NOTES.md is missing"]
    return validate_manifest_block(
        path.read_text(encoding="utf-8"),
        require_assets=require_assets,
        root=root,
        verify_assets=require_assets,
    )


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-assets",
        action="store_true",
        help="Require at least one asset row in the manifest block.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    violations = validate_release_manifest_block(ROOT, require_assets=args.require_assets)
    if violations:
        print("FAIL: release SHA256 manifest block invalid")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    print("PASS: release SHA256 manifest block")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

