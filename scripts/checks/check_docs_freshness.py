"""Validate the initial Phase 1 documentation freshness contract."""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAX_REVIEW_AGE_DAYS = 365
REQUIRED_DOCS = (
    "AGENTS.md",
    "docs/process/TESTING_STRATEGY.md",
    "docs/process/MODEL_RELEASE_TUNEUP.md",
    "docs/process/DOC_AS_CODE.md",
    "docs/process/WORKSPACE_MANIFEST_SYSTEM.md",
)


def _extract_last_reviewed(text: str) -> str | None:
    if not text.startswith("---\n"):
        return None
    end_index = text.find("\n---", 4)
    if end_index == -1:
        return None
    frontmatter = text[4:end_index]
    match = re.search(
        r"^last_reviewed:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$",
        frontmatter,
        re.MULTILINE,
    )
    if not match:
        return None
    return match.group(1)


def validate_docs_freshness(root: Path = ROOT, *, today: date | None = None) -> list[str]:
    review_date = today or date.today()
    violations: list[str] = []
    for relative_path in REQUIRED_DOCS:
        path = root / relative_path
        if not path.is_file():
            violations.append(f"{relative_path} is missing")
            continue
        last_reviewed_text = _extract_last_reviewed(path.read_text(encoding="utf-8"))
        if last_reviewed_text is None:
            violations.append(f"{relative_path} missing last_reviewed frontmatter")
            continue
        try:
            last_reviewed = date.fromisoformat(last_reviewed_text)
        except ValueError:
            violations.append(f"{relative_path} has invalid last_reviewed date")
            continue
        age_days = (review_date - last_reviewed).days
        if age_days > MAX_REVIEW_AGE_DAYS:
            violations.append(
                f"{relative_path} last_reviewed {last_reviewed_text} is older than "
                f"{MAX_REVIEW_AGE_DAYS} days"
            )
    return violations


def _is_distribution_package(root: Path = ROOT) -> bool:
    """The public source export drops AGENTS.md (a source-repo process doc) by
    design and stamps `"distribution": true` into the staged package.json (see
    scripts/packaging/create_github_stage.py). The freshness contract is a
    source-repo process gate, so it is skipped wholesale on a distribution clone."""
    try:
        import json

        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(package, dict) and package.get("distribution") is True


def main() -> int:
    if _is_distribution_package():
        print("SKIP: docs freshness check (distribution package; source-repo-only gate)")
        return 0
    violations = validate_docs_freshness(ROOT)
    if violations:
        print("FAIL: docs freshness check failed")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    print("PASS: docs freshness check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
