"""Fail on typography declarations that silently fall off the token system.

Four scans, three of them whole-tree with no allowlist:

1. Viewport-scaled `font-size` and negative `letter-spacing` (allowlisted).
   Jenny's chat zoom token (`--chat-zoom-factor`) and appearance tokens own
   typographic rhythm; `vw` sizing and negative tracking let responsive
   layouts drift from those tokens and make large/small viewports,
   localization, and user-zoom fitting unpredictable.

2. `var(--font-*)` references with no matching definition anywhere in
   styles/. An undefined custom property is not a parse error - the browser
   silently takes the inline fallback, or drops the declaration entirely when
   there is none. This shipped twice: `--font-mono` (12 call sites, never
   defined; the real token is `--font-family-mono`) and
   `--font-weight-semibold` (1 call site, no `--font-weight-*` family exists).

3. `font:` shorthands whose whole value is a single `var()`. `font-family` is
   MANDATORY in the shorthand grammar, so `font: var(--tl-font-ui);` is
   invalid at computed-value time and resets every font longhand to `unset`
   (= `inherit`, since they are all inherited). It reads like a font-size
   assignment and does the opposite.

4. Bare `pre`/`code` element rules that set a font-family. Nothing in styles/
   resets those elements globally; a rule that reintroduces one would make the
   per-component mono declarations ambiguous.

Scans 2-4 have no allowlist on purpose - the tree is clean as of this check
landing, so seeding one would only invite drift.

5. Literal `px`/`rem` font sizes (type-scale rebase, 2026-09-28). Every
   font-size must resolve through a role token (`--font-size-caption` ..
   `--font-size-title`) so the single Text size setting (`--font-scale`)
   reaches it. A literal is allowed only inside a value that also multiplies
   `--font-scale`, in a custom-property definition, or in a permanently
   allowlisted standalone page. Existing literals are held by a per-file
   ratchet baseline (css_typography_literal_baseline.json) that may only go
   down; run with --update-baseline after a migration lowers a count.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STYLES_DIR = ROOT / "styles"
RENDERER_DIR = ROOT / "renderer"
LITERAL_BASELINE_PATH = Path(__file__).resolve().parent / "css_typography_literal_baseline.json"

# Standalone pages outside the app's token system (scan 5 only). The hosted
# browser portal loads its own stylesheet and never receives --font-scale.
LITERAL_SIZE_ALLOWLIST: frozenset[str] = frozenset(
    {
        "renderer/browser/styles.css",
    }
)

# Files permitted to retain viewport-scaled font sizes or negative tracking
# while their typography is migrated to token-based values in a follow-up.
# See REV-20260424-RENDERER-045 and the typography migration split plan.
ALLOWLIST: frozenset[str] = frozenset(
    {
        "styles/chat-thread.css",
        "styles/views-home-artifacts.css",
        # Split out of views-home-artifacts.css (AR4 CSS decomposition); these
        # inherit the parent's pending typography-token migration exemption
        # rather than being restyled inside the split. Drop them when the
        # negative-tracking rules migrate to --chat-zoom-factor tokens.
        "styles/views-artifacts.css",
        "styles/views-home-board.css",
    }
)

FONT_SIZE_VW_RE = re.compile(r"font-size\s*:[^;]*\bvw\b", re.IGNORECASE)
# `--font-foo: <value>` - a definition. Restricted to custom properties in the
# --font-* namespace so the scan stays scoped to typography.
FONT_VAR_DEF_RE = re.compile(r"(--font-[A-Za-z0-9-]+)\s*:")
# `var(--font-foo` - a reference, with or without an inline fallback.
FONT_VAR_USE_RE = re.compile(r"var\(\s*(--font-[A-Za-z0-9-]+)")
# `font: var(--anything);` with nothing following the closing paren. Matches the
# family-less shorthand only; `font: var(--tl-font-ui)/1.4 var(--font-family-mono)`
# is well-formed and must NOT match.
FONT_SHORTHAND_VAR_ONLY_RE = re.compile(r"font\s*:\s*var\([^)]*\)\s*;", re.IGNORECASE)
# A bare `pre`/`code`/`kbd`/`samp` type selector starting a rule (not `.x pre`,
# not `pre.y`), paired with a font-family inside the block.
BARE_PRE_CODE_RULE_RE = re.compile(
    r"^[ \t]*(?:pre|code|kbd|samp)\s*(?:,\s*(?:pre|code|kbd|samp)\s*)*\{[^}]*font-family",
    re.IGNORECASE | re.MULTILINE,
)
# Matches `letter-spacing: -<number>...;` (rejects negative values of any unit).
LETTER_SPACING_NEGATIVE_RE = re.compile(
    r"letter-spacing\s*:\s*-\d",
    re.IGNORECASE,
)


# A font-size or font shorthand declaration (not a custom property: the
# lookbehind rejects `--font-size-*:` definitions and `--x-font-size:` names).
FONT_SIZE_DECL_RE = re.compile(r"(?<![-\w])(font-size|font)\s*:\s*([^;{}]+)", re.IGNORECASE)
LITERAL_SIZE_RE = re.compile(r"(?<![\w.-])\d*\.?\d+(px|rem)\b", re.IGNORECASE)
SHORTHAND_LINE_HEIGHT_RE = re.compile(r"/\s*[^\s,/]+")
CSS_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
# A role token scaled by a factor under 1 (either operand order) lands under
# the role it names, and under the 12px floor for caption, with no literal px
# for the ratchet to count.
SHRUNK_ROLE_TOKEN_RE = re.compile(
    r"var\(\s*--font-size-[A-Za-z0-9-]+\s*\)\s*\*\s*0*\.\d+"
    r"|(?<![\d.])0*\.\d+\s*\*\s*var\(\s*--font-size-[A-Za-z0-9-]+\s*\)",
    re.IGNORECASE,
)
# The same shrink through indirection: a role token divided by a factor over
# one, or multiplied by a custom property that is not the app's own
# --font-scale (its value is unknown to the gate, so it is treated as a shrink).
ROLE_TOKEN_DIVIDED_RE = re.compile(
    r"var\(\s*--font-size-[A-Za-z0-9-]+\s*\)\s*/\s*(\d*\.?\d+)", re.IGNORECASE
)
ROLE_TOKEN_TIMES_VAR_RE = re.compile(
    r"var\(\s*--font-size-[A-Za-z0-9-]+\s*\)\s*\*\s*var\(\s*(--[A-Za-z0-9-]+)"
    r"|var\(\s*(--[A-Za-z0-9-]+)\s*\)\s*\*\s*var\(\s*--font-size-[A-Za-z0-9-]+\s*\)",
    re.IGNORECASE,
)
# A custom property definition (`--x: ...`): a shrunk role token parked here
# reaches a font-size later as `var(--x)`, past the declaration scan.
CUSTOM_PROPERTY_DECL_RE = re.compile(r"(?<![\w-])(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+)")


# User-driven scale factors a role token may legitimately follow: the app-wide
# text size and the explode view's node zoom (a fallback of 1, never a shrink).
KNOWN_SCALE_FACTORS = {"--font-scale", "--explode-node-scale"}


def _shrinks_role_token(value: str) -> bool:
    if SHRUNK_ROLE_TOKEN_RE.search(value):
        return True
    for match in ROLE_TOKEN_DIVIDED_RE.finditer(value):
        try:
            if float(match.group(1)) > 1:
                return True
        except ValueError:
            continue
    for match in ROLE_TOKEN_TIMES_VAR_RE.finditer(value):
        factor = (match.group(1) or match.group(2) or "").lower()
        if factor and factor not in KNOWN_SCALE_FACTORS:
            return True
    return False


def _line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def _scan_file(path: Path) -> list[str]:
    """Allowlist-aware scans (viewport sizing, negative tracking)."""
    violations: list[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return violations
    relative = path.relative_to(ROOT).as_posix()
    if relative in ALLOWLIST:
        return violations
    for match in FONT_SIZE_VW_RE.finditer(text):
        violations.append(
            f"{relative}:{_line_of(text, match.start())} viewport-scaled font-size"
        )
    for match in LETTER_SPACING_NEGATIVE_RE.finditer(text):
        violations.append(
            f"{relative}:{_line_of(text, match.start())} negative letter-spacing"
        )
    return violations


def _scan_shorthands_and_elements(path: Path) -> list[str]:
    """Whole-tree scans that no file is exempt from."""
    violations: list[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return violations
    relative = path.relative_to(ROOT).as_posix()
    for match in FONT_SHORTHAND_VAR_ONLY_RE.finditer(text):
        violations.append(
            f"{relative}:{_line_of(text, match.start())} `font:` shorthand with no "
            f"font-family ({match.group(0).strip()}) - use `font-size:` instead"
        )
    for match in BARE_PRE_CODE_RULE_RE.finditer(text):
        violations.append(
            f"{relative}:{_line_of(text, match.start())} bare pre/code rule sets "
            "font-family - declare mono per component instead"
        )
    for match in FONT_SIZE_DECL_RE.finditer(text):
        value = match.group(2)
        if match.group(1).lower() == "font":
            # The shorthand's "/<line-height>" slot is not a division.
            value = SHORTHAND_LINE_HEIGHT_RE.sub(" ", value)
        if _shrinks_role_token(value):
            violations.append(
                f"{relative}:{_line_of(text, match.start())} font size scaled below its role "
                f"token ({match.group(0).strip()}) - use the smaller role token instead"
            )
    for match in CUSTOM_PROPERTY_DECL_RE.finditer(text):
        if match.group(1).lower().startswith("--font-size-"):
            continue  # the role tokens themselves are defined from --font-scale
        if _shrinks_role_token(match.group(2)):
            violations.append(
                f"{relative}:{_line_of(text, match.start())} custom property carries a role "
                f"token scaled below itself ({match.group(0).strip()}) - use the smaller role token instead"
            )
    return violations


def _collect_font_variables(paths: list[Path]) -> tuple[set[str], list[tuple[str, int, str]]]:
    """Return every --font-* definition, and every reference with its location.

    Definitions are collected across the WHOLE tree before any reference is
    judged: a token defined in foundation.css and used in ide-view.css is
    perfectly valid, so a per-file check would be wrong.
    """
    defined: set[str] = set()
    used: list[tuple[str, int, str]] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        relative = path.relative_to(ROOT).as_posix()
        defined.update(FONT_VAR_DEF_RE.findall(text))
        for match in FONT_VAR_USE_RE.finditer(text):
            used.append((match.group(1), _line_of(text, match.start()), relative))
    return defined, used


def _literal_size_sites(path: Path) -> list[int]:
    """Line numbers of font-size declarations that carry a literal px/rem."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    # Blank out comments but keep offsets so line numbers stay true.
    text = CSS_COMMENT_RE.sub(lambda match: re.sub(r"[^\n]", " ", match.group(0)), text)
    lines: list[int] = []
    for match in FONT_SIZE_DECL_RE.finditer(text):
        value = match.group(2)
        if "--font-scale" in value:
            continue
        if match.group(1).lower() == "font" and value.strip().lower() in {"inherit", "initial", "unset"}:
            continue
        if match.group(1).lower() == "font":
            # The shorthand's "/<line-height>" slot is not a font size.
            value = SHORTHAND_LINE_HEIGHT_RE.sub(" ", value)
        if LITERAL_SIZE_RE.search(value):
            lines.append(_line_of(text, match.start()))
    return lines


