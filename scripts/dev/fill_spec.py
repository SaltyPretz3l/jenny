"""Fill a delegation template and refuse to write an incomplete one.

A delegated agent reads neither the project contract nor any memory, so the spec it
gets is the whole of what it knows. This tool makes the gaps loud: it exits 2 and
writes nothing when a ``{{KEY}}`` in the template has no value, when a value is empty,
or when a KEY the template does not have is passed.

Usage (run from the repository root)::

    python scripts/dev/fill_spec.py OUT [--template NAME|PATH] KEY=value KEY=@file ...
    python scripts/dev/fill_spec.py --list-keys [--template NAME|PATH]

NAME is ``implementer`` (the default) or ``explorer``.

``KEY=@file`` reads the value from a UTF-8 file, which is the safe way to pass
multi-line or non-ASCII text. The template's notes (everything up to and including
the line ``<!-- BODY -->``) are dropped; the rest is filled in one pass, so a value
that itself contains ``{{...}}`` is kept as written. Write OUT outside the repository
or under an ignored path: a filled spec is a working file, not a tracked document.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

TEMPLATE_DIR = Path(__file__).resolve().parent / "delegation"
TEMPLATES = {
    "implementer": TEMPLATE_DIR / "implementer-spec.md",
    "explorer": TEMPLATE_DIR / "explorer-brief.md",
}
BODY_MARKER = "<!-- BODY -->"
PLACEHOLDER = re.compile(r"\{\{([^{}\r\n]*)\}\}")
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class FillError(Exception):
    """The spec cannot be written as asked."""


def _read_utf8(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def resolve_template(name: str) -> Path:
    return TEMPLATES.get(name, Path(name))


def template_body(text: str) -> str:
    """Return everything after the first line that is exactly the body marker."""
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.rstrip("\r\n") == BODY_MARKER:
            return "".join(lines[index + 1 :]).lstrip("\r\n")
    raise FillError(f"template has no line that is exactly `{BODY_MARKER}`")


def template_keys(body: str) -> list[str]:
    """Placeholder names in first-seen order, each once."""
    seen: dict[str, None] = {}
    for match in PLACEHOLDER.finditer(body):
        seen.setdefault(match.group(1), None)
    return list(seen)


def parse_assignments(
    args: Sequence[str],
    read_file: Callable[[str], str] | None = None,
) -> dict[str, str]:
    reader = read_file or _read_utf8
    values: dict[str, str] = {}
    for arg in args:
        key, sep, value = arg.partition("=")
        if not sep or not KEY_RE.match(key):
            raise FillError(f"expected KEY=value or KEY=@file, got: {arg!r}")
        if key in values:
            raise FillError(f"{key} is given twice")
        if value.startswith("@"):
            try:
                value = reader(value[1:]).strip()
            except OSError as exc:
                raise FillError(f"{key}: cannot read {value[1:]}: {exc}") from exc
        values[key] = value
    return values


def fill(body: str, values: dict[str, str]) -> str:
    in_body = set(template_keys(body))
    problems: list[str] = []
    unfilled = sorted(in_body - values.keys())
    if unfilled:
        problems.append(
            "unfilled placeholders: " + ", ".join("{{" + key + "}}" for key in unfilled)
        )
    unknown = sorted(values.keys() - in_body)
    if unknown:
        problems.append("keys not in the template: " + ", ".join(unknown))
    empty = sorted(key for key in in_body & values.keys() if not values[key].strip())
    if empty:
        problems.append("empty values (write `none` if that is the answer): " + ", ".join(empty))
    if problems:
        raise FillError("; ".join(problems))
    return PLACEHOLDER.sub(lambda match: values[match.group(1)], body)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    parser.add_argument("out", nargs="?", help="file to write the filled spec to")
    parser.add_argument(
        "--template",
        default="implementer",
        help="implementer (default), explorer, or a path to another template",
    )
    parser.add_argument(
        "--list-keys", action="store_true", help="print the template's keys and exit"
    )
    parser.add_argument("assignments", nargs="*", metavar="KEY=value")
    opts = parser.parse_intermixed_args(argv)
    try:
        template_path = resolve_template(opts.template)
        try:
            body = template_body(template_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise FillError(f"cannot read template {template_path}: {exc}") from exc
        if opts.list_keys:
            print("\n".join(template_keys(body)))
            return 0
        if not opts.out:
            raise FillError("give the output file first, then KEY=value arguments")
        if "=" in opts.out:
            raise FillError(
                f"the first argument is the output file, got an assignment: {opts.out!r}"
            )
        text = fill(body, parse_assignments(opts.assignments))
    except FillError as exc:
        print(f"fill_spec: {exc}", file=sys.stderr)
        return 2
    out_path = Path(opts.out)
    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    print(f"wrote {out_path} ({len(text)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
