import pytest

from scripts.checks.check_event_taxonomy_drift import _extract_js_set_entries


def test_literals_after_comments_are_preserved():
    source = "const K = new Set(['first', // comment, ignored\n 'extra', /* block */ 'last']);"
    assert _extract_js_set_entries(source, "K") == {"first", "extra", "last"}


@pytest.mark.parametrize("member", ["unknown", "'prefix' + suffix", "...OTHER.map(fn)"])
def test_unresolved_members_fail_closed(member):
    with pytest.raises(ValueError):
        _extract_js_set_entries("const K = new Set(['first', " + member + "]);", "K")


def test_spread_sets_resolve_and_cycles_fail_closed():
    assert _extract_js_set_entries("const A = new Set(['a']); const B = new Set([...A, 'b']);", "B") == {"a", "b"}
    with pytest.raises(ValueError):
        _extract_js_set_entries("const A = new Set([...A]);", "A")


def test_commented_declarations_are_ignored():
    source = "// const K = new Set(['decoy']);\nconst K = new Set(['real']);"
    assert _extract_js_set_entries(source, "K") == {"real"}


def test_js_escapes_and_commas_inside_members_are_resolved():
    source = r"const K = new Set(['comma,member', 'escaped\u005fmember']);"
    assert _extract_js_set_entries(source, "K") == {"comma,member", "escaped_member"}
