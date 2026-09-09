from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType


def _load_checker() -> ModuleType:
    script_path = (
        Path(__file__).resolve().parents[2]
        / "scripts"
        / "checks"
        / "check_css_logical_direction.py"
    )
    spec = importlib.util.spec_from_file_location("check_css_logical_direction", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError("unable to load CSS logical-direction checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_css_logical_direction_ratchet_and_baseline_write(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    checker = _load_checker()
    styles_dir = tmp_path / "styles"
    styles_dir.mkdir()
    (styles_dir / "fixture.css").write_text(
        """
.fixture {
  margin-left: 1rem;
  text-align: right;
  left: 0; /* rtl:physical */
}
""".strip(),
        encoding="utf-8",
    )
    baseline_path = tmp_path / "scripts" / "checks" / "css_direction_baseline.json"
    baseline_path.parent.mkdir(parents=True)
    baseline_path.write_text(
        json.dumps(
            {
                "total": 1,
                "files": {"styles/fixture.css": 1},
                "note": "Test baseline measured 2026-09-07.",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    monkeypatch.setattr(checker, "STYLES_DIR", styles_dir)
    monkeypatch.setattr(checker, "BASELINE_PATH", baseline_path)

    assert checker.scan_styles() == {"styles/fixture.css": 2}
    assert checker.main([]) == 1
    assert "FAIL: CSS logical-direction declaration count increased" in capsys.readouterr().out

    assert checker.main(["--write-baseline"]) == 0
    written = json.loads(baseline_path.read_text(encoding="utf-8"))
    assert written["total"] == 2
    assert written["files"] == {"styles/fixture.css": 2}
    assert checker.main([]) == 0
    assert "PASS: CSS logical-direction declaration ratchet" in capsys.readouterr().out


def test_css_logical_direction_selector_and_value_exemptions() -> None:
    checker = _load_checker()

    assert checker.count_physical_declarations(
        """
.monaco-editor { left: 0; }
.xterm .cursor { right: 0; }
pre { margin-left: 1rem; }
code.inline { border-right: 1px solid; }
[dir="ltr"] .gutter { padding-left: 1rem; }
.rtl-physical { border-top-right-radius: 2px; }
.preview { padding-left: 1rem; }
.fixture {
  content: "/* rtl:physical */";
  right: 0;
  float: left;
  clear: both;
  text-align: start;
  @media (width > 1px) { color: red; }
  border-left: 1px solid;
}
"""
    ) == 4
