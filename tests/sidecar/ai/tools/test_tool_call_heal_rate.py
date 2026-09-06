"""The ≥98% malformed-call corpus gate — deterministic proxy for the v1 headline metric.

The tool-call reliability net's success metric is "≥98% well-formed tool calls
post-heal on the owner's daily models". The live-model rate is owner-observed
after soak via the ``ai.router.tool_call_reliability`` event; THIS corpus is the
deterministic stand-in: ≥50 near-miss samples spanning the repair taxonomy must
heal into the expected dispatchable call at a ≥0.98 rate through the REAL seams
(`extract_inband_tool_calls` for in-band text, `_tool_call_arguments` for native
string-typed arguments), while ~10 hopeless/prose samples must produce zero
calls (the false-positive guard — healing must never invent a call).

The flag-OFF baseline assertion documents the delta the net provides: strict
parsing alone recovers (approximately) none of the near-miss corpus.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from sidecar.ai.engines.ollama_runtime import _tool_call_arguments
from sidecar.ai.tools.inband_parser import extract_inband_tool_calls
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing

KNOWN_TOOLS = frozenset(
    {"grep_search", "read_file", "glob_files", "edit_file", "web_search"}
)


@pytest.fixture(autouse=True)
def _reset_healing_flag():
    configure_tool_call_healing(None)
    yield
    configure_tool_call_healing(None)


def _flag(enabled: bool) -> None:
    configure_tool_call_healing({"tool_call_reliability_net_enabled": enabled})


@dataclass(frozen=True)
class Sample:
    sample_id: str
    kind: str  # "inband" (extract_inband_tool_calls) | "native_args" (_tool_call_arguments)
    raw: object
    expected_tool: str | None  # None for native_args samples (tool named elsewhere)
    expected_arguments_subset: dict


# ---------------------------------------------------------------------------
# Near-miss corpus: every sample is a realistic malformed emission that the
# net must heal to the EXACT expected tool + arguments (subset match).
# ---------------------------------------------------------------------------

NEAR_MISS_SAMPLES: tuple[Sample, ...] = (
    # -- trailing commas (in-band, all three wrapper formats) ---------------
    Sample(
        "comma_xml",
        "inband",
        '<tool_call>{"name": "grep_search", "arguments": {"pattern": "TODO",}}</tool_call>',
        "grep_search",
        {"pattern": "TODO"},
    ),
    Sample(
        "comma_fence_json",
        "inband",
        '```json\n{"name": "read_file", "arguments": {"path": "main.py",}}\n```',
        "read_file",
        {"path": "main.py"},
    ),
    Sample(
        "comma_fence_tool_call",
        "inband",
        '```tool_call\n{"name": "glob_files", "arguments": {"pattern": "*.py",}}\n```',
        "glob_files",
        {"pattern": "*.py"},
    ),
    Sample(
        "comma_func",
        "inband",
        'I will search now: grep_search({"pattern": "fixme", "path": "src",})',
        "grep_search",
        {"pattern": "fixme", "path": "src"},
    ),
    Sample(
        "comma_nested",
        "inband",
        '<tool_call>{"name": "edit_file", "arguments": {"path": "a.py", "edits": {"old": "x", "new": "y",},}}</tool_call>',
        "edit_file",
        {"path": "a.py", "edits": {"old": "x", "new": "y"}},
    ),
    Sample(
        "comma_array",
        "inband",
        '<tool_call>{"name": "glob_files", "arguments": {"patterns": ["*.py", "*.md",]}}</tool_call>',
        "glob_files",
        {"patterns": ["*.py", "*.md"]},
    ),
    # -- single quotes -------------------------------------------------------
    Sample(
        "squote_xml",
        "inband",
        "<tool_call>{'name': 'grep_search', 'arguments': {'pattern': 'TODO'}}</tool_call>",
        "grep_search",
        {"pattern": "TODO"},
    ),
    Sample(
        "squote_fence",
        "inband",
        "```json\n{'name': 'read_file', 'arguments': {'path': 'src/app.py'}}\n```",
        "read_file",
        {"path": "src/app.py"},
    ),
    Sample(
        "squote_func",
        "inband",
        "glob_files({'pattern': '**/*.ts'})",
        "glob_files",
        {"pattern": "**/*.ts"},
    ),
    Sample(
        "squote_mixed_keys",
        "inband",
        "<tool_call>{'name': \"web_search\", 'arguments': {'query': 'ollama format schema'}}</tool_call>",
        "web_search",
        {"query": "ollama format schema"},
    ),
    Sample(
        "squote_nested",
        "inband",
        "<tool_call>{'name': 'edit_file', 'arguments': {'path': 'b.py', 'edits': {'old': '1', 'new': '2'}}}</tool_call>",
        "edit_file",
        {"path": "b.py", "edits": {"old": "1", "new": "2"}},
    ),
    # -- Python literals ------------------------------------------------------
    Sample(
        "pyliteral_true",
        "inband",
        '<tool_call>{"name": "grep_search", "arguments": {"pattern": "x", "ignore_case": True}}</tool_call>',
        "grep_search",
        {"pattern": "x", "ignore_case": True},
    ),
    Sample(
        "pyliteral_false",
        "inband",
        '<tool_call>{"name": "web_search", "arguments": {"query": "a", "recent": False}}</tool_call>',
        "web_search",
        {"query": "a", "recent": False},
    ),
    Sample(
        "pyliteral_none",
        "inband",
        '<tool_call>{"name": "read_file", "arguments": {"path": "c.py", "limit": None}}</tool_call>',
        "read_file",
        {"path": "c.py", "limit": None},
    ),
    Sample(
        "pyliteral_fence",
        "inband",
        '```json\n{"name": "grep_search", "arguments": {"pattern": "y", "ignore_case": True, "whole_word": False}}\n```',
        "grep_search",
        {"pattern": "y", "ignore_case": True, "whole_word": False},
    ),
    Sample(
        "pyliteral_func",
        "inband",
        'read_file({"path": "d.py", "follow_symlinks": True})',
        "read_file",
        {"path": "d.py", "follow_symlinks": True},
    ),
    # -- smart quotes ---------------------------------------------------------
    Sample(
        "smart_xml",
        "inband",
        "<tool_call>{“name”: “grep_search”, “arguments”: {“pattern”: “TODO”}}</tool_call>",
        "grep_search",
        {"pattern": "TODO"},
    ),
    Sample(
        "smart_fence",
        "inband",
        "```json\n{“name”: “read_file”, “arguments”: {“path”: “e.py”}}\n```",
        "read_file",
        {"path": "e.py"},
    ),
    Sample(
        "smart_mixed",
        "inband",
        '<tool_call>{“name”: "web_search", “arguments”: {“query”: "rust build"}}</tool_call>',
        "web_search",
        {"query": "rust build"},
    ),
    # -- fenced payloads with prose around them --------------------------------
    Sample(
        "fence_prose_before",
        "inband",
        'Let me look that up.\n```json\n{"name": "web_search", "arguments": {"query": "weather berlin",}}\n```',
        "web_search",
        {"query": "weather berlin"},
    ),
    Sample(
        "fence_prose_after",
        "inband",
        '```json\n{"name": "glob_files", "arguments": {"pattern": "*.rs",}}\n```\nThat should find the files.',
        "glob_files",
        {"pattern": "*.rs"},
    ),
    Sample(
        "fence_no_lang",
        "inband",
        'Running:\n```\n{"name": "grep_search", "arguments": {"pattern": "panic"}}\n```',
        "grep_search",
        {"pattern": "panic"},
    ),
    # -- XML wrapper with malformed interior ------------------------------------
    Sample(
        "xml_squote_comma",
        "inband",
        "<tool_call>{'name': 'glob_files', 'arguments': {'pattern': '*.go',}}</tool_call>",
        "glob_files",
        {"pattern": "*.go"},
    ),
    Sample(
        "xml_pyliteral_comma",
        "inband",
        '<tool_call>{"name": "grep_search", "arguments": {"pattern": "err", "ignore_case": True,}}</tool_call>',
        "grep_search",
        {"pattern": "err", "ignore_case": True},
    ),
    Sample(
        "xml_whitespace_mess",
        "inband",
        '<tool_call>\n\n  {"name": "read_file",\n   "arguments": {"path": "f.py",}}  \n\n</tool_call>',
        "read_file",
        {"path": "f.py"},
    ),
    # -- func-call syntax ------------------------------------------------------
    Sample(
        "func_pyliteral",
        "inband",
        'web_search({"query": "electron sandbox", "recent": True})',
        "web_search",
        {"query": "electron sandbox", "recent": True},
    ),
    Sample(
        "func_squote",
        "inband",
        "grep_search({'pattern': 'unwrap', 'path': 'src'})",
        "grep_search",
        {"pattern": "unwrap", "path": "src"},
    ),
    # -- nested-brace arguments -------------------------------------------------
    Sample(
        "nested_xml",
        "inband",
        '<tool_call>{"name": "edit_file", "arguments": {"path": "g.py", "edits": {"a": {"b": 1}}}}</tool_call>',
        "edit_file",
        {"path": "g.py", "edits": {"a": {"b": 1}}},
    ),
    Sample(
        "nested_fence_comma",
        "inband",
        '```json\n{"name": "edit_file", "arguments": {"path": "h.py", "edits": {"old": "a", "new": "b"},}}\n```',
        "edit_file",
        {"path": "h.py", "edits": {"old": "a", "new": "b"}},
    ),
    Sample(
        "nested_deep",
        "inband",
        '<tool_call>{"name": "edit_file", "arguments": {"path": "i.py", "edits": {"x": {"y": {"z": "deep"}}},}}</tool_call>',
        "edit_file",
        {"path": "i.py", "edits": {"x": {"y": {"z": "deep"}}}},
    ),
    # -- bare object mid-prose (no wrapper at all; fourth pass) ------------------
    Sample(
        "bare_mid_prose",
        "inband",
        'I need to check the file. {"name": "read_file", "arguments": {"path": "j.py"}} Running it now.',
        "read_file",
        {"path": "j.py"},
    ),
    Sample(
        "bare_nested",
        "inband",
        'Executing {"name": "edit_file", "arguments": {"path": "k.py", "edits": {"old": "q", "new": "r"}}} for you.',
        "edit_file",
        {"path": "k.py", "edits": {"old": "q", "new": "r"}},
    ),
    Sample(
        "bare_start_of_text",
        "inband",
        '{"name": "web_search", "arguments": {"query": "python 3.13 release date"}}',
        "web_search",
        {"query": "python 3.13 release date"},
    ),
    # -- combination cases --------------------------------------------------------
    Sample(
        "combo_fence_comma_pyliteral",
        "inband",
        'Sure!\n```json\n{"name": "grep_search", "arguments": {"pattern": "def ", "ignore_case": False,}}\n```',
        "grep_search",
        {"pattern": "def ", "ignore_case": False},
    ),
    Sample(
        "combo_xml_smart_comma",
        "inband",
        "<tool_call>{“name”: “glob_files”, “arguments”: {“pattern”: “*.css”,}}</tool_call>",
        "glob_files",
        {"pattern": "*.css"},
    ),
    Sample(
        "combo_prose_nested_comma",
        "inband",
        'On it. {"name": "edit_file", "arguments": {"path": "l.py", "edits": {"old": "m", "new": "n",},}} Done.',
        "edit_file",
        {"path": "l.py", "edits": {"old": "m", "new": "n"}},
    ),
    Sample(
        "combo_fence_squote_pyliteral",
        "inband",
        "```tool_call\n{'name': 'web_search', 'arguments': {'query': 'gguf quant', 'recent': True}}\n```",
        "web_search",
        {"query": "gguf quant", "recent": True},
    ),
    # -- native string-typed arguments (the silently-dropped-to-{} bug class) -----
    Sample(
        "nargs_clean_string",
        "native_args",
        '{"pattern": "TODO"}',
        None,
        {"pattern": "TODO"},
    ),
    Sample(
        "nargs_trailing_comma",
        "native_args",
        '{"pattern": "x", "path": "src",}',
        None,
        {"pattern": "x", "path": "src"},
    ),
    Sample(
        "nargs_single_quotes",
        "native_args",
        "{'query': 'chess opening'}",
        None,
        {"query": "chess opening"},
    ),
    Sample(
        "nargs_python_literals",
        "native_args",
        '{"pattern": "y", "ignore_case": True, "limit": None}',
        None,
        {"pattern": "y", "ignore_case": True, "limit": None},
    ),
    Sample(
        "nargs_smart_quotes",
        "native_args",
        "{“path”: “m.py”}",
        None,
        {"path": "m.py"},
    ),
    Sample(
        "nargs_unterminated_string",
        "native_args",
        '{"pattern": "TODO", "path": "sr',
        None,
        {"pattern": "TODO", "path": "sr"},
    ),
    Sample(
        "nargs_unterminated_brace",
        "native_args",
        '{"pattern": "*.py"',
        None,
        {"pattern": "*.py"},
    ),
    Sample(
        "nargs_unterminated_nested",
        "native_args",
        '{"path": "n.py", "edits": {"old": "u", "new": "v"',
        None,
        {"path": "n.py", "edits": {"old": "u", "new": "v"}},
    ),
    Sample(
        "nargs_unterminated_array",
        "native_args",
        '{"patterns": ["*.py", "*.md"',
        None,
        {"patterns": ["*.py", "*.md"]},
    ),
    Sample(
        "nargs_fenced_string",
        "native_args",
        '```json\n{"query": "sqlite wal"}\n```',
        None,
        {"query": "sqlite wal"},
    ),
    Sample(
        "nargs_combo",
        "native_args",
        "{'pattern': 'raise', 'ignore_case': True,}",
        None,
        {"pattern": "raise", "ignore_case": True},
    ),
    # -- unterminated in-band payloads that still carry their wrapper anchors ----
    Sample(
        "unterminated_fourth_pass_tagless",
        "inband",
        '<tool_call>{"name": "grep_search", "arguments": {"pattern": "z"}}',
        "grep_search",
        {"pattern": "z"},
    ),
    Sample(
        "unterminated_fence_missing_close",
        "inband",
        '```json\n{"name": "read_file", "arguments": {"path": "o.py"}}\n',
        "read_file",
        {"path": "o.py"},
    ),
    Sample(
        "xml_unterminated_string_with_member",
        "inband",
        '<tool_call>{"name": "web_search", "arguments": {"query": "a", "site": "b"}}</tool_call>extra',
        "web_search",
        {"query": "a", "site": "b"},
    ),
    Sample(
        "bare_mid_prose_comma",
        "inband",
        'Let me grep. {"name": "grep_search", "arguments": {"pattern": "impl",}} one moment.',
        "grep_search",
        {"pattern": "impl"},
    ),
    Sample(
        "bare_pyliteral",
        "inband",
        'Checking: {"name": "glob_files", "arguments": {"pattern": "*.tsx", "recursive": True}}',
        "glob_files",
        {"pattern": "*.tsx", "recursive": True},
    ),
    Sample(
        "bare_smart_quote",
        "inband",
        "Search: {“name”: “web_search”, “arguments”: {“query”: “vram budget”}}",
        "web_search",
        {"query": "vram budget"},
    ),
)

# ---------------------------------------------------------------------------
# Hopeless / prose samples: MUST NOT produce a call (the false-positive guard).
# ---------------------------------------------------------------------------

HOPELESS_SAMPLES: tuple[Sample, ...] = (
    Sample("hopeless_truncated_name", "inband", '{"name": "gr', None, {}),
    Sample(
        "hopeless_prose_mention",
        "inband",
        "You could use grep_search to find that, or read_file to inspect it.",
        None,
        {},
    ),
    Sample("hopeless_braces", "inband", "{{{{", None, {}),
    Sample("hopeless_empty", "inband", "", None, {}),
    Sample(
        "hopeless_unknown_tool_healable",
        "inband",
        "<tool_call>{'name': 'launch_missiles', 'arguments': {'target': 'x',}}</tool_call>",
        None,
        {},
    ),
    Sample(
        "hopeless_unknown_func",
        "inband",
        'The right call is foo_tool({"a": 1}) here.',
        None,
        {},
    ),
    Sample(
        "hopeless_prose_with_json_words",
        "inband",
        'The arguments should include a "name" and a "pattern" key.',
        None,
        {},
    ),
    Sample(
        "hopeless_truncated_first_value",
        "inband",
        '<tool_call>{"name": "read_file", "arguments": {"path": "ma</tool_call>',
        None,
        {},
    ),
    Sample("hopeless_nargs_garbage", "native_args", "@@@", None, {}),
    Sample("hopeless_nargs_non_dict_json", "native_args", "[1, 2, 3]", None, {}),
    Sample("hopeless_nargs_number", "native_args", 42, None, {}),
    Sample(
        "hopeless_prose_config_blob_named_like_tool",
        "inband",
        'The tool registry entry looks like {"name": "read_file", "enabled": true} in config.',
        None,
        {},
    ),
    Sample(
        "hopeless_bare_name_only_object",
        "inband",
        '{"name": "grep_search"}',
        None,
        {},
    ),
)


def _subset_match(actual: dict, expected: dict) -> bool:
    for key, value in expected.items():
        if key not in actual or actual[key] != value:
            return False
    return True


def _sample_succeeds(sample: Sample) -> bool:
    """Run one sample through its REAL seam; True when the expected call emerges."""
    if sample.kind == "inband":
        calls, _remaining = extract_inband_tool_calls(str(sample.raw), KNOWN_TOOLS)
        if len(calls) != 1:
            return False
        call = calls[0]
        if sample.expected_tool is not None and call.tool_id != sample.expected_tool:
            return False
        return _subset_match(call.arguments, sample.expected_arguments_subset)
    if sample.kind == "native_args":
        arguments = _tool_call_arguments(sample.raw)
        if not sample.expected_arguments_subset:
            return bool(arguments)
        return _subset_match(arguments, sample.expected_arguments_subset)
    raise AssertionError(f"unknown sample kind: {sample.kind}")


def _sample_produces_any_call(sample: Sample) -> bool:
    """False-positive probe: does the sample yield ANY call/args at all?"""
    if sample.kind == "inband":
        calls, _ = extract_inband_tool_calls(str(sample.raw), KNOWN_TOOLS)
        return bool(calls)
    arguments = _tool_call_arguments(sample.raw)
    return bool(arguments)


def test_corpus_composition_is_large_enough() -> None:
    assert len(NEAR_MISS_SAMPLES) >= 50, len(NEAR_MISS_SAMPLES)
    assert len(HOPELESS_SAMPLES) >= 10, len(HOPELESS_SAMPLES)
    ids = [s.sample_id for s in NEAR_MISS_SAMPLES + HOPELESS_SAMPLES]
    assert len(ids) == len(set(ids)), "duplicate sample ids"


def test_post_heal_well_formed_rate_is_at_least_98_percent() -> None:
    """THE HEADLINE GATE: ≥98% of near-miss intents heal into the expected call."""
    _flag(True)
    failures = [s.sample_id for s in NEAR_MISS_SAMPLES if not _sample_succeeds(s)]
    rate = (len(NEAR_MISS_SAMPLES) - len(failures)) / len(NEAR_MISS_SAMPLES)
    assert rate >= 0.98, (
        f"post-heal well-formed rate {rate:.4f} < 0.98; failing samples: {failures}"
    )


def test_zero_false_positives_on_hopeless_and_prose_samples() -> None:
    """Healing must never invent a call — the R1 defect this net must not ship."""
    _flag(True)
    invented = [s.sample_id for s in HOPELESS_SAMPLES if _sample_produces_any_call(s)]
    assert invented == [], f"healing invented calls for: {invented}"


def test_flag_off_baseline_documents_the_delta() -> None:
    """Documentation assert: strict parsing recovers ~none of the corpus.

    With the net disabled (shipped default), the same near-miss corpus passes
    at <= 0.5 (measured near 0). This is the delta the reliability net
    provides; if strict parsing ever starts passing a large share of the
    corpus, the corpus has gone stale and must be re-hardened.
    """
    _flag(False)
    baseline_successes = [s.sample_id for s in NEAR_MISS_SAMPLES if _sample_succeeds(s)]
    baseline_rate = len(baseline_successes) / len(NEAR_MISS_SAMPLES)
    assert baseline_rate <= 0.5, (
        f"flag-off baseline unexpectedly high ({baseline_rate:.4f}): "
        f"{baseline_successes}"
    )


def test_flag_off_never_produces_calls_from_hopeless_samples() -> None:
    _flag(False)
    invented = [s.sample_id for s in HOPELESS_SAMPLES if _sample_produces_any_call(s)]
    assert invented == [], f"strict parsing invented calls for: {invented}"


def test_healed_inband_calls_are_never_marked_coerced() -> None:
    """Route-policy pin: healed calls dispatch native (no ``coerced`` downgrade)."""
    _flag(True)
    for sample in NEAR_MISS_SAMPLES:
        if sample.kind != "inband":
            continue
        calls, _ = extract_inband_tool_calls(str(sample.raw), KNOWN_TOOLS)
        for call in calls:
            assert getattr(call, "coerced", False) is False, sample.sample_id
