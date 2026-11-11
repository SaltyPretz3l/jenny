from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _load_fill_spec() -> ModuleType:
    script_path = Path(__file__).resolve().parents[3] / "scripts" / "dev" / "fill_spec.py"
    spec = importlib.util.spec_from_file_location("fill_spec_script_for_tests", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive load guard
        raise RuntimeError("failed to load fill_spec.py module spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


fill_spec = _load_fill_spec()

TEMPLATE = (
    "notes with {{IGNORED}}\n<!-- BODY -->\n\nSlice {{SLICE}} in {{WORKDIR}}.\n{{SLICE}} again.\n"
)


def _template(tmp_path: Path, text: str = TEMPLATE) -> Path:
    path = tmp_path / "template.md"
    path.write_text(text, encoding="utf-8", newline="\n")
    return path


def test_fills_the_body_and_drops_the_notes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "spec.md"
    code = fill_spec.main(
        [str(out), "--template", str(_template(tmp_path)), "SLICE=tabs", "WORKDIR=wt"]
    )
    assert code == 0
    assert out.read_bytes() == b"Slice tabs in wt.\ntabs again.\n"
    assert "wrote" in capsys.readouterr().out


def test_unfilled_key_is_listed_and_nothing_is_written(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "spec.md"
    code = fill_spec.main([str(out), "--template", str(_template(tmp_path)), "SLICE=tabs"])
    assert code == 2
    assert not out.exists()
    assert "unfilled placeholders: {{WORKDIR}}" in capsys.readouterr().err


def test_unknown_key_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "spec.md"
    args = [str(out), "--template", str(_template(tmp_path)), "SLICE=a", "WORKDIR=b", "IGNORED=c"]
    assert fill_spec.main(args) == 2
    assert not out.exists()
    assert "keys not in the template: IGNORED" in capsys.readouterr().err


@pytest.mark.parametrize("blank", ["", "   ", "\t"])
def test_empty_value_is_refused(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], blank: str
) -> None:
    out = tmp_path / "spec.md"
    args = [str(out), "--template", str(_template(tmp_path)), "SLICE=a", f"WORKDIR={blank}"]
    assert fill_spec.main(args) == 2
    assert not out.exists()
    assert "empty values" in capsys.readouterr().err


def test_every_problem_is_reported_in_one_run() -> None:
    with pytest.raises(fill_spec.FillError) as excinfo:
        fill_spec.fill("{{A}} {{B}} {{C}}", {"A": "", "D": "x"})
    message = str(excinfo.value)
    assert "unfilled placeholders: {{B}}, {{C}}" in message
    assert "keys not in the template: D" in message
    assert "A" in message.split("empty values", 1)[1]


def test_value_from_file_is_read_as_utf8_and_stripped(tmp_path: Path) -> None:
    value = tmp_path / "context.md"
    value.write_text("\nline one\nnaïve → done\n\n", encoding="utf-8", newline="\n")
    out = tmp_path / "spec.md"
    args = [str(out), "--template", str(_template(tmp_path)), f"SLICE=@{value}", "WORKDIR=wt"]
    assert fill_spec.main(args) == 0
    assert out.read_text(encoding="utf-8").startswith("Slice line one\nnaïve → done in wt.")


def test_missing_value_file_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "spec.md"
    args = [
        str(out),
        "--template",
        str(_template(tmp_path)),
        f"SLICE=@{tmp_path / 'absent.md'}",
        "WORKDIR=wt",
    ]
    assert fill_spec.main(args) == 2
    assert not out.exists()
    assert "SLICE: cannot read" in capsys.readouterr().err


@pytest.mark.parametrize("bad", ["SLICE", "=x", "1KEY=x", "two words=x"])
def test_malformed_assignment_is_refused(bad: str) -> None:
    with pytest.raises(fill_spec.FillError, match="expected KEY=value"):
        fill_spec.parse_assignments([bad])


def test_duplicate_key_is_refused() -> None:
    with pytest.raises(fill_spec.FillError, match="SLICE is given twice"):
        fill_spec.parse_assignments(["SLICE=a", "SLICE=b"])


def test_template_without_body_marker_is_refused(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "spec.md"
    template = _template(tmp_path, "no marker here {{SLICE}}\n")
    assert fill_spec.main([str(out), "--template", str(template), "SLICE=a"]) == 2
    assert not out.exists()
    assert "<!-- BODY -->" in capsys.readouterr().err


def test_forgotten_output_path_does_not_become_a_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    template = _template(tmp_path)
    assert fill_spec.main(["--template", str(template), "SLICE=a", "WORKDIR=b"]) == 2
    assert "first argument is the output file" in capsys.readouterr().err
    assert sorted(path.name for path in tmp_path.iterdir()) == ["template.md"]


def test_placeholder_text_inside_a_value_is_kept_as_written() -> None:
    assert fill_spec.fill("{{A}}|{{B}}", {"A": "{{B}}", "B": "x"}) == "{{B}}|x"


def test_list_keys_prints_body_keys_in_order(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert fill_spec.main(["--list-keys", "--template", str(_template(tmp_path))]) == 0
    assert capsys.readouterr().out.split() == ["SLICE", "WORKDIR"]


@pytest.mark.parametrize("name", sorted(fill_spec.TEMPLATES))
def test_shipped_templates_fill_completely(tmp_path: Path, name: str) -> None:
    template_path = fill_spec.TEMPLATES[name]
    text = template_path.read_text(encoding="utf-8")
    body = fill_spec.template_body(text)
    keys = fill_spec.template_keys(body)
    assert keys, f"{name} template has no keys"
    notes = text[: text.index(fill_spec.BODY_MARKER)]
    for key in keys:
        assert "`{{" + key + "}}`" in notes, f"{name}: the notes do not describe {key}"

    out = tmp_path / f"{name}.md"
    args = [str(out), "--template", name, *[f"{key}=value-for-{key}" for key in keys]]
    assert fill_spec.main(args) == 0
    filled = out.read_text(encoding="utf-8")
    assert "{{" not in filled
    for key in keys:
        assert f"value-for-{key}" in filled

    assert fill_spec.main([str(out), "--template", name, *args[4:]]) == 2
