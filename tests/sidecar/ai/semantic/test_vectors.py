from __future__ import annotations

import math

import pytest

import sidecar.ai.memory.embedding as embedding_module
from sidecar.ai.semantic import vectors


def test_pack_unpack_round_trip_keeps_float32_and_norm() -> None:
    blob, dim, norm = vectors.pack_vector([3.0, 4.0])

    assert dim == 2 and norm == pytest.approx(5.0)
    assert list(vectors.unpack_vector(blob) or []) == [3.0, 4.0]
    assert vectors.unpack_vector(b"abc") is None
    assert vectors.unpack_vector("not bytes") is None


def test_validate_vector_rejects_bad_values() -> None:
    assert vectors.validate_vector([1, 2.5]) == [1.0, 2.5]
    for bad in ([], [True], [math.nan], ["1"], [0.0] * (vectors.MAX_EMBEDDING_DIM + 1), "x"):
        with pytest.raises(ValueError):
            vectors.validate_vector(bad)


def test_truncate_and_normalize_applies_matryoshka_dims() -> None:
    assert vectors.truncate_and_normalize([3.0, 4.0, 12.0], 2) == pytest.approx([0.6, 0.8])
    full = vectors.truncate_and_normalize([3.0, 4.0, 12.0], 0)
    assert full == pytest.approx([3 / 13, 4 / 13, 12 / 13])
    assert vectors.truncate_and_normalize([3.0, 4.0], 8) == pytest.approx([0.6, 0.8])
    with pytest.raises(ValueError):
        vectors.truncate_and_normalize([0.0, 0.0, 1.0], 2)
    with pytest.raises(ValueError):
        vectors.truncate_and_normalize([1.0], -1)


def test_memory_embedding_keeps_its_historical_names() -> None:
    assert embedding_module._pack_vector is vectors.pack_vector
    assert embedding_module._validate_vector is vectors.validate_vector
    assert embedding_module._unpack_vector is vectors.unpack_vector
    assert embedding_module.MAX_EMBEDDING_DIM == vectors.MAX_EMBEDDING_DIM
