"""Run every executable provider-descriptor fixture case against the real engine.

The W5S spike's fixtures under tests/fixtures/plugins/provider-descriptor/ were
documentary: nothing read them, so they drifted from the code they described
(three separate behavior changes had already invalidated recorded expectations
before this suite existed). Executing them is the only thing that keeps a
recorded expectation honest.

This is a CONFORMANCE runner, not a descriptor interpreter. Each case names one
binding from a closed vocabulary and the adapter for it drives the shipped
ChatGPT-subscription engine directly. Nothing here imports sidecar.ai.plugins,
so the Stage-2 boundary is untouched.
"""

from __future__ import annotations

from typing import Any

import pytest

from scripts.checks.provider_descriptor_fixtures import (
    BINDING_EXPECT_KEYS,
    BINDING_INPUT_KEYS,
    BINDING_VOCABULARY,
    fixture_id_for,
    fixture_paths,
    iter_executable_cases,
    load_fixture,
    load_index,
    validate,
)
from tests.sidecar.ai.plugins.provider_descriptor_bindings import (
    BINDINGS,
    CONSTANT_OBJECTS,
    run_case,
)

CASES: list[dict[str, Any]] = iter_executable_cases()


def test_fixture_corpus_passes_its_own_schema_gate() -> None:
    # iter_executable_cases() already refuses to load an invalid corpus; asserting
    # it here means the failure reads as "the corpus is broken" rather than as a
    # collection error in every parametrized case at once.
    assert validate() == []


def test_every_binding_in_the_vocabulary_has_an_adapter() -> None:
    assert set(BINDINGS) == set(BINDING_VOCABULARY)
    assert set(BINDING_INPUT_KEYS) == set(BINDING_VOCABULARY)
    assert set(BINDING_EXPECT_KEYS) == set(BINDING_VOCABULARY)


def test_every_binding_is_exercised_by_at_least_one_case() -> None:
    covered = {case["binding"] for case in CASES}
    assert sorted(BINDING_VOCABULARY - covered) == []


def test_case_ids_are_globally_unique() -> None:
    ids = [case["id"] for case in CASES]
    assert len(set(ids)) == len(ids)


def test_the_case_ratchet_matches_the_corpus_actually_loaded() -> None:
    minimum = load_index()["minimum_executable_cases"]
    assert len(CASES) >= minimum
    # A ratchet that has drifted far below the real count stops protecting
    # anything, so it is expected to be re-pinned when cases are added.
    assert len(CASES) - minimum <= 10, (
        f"{len(CASES)} executable cases vs a ratchet of {minimum}: "
        "raise minimum_executable_cases in index.json"
    )


def test_every_constant_declared_by_a_fixture_is_resolvable() -> None:
    declared: set[str] = set()
    for path in fixture_paths():
        declared |= set(load_fixture(path).get("constants", {}))
    assert sorted(declared - set(CONSTANT_OBJECTS)) == []


def test_no_fixture_declares_an_unused_constant() -> None:
    for path in fixture_paths():
        document = load_fixture(path)
        constants = document.get("constants", {})
        if not constants:
            continue
        blob = str(document["cases"]) + str(document.get("non_executable", []))
        unused = [name for name in constants if "${" + name + "}" not in blob]
        assert unused == [], f"{fixture_id_for(path)}: constants never referenced: {unused}"


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_recorded_expectation_matches_the_shipped_engine(case: dict[str, Any]) -> None:
    run_case(case)
