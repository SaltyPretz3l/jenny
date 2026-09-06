from __future__ import annotations

import pytest

from sidecar.ai.app_profiles import resolve_profile, resolve_variant


@pytest.mark.parametrize(
    ("model_name", "expected_family", "expected_variant"),
    [
        ("qwen3.6:35b-a3b", "qwen36", "35b-a3b"),
        ("Qwen/Qwen3.6-35B-A3B-Instruct", "qwen36", "35b-a3b"),
        ("gemma4:26b-a4b-it", "gemma4", "26b-a4b"),
        ("google/gemma-4-26B-A4B-it", "gemma4", "26b-a4b"),
    ],
)
def test_app_profile_selection_matches_known_local_model_tags(
    model_name: str,
    expected_family: str,
    expected_variant: str,
) -> None:
    profile = resolve_profile(model_name)

    assert profile is not None
    assert profile.family == expected_family
    assert resolve_variant(profile, model_name).name == expected_variant


def test_app_profile_selection_ignores_stale_explicit_profile() -> None:
    profile = resolve_profile("gemma4:26b-a4b-it", explicit="qwen36")

    assert profile is not None
    assert profile.family == "gemma4"


def test_app_profile_selection_accepts_matching_explicit_profile() -> None:
    profile = resolve_profile("qwen3.6:35b-a3b", explicit="qwen36")

    assert profile is not None
    assert profile.family == "qwen36"
