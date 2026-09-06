from __future__ import annotations

import hashlib
import json
from copy import deepcopy

import pytest

from sidecar.ai.context.builder_plugins import PluginContextItem
from sidecar.ai.error_codes import (
    CMP_CHAT_INVALID_PARAMS,
    CMP_PLUGIN_EPOCH_REGRESSION,
    CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT,
    CMP_PLUGIN_LEASE_BUSY,
    CMP_PLUGIN_OUTCOME_INDETERMINATE,
)
from sidecar.ai.plugins.runtime_apply import (
    RESOURCE_KINDS,
    PluginRuntimeContractError,
    apply_plugin_runtime,
)
from sidecar.ai.plugins.runtime_registry import (
    MAX_UNLEASED_GENERATIONS,
    PluginAuthorityMismatchError,
    PluginProviderDescriptor,
    PluginRuntimeAdmissionError,
    PluginRuntimeAuthority,
    PluginRuntimeFencedError,
    PluginRuntimeGeneration,
    PluginRuntimePublicationError,
    PluginRuntimeRegistry,
    admit_plugin_runtime,
)


def _generation(index: int) -> PluginRuntimeGeneration:
    authority = PluginRuntimeAuthority(
        registry_revision=index + 1,
        dependency_graph_hash=f"{index + 1:064x}",
        commit_epoch=index + 1,
        active_generation_id=f"gen-{index + 1}",
    )
    contribution = PluginContextItem(
        publisher_id="jenny-official",
        plugin_id="starter",
        contribution_id=f"skill-{index + 1}",
        kind="skill",
        content_digest=f"{index + 2:064x}",
        content=f"instruction {index + 1}",
    )
    return PluginRuntimeGeneration(authority, f"sidecar-gen-{index + 1}", (contribution,))


def _assert_published(
    registry: PluginRuntimeRegistry,
    generation: PluginRuntimeGeneration,
) -> None:
    with registry.lease(generation.authority) as leased:
        assert leased is generation


def test_leased_turn_keeps_immutable_generation_across_publication() -> None:
    registry = PluginRuntimeRegistry()
    first = _generation(0)
    second = _generation(1)
    registry.publish(first)
    with registry.lease(first.authority) as leased:
        registry.publish(second)
        assert leased is first
        assert "instruction 1" in registry.build_turn_overlays()[0]
    assert registry.build_turn_overlays() == ()
    with pytest.raises(PluginAuthorityMismatchError):
        with registry.lease(first.authority):
            pass


def test_provider_binding_is_invalidated_by_generation_publication() -> None:
    registry = PluginRuntimeRegistry()
    first_base = _generation(0)
    provider = PluginProviderDescriptor(
        provider_id="chatgpt",
        engine_type="chatgpt",
        descriptor_digest="a" * 64,
        descriptor={"provider_id": "chatgpt"},
    )
    first = PluginRuntimeGeneration(
        first_base.authority,
        first_base.sidecar_plugin_generation,
        first_base.contributions,
        providers=(provider,),
    )
    registry.publish(first)
    binding = registry.current_provider_binding("chatgpt")
    assert binding is not None
    assert registry.is_provider_binding_current(binding) is True
    registry.publish(_generation(1))
    assert registry.is_provider_binding_current(binding) is False


def test_pin_can_be_acquired_before_worker_registration_then_bound_and_released() -> None:
    registry = PluginRuntimeRegistry()
    first = _generation(0)
    second = _generation(1)
    registry.publish(first)
    pin = registry.acquire_pin(first.authority)
    registry.publish(second)
    with pin.bind() as generation:
        assert generation is first
        assert "instruction 1" in registry.build_turn_overlays()[0]
    pin.release()
    pin.release()
    with pytest.raises(RuntimeError, match="released"):
        with pin.bind():
            pass


def test_fence_blocks_new_plugin_admissions_but_not_core_only_state() -> None:
    registry = PluginRuntimeRegistry()
    generation = _generation(0)
    registry.publish(generation)
    registry.fence("enable")
    with pytest.raises(PluginRuntimeFencedError):
        with registry.lease(generation.authority):
            pass
    registry.unfence()
    _assert_published(registry, generation)


def test_registry_retains_at_most_four_unleased_noncurrent_generations() -> None:
    events: list[tuple[str, dict[str, object]]] = []
    registry = PluginRuntimeRegistry(event_sink=lambda event, data: events.append((event, data)))
    generations = [_generation(index) for index in range(MAX_UNLEASED_GENERATIONS + 3)]
    first = generations[0]
    registry.publish(first)
    with registry.lease(first.authority):
        for generation in generations[1:]:
            registry.publish(generation)
        assert "instruction 1" in registry.build_turn_overlays()[0]
    with pytest.raises(PluginAuthorityMismatchError):
        with registry.lease(first.authority):
            pass
    _assert_published(registry, generations[-1])
    evictions = [event for event, _data in events if event == "plugin.runtime.generation_evicted"]
    assert len(evictions) == len(generations) - (MAX_UNLEASED_GENERATIONS + 1)


