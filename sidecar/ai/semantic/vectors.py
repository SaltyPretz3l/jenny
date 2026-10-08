"""Float32 vector helpers shared by the semantic catalog and memory embeddings.

Vectors are stored as packed float32 BLOBs with a precomputed L2 norm. The
pack/validate/unpack helpers moved here from ``sidecar/ai/memory/embedding.py``
unchanged; that module re-imports them under its historical private names.
"""

from __future__ import annotations

import math
from array import array
from collections.abc import Sequence

MAX_EMBEDDING_DIM = 4096


def pack_vector(embedding: list[float]) -> tuple[bytes, int, float]:
    """Pack to float32 bytes; the norm is computed on the stored precision."""
    packed = array("f", embedding)
    norm = math.sqrt(sum(value * value for value in packed))
    return packed.tobytes(), len(packed), norm


def validate_vector(embedding: object) -> list[float]:
    if not isinstance(embedding, list) or not embedding:
        raise ValueError("embedding must be a non-empty list")
    if len(embedding) > MAX_EMBEDDING_DIM:
        raise ValueError("embedding exceeds the dimension limit")
    normalized: list[float] = []
    for value in embedding:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("embedding values must be finite numbers")
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("embedding values must be finite numbers")
        normalized.append(number)
    return normalized


def unpack_vector(blob: object) -> array | None:
    if not isinstance(blob, bytes) or len(blob) % 4 != 0:
        return None
    unpacked = array("f")
    unpacked.frombytes(blob)
    return unpacked


def normalize(values: Sequence[float]) -> list[float]:
    """Return ``values`` scaled to unit L2 length; a zero vector is an error."""
    floats = [float(value) for value in values]
    norm = math.sqrt(sum(value * value for value in floats))
    if not floats or norm == 0.0 or not math.isfinite(norm):
        raise ValueError("cannot normalize a zero or non-finite vector")
    return [value / norm for value in floats]


def truncate_and_normalize(values: Sequence[float], dims: int) -> list[float]:
    """Matryoshka truncation: keep the first ``dims`` values, then L2-normalize.

    ``dims`` of 0 (or one not smaller than the vector) keeps every value.
    """
    if isinstance(dims, bool) or not isinstance(dims, int) or dims < 0:
        raise ValueError("dims must be a non-negative integer")
    kept = list(values[:dims]) if 0 < dims < len(values) else list(values)
    return normalize(kept)
