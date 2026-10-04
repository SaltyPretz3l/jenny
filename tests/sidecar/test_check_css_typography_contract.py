from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType


def _load_module() -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / "check_css_typography_contract.py"
    spec = importlib.util.spec_from_file_location("check_css_typography_contract_for_tests", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive load guard
        raise RuntimeError("failed to load check_css_typography_contract.py module spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _repo(module: ModuleType, monkeypatch, tmp_path: Path, css: dict[str, str], baseline: dict[str, int]) -> Path:
    root = tmp_path / "repo"
    for relative, text in css.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text(json.dumps({"files": baseline}), encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", root)
    monkeypatch.setattr(module, "STYLES_DIR", root / "styles")
    monkeypatch.setattr(module, "RENDERER_DIR", root / "renderer")
    monkeypatch.setattr(module, "LITERAL_BASELINE_PATH", baseline_path)
    return root


def test_literal_sizes_flagged_but_tokens_definitions_and_scaled_values_pass(tmp_path, monkeypatch) -> None:
    module = _load_module()
    _repo(module, monkeypatch, tmp_path, {
        "styles/a.css": (
            ":root { --font-size-body: calc(14px * var(--font-scale, 1)); }\n"
            ".ok { font-size: var(--font-size-body); }\n"
            ".em { font-size: 0.92em; }\n"
            ".hero { font-size: clamp(calc(24px * var(--font-scale, 1)), 3vw, 40px); }\n"
            "/* font-size: 11px in a comment is ignored */\n"
            ".inherit { font: inherit; }\n"
            ".bad { font-size: 11px; }\n"
            ".bad-rem { font-size: .72rem; }\n"
            ".bad-short { font: 500 13px/1.4 var(--font-family-mono); }\n"
        ),
    }, {})
    counts = module.collect_literal_size_counts()
    assert counts == {"styles/a.css": [7, 8, 9]}


def test_ratchet_allows_at_or_below_baseline_and_fails_on_growth(tmp_path, monkeypatch) -> None:
    module = _load_module()
    _repo(module, monkeypatch, tmp_path, {
        "styles/a.css": ".x { font-size: 11px; }\n.y { font-size: 12px; }\n",
        "renderer/inventory/b.css": ".z { font-size: 10px; }\n",
        "renderer/browser/styles.css": ".portal { font-size: 1rem; }\n",
    }, {"styles/a.css": 2})
    violations = module.literal_size_violations(module.collect_literal_size_counts(), module._load_literal_baseline())
    # a.css sits at its ratchet; b.css has no allowance; the portal is allowlisted.
    assert len(violations) == 1
    assert violations[0].startswith("renderer/inventory/b.css: 1 literal")


def test_update_baseline_refuses_growth_without_flag(tmp_path, monkeypatch) -> None:
    module = _load_module()
    _repo(module, monkeypatch, tmp_path, {"styles/a.css": ".x { font-size: 11px; }\n.y { font-size: 9px; }\n"},
          {"styles/a.css": 1})
    assert module.main(["--update-baseline"]) == 1
    assert module.main(["--update-baseline", "--allow-growth"]) == 0
    assert module._load_literal_baseline() == {"styles/a.css": 2}


def test_shorthand_line_height_is_not_a_font_size(tmp_path, monkeypatch) -> None:
    module = _load_module()
    _repo(module, monkeypatch, tmp_path, {
        "styles/a.css": (
            ".ok { font: var(--font-size-code)/20px var(--font-family-mono); }\n"
            ".bad { font: 13px/20px var(--font-family-mono); }\n"
        ),
    }, {})
    assert module.collect_literal_size_counts() == {"styles/a.css": [2]}


def test_empty_baseline_still_refuses_growth(tmp_path, monkeypatch) -> None:
    module = _load_module()
    _repo(module, monkeypatch, tmp_path, {"styles/a.css": ".x { font-size: 11px; }\n"}, {})
    assert module.main(["--update-baseline"]) == 1
    assert module._load_literal_baseline() == {}


def test_role_token_scaled_below_one_is_flagged(tmp_path, monkeypatch) -> None:
    # A role token shrunk by calc() slips under the 12px floor without a
    # literal px (the health pill badge rendered at 10.08px this way).
    module = _load_module()
    root = _repo(module, monkeypatch, tmp_path, {
        "styles/a.css": (
            ".ok { font-size: var(--font-size-caption); }\n"
            ".grow { font-size: calc(var(--font-size-body) * 1.2); }\n"
            ".bad { font-size: calc(var(--font-size-caption) * 0.84); }\n"
            ".bad-lead { font-size: calc(.9 * var(--font-size-footnote)); }\n"
            ".not-font { width: calc(var(--font-size-caption) * 0.5); }\n"
        ),
    }, {})
    violations = module._scan_shorthands_and_elements(root / "styles" / "a.css")
    shrunk = [item for item in violations if "below its role" in item]
    assert [item.split(" ")[0] for item in shrunk] == ["styles/a.css:3", "styles/a.css:4"]


def test_role_token_shrunk_through_indirection_is_flagged(tmp_path, monkeypatch) -> None:
    # The first gate only saw `* .9` inside a font-size declaration; the same
    # shrink hides in a custom property, a division, or an unknown multiplier.
    module = _load_module()
    root = _repo(module, monkeypatch, tmp_path, {
        "styles/a.css": (
            ":root { --small: calc(var(--font-size-body) * .9); }\n"
            ".div { font-size: calc(var(--font-size-body) / 1.1); }\n"
            ".unknown { font-size: calc(var(--font-size-body) * var(--scale)); }\n"
            ".ok-scale { font-size: calc(var(--font-size-body) * var(--font-scale)); }\n"
            ".ok-div { font-size: calc(var(--font-size-body) / 1); }\n"
            ".ok-shorthand { font: var(--font-size-code)/1.7 var(--font-family-mono); }\n"
            ".ok-known { font-size: calc(var(--font-size-caption) * var(--explode-node-scale, 1)); }\n"
            ":root { --font-size-body: calc(14px * var(--font-scale)); --gap: calc(var(--font-size-body) * 2); }\n"
        ),
    }, {})
    violations = module._scan_shorthands_and_elements(root / "styles" / "a.css")
    flagged = sorted(item.split(" ")[0] for item in violations if "below its" in item)
    assert flagged == ["styles/a.css:1", "styles/a.css:2", "styles/a.css:3"]