def test_commit_epoch_regression_and_authority_reuse_are_rejected() -> None:
    registry = PluginRuntimeRegistry()
    older = _generation(0)
    newer = _generation(1)
    registry.publish(newer)
    with pytest.raises(PluginRuntimePublicationError) as epoch_error:
        registry.publish(older)
    assert epoch_error.value.reason_code == "runtime_commit_epoch_regression"
    changed_same_authority = PluginRuntimeGeneration(
        newer.authority,
        newer.sidecar_plugin_generation,
        older.contributions,
    )
    registry = PluginRuntimeRegistry()
    registry.publish(newer)
    with pytest.raises(PluginRuntimePublicationError) as reused_error:
        registry.publish(changed_same_authority)
    assert reused_error.value.reason_code == "runtime_authority_reused"


def _content_json(
    kind: str,
    contribution_id: str,
    text: str,
    *,
    publisher_id: str = "jenny-official",
    plugin_id: str = "starter",
) -> tuple[str, str]:
    payload = {"kind": kind, "instructions" if kind == "skill" else "template": text}
    value = {
        "content_schema_version": 1,
        "publisher_id": publisher_id,
        "plugin_id": plugin_id,
        "contribution_id": contribution_id,
        "payload": payload,
    }
    exact = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return exact, hashlib.sha256(exact.encode("utf-8")).hexdigest()


def _runtime_spec(
    revision: int,
    epoch: int,
    contributions: tuple[tuple[str, str, str], ...] = (("skill", "skill-main", "Use {input} verbatim."),),
) -> tuple[dict[str, object], list[dict[str, str]]]:
    declarative: dict[str, list[dict[str, str]]] = {
        "skill_scopes": [],
        "prompts": [],
        "themes": [],
        "settings_schemas": [],
        "commands": [],
        "workflows": [],
        "mcp_descriptors": [],
    }
    envelope: list[dict[str, str]] = []
    for index, (kind, contribution_id, text) in enumerate(contributions):
        exact, digest = _content_json(kind, contribution_id, text)
        array_name = "skill_scopes" if kind == "skill" else "prompts"
        declarative[array_name].append({
            "publisher_id": "jenny-official",
            "plugin_id": "starter",
            "contribution_id": contribution_id,
            "artifact_digest": f"{index + 100:064x}",
            "content_digest": digest,
        })
        envelope.append({"content_digest": digest, "content_json": exact})
    return ({
        "kind": "plugin_runtime_snapshot",
        "registry_revision": revision,
        "dependency_graph_hash": f"{revision + 200:064x}",
        "commit_epoch": epoch,
        "active_generation_id": f"gen-runtime-{revision}",
        "declarative_content": declarative,
    }, envelope)


def _resource_objects() -> dict[str, object]:
    return {kind: object() for kind in RESOURCE_KINDS}


def _first_descriptor(snapshot: dict[str, object]) -> dict[str, str]:
    declarative = snapshot["declarative_content"]
    assert isinstance(declarative, dict)
    descriptors = declarative["skill_scopes"]
    assert isinstance(descriptors, list) and descriptors
    descriptor = descriptors[0]
    assert isinstance(descriptor, dict)
    return descriptor


def _replace_content(
    snapshot: dict[str, object],
    envelope: list[dict[str, str]],
    exact: str,
) -> None:
    digest = hashlib.sha256(exact.encode("utf-8", errors="surrogatepass")).hexdigest()
    _first_descriptor(snapshot)["content_digest"] = digest
    envelope[:] = [{"content_digest": digest, "content_json": exact}]


def test_exact_apply_is_deterministic_all_or_nothing_and_returns_exact_attestation() -> None:
    registry = PluginRuntimeRegistry()
    resources = _resource_objects()
    snapshot, envelope = _runtime_spec(
        1,
        1,
        (
            ("skill", "skill-z", "No interpolation: {input}"),
            ("prompt", "prompt-a", "Prompt ${value} verbatim"),
        ),
    )
    publication = apply_plugin_runtime(
        registry,
        snapshot=snapshot,
        declarative_content=envelope,
        resource_provider=lambda: resources,
    )
    assert [item.contribution_id for item in publication.generation.contributions] == [
        "prompt-a",
        "skill-z",
    ]
    assert publication.generation.contributions[0].content == "Prompt ${value} verbatim"
    assert publication.attestation == {
        "attestation_schema_version": 1,
        "participant_kind": "sidecar",
        "registry_revision": 1,
        "dependency_graph_hash": snapshot["dependency_graph_hash"],
        "commit_epoch": 1,
        "sidecar_plugin_generation": publication.generation.sidecar_plugin_generation,
        "reused_resource_proofs": publication.attestation["reused_resource_proofs"],
        "rejected_contributions": [],
    }
    proofs = publication.attestation["reused_resource_proofs"]
    assert isinstance(proofs, list)
    assert [proof["resource_kind"] for proof in proofs] == list(RESOURCE_KINDS)
    assert all(len(str(proof["digest"])) == 64 for proof in proofs)


