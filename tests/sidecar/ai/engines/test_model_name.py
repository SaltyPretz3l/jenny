from __future__ import annotations

from sidecar.ai.engines.model_name import canonical_model_token


def test_canonical_model_token_strips_hf_registry_namespace() -> None:
    # The hf.co/<org>/ namespace is dropped; the bare family + tag survive,
    # lowercased — the form the family-prefix allowlists match.
    assert (
        canonical_model_token("hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS")
        == "qwen3.6-35b-a3b-gguf:ud-iq4_xs"
    )


def test_canonical_model_token_strips_vllm_style_org_prefix() -> None:
    assert canonical_model_token("Qwen/Qwen3.5-9B") == "qwen3.5-9b"


def test_canonical_model_token_passes_through_unnamespaced_tag() -> None:
    assert canonical_model_token("gpt-oss:20b") == "gpt-oss:20b"
    assert canonical_model_token("qwen3.6:35b-a3b") == "qwen3.6:35b-a3b"


def test_canonical_model_token_lowercases_and_strips_whitespace() -> None:
    assert canonical_model_token("  GPT-OSS:20B  ") == "gpt-oss:20b"


def test_canonical_model_token_handles_empty_and_none() -> None:
    assert canonical_model_token("") == ""
    assert canonical_model_token(None) == ""


def test_canonical_model_token_trailing_slash_yields_empty_segment() -> None:
    # A name that is only/ends with a separator has no final family segment.
    assert canonical_model_token("hf.co/org/") == ""
    assert canonical_model_token("/") == ""
