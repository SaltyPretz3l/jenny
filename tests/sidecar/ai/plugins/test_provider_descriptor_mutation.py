"""Prove every provider-descriptor expectation is load-bearing.

A conformance suite can pass while proving nothing: an adapter that reads no
expectation key, or an oracle that compares a value against itself, is green
forever. This suite perturbs each executable case's frozen expectation one leaf
at a time and requires the perturbed run to FAIL.

``perturb`` is deliberately NON-WEAKENING. It never deletes a key, shortens a
list, or relaxes a bound: a weakened oracle would correctly keep passing and
would prove the opposite of what this suite exists to prove. Every mutation
makes the expectation strictly harder or simply different, so the only way a
mutant survives is if nothing reads that leaf.

Runs against the same run_case() the conformance suite uses, so a mutant
exercises exactly the production path the real expectation does.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from scripts.checks.provider_descriptor_fixtures import (
    BINDING_VOCABULARY,
    iter_executable_cases,
)
from tests.sidecar.ai.plugins.provider_descriptor_bindings import run_case

CASES: list[dict[str, Any]] = iter_executable_cases()
MUTANT_MARKER = "::MUTANT"

# The reasoning-cache byte-ceiling case builds multi-megabyte blobs; mutating
# every leaf of every case is still comfortably sub-minute, but the slow cases
# are worth naming so a future timing regression has an obvious first suspect.
SLOW_BINDINGS = frozenset({"reasoning_cache"})


def _mutate_scalar(value: Any) -> Any:
    if isinstance(value, bool):
        return not value
    if isinstance(value, (int, float)):
        return value + 1
    if isinstance(value, str):
        return f"{value}{MUTANT_MARKER}" if value else MUTANT_MARKER
    if value is None:
        return MUTANT_MARKER
    return MUTANT_MARKER


def perturb(expect: Any, path: str = "") -> Iterator[tuple[str, Any]]:
    """Yield one strictly non-weakening mutant per LEAF of ``expect``.

    - str -> value + "::MUTANT" (or "::MUTANT" when empty)
    - int/float -> +1 ; bool -> negated ; None -> "::MUTANT"
    - EMPTY list/dict -> a sentinel is APPENDED/INSERTED, so "expects nothing"
      becomes "expects something impossible". Leaving them alone would make
      ``stream_items: []`` and ``arguments: {}`` unverifiable by this suite.
    - non-empty list/dict -> recurse into children; the container itself is
      never replaced, shortened, or reordered.
    """
    if isinstance(expect, dict):
        if not expect:
            yield path or "<root>", {MUTANT_MARKER: MUTANT_MARKER}
            return
        for key, value in expect.items():
            child_path = f"{path}.{key}" if path else str(key)
            for mutant_path, mutant in perturb(value, child_path):
                yield mutant_path, {**expect, key: mutant}
        return
    if isinstance(expect, list):
        if not expect:
            yield path or "<root>", [MUTANT_MARKER]
            return
        for index, value in enumerate(expect):
            child_path = f"{path}[{index}]"
            for mutant_path, mutant in perturb(value, child_path):
                yield mutant_path, [*expect[:index], mutant, *expect[index + 1 :]]
        return
    yield path or "<root>", _mutate_scalar(expect)


def _mutants(case: dict[str, Any]) -> list[tuple[str, Any]]:
    return list(perturb(case["expect"]))


def _survives(case: dict[str, Any], mutant_expect: Any) -> bool:
    """True when the mutated expectation still passes -- i.e. nothing read it."""
    try:
        run_case({**case, "expect": mutant_expect})
    except AssertionError:
        return False
    return True


def test_perturb_never_weakens_a_container() -> None:
    original = {"a": "x", "b": [1, 2], "c": {}, "d": [], "e": None, "f": True}
    seen = list(perturb(original))
    assert seen, "perturb must yield at least one mutant for a non-empty expectation"
    for _path, mutant in seen:
        assert set(mutant) == set(original), "a mutant must never drop a top-level key"
        assert len(mutant["b"]) == len(original["b"]), "a mutant must never shorten a list"
        assert len(mutant["d"]) >= len(original["d"]), "an empty list must grow, not shrink"
        assert len(mutant["c"]) >= len(original["c"]), "an empty dict must grow, not shrink"


def test_perturb_covers_every_leaf_including_empty_containers() -> None:
    paths = {path for path, _ in perturb({"a": "x", "b": [1, 2], "c": {}, "d": []})}
    assert paths == {"a", "b[0]", "b[1]", "c", "d"}


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_every_executable_case_yields_at_least_one_mutant(case: dict[str, Any]) -> None:
    assert _mutants(case), f"{case['id']}: expectation has no mutable leaf"


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_every_mutant_of_every_expectation_fails(case: dict[str, Any]) -> None:
    survivors = [
        path for path, mutant_expect in _mutants(case) if _survives(case, mutant_expect)
    ]
    assert survivors == [], (
        f"{case['id']}: mutated expectation still passed at {survivors} -- "
        "the adapter never reads that value, so the expectation proves nothing"
    )


def test_every_binding_is_proved_non_vacuous_by_a_failing_mutant() -> None:
    """No adapter may be a silent no-op stub.

    Per binding, find one case whose FIRST mutant fails. A binding whose adapter
    ignored its expectation entirely would have no such case, even though the
    unmutated corpus would still be green.
    """
    proved: set[str] = set()
    for case in CASES:
        binding = case["binding"]
        if binding in proved:
            continue
        for _path, mutant_expect in _mutants(case):
            if not _survives(case, mutant_expect):
                proved.add(binding)
                break
    assert sorted(BINDING_VOCABULARY - proved) == []


def test_slow_bindings_are_still_declared_in_the_vocabulary() -> None:
    assert SLOW_BINDINGS <= BINDING_VOCABULARY