def test_malformed_mismatched_or_later_content_never_replaces_prior_registry() -> None:
    registry = PluginRuntimeRegistry()
    resources = _resource_objects()
    prior_snapshot, prior_envelope = _runtime_spec(1, 1)
    prior = apply_plugin_runtime(
        registry,
        snapshot=prior_snapshot,
        declarative_content=prior_envelope,
        resource_provider=lambda: resources,
    )

    candidates: list[tuple[str, dict[str, object], list[dict[str, str]]]] = []
    for reason, raw in (
        ("runtime_content_json_invalid", "{"),
        (
            "runtime_content_json_invalid",
            '{"content_schema_version":1,"publisher_id":"jenny-official",'
            '"publisher_id":"duplicate","plugin_id":"starter",'
            '"contribution_id":"skill-main","payload":{"kind":"skill","instructions":"x"}}',
        ),
    ):
        snapshot, envelope = _runtime_spec(2, 2)
        _replace_content(snapshot, envelope, raw)
        candidates.append((reason, snapshot, envelope))

    snapshot, envelope = _runtime_spec(2, 2)
    envelope[0]["content_json"] += " "
    candidates.append(("runtime_content_digest_mismatch", snapshot, envelope))

    snapshot, envelope = _runtime_spec(2, 2)
    exact, _digest = _content_json("skill", "skill-other", "different identity")
    _replace_content(snapshot, envelope, exact)
    candidates.append(("runtime_content_identity_mismatch", snapshot, envelope))

    snapshot, envelope = _runtime_spec(2, 2)
    exact, _digest = _content_json("prompt", "skill-main", "wrong kind")
    _replace_content(snapshot, envelope, exact)
    candidates.append(("runtime_content_identity_mismatch", snapshot, envelope))

    snapshot, _envelope = _runtime_spec(2, 2)
    candidates.append(("runtime_content_closure_mismatch", snapshot, []))

    snapshot, envelope = _runtime_spec(2, 2)
    envelope.append(dict(envelope[0]))
    candidates.append(("runtime_content_envelope_duplicate", snapshot, envelope))

    snapshot, envelope = _runtime_spec(2, 2)
    exact, digest = _content_json("skill", "skill-extra", "extra")
    envelope.append({"content_digest": digest, "content_json": exact})
    candidates.append(("runtime_content_closure_mismatch", snapshot, envelope))

    snapshot, envelope = _runtime_spec(2, 2)
    declarative = snapshot["declarative_content"]
    assert isinstance(declarative, dict)
    declarative["commands"] = [dict(_first_descriptor(snapshot))]
    candidates.append(("runtime_surface_not_supported", snapshot, envelope))

    snapshot, envelope = _runtime_spec(2, 2)
    envelope[0]["content_json"] = "\ud800"
    candidates.append(("runtime_content_utf8_invalid", snapshot, envelope))

    for expected_reason, snapshot, envelope in candidates:
        with pytest.raises(PluginRuntimeContractError) as error:
            apply_plugin_runtime(
                registry,
                snapshot=snapshot,
                declarative_content=envelope,
                resource_provider=lambda: resources,
            )
        assert error.value.reason_code == expected_reason
        if expected_reason == "runtime_content_identity_mismatch":
            assert error.value.rejected_contributions[0]["contribution_id"] == "skill-main"
        _assert_published(registry, prior.generation)


