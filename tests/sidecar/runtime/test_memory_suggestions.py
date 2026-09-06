"""Behavioral unit tests for sidecar.runtime.memory_suggestions."""

from __future__ import annotations

import subprocess
import sys
from types import SimpleNamespace

import pytest

from sidecar.runtime.memory_suggestions import (
    _validate_capture,
    serialize_pending_memory_candidate,
    suggest_memories,
)

# ---------------------------------------------------------------------------
# Fake memory store
# ---------------------------------------------------------------------------


class FakeMemoryStore:
    """Minimal stand-in for MemoryStore – no SQLite required."""

    def __init__(self, *, fingerprint_known: bool = False) -> None:
        self.calls: list[tuple[str, object]] = []
        self._fingerprint_known = fingerprint_known
        self._pending: list = []

    # Public API mirrored from MemoryStore --------------------------------

    def get_pending_candidates(self, session_id: str) -> list:
        self.calls.append(("get_pending_candidates", session_id))
        return list(self._pending)

    def has_memory_fingerprint(self, fp: str) -> bool:
        self.calls.append(("has_memory_fingerprint", fp))
        return self._fingerprint_known

    def delete_pending_candidate(
        self, *, session_id: str, content_fingerprint: str
    ) -> None:
        self.calls.append(
            ("delete_pending_candidate", session_id, content_fingerprint)
        )


# ---------------------------------------------------------------------------
# _validate_capture
# ---------------------------------------------------------------------------


def test_validate_capture_rejects_too_short() -> None:
    assert _validate_capture("ab") is False


def test_validate_capture_rejects_generic_word() -> None:
    assert _validate_capture("it") is False


def test_validate_capture_rejects_too_long() -> None:
    assert _validate_capture("x" * 200) is False


def test_validate_capture_accepts_normal_word() -> None:
    assert _validate_capture("Python") is True


# ---------------------------------------------------------------------------
# Profile extraction: "my name is Jordan"
# ---------------------------------------------------------------------------


def test_profile_extraction_length_and_kind() -> None:
    store = FakeMemoryStore()
    results = suggest_memories(
        messages=[{"role": "user", "content": "my name is Jordan"}],
        memory_store=store,
        session_id=None,
    )
    assert len(results) == 1
    item = results[0]
    assert item["lesson_kind"] == "profile"


def test_profile_extraction_title() -> None:
    store = FakeMemoryStore()
    results = suggest_memories(
        messages=[{"role": "user", "content": "my name is Jordan"}],
        memory_store=store,
        session_id=None,
    )
    assert results[0]["title"] == "Preferred name: Jordan"


def test_profile_extraction_lesson_text() -> None:
    store = FakeMemoryStore()
    results = suggest_memories(
        messages=[{"role": "user", "content": "my name is Jordan"}],
        memory_store=store,
        session_id=None,
    )
    # The source builds: f"The user's name is {value}." with value title-cased.
    assert results[0]["lesson_text"] == "The user's name is Jordan."


def test_profile_extraction_confidence() -> None:
    store = FakeMemoryStore()
    results = suggest_memories(
        messages=[{"role": "user", "content": "my name is Jordan"}],
        memory_store=store,
        session_id=None,
    )
    assert results[0]["confidence"] == 0.99


def test_profile_extraction_fingerprint_is_nonempty_str() -> None:
    store = FakeMemoryStore()
    results = suggest_memories(
        messages=[{"role": "user", "content": "my name is Jordan"}],
        memory_store=store,
        session_id=None,
    )
    fp = results[0]["content_fingerprint"]
    assert isinstance(fp, str) and len(fp) > 0


def test_profile_extraction_calls_has_memory_fingerprint() -> None:
    """has_memory_fingerprint MUST be invoked with the returned fingerprint."""
    store = FakeMemoryStore()
    results = suggest_memories(
        messages=[{"role": "user", "content": "my name is Jordan"}],
        memory_store=store,
        session_id=None,
    )
    fp = results[0]["content_fingerprint"]
    fingerprint_calls = [
        arg for (name, arg) in store.calls if name == "has_memory_fingerprint"
    ]
    assert fp in fingerprint_calls


# ---------------------------------------------------------------------------
# Store-suppression gate: fingerprint already known -> empty result
# ---------------------------------------------------------------------------


def test_store_suppression_returns_empty_when_fingerprint_known() -> None:
    store = FakeMemoryStore(fingerprint_known=True)
    results = suggest_memories(
        messages=[{"role": "user", "content": "my name is Jordan"}],
        memory_store=store,
        session_id=None,
    )
    assert results == []


# ---------------------------------------------------------------------------
# Non-user messages are ignored
# ---------------------------------------------------------------------------