def _literal_scan_paths() -> list[Path]:
    paths = sorted(STYLES_DIR.rglob("*.css")) if STYLES_DIR.is_dir() else []
    if RENDERER_DIR.is_dir():
        paths += sorted(RENDERER_DIR.rglob("*.css"))
    return [path for path in paths if path.is_file()]


def collect_literal_size_counts() -> dict[str, list[int]]:
    counts: dict[str, list[int]] = {}
    for path in _literal_scan_paths():
        relative = path.relative_to(ROOT).as_posix()
        if relative in LITERAL_SIZE_ALLOWLIST:
            continue
        sites = _literal_size_sites(path)
        if sites:
            counts[relative] = sites
    return counts


def _load_literal_baseline() -> dict[str, int]:
    try:
        data = json.loads(LITERAL_BASELINE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    files = data.get("files", {}) if isinstance(data, dict) else {}
    return {str(key): int(value) for key, value in files.items()}


def write_literal_baseline(counts: dict[str, list[int]]) -> None:
    payload = {
        "_comment": (
            "Ratchet for scan 5 of check_css_typography_contract.py: literal px/rem "
            "font sizes per file. Counts may only go down; regenerate with "
            "--update-baseline after a migration lowers them."
        ),
        "files": {key: len(value) for key, value in sorted(counts.items())},
    }
    LITERAL_BASELINE_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def literal_size_violations(
    counts: dict[str, list[int]], baseline: dict[str, int]
) -> list[str]:
    violations: list[str] = []
    for relative, sites in sorted(counts.items()):
        allowed = baseline.get(relative, 0)
        if len(sites) > allowed:
            where = ", ".join(str(line) for line in sites[:12])
            violations.append(
                f"{relative}: {len(sites)} literal px/rem font size(s), ratchet allows "
                f"{allowed} (lines {where}) - use a --font-size-<role> token"
            )
    return violations


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--update-baseline" in args:
        counts = collect_literal_size_counts()
        baseline = _load_literal_baseline()
        # Only the very first seeding (no baseline file yet) skips the growth
        # check; an empty baseline is a real ratchet of zero.
        grown = literal_size_violations(counts, baseline) if LITERAL_BASELINE_PATH.exists() else []
        if grown and "--allow-growth" not in args:
            print("FAIL: refusing to raise the literal font-size ratchet")
            for item in grown:
                print(f"  - {item}")
            return 1
        write_literal_baseline(counts)
        print(f"UPDATED: {LITERAL_BASELINE_PATH.name} ({sum(len(v) for v in counts.values())} literal sites)")
        return 0
    if "--literal-report" in args:
        for relative, sites in sorted(collect_literal_size_counts().items()):
            print(f"{relative}: {len(sites)} ({', '.join(str(line) for line in sites)})")
        return 0
    if not STYLES_DIR.is_dir():
        print("PASS: CSS typography contract check (no styles/ directory)")
        return 0
    paths = [path for path in sorted(STYLES_DIR.rglob("*.css")) if path.is_file()]
    violations: list[str] = []
    for path in paths:
        violations.extend(_scan_file(path))
        violations.extend(_scan_shorthands_and_elements(path))

    defined, used = _collect_font_variables(paths)
    for name, line_no, relative in used:
        if name not in defined:
            violations.append(
                f"{relative}:{line_no} undefined custom property {name} - "
                "the reference silently takes its inline fallback"
            )

    violations.extend(literal_size_violations(collect_literal_size_counts(), _load_literal_baseline()))

    if violations:
        print("FAIL: CSS typography contract drift detected")
        for item in violations:
            print(f"  - {item}")
        print(
            "Replace viewport-based font-size with token/breakpoint sizes "
            "that respect --chat-zoom-factor, set negative letter-spacing to 0, "
            "define every --font-* token you reference, give every `font:` "
            "shorthand a font-family (or use the `font-size:` longhand), and size "
            "text with --font-size-<role> tokens rather than literal px/rem."
        )
        return 1

    print("PASS: CSS typography contract check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
