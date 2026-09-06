"""Malformed-input regressions for hardware recommendation policy."""

from __future__ import annotations

from sidecar.runtime.hardware_profile import (
    SystemMemoryInfo,
    _build_model_recommendations,
)
from sidecar.runtime.hardware_recommendations import (
    MAX_MODEL_SIZE_MB,
    disk_required_mb,
)


def test_disk_required_mb_rejects_non_finite_and_bounds_extreme_values() -> None:
    assert disk_required_mb("Infinity") == 0
    assert disk_required_mb("-Infinity") == 0
    assert disk_required_mb("not-a-number") == 0
    assert disk_required_mb(10**1000) == MAX_MODEL_SIZE_MB


def test_catalog_non_finite_sizes_degrade_to_zero() -> None:
    recommendations = _build_model_recommendations(
        0,
        "",
        SystemMemoryInfo(total_mb=64_000, available_mb=56_000),
        {
            "models": [
                {
                    "modelId": "safe:test",
                    "pullTag": "safe:test",
                    "params": "9" * 1000 + "B",
                    "ramRequiredMb": "Infinity",
                    "downloadSizeMb": "Infinity",
                }
            ]
        },
    )

    assert len(recommendations) == 1
    assert recommendations[0].ram_required_mb == 0
    assert recommendations[0].download_size_mb == 0
    assert recommendations[0].disk_required_mb == 0
