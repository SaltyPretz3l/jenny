"""Validate CMP-* error-code registry drift and inline literal regressions."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "sidecar"
SERVICES = ROOT / "services"
DOCS_REGISTRY = ROOT / "docs" / "operations" / "error-codes.md"

CANONICAL_FILES = {
    (SIDECAR / "ai" / "error_codes.py").resolve(),
    (SERVICES / "backend" / "error-codes.js").resolve(),
}

_CMP_CODE_PATTERN = r"CMP-[A-Z]+(?:-[A-Z0-9]+)+"
_CMP_CODE = re.compile(rf"\b{_CMP_CODE_PATTERN}\b")
_PY_QUOTED_CMP_LITERAL = re.compile(
    rf"""(?P<quote>['"])(?P<body>[^'"\n]*{_CMP_CODE_PATTERN}[^'"\n]*)(?P=quote)"""
)
_JS_QUOTED_CMP_LITERAL = re.compile(
    rf"""(?P<quote>['"`])(?P<body>[^'"`\n]*{_CMP_CODE_PATTERN}[^'"`\n]*)(?P=quote)"""
)


def _is_real_code(code: str) -> bool:
    return bool(code) and "NNNN" not in code


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _codes_in_text(text: str) -> set[str]:
    return {code for code in _CMP_CODE.findall(text) if _is_real_code(code)}


def source_error_codes() -> set[str]:
    codes: set[str] = set()
    for path in CANONICAL_FILES:
        codes.update(_codes_in_text(_read_text(path)))
    return codes


def documented_error_codes() -> set[str]:
    return _codes_in_text(_read_text(DOCS_REGISTRY))


def registry_drift() -> list[str]:
    source_codes = source_error_codes()
    documented_codes = documented_error_codes()
    violations = [
        f"missing from docs: {code}"
        for code in sorted(source_codes - documented_codes)
    ]
    violations.extend(
        f"documented but not defined: {code}"
        for code in sorted(documented_codes - source_codes)
    )
    return violations


def _source_files() -> list[Path]:
    return sorted(
        [*SIDECAR.rglob("*.py"), *SERVICES.rglob("*.js")],
        key=lambda path: path.relative_to(ROOT).as_posix(),
    )


def _strip_js_block_comments(line: str, *, in_block_comment: bool) -> tuple[str, bool]:
    parts: list[str] = []
    index = 0
    while index < len(line):
        if in_block_comment:
            end = line.find("*/", index)
            if end < 0:
                return "".join(parts), True
            index = end + 2
            in_block_comment = False
            continue
        start = line.find("/*", index)
        if start < 0:
            parts.append(line[index:])
            break
        parts.append(line[index:start])
        index = start + 2
        in_block_comment = True
    return "".join(parts), in_block_comment


def find_inline_codes(path: Path) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return hits
    is_js = path.suffix.lower() == ".js"
    quoted_literal_re = _JS_QUOTED_CMP_LITERAL if is_js else _PY_QUOTED_CMP_LITERAL
    in_block_comment = False
    for lineno, line in enumerate(lines, start=1):
        scan_line = line
        if is_js:
            scan_line, in_block_comment = _strip_js_block_comments(
                line,
                in_block_comment=in_block_comment,
            )
        if "CMP-" not in scan_line:
            continue
        stripped = scan_line.lstrip()
        if stripped.startswith(("#", "//", "*")):
            continue
        for match in quoted_literal_re.finditer(scan_line):
            for code in sorted(_codes_in_text(match.group("body"))):
                hits.append((lineno, code))
    return hits


def inline_code_violations() -> list[str]:
    violations: list[str] = []
    for file_path in _source_files():
        if file_path.resolve() in CANONICAL_FILES:
            continue
        for lineno, code in find_inline_codes(file_path):
            violations.append(f"{file_path.relative_to(ROOT)}:{lineno}  {code}")
    return violations


def main() -> int:
    violations = inline_code_violations()
    drift = registry_drift()

    if violations:
        print(
            "FAIL: inline CMP error codes found outside canonical files\n"
            "  Move these to sidecar/ai/error_codes.py or services/backend/error-codes.js\n"
            "  and import the constant instead."
        )
        for item in violations:
            print(f"  - {item}")

    if drift:
        print(
            "FAIL: CMP error-code registry drift found\n"
            "  Keep docs/operations/error-codes.md reconciled with canonical constants."
        )
        for item in drift:
            print(f"  - {item}")

    if violations or drift:
        return 1

    print("PASS: CMP error codes are canonical and documented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
