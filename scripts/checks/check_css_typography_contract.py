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
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STYLES_DIR = ROOT / "styles"

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


def main() -> int:
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

    if violations:
        print("FAIL: CSS typography contract drift detected")
        for item in violations:
            print(f"  - {item}")
        print(
            "Replace viewport-based font-size with token/breakpoint sizes "
            "that respect --chat-zoom-factor, set negative letter-spacing to 0, "
            "define every --font-* token you reference, and give every `font:` "
            "shorthand a font-family (or use the `font-size:` longhand)."
        )
        return 1

    print("PASS: CSS typography contract check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
