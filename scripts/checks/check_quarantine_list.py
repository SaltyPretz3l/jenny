"""Fail if tests/.quarantine.json has an invalid, expired, or dangling entry.

The safe runner (scripts/run-node-tests-safe.js) retries a quarantined test
file up to `retries` extra times before declaring it failed, so a genuinely
flaky file can pass on a re-run while the run stays green. Quarantine is debt,
not a silent skip: every entry must name a real test file, a reason, a tracking
ticket, and an expiry date, and this gate hard-fails the build when any of
those is missing, malformed, expired, or points at a file that no longer
exists -- so a quarantine entry can never quietly outlive the flake it covered.

tests/.quarantine.json maps a repo-relative test path to
  {"retries": <int 1..5>, "reason": <str>, "ticket": <str>, "expires_on": "YYYY-MM-DD"}.
An empty object (the default) is clean. Pure stdlib; runs on the blocking
check:policy step. Exit 0 = clean, exit 1 = an invalid/expired/dangling entry.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUARANTINE_REL = "tests/.quarantine.json"
REQUIRED_FIELDS = ("retries", "reason", "ticket", "expires_on")
MAX_RETRIES = 5
TEST_FILE_SUFFIXES = (".test.js", ".test.cjs", ".test.mjs")


def _quarantine_path() -> Path:
    return ROOT / "tests" / ".quarantine.json"


def load_quarantine(path: Path) -> tuple[dict | None, str | None]:
    """Return (entries, error). A missing or empty file is clean ({}, None)."""
    if not path.exists():
        return {}, None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        return None, f"could not read {QUARANTINE_REL}: {error}"
    if not raw.strip():
        return {}, None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        return None, f"{QUARANTINE_REL} is not valid JSON: {error}"
    if not isinstance(data, dict):
        return None, f"{QUARANTINE_REL} must be a JSON object mapping test path -> entry"
    return data, None


def _target_violation(rel_path: object, root: Path) -> str | None:
    normalized = str(rel_path).replace("\\", "/")
    parts = normalized.split("/")
    invalid_path = f"{rel_path}: quarantine key must be a repository-relative tests/ path"
    try:
        candidate = Path(normalized)
        resolved_root = root.resolve()
        resolved_target = (root / candidate).resolve()
        resolved_target.relative_to(resolved_root)
    except (OSError, ValueError):
        return invalid_path
    if (
        candidate.is_absolute()
        or any(part in {"", ".", ".."} for part in parts)
        or not normalized.startswith("tests/")
    ):
        return invalid_path
    if not normalized.endswith(TEST_FILE_SUFFIXES):
        return f"{rel_path}: quarantine key must be a *.test.js path"
    if not resolved_target.is_file():
        return f"{rel_path}: quarantine targets a file that does not exist"
    return None


def find_violations(entries: dict, root: Path, today: date) -> list[str]:
    violations: list[str] = []
    for rel_path, entry in entries.items():
        if not isinstance(entry, dict):
            violations.append(f"{rel_path}: quarantine entry must be a JSON object")
            continue

        missing = [field for field in REQUIRED_FIELDS if field not in entry]
        if missing:
            violations.append(f"{rel_path}: quarantine entry missing field(s): {', '.join(missing)}")

        retries = entry.get("retries")
        # bool is an int subclass; reject it so `true` cannot pose as a count.
        if not isinstance(retries, int) or isinstance(retries, bool) or retries < 1:
            violations.append(f"{rel_path}: 'retries' must be an integer >= 1")
        elif retries > MAX_RETRIES:
            violations.append(f"{rel_path}: 'retries' {retries} exceeds the cap of {MAX_RETRIES}")

        for field in ("reason", "ticket"):
            if field in entry:
                value = entry.get(field)
                if not isinstance(value, str) or not value.strip():
                    violations.append(f"{rel_path}: '{field}' must be a non-empty string")

        if "expires_on" in entry:
            expires_raw = entry.get("expires_on")
            try:
                expires = date.fromisoformat(str(expires_raw).strip())
            except ValueError:
                violations.append(
                    f"{rel_path}: 'expires_on' is not an ISO date (YYYY-MM-DD): {expires_raw!r}"
                )
            else:
                if expires < today:
                    violations.append(
                        f"{rel_path}: quarantine expired on {expires_raw} -- fix the flake or renew the entry"
                    )

        # The keyed path must be a real test file: a dangling entry means the
        # flake's file was renamed/deleted and the quarantine is now a no-op.
        target_violation = _target_violation(rel_path, root)
        if target_violation is not None:
            violations.append(target_violation)
    return violations


def main() -> int:
    today = date.today()
    entries, load_error = load_quarantine(_quarantine_path())
    if load_error is not None:
        print("FAIL: test quarantine list invalid")
        print(f"  - {load_error}")
        return 1

    violations = find_violations(entries, ROOT, today)
    if violations:
        print("FAIL: test quarantine list invalid or stale")
        for item in violations:
            print(f"  - {item}")
        print(
            "Every tests/.quarantine.json entry needs retries(1..5)/reason/ticket/expires_on and "
            "must target an existing *.test.js file; fix the flake and remove the entry rather "
            "than letting it expire."
        )
        return 1

    print(f"PASS: test quarantine list clean ({len(entries)} quarantined file(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