def test_reapply_is_idempotent_and_authority_regressions_fail_closed() -> None:
    registry = PluginRuntimeRegistry()
    resources = _resource_objects()
    snapshot, envelope = _runtime_spec(2, 2)
    first = apply_plugin_runtime(
        registry,
        snapshot=snapshot,
        declarative_content=envelope,
        resource_provider=lambda: resources,
    )
    repeated = apply_plugin_runtime(
        registry,
        snapshot=deepcopy(snapshot),
        declarative_content=deepcopy(envelope),
        resource_provider=lambda: resources,
    )
    assert repeated == first

    changed_snapshot = deepcopy(snapshot)
    changed_envelope = deepcopy(envelope)
    exact, _digest = _content_json("skill", "skill-main", "different bytes")
    _replace_content(changed_snapshot, changed_envelope, exact)
    with pytest.raises(PluginRuntimeContractError) as reused:
        apply_plugin_runtime(
            registry,
            snapshot=changed_snapshot,
            declarative_content=changed_envelope,
            resource_provider=lambda: resources,
        )
    assert reused.value.code == CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT

    for revision, epoch in ((3, 1), (2, 3)):
        regressed_snapshot, regressed_envelope = _runtime_spec(revision, epoch)
        with pytest.raises(PluginRuntimeContractError) as regressed:
            apply_plugin_runtime(
                registry,
                snapshot=regressed_snapshot,
                declarative_content=regressed_envelope,
                resource_provider=lambda: resources,
            )
        assert regressed.value.code == CMP_PLUGIN_EPOCH_REGRESSION
        _assert_published(registry, first.generation)


def test_resource_identity_change_refuses_publication_with_opaque_error() -> None:
    registry = PluginRuntimeRegistry()
    stable = _resource_objects()
    calls = 0

    def changing_provider() -> dict[str, object]:
        nonlocal calls
        calls += 1
        current = dict(stable)
        if calls > 1:
            current["tool"] = object()
        return current

    snapshot, envelope = _runtime_spec(1, 1)
    with pytest.raises(PluginRuntimeContractError) as error:
        apply_plugin_runtime(
            registry,
            snapshot=snapshot,
            declarative_content=envelope,
            resource_provider=changing_provider,
        )
    assert error.value.code == CMP_PLUGIN_OUTCOME_INDETERMINATE
    assert error.value.reason_code == "runtime_resource_identity_changed"
    with pytest.raises(PluginAuthorityMismatchError):
        with registry.lease(PluginRuntimeAuthority(1, "1" * 64, 1, "gen-1")):
            pass


def test_admission_is_exact_core_or_pinned_plugin_authority() -> None:
    registry = PluginRuntimeRegistry()
    resources = _resource_objects()
    first_snapshot, first_envelope = _runtime_spec(1, 1)
    first = apply_plugin_runtime(
        registry,
        snapshot=first_snapshot,
        declarative_content=first_envelope,
        resource_provider=lambda: resources,
    )
    assert admit_plugin_runtime(registry, None).mode == "core_only"
    assert admit_plugin_runtime(registry, {"mode": "core_only"}).mode == "core_only"

    authority_payload = {
        "mode": "plugin",
        "registry_revision": first.generation.authority.registry_revision,
        "dependency_graph_hash": first.generation.authority.dependency_graph_hash,
        "commit_epoch": first.generation.authority.commit_epoch,
        "active_generation_id": first.generation.authority.active_generation_id,
    }
    admission = admit_plugin_runtime(registry, authority_payload)
    assert admission.mode == "plugin"
    assert admission.pin is not None

    second_snapshot, second_envelope = _runtime_spec(2, 2)
    second = apply_plugin_runtime(
        registry,
        snapshot=second_snapshot,
        declarative_content=second_envelope,
        resource_provider=lambda: resources,
    )
    with admission.pin.bind() as pinned:
        assert pinned is first.generation
    admission.release()

    with pytest.raises(PluginRuntimeAdmissionError) as stale:
        admit_plugin_runtime(registry, authority_payload)
    assert stale.value.code == CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT
    assert stale.value.retryable is True

    current = second.generation.authority
    registry.fence("enable")
    with pytest.raises(PluginRuntimeAdmissionError) as fenced:
        admit_plugin_runtime(registry, {
            "mode": "plugin",
            "registry_revision": current.registry_revision,
            "dependency_graph_hash": current.dependency_graph_hash,
            "commit_epoch": current.commit_epoch,
            "active_generation_id": current.active_generation_id,
        })
    assert fenced.value.code == CMP_PLUGIN_LEASE_BUSY
    registry.unfence()

    for malformed in ({"mode": "core_only", "extra": True}, {"mode": "plugin"}, "plugin"):
        with pytest.raises(PluginRuntimeAdmissionError) as invalid:
            admit_plugin_runtime(registry, malformed)
        assert invalid.value.code == CMP_CHAT_INVALID_PARAMS


def test_observability_failure_and_untrusted_fence_reason_do_not_change_authority() -> None:
    def failing_sink(_event: str, _data: dict[str, object]) -> None:
        raise RuntimeError("log failed")

    registry = PluginRuntimeRegistry(event_sink=failing_sink)
    generation = _generation(0)
    assert registry.publish(generation) is generation
    registry.fence("C:\\private\\plugin.json")
    with pytest.raises(PluginRuntimeFencedError, match="mutation"):
        with registry.lease(generation.authority):
            pass
    registry.unfence()
    _assert_published(registry, generation)
