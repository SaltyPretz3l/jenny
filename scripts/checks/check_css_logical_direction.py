"""Keep physical-direction CSS declarations on a shrink-only ratchet.

Jenny's document direction follows the selected UI language, so layout CSS
must use logical properties (`margin-inline-start`, `inset-inline-end`, and
similar) to mirror under RTL. This check counts the remaining physical
left/right declarations in `styles/**/*.css` and rejects any per-file or
whole-tree increase over its dedicated baseline.

Screen-physical integrations may opt out with `/* rtl:physical */` on the
declaration line or by using one of the narrowly documented selector shapes
for code/editor hosts. When migrations lower the count, the check prints a
LOWER hint; updating the baseline remains an explicit integrator action.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import date
from pathlib import Path
from typing import NamedTuple, Sequence

ROOT = Path(__file__).resolve().parents[2]
STYLES_DIR = ROOT / "styles"
BASELINE_PATH = Path(__file__).resolve().with_name("css_direction_baseline.json")

PHYSICAL_PROPERTIES = (
    "border-bottom-left-radius",
    "border-bottom-right-radius",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-left-color",
    "border-left-style",
    "border-left-width",
    "border-right-color",
    "border-right-style",
    "border-right-width",
    "padding-left",
    "padding-right",
    "margin-left",
    "margin-right",
    "border-left",
    "border-right",
    "text-align",
    "float",
    "clear",
    "left",
    "right",
)
DECLARATION_RE = re.compile(
    rf"(?:^|[;{{}}])\s*(?P<property>{'|'.join(map(re.escape, PHYSICAL_PROPERTIES))})"
    r"\s*:\s*(?P<value>[^;{}]*)(?=;|})",
    re.IGNORECASE | re.MULTILINE,
)
DIRECTION_VALUE_RE = re.compile(r"(?:left|right)(?:\s*!important)?\Z", re.IGNORECASE)
CODE_ELEMENT_SELECTOR_RE = re.compile(
    r"(?:^|[\s>+~,(])(?:pre|code)(?=$|[\s>+~.#:\[,)])",
    re.IGNORECASE,
)
LTR_SELECTOR_RE = re.compile(r"\[\s*dir\s*=\s*(['\"])ltr\1\s*\]", re.IGNORECASE)
SELECTOR_MARKERS = (".monaco", ".xterm", ".rtl-physical")


class Block(NamedTuple):
    content_start: int
    content_end: int
    prelude: str
    parent: int | None


class OpenBlock(NamedTuple):
    block_index: int
    content_start: int
    prelude: str
    parent: int | None


def _strip_comments(text: str) -> tuple[str, set[int]]:
    """Strip CSS comments while preserving offsets and escape-hatch lines."""
    output = list(text)
    exempt_lines: set[int] = set()
    index = 0
    line = 1
    quote: str | None = None
    while index < len(text):
        char = text[index]
        if quote is not None:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
            if char == "\n":
                line += 1
            index += 1
            continue
        if char in {'"', "'"}:
            quote = char
            index += 1
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            end = len(text) if end < 0 else end + 2
            comment = text[index:end]
            end_line = line + comment.count("\n")
            if "rtl:physical" in comment.casefold():
                exempt_lines.update(range(line, end_line + 1))
            for position in range(index, end):
                if output[position] != "\n":
                    output[position] = " "
            line = end_line
            index = end
            continue
        if char == "\n":
            line += 1
        index += 1
    return "".join(output), exempt_lines


def _collect_blocks(text: str) -> list[Block]:
    """Collect brace blocks and the selector/at-rule prelude for each block."""
    blocks: list[Block | None] = []
    stack: list[OpenBlock] = []
    segment_starts = [0]
    quote: str | None = None
    index = 0
    while index < len(text):
        char = text[index]
        if quote is not None:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "{":
            parent = stack[-1].block_index if stack else None
            prelude = text[segment_starts[-1] : index].strip()
            block_index = len(blocks)
            blocks.append(None)
            stack.append(OpenBlock(block_index, index + 1, prelude, parent))
            segment_starts.append(index + 1)
        elif char == ";":
            segment_starts[-1] = index + 1
        elif char == "}" and stack:
            opened = stack.pop()
            blocks[opened.block_index] = Block(
                opened.content_start,
                index,
                opened.prelude,
                opened.parent,
            )
            segment_starts.pop()
            segment_starts[-1] = index + 1
        index += 1
    # Unterminated blocks are deliberately bounded to EOF so malformed CSS
    # cannot make the policy scan silently ignore the remaining declarations.
    while stack:
        opened = stack.pop()
        blocks[opened.block_index] = Block(
            opened.content_start,
            len(text),
            opened.prelude,
            opened.parent,
        )
        segment_starts.pop()
    return [block for block in blocks if block is not None]


def _selector_is_exempt(selector: str) -> bool:
    folded = selector.casefold()
    return (
        any(marker in folded for marker in SELECTOR_MARKERS)
        or LTR_SELECTOR_RE.search(selector) is not None
        or CODE_ELEMENT_SELECTOR_RE.search(selector) is not None
    )


def _inside_exempt_rule(position: int, blocks: list[Block]) -> bool:
    containing = [
        (index, block)
        for index, block in enumerate(blocks)
        if block.content_start <= position < block.content_end
    ]
    if not containing:
        return False
    block_index = max(containing, key=lambda item: item[1].content_start)[0]
    while block_index is not None:
        block = blocks[block_index]
        if not block.prelude.startswith("@") and _selector_is_exempt(block.prelude):
            return True
        block_index = block.parent
    return False


def count_physical_declarations(text: str) -> int:
    """Count non-exempt physical-direction declarations in one stylesheet."""
    stripped, exempt_lines = _strip_comments(text)
    blocks = _collect_blocks(stripped)
    count = 0
    for match in DECLARATION_RE.finditer(stripped):
        property_name = match.group("property").casefold()
        value = match.group("value").strip()
        if property_name in {"float", "clear", "text-align"}:
            if DIRECTION_VALUE_RE.fullmatch(value) is None:
                continue
        property_line = stripped.count("\n", 0, match.start("property")) + 1
        if property_line in exempt_lines:
            continue
        if _inside_exempt_rule(match.start("property"), blocks):
            continue
        count += 1
    return count


def scan_styles() -> dict[str, int]:
    """Return non-zero physical declaration counts keyed by repo-relative path."""
    if not STYLES_DIR.is_dir():
        return {}
    measured: dict[str, int] = {}
    for path in sorted(STYLES_DIR.rglob("*.css")):
        if not path.is_file():
            continue
        try:
            count = count_physical_declarations(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError) as error:
            relative = path.relative_to(ROOT).as_posix()
            raise RuntimeError(f"cannot read {relative}: {error}") from error
        if count:
            measured[path.relative_to(ROOT).as_posix()] = count
    return measured


def _load_baseline() -> tuple[int, dict[str, int]]:
    try:
        raw = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        relative = BASELINE_PATH.relative_to(ROOT).as_posix()
        raise RuntimeError(f"cannot read {relative}: {error}") from error
    if not isinstance(raw, dict) or set(raw) != {"total", "files", "note"}:
        raise RuntimeError("baseline must contain exactly: total, files, note")
    total = raw["total"]
    files = raw["files"]
    note = raw["note"]
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise RuntimeError("baseline total must be a non-negative integer")
    if not isinstance(files, dict) or not isinstance(note, str) or not note.strip():
        raise RuntimeError("baseline files must be an object and note must be non-empty")
    normalized: dict[str, int] = {}
    for path, count in files.items():
        if (
            not isinstance(path, str)
            or not path.startswith("styles/")
            or isinstance(count, bool)
            or not isinstance(count, int)
            or count < 0
        ):
            raise RuntimeError("baseline files must map styles/ paths to non-negative integers")
        normalized[path] = count
    if sum(normalized.values()) != total:
        raise RuntimeError("baseline total must equal the sum of its per-file counts")
    return total, normalized


def _write_baseline(measured: dict[str, int]) -> None:
    payload = {
        "total": sum(measured.values()),
        "files": dict(sorted(measured.items())),
        "note": (
            f"Measured {date.today().isoformat()} for RTL0; lower after "
            "physical declarations migrate to logical CSS properties."
        ),
    }
    try:
        temporary = BASELINE_PATH.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        temporary.replace(BASELINE_PATH)
    except OSError as error:
        raise RuntimeError(
            f"cannot write {BASELINE_PATH.relative_to(ROOT).as_posix()}: {error}"
        ) from error


def _print_report(measured: dict[str, int]) -> None:
    print("COUNT  FILE")
    for path, count in sorted(measured.items(), key=lambda item: (-item[1], item[0])):
        print(f"{count:5d}  {path}")
    print(f"{sum(measured.values()):5d}  TOTAL")


def _compare_counts(
    measured: dict[str, int],
    baseline_total: int,
    baseline_files: dict[str, int],
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    lower: list[str] = []
    for path in sorted(set(measured) | set(baseline_files)):
        current = measured.get(path, 0)
        baseline = baseline_files.get(path, 0)
        if current > baseline:
            failures.append(f"{path}: {current} > baseline {baseline}")
        elif current < baseline:
            lower.append(f"{path}: {current} < baseline {baseline}")
    measured_total = sum(measured.values())
    if measured_total > baseline_total:
        failures.append(f"TOTAL: {measured_total} > baseline {baseline_total}")
    elif measured_total < baseline_total:
        lower.append(f"TOTAL: {measured_total} < baseline {baseline_total}")
    return failures, lower


def _print_lower_hints(lower: list[str]) -> None:
    for hint in lower:
        print(f"LOWER: {hint}")
    if lower:
        print(
            "LOWER: re-run with --write-baseline after integrating all concurrent "
            "CSS migrations"
        )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", action="store_true", help="print counts by stylesheet")
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help="replace the shrink-only baseline with the current measured counts",
    )
    args = parser.parse_args(argv)

    try:
        measured = scan_styles()
        if args.write_baseline:
            _write_baseline(measured)
            print(f"WROTE: {BASELINE_PATH.relative_to(ROOT).as_posix()}")
        baseline_total, baseline_files = _load_baseline()
    except RuntimeError as error:
        print(f"FAIL: CSS logical-direction declaration ratchet: {error}")
        return 1

    if args.report:
        _print_report(measured)

    measured_total = sum(measured.values())
    failures, lower = _compare_counts(measured, baseline_total, baseline_files)

    if failures:
        print("FAIL: CSS logical-direction declaration count increased")
        for failure in failures:
            print(f"  - {failure}")
        print("Use logical CSS properties or a documented RTL physical exemption.")
        _print_lower_hints(lower)
        return 1
    _print_lower_hints(lower)
    print(f"PASS: CSS logical-direction declaration ratchet ({measured_total} remaining)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
