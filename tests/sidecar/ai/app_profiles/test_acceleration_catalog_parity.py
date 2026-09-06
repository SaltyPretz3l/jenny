"""Parity guards for the managed llama-server acceleration catalog."""

from __future__ import annotations

import json
from pathlib import Path

from sidecar.ai.app_profiles import canonicalize_model_name, resolve_profile


REPO_ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = REPO_ROOT / "config" / "model-acceleration-catalog.json"


def test_acceleration_catalog_matches_app_profile_registry() -> None:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))

    for entry in catalog["families"]:
        family = entry["family"]
        family_profile = resolve_profile(family)
        assert family_profile is not None
        assert family_profile.family == family

        for prefix in entry["matchPrefixes"]:
            assert canonicalize_model_name(prefix) == prefix
            profile = resolve_profile(prefix)
            assert profile is not None, f"matchPrefix {prefix!r} must resolve to a profile"
            assert profile.family == family

        assert entry["mtp"] in {"yes", "unverified", "no"}
        assert entry["mtpShape"] in {"native", "separate"}
        if entry["mtpShape"] == "separate":
            assert entry.get("drafterPattern")
