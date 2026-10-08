"""Require accessible names and tooltips on icon-only renderer buttons.

Static scan of <button> markup and actionButton({...}) literals. Buttons
built with document.createElement and attributes set at runtime are not
seen; cover those in their own behavioural tests.
"""
from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST: dict[str, int] = {}
EXCLUDED_DIRS = {
    ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", "archive",
    "artifacts", "build", "dist", "node_modules", "repomix", "tests", "vendor",
}
BUTTON_RE = re.compile(
    r"<button\b(?P<attrs>(?:[^>\"']|\"[^\"]*\"|'[^']*')*)>"
    r"(?P<content>.*?)</button\s*>", re.IGNORECASE | re.DOTALL,
)
TOKEN_RE = re.compile(
    r"//[^\n]*|/\*.*?\*/|'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|"
    r"`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]", re.DOTALL,
)
ATTRIBUTE_RE = re.compile(
    r"([^\s=\"'<>`]+)\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
)
# A template interpolation or a trustedHtml expression is opaque to a static
# scan. It counts as an icon only when its text says so (renderIcon(...),
# ICON_CLOSE, svgGlyph); anything else (labels, menu rows, option text) is
# assumed to carry visible words.
ICON_EXPR_RE = re.compile(r"icon|svg|glyph", re.IGNORECASE)


def iter_scan_files() -> Iterable[Path]:
    paths = [ROOT / "index.html", *sorted((ROOT / "renderer").rglob("*.js"))]
    for path in paths:
        if path.is_file() and not EXCLUDED_DIRS.intersection(path.relative_to(ROOT).parts):
            yield path


def iter_inventory_calls(source: str) -> Iterable[tuple[int, int]]:
    tokens = [token for token in TOKEN_RE.finditer(source)
              if not token.group().startswith(("//", "/*"))]
    for index, token in enumerate(tokens[:-2]):
        if (token.group() in {"actionButton", "chip"}
                and tokens[index + 1].group() == "("
                and tokens[index + 2].group() == "{"):
            yield token.start(), tokens[index + 2].start()


def read_key(token: str) -> str | None:
    if re.fullmatch(r"[A-Za-z_$][\w$]*", token):
        return token
    return token[1:-1] if token.startswith(("'", '"')) else None


def object_keys(source: str, start: int) -> dict[str, str]:
    """Read the outer object keys, each mapped to its value's token text.

    Nested objects and calls stay inside the value text; a shorthand property
    maps to its own name.
    """
    depth = 0
    values: dict[str, list[str]] = {}
    expecting_key = False
    current: str | None = None
    for token in TOKEN_RE.finditer(source, start):
        value = token.group()
        if value.startswith(("//", "/*")):
            continue
        depth += value in {"{", "[", "("}
        depth -= value in {"}", "]", ")"}
        if depth == 0:
            break
        if depth == 1 and value in {"{", ","}:
            expecting_key, current = True, None
        elif expecting_key:
            current = read_key(value)
            if current is not None:
                values[current] = []
            expecting_key = False
        elif current is not None and (values[current] or value != ":"):
            values[current].append(value)
    return {key: " ".join(parts) or key for key, parts in values.items()}


def strip_interpolations(content: str) -> tuple[str, list[str]]:
    """Remove `${...}` interpolations and return their expression texts."""
    expressions: list[str] = []
    while (match := re.search(r"\$\{", content)) is not None:
        depth = 1
        end = len(content)
        for token in TOKEN_RE.finditer(content, match.end()):
            if token.group() == "{":
                depth += 1
            elif token.group() == "}":
                depth -= 1
                if depth == 0:
                    end = token.end()
                    break
        expressions.append(content[match.end():end - 1])
        content = content[:match.start()] + content[end:]
    return content, expressions


def is_icon_only(content: str) -> bool:
    content, expressions = strip_interpolations(content)
    content = re.sub(r"<!--.*?-->", "", content, flags=re.DOTALL)
    content = re.sub(r"<svg\b[^>]*>.*?</svg\s*>", "", content, flags=re.IGNORECASE | re.DOTALL)
    content = re.sub(
        r"<span\b[^>]*\bclass\s*=\s*([\"'])[^\"']*\bsr-only\b[^\"']*\1[^>]*>.*?</span\s*>",
        "", content, flags=re.IGNORECASE | re.DOTALL,
    )
    visible = unescape(re.sub(r"<[^>]*>", "", content)).strip()
    if visible and not (len(visible) == 1 and not visible.isalnum()):
        return False
    return all(ICON_EXPR_RE.search(expression) for expression in expressions)


def html_value_is_icon(value: str) -> bool:
    """A trustedHtml value is an icon when its literals carry no visible text and
    every non-literal part is icon-named (or there is none)."""
    tokens = [token.group() for token in TOKEN_RE.finditer(value)
              if not token.group().startswith(("//", "/*"))]
    literals = "".join(token[1:-1] for token in tokens if token.startswith(("'", '"', "`")))
    if not is_icon_only(literals):
        return False
    identifiers = [token for token in tokens if re.fullmatch(r"[A-Za-z_$][\w$]*", token)]
    return not identifiers or any(ICON_EXPR_RE.search(token) for token in identifiers)


def collect_occurrences() -> tuple[dict[str, list[str]], int]:
    occurrences: dict[str, list[str]] = defaultdict(list)
    checked = 0
    for path in iter_scan_files():
        relative = path.relative_to(ROOT).as_posix()
        source = path.read_text(encoding="utf-8")
        candidates: list[tuple[int, list[str], str]] = []
        for match in BUTTON_RE.finditer(source):
            checked += 1
            if is_icon_only(match["content"]):
                attrs = {attr[1].lower() for attr in ATTRIBUTE_RE.finditer(match["attrs"])}
                # The inventory tooltip (data-tooltip) replaces the native title.
                if "data-tooltip" in attrs:
                    attrs.add("title")
                missing = [name for name in ("aria-label", "title") if name not in attrs]
                candidates.append((match.start(), missing, match.group()))
        if path.suffix == ".js":
            for start, object_start in iter_inventory_calls(source):
                keys = object_keys(source, object_start)
                checked += 1
                icon_only = "label" not in keys and (
                    "iconHtml" in keys
                    or ("trustedHtml" in keys and html_value_is_icon(keys["trustedHtml"]))
                )
                if icon_only:
                    missing = [
                        name for key, name in (("ariaLabel", "aria-label"), ("title", "title"))
                        if key not in keys
                    ]
                    candidates.append((start, missing, source[start:start + 160]))
        for start, missing, excerpt in sorted(candidates):
            if missing:
                line = source.count("\n", 0, start) + 1
                short_excerpt = " ".join(excerpt.split())[:80]
                occurrences[relative].append(
                    f"{relative}:{line}: missing {' and '.join(missing)} -- {short_excerpt}"
                )
    return occurrences, checked


def find_violations(occurrences: dict[str, list[str]]) -> list[str]:
    violations: list[str] = []
    for relative, findings in sorted(occurrences.items()):
        allowed = max(0, ALLOWLIST.get(relative, 0))
        violations.extend(findings[allowed:])
    return violations


def main() -> int:
    occurrences, checked = collect_occurrences()
    violations = find_violations(occurrences)
    if violations:
        for finding in violations:
            print(finding)
        print("FAIL: icon-only buttons must carry aria-label and title")
        return 1
    print(f"PASS: icon-only buttons carry aria-label and title ({checked} buttons checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
