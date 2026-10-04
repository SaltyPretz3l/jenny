from scripts.checks import check_no_raw_html_primitives as checker


def test_primitive_counts_are_independent_of_line_layout(tmp_path, monkeypatch):
    source = tmp_path / "renderer.js"
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    monkeypatch.setattr(checker, "iter_scan_files", lambda: [source])
    source.write_text("<button/><input/><select/>\ncreateElement('button'); createElement('input');", encoding="utf-8")
    occurrences = checker.collect_occurrences()
    assert occurrences[("renderer.js", "html_tag")] == ["renderer.js:1"] * 3
    assert occurrences[("renderer.js", "create_element")] == ["renderer.js:2"] * 2
    source.write_text("<button/>\n<input/>\n<select/>\ncreateElement(\n'button');\ncreateElement('input');", encoding="utf-8")
    occurrences = checker.collect_occurrences()
    assert len(occurrences[("renderer.js", "html_tag")]) == 3
    assert occurrences[("renderer.js", "create_element")] == ["renderer.js:4", "renderer.js:6"]
