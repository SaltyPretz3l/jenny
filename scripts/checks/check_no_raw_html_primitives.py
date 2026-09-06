"""Fail if raw HTML primitives are used outside renderer/inventory."""
from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RENDERER = ROOT / "renderer"
INVENTORY = RENDERER / "inventory"
TAG_RE = re.compile(r"<\s*(button|input|select)\b", flags=re.IGNORECASE)
CREATE_ELEMENT_RE = re.compile(
    r"\bcreateElement\(\s*['\"](button|input|select)['\"]", flags=re.IGNORECASE
)
HTML_SUFFIXES = {".tsx", ".jsx", ".html"}
JS_SUFFIXES = {".js", ".mjs"}
LEGACY_RAW_PRIMITIVE_ALLOWLIST = {
    # Active root-shell legacy debt. The cap is a ceiling (count <= cap passes), so
    # it never self-tightens: after markup is removed, re-measure and lower it here
    # rather than leaving stale headroom behind. It only ever moves down.
    "index.html": {"html_tag": 51},
    # Active root renderer markup/string-template debt tracked by the same finding.
    "renderer/chat/renderer-approval-block.js": {"html_tag": 3},
    "renderer/chat/renderer-user-questions-block.js": {"html_tag": 6},
    "renderer/chat/renderer-artifact-card-utils.js": {"html_tag": 1},
    "renderer/features/renderer-artifacts-render.js": {"html_tag": 3},
    "renderer/features/renderer-interactive-panel-utils.js": {"html_tag": 7},
    "renderer/chat/renderer-render-pipeline-render-effects.js": {"create_element": 1},
    "renderer/chat/renderer-render-pipeline-thread-dom.js": {"html_tag": 1},
    "renderer/shell/renderer-sidebar-utils.js": {"html_tag": 2},
    # Nav-overhaul top rail: the rail's tab-button template is permanent
    # infrastructure (the sole view-switch nav); tracked under REV-20260424-RENDERER-048.
    "renderer/shell/renderer-toprail-utils.js": {"html_tag": 1},
    # Settings nav rail: the section/disclosure tab-button templates are permanent
    # infrastructure (the sole Settings-section nav, generated from the section
    # registry). Same rationale as the top rail — net moved here from index.html.
    "renderer/shell/renderer-settings-nav-utils.js": {"html_tag": 2},
    # Ollama engine gate: copied native install opt-in checkbox; inventory has no
    # form-input primitive. Measured one raw input and no other raw primitives;
    # the total numeric allowlist budget measures 114 after the wizard scene exits.
    "renderer/features/setup-scenes/ollama-engine-gate.js": {"html_tag": 1},
    "renderer/features/renderer-skills-utils.js": {"html_tag": 1},
    "renderer/features/renderer-suggestion-utils.js": {"html_tag": 2},
    # renderer/shell/renderer-toast-utils.js held {"html_tag": 2} for the
    # dismiss and action <button> string templates. The redesign builds both
    # with createElement + textContent instead of hand-escaped markup, so the
    # same two buttons are now create_element -- identical debt, safer form,
    # and it drops the escaping the old templates had to get right by hand.
    # Revisit with the rest when an inventory `button` primitive ships.
    "renderer/shell/renderer-toast-utils.js": {"create_element": 2},
    "renderer/chat/renderer-transcript-actions.js": {"html_tag": 1},
    "renderer/chat/renderer-transcript-interactions.js": {"html_tag": 4},
    "renderer/chat/renderer-turn-row-render-utils.js": {"html_tag": 1},
    "renderer/features/renderer-companion-utils.js": {"create_element": 1},
    "renderer/features/renderer-mermaid-utils.js": {"create_element": 4},
    "renderer/shell/renderer-workspace-chrome-utils.js": {"create_element": 9},
    "renderer/features/renderer-artifact-document-render.js": {"html_tag": 2, "create_element": 2},
    # Phase 6F observability surfacing — buttons/selects emitted as static markup
    # for new UI surfaces that have no inventory equivalent. Tracked separately
    # from REV-20260424-RENDERER-048 as scoped UI debt; revisit when an
    # inventory `button` / `select` primitive ships.
    "renderer/shell/renderer-health-pill-markup-utils.js": {"html_tag": 1},
    "renderer/chat/renderer-approval-batch-utils.js": {"html_tag": 3},
    # -2 (3->1): the message-level "Copy reasoning" button was removed (the
    # reasoning block no longer carries a copy affordance), and the group
    # expand-all toggle went with it -- the file has no expand-all markup left.
    # The remaining 1 is the per-phase `reasoning-row-header` toggle <button>;
    # revisit when an inventory `button` primitive ships.
    "renderer/chat/renderer-transcript-reasoning-v2.js": {"html_tag": 1},
    "renderer/shell/renderer-observability-markup-utils.js": {"html_tag": 1},
}
EXCLUDED_TOP_LEVEL_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "archive",
    "artifacts",
    "build",
    "dist",
    "node_modules",
    "repomix",
    "tests",
    "vendor",
}

def repo_relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def is_excluded(path: Path) -> bool:
    try:
        relative = path.relative_to(ROOT)
    except ValueError:
        return True
    if not relative.parts:
        return True
    return relative.parts[0] in EXCLUDED_TOP_LEVEL_DIRS


def iter_scan_files() -> Iterable[Path]:
    seen: set[Path] = set()
    roots = [
        ROOT / "index.html",
        ROOT / "overlay.html",
        ROOT / "mermaid-frame.html",
    ]
    roots.extend(ROOT.glob("renderer*.js"))
    if RENDERER.exists():
        roots.extend(RENDERER.rglob("*"))

    for file_path in roots:
        if file_path in seen or not file_path.is_file():
            continue
        seen.add(file_path)
        if is_excluded(file_path):
            continue
        if INVENTORY in file_path.parents:
            continue
        if file_path.suffix not in HTML_SUFFIXES | JS_SUFFIXES:
            continue
        yield file_path


def collect_occurrences() -> dict[tuple[str, str], list[str]]:
    occurrences: dict[tuple[str, str], list[str]] = defaultdict(list)
    for file_path in iter_scan_files():
        relative_path = repo_relative(file_path)
        text = file_path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if file_path.suffix in HTML_SUFFIXES | JS_SUFFIXES and TAG_RE.search(line):
                occurrences[(relative_path, "html_tag")].append(f"{relative_path}:{lineno}")
            if file_path.suffix in JS_SUFFIXES and CREATE_ELEMENT_RE.search(line):
                occurrences[(relative_path, "create_element")].append(f"{relative_path}:{lineno}")
    return occurrences


def allowed_count(relative_path: str, kind: str) -> int:
    entry = LEGACY_RAW_PRIMITIVE_ALLOWLIST.get(relative_path, {})
    try:
        return max(0, int(entry.get(kind, 0)))
    except (TypeError, ValueError):
        return 0


def find_violations() -> list[str]:
    violations: list[str] = []
    for (relative_path, kind), locations in sorted(collect_occurrences().items()):
        allowed = allowed_count(relative_path, kind)
        if len(locations) <= allowed:
            continue
        suffix = ""
        if allowed:
            suffix = f" (allowed legacy {kind}: {allowed})"
        violations.extend(f"{location} [{kind}]{suffix}" for location in locations[allowed:])
    return violations


def main() -> int:
    violations = find_violations()

    if violations:
        print("FAIL: raw HTML primitives found outside renderer/inventory")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: no new raw HTML primitives outside inventory")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
