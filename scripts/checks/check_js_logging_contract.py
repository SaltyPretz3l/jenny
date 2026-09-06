"""Enforce JS logging/error-boundary contract touchpoints."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

REQUIRED_SNIPPETS = {
    ROOT / "main.js": [
        "normalizeLogEntry",
        "diagnostics:renderer-error",
        "app.unhandled_failure",
    ],
    ROOT / "preload.js": [
        "reportRendererError",
        "diagnostics:renderer-error",
    ],
    ROOT / "renderer/shell/renderer-lifecycle-utils.js": [
        "schema_version",
    ],
    ROOT / "renderer/shell/renderer-lifecycle-error-utils.js": [
        "renderer.global_error",
        "unhandledrejection",
        "error_code",
    ],
}


def main() -> int:
    violations: list[str] = []
    for path, snippets in REQUIRED_SNIPPETS.items():
        if not path.exists():
            violations.append(f"missing required file: {path}")
            continue
        text = path.read_text(encoding="utf-8")
        for snippet in snippets:
            if snippet not in text:
                violations.append(f"{path.relative_to(ROOT)} missing snippet: {snippet!r}")
    if violations:
        print("FAIL: js logging contract check")
        for line in violations:
            print(f"  - {line}")
        return 1
    print("PASS: js logging contract check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
