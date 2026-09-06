"""Tests for sidecar.ai.engines.ollama_templates."""

from __future__ import annotations

from sidecar.ai.engines.ollama_templates import (
    SCHEMA_VERSION,
    resolve_template,
    resolve_template_from_model_info,
    template_diagnostics,
)

# ---------------------------------------------------------------------------
# Registry basics
# ---------------------------------------------------------------------------


def test_registry_contains_minimum_families() -> None:
    required = {
        "llama3",
        "mistral",
        "gemma",
        "phi",
        "qwen",
        "chatml",
        "lfm2",
        "command-r",
        "deepseek",
        "vicuna",
    }
    assert all(resolve_template(family) is not None for family in required)


def test_schema_version_is_positive_integer() -> None:
    assert isinstance(SCHEMA_VERSION, int)
    assert SCHEMA_VERSION >= 1


# ---------------------------------------------------------------------------
# resolve_template
# ---------------------------------------------------------------------------


def test_resolve_exact_family_match() -> None:
    entry = resolve_template(family="llama3")
    assert entry is not None
    assert entry.family == "llama3"


def test_resolve_prefix_match() -> None:
    entry = resolve_template(family="llama3.2")
    assert entry is not None
    assert entry.family == "llama3"


def test_resolve_from_families_list() -> None:
    entry = resolve_template(families=["bert", "gemma"])
    assert entry is not None
    assert entry.family == "gemma"


def test_resolve_unknown_family_returns_none() -> None:
    entry = resolve_template(family="totally-unknown-model-xyz")
    assert entry is None


def test_resolve_empty_inputs_returns_none() -> None:
    assert resolve_template() is None
    assert resolve_template(family="") is None
    assert resolve_template(families=[]) is None


def test_resolve_case_insensitive() -> None:
    entry = resolve_template(family="Mistral")
    assert entry is not None
    assert entry.family == "mistral"


def test_lfm2_template_matches_official_instruct_markers() -> None:
    entry = resolve_template(family="lfm2")
    assert entry is not None
    assert entry.prompt_start == "<|startoftext|><|im_start|>"
    assert entry.prompt_end == "<|im_end|>"
    assert entry.stop_tokens == ("<|im_end|>",)
    assert entry.suggested_num_ctx == 32768


# ---------------------------------------------------------------------------
# resolve_template_from_model_info
# ---------------------------------------------------------------------------


def test_resolve_from_model_info_details_family() -> None:
    info = {"details": {"family": "qwen"}}
    entry, source = resolve_template_from_model_info(info)
    assert entry is not None
    assert entry.family == "qwen"
    assert source == "details.family"


def test_resolve_from_model_info_details_families() -> None:
    info = {"details": {"family": "unknown-thing", "families": ["gemma"]}}
    entry, source = resolve_template_from_model_info(info)
    assert entry is not None
    assert entry.family == "gemma"
    assert source == "details.families"


def test_resolve_from_model_info_unresolved() -> None:
    info = {"details": {"family": "totally-new-arch"}}
    entry, source = resolve_template_from_model_info(info)
    assert entry is None
    assert source == "unresolved"


def test_resolve_from_model_info_no_metadata() -> None:
    entry, source = resolve_template_from_model_info(None)
    assert entry is None
    assert source == "no_metadata"


def test_resolve_from_model_info_no_details() -> None:
    info = {"model_info": {}}
    entry, source = resolve_template_from_model_info(info)
    assert entry is None
    assert source == "no_details"


# ---------------------------------------------------------------------------
# template_diagnostics
# ---------------------------------------------------------------------------


def test_template_diagnostics_resolved() -> None:
    info = {"details": {"family": "phi"}}
    diag = template_diagnostics("phi3:mini", info)

    assert diag["resolved"] is True
    assert diag["family"] == "phi"
    assert diag["model"] == "phi3:mini"
    assert diag["schema_version"] == SCHEMA_VERSION
    assert isinstance(diag["stop_tokens"], list)
    assert diag["eos_token"]


def test_template_diagnostics_unresolved() -> None:
    info = {"details": {"family": "new-architecture-2027"}}
    diag = template_diagnostics("new-model:7b", info)

    assert diag["resolved"] is False
    assert diag["raw_family"] == "new-architecture-2027"
    assert diag["model"] == "new-model:7b"


def test_template_diagnostics_no_metadata() -> None:
    diag = template_diagnostics("unknown:latest", None)
    assert diag["resolved"] is False
    assert diag["resolution_source"] == "no_metadata"


# ---------------------------------------------------------------------------
# Entry data validation
# ---------------------------------------------------------------------------


def test_all_entries_have_required_fields() -> None:
    for family in (
        "llama3",
        "mistral",
        "gemma",
        "phi",
        "qwen",
        "chatml",
        "lfm2",
        "command-r",
        "deepseek",
        "vicuna",
    ):
        entry = resolve_template(family)
        assert entry is not None
        assert entry.family, f"{family}: missing family"
        assert isinstance(entry.stop_tokens, tuple), f"{family}: stop_tokens should be tuple"
        assert entry.eos_token, f"{family}: missing eos_token"
        assert entry.suggested_num_ctx > 0, f"{family}: suggested_num_ctx must be positive"