def test_assistant_message_not_extracted() -> None:
    store = FakeMemoryStore()
    results = suggest_memories(
        messages=[{"role": "assistant", "content": "my name is X"}],
        memory_store=store,
        session_id=None,
    )
    assert results == []


# ---------------------------------------------------------------------------
# messages not a list raises ValueError
# ---------------------------------------------------------------------------


def test_messages_not_list_raises_value_error() -> None:
    store = FakeMemoryStore()
    with pytest.raises(ValueError):
        suggest_memories(
            messages="my name is Jordan",  # type: ignore[arg-type]
            memory_store=store,
            session_id=None,
        )


# ---------------------------------------------------------------------------
# Cap at one: multiple extractable facts -> only highest-confidence returned
# ---------------------------------------------------------------------------


def test_cap_at_one_returns_single_highest_confidence_candidate() -> None:
    """A message with two extractable facts must return exactly one item."""
    store = FakeMemoryStore()
    # "call me Jen" -> profile (confidence 0.98)
    # "I prefer Python" -> preference (confidence 0.95)
    # The cap should keep only the highest-confidence one.
    results = suggest_memories(
        messages=[{"role": "user", "content": "call me Jen, I prefer Python"}],
        memory_store=store,
        session_id=None,
    )
    assert len(results) == 1
    # The single surviving item must be the HIGHEST-confidence candidate, not
    # merely *a* candidate.  "call me Jen" -> profile @ 0.98 must outrank
    # "I prefer Python" -> preference @ 0.95.  Asserting the exact winner (kind,
    # confidence, and title) rules out a regression that returns the wrong
    # (lower-confidence) candidate after the cap.
    assert results[0]["lesson_kind"] == "profile"
    assert results[0]["confidence"] == 0.98
    assert results[0]["title"] == "Preferred address: Jen"


# ---------------------------------------------------------------------------
# Pending-candidate short-circuit
# ---------------------------------------------------------------------------


def _make_pending_candidate(**kwargs) -> SimpleNamespace:
    """Build a SimpleNamespace with every attribute serialize_pending_memory_candidate reads."""
    defaults = dict(
        id=1,
        session_id="sess",
        source_request_id="req-1",
        title="Preferred name: Seen",
        lesson_text="The user's name is Seen.",
        lesson_kind="profile",
        confidence=0.99,
        source_excerpt="my name is Seen",
        content_fingerprint="profile:the-user-s-name-is-seen",
        family_key="",
        category="",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def test_pending_candidate_short_circuit_filters_seen_and_returns_unseen() -> None:
    cand_seen = _make_pending_candidate(
        id=1,
        title="Preferred name: Seen",
        lesson_text="The user's name is Seen.",
        content_fingerprint="profile:the-user-s-name-is-seen",
    )
    cand_unseen = _make_pending_candidate(
        id=2,
        title="Preferred name: Unseen",
        lesson_text="The user's name is Unseen.",
        content_fingerprint="profile:the-user-s-name-is-unseen",
    )

    class SplitFakeStore(FakeMemoryStore):
        def __init__(self) -> None:
            super().__init__(fingerprint_known=False)
            self._pending = [cand_seen, cand_unseen]

        def has_memory_fingerprint(self, fp: str) -> bool:
            self.calls.append(("has_memory_fingerprint", fp))
            # seen candidate -> already in store; unseen -> not in store
            return fp == cand_seen.content_fingerprint

    store = SplitFakeStore()
    results = suggest_memories(
        messages=[],  # not reached because pending candidates are processed first
        memory_store=store,
        session_id="sess",
    )

    # Only cand_unseen should be returned
    assert results == [serialize_pending_memory_candidate(cand_unseen)]

    # delete_pending_candidate must have been called for the seen fingerprint
    delete_calls = [
        (name, sid, fp)
        for entry in store.calls
        if (name := entry[0]) == "delete_pending_candidate"
        for sid in [entry[1]]
        for fp in [entry[2]]
    ]
    assert len(delete_calls) == 1
    assert delete_calls[0][1] == "sess"
    assert delete_calls[0][2] == cand_seen.content_fingerprint

def test_module_imports_standalone_in_a_fresh_interpreter() -> None:
    """This module must not need another module loaded first to import.

    It used to pull shared text helpers from sidecar.runtime.memory while memory
    re-exported symbols from here, so importing it first hit the
    partially-initialized-module guard. This file used to paper over that with an
    `import sidecar.runtime.memory` at the top, which meant the suite could never
    see the breakage. The helpers now live in the leaf module memory_text.
    """
    completed = subprocess.run(
        [sys.executable, "-c", "import sidecar.runtime.memory_suggestions"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, (
        "importing sidecar.runtime.memory_suggestions on its own failed; a circular "
        f"import has come back:{chr(10)}{completed.stderr}"
    )
