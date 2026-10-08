from __future__ import annotations

import pytest

from scripts.checks import check_icon_button_labels as checker


@pytest.fixture
def tree(tmp_path, monkeypatch):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    monkeypatch.setattr(checker, "ALLOWLIST", {})
    (tmp_path / "renderer").mkdir()
    return tmp_path


@pytest.mark.parametrize("content", [
    '<button aria-label="Close" title="Close"><svg><path/></svg></button>',
    '<button>Commands</button>',
    '<button>7</button>',
    '<button>é</button>',
    '<button class="menu-row">${escapeHtml(item.label)}</button>',
    '<button>${renderIcon("plus")}${escapeHtml(label)}</button>',
    '<button aria-label="Details" data-tooltip="More about this field">?</button>',
])
def test_markup_passes(tree, capsys, content):
    (tree / "index.html").write_text(content, encoding="utf-8")
    assert checker.main() == 0
    assert "PASS: icon-only buttons carry aria-label and title (1 buttons checked)" in capsys.readouterr().out


@pytest.mark.parametrize("content", [
    '<button aria-label="Close">×</button>',
    '<button aria-label="Up">&#8593;</button>',
    '<button aria-label="Close">${renderIcon({ size: 12 })}</button>',
    '<button aria-label="Close"><!-- Close --><span class="other sr-only">Close</span></button>',
    '<button aria-label="Close" data-i18n-title="close"><svg/></button>',
])
def test_markup_missing_title_reports_location(tree, capsys, content):
    (tree / "index.html").write_text("\n" + content, encoding="utf-8")
    assert checker.main() == 1
    output = capsys.readouterr().out
    assert "index.html:2: missing title -- " in output
    assert "FAIL:" in output


@pytest.mark.parametrize("call", ["actionButton", "inventory.actionButton", "chip"])
@pytest.mark.parametrize("properties,expected", [
    ('trustedHtml: icon, ariaLabel: "Close", title: "Close"', 0),
    ('iconHtml: icon, ariaLabel: "Close"', 1),
    ('trustedHtml: icon, label: "Commands"', 0),
    ('trustedHtml, ariaLabel, title', 0),
    ('trustedHtml: renderIcon({ size: 12 }), ariaLabel: "Close"', 1),
    ('trustedHtml: ICON_CLOSE, ariaLabel: "Close"', 1),
    ('trustedHtml: \'<span class="dot" aria-hidden="true"></span>\' + \'<span class="count"></span>\', ariaLabel: "Open"', 1),
    ('trustedHtml: \'<span>\' + escape(jt("k", "Add file")) + \'</span>\', ariaLabel: "Add"', 0),
    ('trustedHtml: "<svg><path/></svg>", ariaLabel: "Close"', 1),
    ('trustedHtml: `<svg/>${glyph}`, ariaLabel: "Close"', 1),
    ('trustedHtml: escapeHtml(item.label), ariaLabel: "Row"', 0),
    ('trustedHtml: "{title: fake}", ariaLabel: "Close"', 0),
    ('trustedHtml: `<b>${escapeHtml(name)}</b>`, ariaLabel: "Row"', 0),
])
def test_inventory_calls(tree, capsys, call, properties, expected):
    (tree / "renderer" / "sample.js").write_text(
        f"{call}({{ {properties} }});", encoding="utf-8"
    )
    assert checker.main() == expected
    output = capsys.readouterr().out
    if expected:
        assert "renderer/sample.js:1: missing title" in output


def test_js_markup_and_missing_aria_label(tree, capsys):
    (tree / "renderer" / "sample.js").write_text(
        'const html = `<button title="Close">${icon}</button>`;', encoding="utf-8"
    )
    assert checker.main() == 1
    assert "renderer/sample.js:1: missing aria-label" in capsys.readouterr().out


def test_allowlist_is_a_ceiling(tree, monkeypatch, capsys):
    sample = tree / "index.html"
    monkeypatch.setattr(checker, "ALLOWLIST", {"index.html": 1})
    for count, expected in [(0, 0), (1, 0), (2, 1)]:
        sample.write_text('<button>+</button>\n' * count, encoding="utf-8")
        assert checker.main() == expected
        output = capsys.readouterr().out
        if expected:
            assert "index.html:2:" in output
            assert "index.html:1:" not in output


def test_excluded_directories_are_skipped(tree, capsys):
    for directory in ["node_modules", "tests", "archive", "artifacts", "build", "dist"]:
        excluded = tree / "renderer" / directory
        excluded.mkdir()
        (excluded / "bad.js").write_text('<button>+</button>', encoding="utf-8")
    assert checker.main() == 0
    assert "(0 buttons checked)" in capsys.readouterr().out
