from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from sidecar.ai.plugins.runtime_apply_stage7 import build_generation_v5
from sidecar.ai.plugins.runtime_contracts import PluginRuntimeContractError


def _provider_content() -> tuple[dict[str, object], str]:
    fixture = json.loads(
        Path("tests/fixtures/plugins/contract-parity/shards/stage7-v5.json").read_text(
            encoding="utf-8"
        )
    )
    descriptor = next(
        item["value"] for item in fixture["cases"] if item["id"] == "stage7_provider_valid"
    )
    content_json = json.dumps(descriptor, sort_keys=True, separators=(",", ":"))
    return descriptor, content_json


def _snapshot(descriptor: dict[str, object], digest: str) -> dict[str, object]:
    return {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 5,
        "registry_revision": 1,
        "dependency_graph_hash": "1" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen_1",
        "declarative_content": [],
        "remote_mcp_bindings": [],
        "restricted_contributions": [],
        "view_contributions": [],
        "provider_descriptors": [
            {
                "publisher_id": "openai",
                "plugin_id": "chatgpt_subscription",
                "contribution_id": "provider",
                "provider_id": descriptor["provider_id"],
                "engine_type": descriptor["engine_type"],
                "artifact_digest": "b" * 64,
                "descriptor_digest": digest,
            }
        ],
    }


def test_provider_content_must_match_advertised_descriptor_digest() -> None:
    descriptor, content_json = _provider_content()
    claimed_digest = "a" * 64

    with pytest.raises(PluginRuntimeContractError) as raised:
        build_generation_v5(
            _snapshot(descriptor, claimed_digest),
            [{"content_digest": claimed_digest, "content_json": content_json}],
        )

    assert raised.value.reason_code == "runtime_content_digest_mismatch"


def test_duplicate_provider_content_envelopes_are_rejected() -> None:
    descriptor, content_json = _provider_content()
    digest = hashlib.sha256(content_json.encode("utf-8")).hexdigest()
    envelope = {"content_digest": digest, "content_json": content_json}

    with pytest.raises(PluginRuntimeContractError) as raised:
        build_generation_v5(_snapshot(descriptor, digest), [envelope, dict(envelope)])

    assert raised.value.reason_code == "runtime_content_envelope_duplicate"
