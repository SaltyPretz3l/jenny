"""Fail if a JS test() block's ONLY assertions are vacuous (non-correctness) oracles.

A "vacuous oracle" proves a code path does not crash but never checks WHAT it
produced. The two patterns this gate catches:

  - a `test()`/`it()` block whose sole assertion is `assert.doesNotThrow(...)`
    (or `assert.doesNotReject(...)`), and
  - a block whose only assertions are bare truthiness checks --
    `assert.ok(value)` / `assert(value)` where the argument is a plain
    identifier or member-access chain with no comparison, call, index, or
    negation (e.g. `assert.ok(result)`).

A block VIOLATES only when it has >=1 assertion and EVERY assertion is weak.
Any single strong assertion (deepEqual, equal, match, throws, a predicate
inside ok(), ...) clears the block. The detector is deliberately biased toward
STRONG classification: a false negative (missing a weak test) is caught later
by the de-vacuuming worklist + scoped mutation audit, whereas a false positive
(flagging a real test) would red-lock the gate. The allowlist below is the
escape hatch for the residue and is strictly shrinking + date-expiring, modeled
on check_file_size.LEGACY_SIZE_ALLOWLIST and
check_no_raw_html_primitives.LEGACY_RAW_PRIMITIVE_ALLOWLIST:
  - expired entries fail
  - an entry whose file now has FEWER weak-only blocks than its count fails
    ("ratchet down"), and an entry whose file has zero / is gone fails ("remove")

String- and comment-safe: the scan runs on a skeleton (comments removed,
string/template literals blanked) produced by the same technique as
scripts/checks/check_test_coverage_map._js_skeleton, so an `assert.ok` written
inside a string or comment creates no finding. Regex literals are not lexed; a
regex that confuses the skeleton only desynchronizes that one block's brace/paren
matching, which makes the block skipped (a safe false-negative), never a crash.

Runs in the blocking check:policy step (pure stdlib). Exit 0 = clean, exit 1 =
a new weak-only block or an invalid/stale allowlist entry.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TESTS_DIR = ROOT / "tests"
TEST_FILE_RE = re.compile(r"\.test\.(c|m)?js$")
SKIP_DIR_NAMES = {
    ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", "__pycache__",
    "node_modules", "dist", "build", "out", "coverage",
}
ALLOWLIST_PLAN_DOC = "docs/plans/TEST_COVERAGE_RATCHET.md"

# test()/it() block openers. describe()/before()/after() and t.test() subtests
# are intentionally NOT judged: the leading (?<![\w$.]) drops `t.test(` so a
# parent block subsumes its subtests (a strong subtest assertion clears it).
_BLOCK_OPENER_RE = re.compile(r"(?<![\w$.])(?:test|it)\s*\(")
# assert.<method>(  and bare assert(  (node:assert/strict). t.assert.* is unused
# in this repo (verified), so it is intentionally not matched.
_ASSERT_METHOD_RE = re.compile(r"(?<![\w$.])assert\.([A-Za-z_]+)\s*\(")
_ASSERT_BARE_RE = re.compile(r"(?<![\w$.])assert\s*\(")

# Methods that on their own only prove "did not throw" -> always weak.
_WEAK_METHODS = {"doesNotThrow", "doesNotReject"}
# ok() / bare assert(): weak unless the argument carries a real predicate.
_TRUTHY_METHODS = {"ok"}
# A bare reference: identifier or dotted member chain (optional leading await),
# nothing else -- no call, comparison, index, negation, logical/ternary op.
_BARE_REF_RE = re.compile(r"^(?:await\s+)?[\w$]+(?:\.[\w$]+)*$")


@dataclass(frozen=True)
class VacuousOracleException:
    label: str
    reason: str
    expires_on: str
    count: int  # weak-only blocks tolerated in this file (shrink-only debt)


# The allowlist is intentionally empty; any future exception must be date-expiring and shrink-only.
VACUOUS_ORACLE_ALLOWLIST: dict[str, VacuousOracleException] = {}


# ---------------------------------------------------------------------------
# String/comment-safe skeleton (adapted from check_test_coverage_map._js_skeleton)
# ---------------------------------------------------------------------------

def _js_skeleton(text: str) -> str:
    """Comments removed; each string/template literal collapsed to a single
    ``\\x00`` sentinel. A char-by-char scan that consumes whole literals
    (handling escapes) and whole comments, so a comment delimiter inside a
    string and an assert inside a comment are both handled. A sentinel never
    matches _BARE_REF_RE, so a string argument classifies as strong."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and nxt == "*":
            i += 2
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                i += 1
            i += 2
            out.append(" ")
            continue
        if c in ("'", '"', "`"):
            quote = c
            i += 1
            while i < n:
                ch = text[i]
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    i += 1
                    break
                i += 1
            out.append("\x00")
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _match_paren(s: str, open_idx: int) -> int:
    """Return the index of the ')' matching the '(' at ``open_idx``, or -1 if
    unbalanced (e.g. a regex literal desynchronized the skeleton)."""
    depth = 0
    for i in range(open_idx, len(s)):
        c = s[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _first_arg(arg: str) -> str:
    """First top-level argument of a (already paren-stripped) argument list."""
    depth = 0
    for i, c in enumerate(arg):
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            return arg[:i].strip()
    return arg.strip()


def _iter_test_blocks(skeleton: str) -> list[tuple[int, int]]:
    """Spans [open_paren, close_paren] of OUTERMOST test()/it() argument lists."""
    spans: list[tuple[int, int]] = []
    last_end = -1
    for match in _BLOCK_OPENER_RE.finditer(skeleton):
        if match.start() < last_end:
            continue  # nested inside an already-captured outer block
        open_paren = match.end() - 1  # the '(' after test/it
        close = _match_paren(skeleton, open_paren)
        if close == -1:
            continue
        spans.append((open_paren, close))
        last_end = close
    return spans


def _arg_is_weak_truthy(block: str, open_paren: int) -> bool:
    """True if the first argument of an ok()/bare-assert call is a bare ref."""
    close = _match_paren(block, open_paren)
    if close == -1:
        return False  # malformed -> treat as strong (never flag)
    arg = _first_arg(block[open_paren + 1:close])
    return bool(arg) and bool(_BARE_REF_RE.match(arg))


def _block_is_weak_only(block: str) -> bool:
    assertions = 0
    weak = 0
    for match in _ASSERT_METHOD_RE.finditer(block):
        method = match.group(1)
        assertions += 1
        if method in _WEAK_METHODS:
            weak += 1
        elif method in _TRUTHY_METHODS and _arg_is_weak_truthy(block, match.end() - 1):
            weak += 1
    for match in _ASSERT_BARE_RE.finditer(block):
        assertions += 1
        if _arg_is_weak_truthy(block, match.end() - 1):
            weak += 1
    return assertions > 0 and weak == assertions


# ---------------------------------------------------------------------------
# Scan + allowlist enforcement
# ---------------------------------------------------------------------------

def _iter_test_files():
    if not TESTS_DIR.exists():
        return
    for path in TESTS_DIR.rglob("*"):
        if any(part in SKIP_DIR_NAMES for part in path.parts):
            continue
        if path.is_file() and TEST_FILE_RE.search(path.name):
            yield path


def _count_weak_only_blocks(path: Path) -> int:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    if "assert" not in text:
        return 0
    skeleton = _js_skeleton(text)
    return sum(
        1 for start, end in _iter_test_blocks(skeleton)
        if _block_is_weak_only(skeleton[start:end + 1])
    )


def scan_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for path in _iter_test_files():
        n = _count_weak_only_blocks(path)
        if n:
            counts[path.relative_to(ROOT).as_posix()] = n
    return counts


def _validate_allowlist(today: date) -> list[str]:
    errors: list[str] = []
    seen_labels: set[str] = set()
    for rel, entry in VACUOUS_ORACLE_ALLOWLIST.items():
        tag = (entry.label or "").strip() or rel
        if not (entry.label or "").strip():
            errors.append(f"{rel}: exception must define a non-empty label")
        elif entry.label in seen_labels:
            errors.append(f"{rel}: duplicate exception label '{entry.label}'")
        else:
            seen_labels.add(entry.label)
        if not (entry.reason or "").strip():
            errors.append(f"{rel}: exception '{tag}' is missing a reason")
        if entry.count < 1:
            errors.append(f"{rel}: exception '{tag}' must allow >=1 (remove the entry instead)")
        try:
            expires = date.fromisoformat(str(entry.expires_on).strip())
        except ValueError:
            errors.append(f"{rel}: exception '{tag}' has invalid expires_on: {entry.expires_on!r}")
            continue
        if expires < today:
            errors.append(f"{rel}: exception '{tag}' expired on {entry.expires_on}")
    return errors


def find_violations(counts: dict[str, int]) -> tuple[list[str], list[str], list[str]]:
    """Return (violations, stale, warnings)."""
    violations: list[str] = []
    stale: list[str] = []
    warnings: list[str] = []
    allowed = {rel.replace("\\", "/"): entry for rel, entry in VACUOUS_ORACLE_ALLOWLIST.items()}

    for rel, n in sorted(counts.items()):
        entry = allowed.get(rel)
        cap = entry.count if entry else 0
        if n > cap:
            suffix = f" (allowed {cap})" if entry else ""
            violations.append(f"{rel}: {n} weak-only test block(s){suffix} -- {n - cap} over the limit")
        elif entry and n < entry.count:
            stale.append(
                f"{rel}: allowlist permits {entry.count} weak-only block(s) but only {n} remain "
                f"-- lower the count to {n}"
            )
        elif entry:
            warnings.append(f"{rel}: {n} weak-only block(s) allowed until {entry.expires_on} -- {entry.reason}")

    for rel, entry in allowed.items():
        if rel not in counts:
            stale.append(
                f"{rel}: remove vacuous-oracle exception '{entry.label}' -- the file has no "
                f"weak-only blocks (or was not scanned)"
            )
    return violations, stale, warnings


def main() -> int:
    today = date.today()
    counts = scan_counts()
    allowlist_errors = _validate_allowlist(today)
    violations, stale, warnings = find_violations(counts)

    failed = False
    if violations:
        failed = True
        print("FAIL: test blocks whose only assertions are vacuous (doesNotThrow / bare truthiness)")
        for item in violations:
            print(f"  - {item}")
        print(
            "Strengthen the oracle (assert the return value / state / thrown error), or add a "
            f"temporary shrinking exception to VACUOUS_ORACLE_ALLOWLIST "
            f"(label + reason + expires_on + count) per {ALLOWLIST_PLAN_DOC}."
        )
    if allowlist_errors or stale:
        failed = True
        print("FAIL: vacuous-oracle allowlist invalid or stale (the allowlist must strictly shrink)")
        for item in [*allowlist_errors, *stale]:
            print(f"  - {item}")
    if warnings:
        print("WARN: temporary vacuous-oracle exceptions")
        for item in warnings:
            print(f"  - {item}")

    if failed:
        return 1

    tolerated = sum(counts.get(rel, 0) for rel in {k.replace("\\", "/") for k in VACUOUS_ORACLE_ALLOWLIST})
    print(
        f"PASS: no new vacuous-oracle test blocks "
        f"({len(VACUOUS_ORACLE_ALLOWLIST)} file(s) on the shrinking allowlist, {tolerated} block(s) tolerated)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
