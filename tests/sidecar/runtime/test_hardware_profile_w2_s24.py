from __future__ import annotations

import sys
from types import SimpleNamespace

from sidecar.runtime.hardware_profile import _probe_gpu_inner


def test_probe_gpu_inner_prefers_rocm_when_hip_and_cuda_devices_are_available(
    monkeypatch,
) -> None:
    torch_stub = SimpleNamespace(
        __version__="2.7.0+rocm6.2",
        version=SimpleNamespace(cuda=None, hip="6.2"),
        cuda=SimpleNamespace(
            is_available=lambda: True,
            get_device_name=lambda _index: "AMD Radeon RX 7900 XTX",
            get_device_properties=lambda _index: SimpleNamespace(total_mem=24 * 1024**3),
            get_device_capability=lambda _index: (11, 0),
            get_driver_version=lambda: "6.2",
            is_bf16_supported=lambda: True,
        ),
    )
    monkeypatch.setitem(sys.modules, "torch", torch_stub)

    gpu, capabilities, _python = _probe_gpu_inner()

    assert gpu.type == "rocm"
    assert gpu.name == "AMD Radeon RX 7900 XTX"
    assert gpu.vram_mb == 24 * 1024
    assert capabilities.bfloat16 is True
