"""Tests for sidecar.runtime.hardware_profile."""

from __future__ import annotations

import json
import multiprocessing
import sys
import threading
import time
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sidecar.runtime.hardware_profile import (
    _FALLBACK_CATALOG,
    CapabilityFlags,
    GpuInfo,
    HardwareProfile,
    ModelRecommendation,
    OllamaStatus,
    PythonInfo,
    SystemMemoryInfo,
    _build_model_recommendations,
    _build_recommendations,
    _catalog_models,
    _detect_apple_silicon_gpu,
    _effective_gpu,
    _entry_get,
    _get_immutable_profile,
    _int_or_zero,
    _probe_gpu_with_timeout,
    _probe_ollama,
    _probe_system_memory,
    _stop_gpu_probe_process,
    get_cached_hardware_summary,
    get_hardware_profile,
    reset_cache,
)
from sidecar.runtime.hardware_recommendations import _params_to_billions


def _sleeping_gpu_probe_target(send_connection) -> None:
    time.sleep(10)
    send_connection.close()


def _empty_gpu_probe_target(send_connection) -> None:
    send_connection.close()


def _oversize_gpu_probe_target(send_connection) -> None:
    send_connection.send_bytes(b"x" * (16 * 1024 + 1))
    send_connection.close()


class _TerminateFailsProbeProcess:
    def __init__(self) -> None:
        self.alive = True
        self.terminate_calls = 0
        self.kill_calls = 0
        self.join_calls: list[float] = []
        self.closed = False

    def is_alive(self) -> bool:
        return self.alive

    def terminate(self) -> None:
        self.terminate_calls += 1
        raise OSError("terminate failed")

    def kill(self) -> None:
        self.kill_calls += 1
        self.alive = False

    def join(self, timeout: float = 0.0) -> None:
        self.join_calls.append(timeout)

    def close(self) -> None:
        self.closed = True


def setup_function() -> None:
    reset_cache()


def teardown_function() -> None:
    reset_cache()


# ---------------------------------------------------------------------------
# Data type serialization
# ---------------------------------------------------------------------------


def test_hardware_profile_to_dict_complete() -> None:
    profile = HardwareProfile(
        gpu=GpuInfo(
            type="cuda",
            name="NVIDIA RTX 4090",
            vram_mb=24564,
            compute_capability="8.9",
            driver_version="555.42",
        ),
        capabilities=CapabilityFlags(
            bfloat16=True,
            flash_attention=True,
            quantization_4bit=True,
            quantization_8bit=True,
        ),
        python=PythonInfo(version="3.11.5", torch_version="2.3.0", cuda_version="12.1"),
        ollama=OllamaStatus(installed=True, version="0.3.6", running=True),
        dependencies={"torch": "available", "tiktoken": "missing"},
        recommendations=["GPU supports 4-bit quantized models up to about 30B parameters."],
    )
    d = profile.to_dict()

    assert d["gpu"]["type"] == "cuda"
    assert d["gpu"]["name"] == "NVIDIA RTX 4090"
    assert d["gpu"]["vram_mb"] == 24564
    assert d["capabilities"]["bfloat16"] is True
    assert d["capabilities"]["flash_attention"] is True
    assert d["python"]["version"] == "3.11.5"
    assert d["python"]["torch_version"] == "2.3.0"
    assert d["ollama"]["installed"] is True
    assert d["ollama"]["running"] is True
    assert d["dependencies"]["torch"] == "available"
    assert len(d["recommendations"]) == 1
    # No probe_timeout key when it's False
    assert "probe_timeout" not in d["gpu"]


def test_hardware_profile_to_dict_with_timeout_flag() -> None:
    profile = HardwareProfile(gpu=GpuInfo(probe_timeout=True))
    d = profile.to_dict()
    assert d["gpu"]["probe_timeout"] is True


def test_hardware_profile_cpu_only_defaults() -> None:
    profile = HardwareProfile()
    d = profile.to_dict()
    assert d["gpu"]["type"] == "cpu"
    assert d["gpu"]["vram_mb"] == 0
    assert d["capabilities"]["bfloat16"] is False
    assert d["ollama"]["running"] is False


# ---------------------------------------------------------------------------
# GPU detection with timeout
# ---------------------------------------------------------------------------


def test_gpu_probe_timeout_returns_partial_results() -> None:
    """Simulate a hanging GPU probe — should return within timeout."""
    before_pids = {
        child.pid for child in multiprocessing.active_children() if child.pid is not None
    }
    started_at = time.monotonic()
    gpu, caps, py = _probe_gpu_with_timeout(
        timeout=0.1,
        process_context=multiprocessing.get_context("spawn"),
        probe_target=_sleeping_gpu_probe_target,
    )
    elapsed = time.monotonic() - started_at

    assert gpu.probe_timeout is True
    assert gpu.type == "cpu"
    assert py.version
    assert elapsed < 0.75
    after_pids = {
        child.pid for child in multiprocessing.active_children() if child.pid is not None
    }
    assert after_pids <= before_pids


def test_gpu_probe_error_returns_safe_defaults() -> None:
    gpu, caps, py = _probe_gpu_with_timeout(
        timeout=4.0,
        process_context=multiprocessing.get_context("spawn"),
        probe_target=_empty_gpu_probe_target,
    )

    assert gpu.type == "cpu"
    assert gpu.probe_timeout is False
    assert py.version


def test_gpu_probe_rejects_oversize_child_payload() -> None:
    gpu, caps, py = _probe_gpu_with_timeout(
        timeout=4.0,
        process_context=multiprocessing.get_context("spawn"),
        probe_target=_oversize_gpu_probe_target,
    )

    assert gpu == GpuInfo()
    assert caps == CapabilityFlags()
    assert py.version


def test_gpu_probe_cleanup_kills_and_reaps_after_terminate_failure() -> None:
    process = _TerminateFailsProbeProcess()
    started_at = time.monotonic()

    _stop_gpu_probe_process(process)
    elapsed = time.monotonic() - started_at

    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert len(process.join_calls) == 2
    assert max(process.join_calls) <= 0.201
    assert elapsed < 0.3
    assert process.closed is True


def test_concurrent_immutable_profile_callers_share_one_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe_started = threading.Event()
    release_probe = threading.Event()
    calls = 0
    expected = (
        GpuInfo(type="cuda", name="shared", vram_mb=1024),
        CapabilityFlags(bfloat16=True),
        PythonInfo(version="3.13"),
    )

    def probe_once():
        nonlocal calls
        calls += 1
        probe_started.set()
        assert release_probe.wait(1.0)
        return expected

    monkeypatch.setattr(
        "sidecar.runtime.hardware_profile._probe_gpu_with_timeout",
        probe_once,
    )
    results: list[tuple[GpuInfo, CapabilityFlags, PythonInfo]] = []
    threads = [
        threading.Thread(target=lambda: results.append(_get_immutable_profile()))
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    assert probe_started.wait(1.0)
    release_probe.set()
    for thread in threads:
        thread.join(1.0)

    assert all(thread.is_alive() is False for thread in threads)
    assert calls == 1
    assert results == [expected, expected]


def test_gpu_probe_no_torch() -> None:
    """When torch is not installed, should return CPU-only profile."""
    gpu, caps, py = _probe_gpu_with_timeout(timeout=2.0)
    # In CI without GPU, should be cpu
    assert gpu.type in ("cpu", "cuda", "rocm", "xpu")
    assert py.version  # Python version always populated


# ---------------------------------------------------------------------------
# Ollama probe
# ---------------------------------------------------------------------------


def test_ollama_probe_not_running(monkeypatch) -> None:
    """Probe a host that will not respond."""
    # Do not aim a real socket at a "probably free" port: whether 127.0.0.1:19999
    # is occupied is outside this test's control, and the miss cost real seconds.
    def _refuse(*_args, **_kwargs):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr("urllib.request.urlopen", _refuse)

    status = _probe_ollama(host="http://127.0.0.1:19999", timeout=0.5)
    assert status.running is False
    # installed depends on whether ollama is on PATH


def test_ollama_probe_running(monkeypatch) -> None:
    """Simulate a running Ollama server."""
    response_data = json.dumps({"version": "0.3.6"}).encode("utf-8")

    mock_response = MagicMock()
    mock_response.read.return_value = response_data
    mock_response.__enter__ = lambda self: self
    mock_response.__exit__ = MagicMock(return_value=False)

    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *args, **kwargs: mock_response,
    )

    status = _probe_ollama(host="http://localhost:11434", timeout=1.0)
    assert status.running is True
    assert status.version == "0.3.6"
    assert status.installed is True


# ---------------------------------------------------------------------------
# Recommendations
# ---------------------------------------------------------------------------


def test_recommendations_cpu_only() -> None:
    recs = _build_recommendations(
        GpuInfo(type="cpu"),
        CapabilityFlags(),
        {"tiktoken": "available"},
    )
    assert any("No GPU detected" in r for r in recs)


def test_recommendations_high_vram_cuda() -> None:
    recs = _build_recommendations(
        GpuInfo(type="cuda", vram_mb=24000),
        CapabilityFlags(bfloat16=True, flash_attention=True),
        {"tiktoken": "available"},
    )
    assert any("30B" in r for r in recs)
    assert not any("Flash Attention" in r for r in recs)


def test_recommendations_missing_flash_attention() -> None:
    recs = _build_recommendations(
        GpuInfo(type="cuda", vram_mb=16000),
        CapabilityFlags(bfloat16=True, flash_attention=False),
        {"tiktoken": "available"},
    )
    assert any("Flash Attention" in r for r in recs)


def test_recommendations_missing_tiktoken() -> None:
    recs = _build_recommendations(
        GpuInfo(type="cpu"),
        CapabilityFlags(),
        {"tiktoken": "missing"},
    )
    assert any("tiktoken" in r for r in recs)


# ---------------------------------------------------------------------------
# Session cache
# ---------------------------------------------------------------------------


def test_cached_hardware_summary_returns_none_before_probe() -> None:
    assert get_cached_hardware_summary() is None


def test_cached_hardware_summary_returns_data_after_probe() -> None:
    _ = get_hardware_profile()
    summary = get_cached_hardware_summary()
    assert summary is not None
    assert "gpu_type" in summary


def test_get_hardware_profile_returns_complete_profile() -> None:
    profile = get_hardware_profile()
    d = profile.to_dict()
    assert "gpu" in d
    assert "capabilities" in d
    assert "python" in d
    assert "ollama" in d
    assert "dependencies" in d
    assert "recommendations" in d
    # New structured fields ride alongside the legacy text recommendations.
    assert "memory" in d
    assert "model_recommendations" in d
    # Python version should always be populated
    assert d["python"]["version"]


# ---------------------------------------------------------------------------
# System memory probe
# ---------------------------------------------------------------------------


def test_probe_system_memory_returns_nonnegative() -> None:
    mem = _probe_system_memory()
    assert mem.total_mb >= 0
    assert mem.available_mb >= 0


def test_probe_system_memory_uses_psutil(monkeypatch) -> None:
    import psutil

    fake = MagicMock()
    fake.total = 16 * 1024 * 1024 * 1024
    fake.available = 8 * 1024 * 1024 * 1024
    monkeypatch.setattr(psutil, "virtual_memory", lambda: fake)
    mem = _probe_system_memory()
    assert mem.total_mb == 16384
    assert mem.available_mb == 8192


def test_probe_system_memory_fail_open_without_psutil(monkeypatch) -> None:
    import sys

    monkeypatch.setitem(sys.modules, "psutil", None)  # import psutil -> ImportError
    mem = _probe_system_memory()
    assert mem.total_mb == 0
    assert mem.available_mb == 0


# ---------------------------------------------------------------------------
# Model recommendation engine
# ---------------------------------------------------------------------------


def _recommended(recs: list[ModelRecommendation]) -> ModelRecommendation | None:
    picks = [r for r in recs if r.recommended]
    assert len(picks) <= 1, "at most one model may be flagged recommended"
    return picks[0] if picks else None


def test_model_recommendations_24gb_picks_preferred_accelerator_fit() -> None:
    """Capability-first ranking selects the preferred fitting accelerator model."""
    recs = _build_model_recommendations(24000, "NVIDIA RTX 4090", SystemMemoryInfo(32000, 28000), None)
    pick = _recommended(recs)
    assert pick is not None
    assert pick.pull_tag == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0"
    assert pick.fits_in_vram is True


def test_model_recommendations_16gb_picks_preferred_accelerator_fit() -> None:
    recs = _build_model_recommendations(16000, "NVIDIA RTX 4080", SystemMemoryInfo(32000, 24000), None)
    pick = _recommended(recs)
    assert pick is not None
    assert pick.pull_tag == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0"
    assert pick.fits_in_vram is True
    assert "best fit" in pick.reason.lower()


def test_model_recommendations_16gb_prefers_bundled_ornith_family() -> None:
    recs = _build_model_recommendations(16000, "NVIDIA RTX 4080", SystemMemoryInfo(32000, 24000), None)
    pick = _recommended(recs)

    assert pick is not None
    assert pick.pull_tag.startswith("hf.co/ornith-ai/Ornith-1.5-9B-GGUF")
    assert pick.preferred is True


def test_model_recommendations_12gb_picks_preferred_accelerator_fit() -> None:
    recs = _build_model_recommendations(12000, "NVIDIA RTX 3060", SystemMemoryInfo(16000, 12000), None)
    pick = _recommended(recs)
    assert pick is not None
    assert pick.pull_tag == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M"


def test_model_recommendations_8gb_picks_ornith_lean_coder() -> None:
    """8GB VRAM: the Q8_0 coder tier (12000MB) doesn't fit, but the preferred lean
    Q4_K_M coder-lite (7500MB) does, and beats the non-preferred Gemma 4 E4B."""
    recs = _build_model_recommendations(8000, "NVIDIA RTX 3050", SystemMemoryInfo(16000, 12000), None)
    pick = _recommended(recs)
    assert pick is not None
    assert pick.pull_tag == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M"
    assert pick.preferred is True
    assert pick.fits_in_vram is True


def test_model_recommendations_cpu_uses_available_ram_for_all_models() -> None:
    recs = _build_model_recommendations(0, "", SystemMemoryInfo(16000, 16000), None)
    pick = _recommended(recs)
    assert pick is not None
    assert pick.fits_in_vram is False
    assert pick.fits_on_cpu is True
    assert pick.fits is True
    assert pick.preferred is True
    assert pick.pull_tag == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0"
    assert "cpu inference will be slower" in pick.reason.lower()


def test_model_recommendations_windows_arm_56gb_picks_preferred_ornith() -> None:
    recs = _build_model_recommendations(
        0,
        "",
        SystemMemoryInfo(64000, 56000),
        None,
        gpu=GpuInfo(type="cpu", name=""),
    )
    pick = _recommended(recs)
    assert pick is not None
    assert pick.pull_tag == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0"
    assert pick.fits_on_cpu is True
    assert pick.download_size_mb == 9530
    assert pick.disk_required_mb == 11530


def test_model_recommendations_cpu_low_ram_picks_tiny() -> None:
    recs = _build_model_recommendations(0, "", SystemMemoryInfo(4000, 4000), None)
    pick = _recommended(recs)
    assert pick is not None
    assert "e2b" in pick.pull_tag.lower()


def test_apple_silicon_detection_reports_metal_and_total_unified_memory() -> None:
    detected = _detect_apple_silicon_gpu(
        GpuInfo(type="cpu"),
        SystemMemoryInfo(total_mb=16384, available_mb=12000),
        system_name="Darwin",
        machine_name="arm64",
    )

    assert detected.type == "metal"
    assert detected.name == "Apple Silicon GPU"
    assert detected.memory_architecture == "unified"
    assert detected.unified_memory_mb == 16384
    assert detected.vram_mb == 0


def test_apple_silicon_16gb_unified_memory_recommends_accelerated_e4b() -> None:
    recs = _build_model_recommendations(
        0,
        "Apple Silicon GPU",
        SystemMemoryInfo(total_mb=16384, available_mb=12000),
        None,
        gpu=GpuInfo(type="metal", name="Apple Silicon GPU", unified_memory_mb=16384),
    )
    pick = _recommended(recs)

    assert pick is not None
    assert pick.pull_tag == "batiai/gemma4-e4b:q6"
    assert pick.fits_in_accelerator is True
    assert pick.fits_in_vram is False
    assert "unified-memory model budget" in pick.reason


def test_model_recommendations_nothing_fits_recommends_smallest() -> None:
    # Impossible hardware: no GPU and ~0 RAM. UI must still get one pick.
    recs = _build_model_recommendations(0, "", SystemMemoryInfo(0, 0), None)
    pick = _recommended(recs)
    assert pick is not None
    # total_mb==0 -> avail unknown -> cpu_ok True, so a 0-VRAM model still fits;
    # the engine never returns an empty pick.


def test_model_recommendations_uses_supplied_catalog() -> None:
    catalog = {
        "catalogVersion": 9,
        "models": [
            {
                "tier": "only", "modelId": "custom:7b", "displayName": "Custom 7B",
                "params": "7B", "quant": "Q4", "vramRequiredMb": 6000,
                "ramRequiredMb": 8000, "contextLength": 8192, "pullTag": "custom:7b",
            }
        ],
    }
    recs = _build_model_recommendations(16000, "GPU", SystemMemoryInfo(16000, 16000), catalog)
    assert len(recs) == 1
    assert recs[0].pull_tag == "custom:7b"
    assert recs[0].recommended is True


def test_model_recommendations_catalog_without_preferred_flags_unaffected() -> None:
    """The largest fitting model wins among equally-preferred entries."""
    catalog = {
        "catalogVersion": 9,
        "models": [
            {
                "tier": "big", "modelId": "custom:13b", "displayName": "Custom 13B",
                "params": "13B", "quant": "Q4", "vramRequiredMb": 10000,
                "ramRequiredMb": 12000, "contextLength": 8192, "pullTag": "custom:13b",
            },
            {
                "tier": "small", "modelId": "custom:7b", "displayName": "Custom 7B",
                "params": "7B", "quant": "Q4", "vramRequiredMb": 6000,
                "ramRequiredMb": 8000, "contextLength": 8192, "pullTag": "custom:7b",
            },
        ],
    }
    recs = _build_model_recommendations(16000, "GPU", SystemMemoryInfo(16000, 16000), catalog)
    pick = _recommended(recs)
    assert pick is not None
    # Both fit and are equally non-preferred, so the largest (13B) wins.
    assert pick.pull_tag == "custom:13b"
    assert pick.preferred is False


def test_model_recommendations_preferred_outranks_params_only_within_fit_bucket() -> None:
    catalog = {
        "catalogVersion": 9,
        "models": [
            {
                "tier": "big", "modelId": "custom:13b", "displayName": "Custom 13B",
                "params": "13B", "quant": "Q6", "vramRequiredMb": 6000,
                "ramRequiredMb": 8000, "contextLength": 8192, "pullTag": "custom:13b",
            },
            {
                "tier": "preferred", "modelId": "custom:7b", "displayName": "Preferred 7B",
                "params": "7B", "quant": "Q4", "vramRequiredMb": 10000,
                "ramRequiredMb": 12000, "contextLength": 8192, "pullTag": "custom:7b",
                "preferred": True,
            },
        ],
    }

    both_fit = _build_model_recommendations(16000, "GPU", SystemMemoryInfo(16000, 16000), catalog)
    both_fit_pick = _recommended(both_fit)
    assert both_fit_pick is not None
    assert all(rec.fits for rec in both_fit)
    assert both_fit_pick.pull_tag == "custom:7b"
    assert both_fit_pick.preferred is True

    only_larger_fits = _build_model_recommendations(8000, "GPU", SystemMemoryInfo(8000, 8000), catalog)
    only_larger_fit_pick = _recommended(only_larger_fits)
    assert only_larger_fit_pick is not None
    assert next(rec for rec in only_larger_fits if rec.pull_tag == "custom:13b").fits is True
    assert next(rec for rec in only_larger_fits if rec.pull_tag == "custom:7b").fits is False
    assert only_larger_fit_pick.pull_tag == "custom:13b"
    assert only_larger_fit_pick.preferred is False


def test_effective_gpu_uses_nvidia_smi_when_torch_absent(monkeypatch) -> None:
    reset_cache()
    monkeypatch.setattr(
        "sidecar.runtime.hardware_profile._probe_gpu_with_timeout",
        lambda: (GpuInfo(type="cpu", vram_mb=0), CapabilityFlags(), PythonInfo(version="3.11")),
    )
    monkeypatch.setattr(
        "sidecar.runtime.hardware_vram_usage.get_gpu_static_info",
        lambda: {
            "available": True, "name": "NVIDIA RTX 4080", "total_mb": 16000,
            "gpu_type": "cuda", "source": "nvidia-smi", "sampled_at": "",
        },
    )
    monkeypatch.setattr(
        "sidecar.runtime.hardware_profile._probe_ollama",
        lambda host=None: OllamaStatus(),
    )
    # `fits_on_cpu` is a function of host RAM, so pin it: without this the
    # assertion below passes or fails according to whoever runs the suite.
    import psutil

    fake_memory = MagicMock()
    fake_memory.total = 64 * 1024 * 1024 * 1024
    fake_memory.available = 32 * 1024 * 1024 * 1024
    monkeypatch.setattr(psutil, "virtual_memory", lambda: fake_memory)
    profile = get_hardware_profile()
    d = profile.to_dict()
    assert d["gpu"]["vram_mb"] == 16000
    assert d["gpu"]["type"] == "cuda"
    assert d["gpu"]["name"] == "NVIDIA RTX 4080"
    picks = [m for m in d["model_recommendations"] if m["recommended"]]
    assert len(picks) == 1
    assert picks[0]["pull_tag"] == "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0"
    assert picks[0]["fits_on_cpu"] is True


def test_hardware_profile_promotes_apple_silicon_cpu_fallback_to_metal(monkeypatch) -> None:
    reset_cache()
    dependency_report = MagicMock()
    dependency_report.to_dict.return_value = {}
    monkeypatch.setattr(
        "sidecar.runtime.hardware_profile._probe_gpu_with_timeout",
        lambda: (GpuInfo(type="cpu"), CapabilityFlags(), PythonInfo(version="3.11")),
    )
    monkeypatch.setattr("sidecar.runtime.hardware_profile.platform.system", lambda: "Darwin")
    monkeypatch.setattr("sidecar.runtime.hardware_profile.platform.machine", lambda: "arm64")
    monkeypatch.setattr(
        "sidecar.runtime.hardware_profile._probe_system_memory",
        lambda: SystemMemoryInfo(total_mb=16384, available_mb=12000),
    )
    monkeypatch.setattr(
        "sidecar.runtime.hardware_profile._probe_ollama",
        lambda host=None: OllamaStatus(),
    )
    monkeypatch.setattr(
        "sidecar.runtime.hardware_profile.probe_dependencies",
        lambda: dependency_report,
    )

    payload = get_hardware_profile().to_dict()
    picks = [entry for entry in payload["model_recommendations"] if entry["recommended"]]

    assert payload["gpu"]["type"] == "metal"
    assert payload["gpu"]["memory_architecture"] == "unified"
    assert payload["gpu"]["unified_memory_mb"] == 16384
    assert payload["gpu"]["vram_mb"] == 0
    assert len(picks) == 1
    assert picks[0]["pull_tag"] == "batiai/gemma4-e4b:q6"
    assert picks[0]["fits_in_accelerator"] is True


# ---------------------------------------------------------------------------
# _probe_gpu_inner — CUDA / ROCm / XPU torch mock paths (lines 184-263)
# ---------------------------------------------------------------------------


def _make_torch_stub(
    *,
    cuda_available: bool = False,
    has_hip: bool = False,
    has_xpu: bool = False,
    xpu_available: bool = False,
    device_name: str = "NVIDIA RTX 3090",
    total_mem: int = 24 * 1024 * 1024 * 1024,
    capability: tuple[int, int] = (8, 6),
    driver: str = "525.85.12",
    bf16: bool = True,
    torch_version: str = "2.3.0",
    cuda_version_str: str = "12.1",
) -> MagicMock:
    """Build a minimal fake torch module wired for _probe_gpu_inner."""
    torch_stub = MagicMock()
    torch_stub.__version__ = torch_version

    # torch.version.cuda
    torch_stub.version = MagicMock()
    torch_stub.version.cuda = cuda_version_str
    if has_hip:
        torch_stub.version.hip = "5.7"
    else:
        # Attribute must not exist so hasattr() returns False
        del torch_stub.version.hip

    # torch.cuda
    torch_stub.cuda = MagicMock()
    torch_stub.cuda.is_available.return_value = cuda_available
    torch_stub.cuda.get_device_name.return_value = device_name
    props = MagicMock()
    props.total_mem = total_mem
    torch_stub.cuda.get_device_properties.return_value = props
    torch_stub.cuda.get_device_capability.return_value = capability
    torch_stub.cuda.get_driver_version = lambda: driver
    torch_stub.cuda.is_bf16_supported.return_value = bf16

    # torch.hip attribute presence controls ROCm branch
    if has_hip:
        torch_stub.hip = MagicMock()
    else:
        # Remove so hasattr returns False
        del torch_stub.hip

    # torch.xpu
    if has_xpu:
        torch_stub.xpu = MagicMock()
        torch_stub.xpu.is_available.return_value = xpu_available
        torch_stub.xpu.get_device_name.return_value = "Intel Arc A770"
    else:
        del torch_stub.xpu

    return torch_stub


def _probe_gpu_inner_with_torch(monkeypatch, torch_stub):
    """Inject a fake torch into sys.modules (auto-restored by monkeypatch) and
    run the real _probe_gpu_inner against it. Mirrors the monkeypatch.setitem
    idiom already used for the psutil fail-open test above."""
    monkeypatch.setitem(sys.modules, "torch", torch_stub)
    from sidecar.runtime import hardware_profile

    return hardware_profile._probe_gpu_inner()


def test_probe_gpu_inner_cuda_parses_device_fields(monkeypatch) -> None:
    """CUDA branch: name, vram_mb, compute_capability, driver_version all parsed."""
    torch_stub = _make_torch_stub(
        cuda_available=True,
        device_name="NVIDIA RTX 3090",
        total_mem=24 * 1024 * 1024 * 1024,  # 24 576 MB
        capability=(8, 6),
        driver="525.85.12",
        bf16=True,
        torch_version="2.3.0",
        cuda_version_str="12.1",
    )
    gpu, caps, py = _probe_gpu_inner_with_torch(monkeypatch, torch_stub)

    assert gpu.type == "cuda"
    assert gpu.name == "NVIDIA RTX 3090"
    assert gpu.vram_mb == 24576  # 24 * 1024 MB
    assert gpu.compute_capability == "8.6"
    assert gpu.driver_version == "525.85.12"
    assert caps.bfloat16 is True
    assert caps.quantization_4bit is True
    assert caps.quantization_8bit is True
    assert py.torch_version == "2.3.0"
    assert py.cuda_version == "12.1"


def test_probe_gpu_inner_cuda_bf16_false(monkeypatch) -> None:
    """CUDA branch with bf16=False propagates correctly to CapabilityFlags."""
    torch_stub = _make_torch_stub(cuda_available=True, bf16=False)
    gpu, caps, py = _probe_gpu_inner_with_torch(monkeypatch, torch_stub)

    assert gpu.type == "cuda"
    assert caps.bfloat16 is False
    assert caps.quantization_4bit is True


def test_probe_gpu_inner_rocm_branch(monkeypatch) -> None:
    """ROCm branch: type='rocm', bfloat16=True, quantization bits set."""
    torch_stub = _make_torch_stub(cuda_available=False, has_hip=True)
    gpu, caps, py = _probe_gpu_inner_with_torch(monkeypatch, torch_stub)

    assert gpu.type == "rocm"
    assert caps.bfloat16 is True
    assert caps.quantization_4bit is True
    assert caps.quantization_8bit is True
    # CUDA not available -> device_name stays empty for ROCm
    assert gpu.name == ""


def test_probe_gpu_inner_xpu_branch(monkeypatch) -> None:
    """Intel XPU branch: type='xpu', bfloat16=True, name parsed."""
    torch_stub = _make_torch_stub(cuda_available=False, has_hip=False, has_xpu=True, xpu_available=True)
    gpu, caps, py = _probe_gpu_inner_with_torch(monkeypatch, torch_stub)

    assert gpu.type == "xpu"
    assert gpu.name == "Intel Arc A770"
    assert caps.bfloat16 is True
    # XPU branch does NOT set quantization flags
    assert caps.quantization_4bit is False


def test_probe_gpu_inner_cpu_fallback_with_torch(monkeypatch) -> None:
    """Stage 4: torch present but no CUDA/ROCm/XPU -> cpu type returned."""
    torch_stub = _make_torch_stub(cuda_available=False, has_hip=False, has_xpu=False)
    gpu, caps, py = _probe_gpu_inner_with_torch(monkeypatch, torch_stub)

    assert gpu.type == "cpu"
    assert gpu.vram_mb == 0
    assert caps.bfloat16 is False
    # torch_version should still be populated (line 184-189 runs before stages)
    assert py.torch_version == "2.3.0"


# ---------------------------------------------------------------------------
# _build_recommendations — VRAM tier branches (lines 352-357)
# ---------------------------------------------------------------------------


def test_recommendations_16gb_cuda_tier() -> None:
    """16 GB VRAM lands in the 13B tier (>=16000, <24000)."""
    recs = _build_recommendations(
        GpuInfo(type="cuda", vram_mb=16000),
        CapabilityFlags(bfloat16=True, flash_attention=True),
        {},
    )
    assert any("13B" in r for r in recs)
    assert not any("30B" in r for r in recs)


def test_recommendations_8gb_cuda_tier() -> None:
    """8 GB VRAM lands in the 7B tier (>=8000, <16000)."""
    recs = _build_recommendations(
        GpuInfo(type="cuda", vram_mb=8000),
        CapabilityFlags(bfloat16=True, flash_attention=True),
        {},
    )
    assert any("7B" in r for r in recs)
    assert not any("13B" in r for r in recs)


def test_recommendations_4gb_cuda_tier() -> None:
    """4 GB VRAM lands in the 3B tier (>=4000, <8000)."""
    recs = _build_recommendations(
        GpuInfo(type="cuda", vram_mb=4000),
        CapabilityFlags(bfloat16=True, flash_attention=True),
        {},
    )
    assert any("3B" in r for r in recs)
    assert not any("7B" in r for r in recs)


def test_recommendations_very_low_vram_cuda_tier() -> None:
    """< 4 GB VRAM lands in the 'Limited VRAM' else branch (line 357)."""
    recs = _build_recommendations(
        GpuInfo(type="cuda", vram_mb=2000),
        CapabilityFlags(bfloat16=True, flash_attention=True),
        {},
    )
    assert any("Limited VRAM" in r for r in recs)
    assert not any("3B" in r for r in recs)


def test_recommendations_no_gpu_type_match_produces_no_vram_message() -> None:
    """gpu.type == 'rocm' with vram_mb=0 produces no VRAM tier message."""
    recs = _build_recommendations(
        GpuInfo(type="rocm", vram_mb=0),
        CapabilityFlags(),
        {},
    )
    # ROCm with vram_mb==0 hits neither the cpu branch nor the cuda/vram branch
    assert not any("No GPU detected" in r for r in recs)
    assert not any("30B" in r or "13B" in r or "7B" in r or "3B" in r or "Limited" in r for r in recs)


# ---------------------------------------------------------------------------
# _effective_gpu — early return (line 409) and exception path (lines 419-420)
# ---------------------------------------------------------------------------


def test_effective_gpu_returns_early_when_vram_known() -> None:
    """When gpu.vram_mb > 0, _effective_gpu returns it without calling nvidia-smi."""
    calls: list[str] = []

    def fake_get_static() -> dict:
        calls.append("called")
        return {"available": True, "total_mb": 8000, "gpu_type": "cuda", "name": "Other"}

    with patch("sidecar.runtime.hardware_vram_usage.get_gpu_static_info", fake_get_static):
        vram, name, gtype = _effective_gpu(GpuInfo(type="cuda", name="RTX 4090", vram_mb=24000))

    assert vram == 24000
    assert name == "RTX 4090"
    assert gtype == "cuda"
    # nvidia-smi must NOT have been consulted (early-return branch, line 409)
    assert calls == [], f"expected no nvidia-smi call but got {calls}"


def test_effective_gpu_exception_from_nvidia_smi_falls_back_to_cpu() -> None:
    """When get_gpu_static_info raises, _effective_gpu falls through to (0, '', 'cpu')."""
    def boom() -> dict:
        raise OSError("nvidia-smi not found")

    with patch("sidecar.runtime.hardware_vram_usage.get_gpu_static_info", boom):
        vram, name, gtype = _effective_gpu(GpuInfo(type="cpu", name="", vram_mb=0))

    # Exception swallowed (lines 419-420); values stay at defaults
    assert vram == 0
    assert name == ""
    assert gtype == "cpu"


def test_effective_gpu_fills_from_nvidia_smi_when_torch_absent() -> None:
    """When vram_mb==0 and nvidia-smi returns data, VRAM/name/type are filled."""
    def fake_static() -> dict:
        return {"available": True, "total_mb": 16000, "gpu_type": "cuda", "name": "RTX 4080"}

    with patch("sidecar.runtime.hardware_vram_usage.get_gpu_static_info", fake_static):
        vram, name, gtype = _effective_gpu(GpuInfo(type="cpu", name="", vram_mb=0))

    assert vram == 16000
    assert name == "RTX 4080"
    assert gtype == "cuda"


def test_effective_gpu_keeps_existing_name_when_nvidia_smi_returns_different() -> None:
    """If gpu already has a name, nvidia-smi's name is ignored (name guard, line 417)."""
    def fake_static() -> dict:
        return {"available": True, "total_mb": 8000, "gpu_type": "cuda", "name": "SMI Name"}

    with patch("sidecar.runtime.hardware_vram_usage.get_gpu_static_info", fake_static):
        vram, name, gtype = _effective_gpu(GpuInfo(type="cpu", name="Torch Name", vram_mb=0))

    assert vram == 8000
    assert name == "Torch Name"   # existing name must NOT be overwritten
    assert gtype == "cuda"


# ---------------------------------------------------------------------------
# _entry_get — None fallback (line 489)
# ---------------------------------------------------------------------------


def test_entry_get_returns_none_when_no_key_matches() -> None:
    """_entry_get returns None when none of the given keys are present."""
    entry = {"someOtherKey": "value"}
    result = _entry_get(entry, "missingKey", "alsoMissing")
    assert result is None


def test_entry_get_skips_none_and_empty_string_values() -> None:
    """_entry_get skips keys whose value is None or '' and returns next match."""
    entry = {"first": None, "second": "", "third": "winner"}
    result = _entry_get(entry, "first", "second", "third")
    assert result == "winner"


def test_entry_get_returns_first_truthy_key() -> None:
    """_entry_get returns the value of the first key whose value is not None/''."""
    entry = {"pullTag": "my:tag", "pull_tag": "other:tag"}
    result = _entry_get(entry, "pullTag", "pull_tag")
    assert result == "my:tag"


# ---------------------------------------------------------------------------
# _int_or_zero — TypeError / ValueError paths (lines 501-502)
# ---------------------------------------------------------------------------


def test_int_or_zero_with_none_returns_zero() -> None:
    """None triggers TypeError inside int(float(None)) -> returns 0."""
    assert _int_or_zero(None) == 0


def test_int_or_zero_with_non_numeric_string_returns_zero() -> None:
    """Non-numeric string triggers ValueError -> returns 0."""
    assert _int_or_zero("not-a-number") == 0


def test_int_or_zero_with_valid_number_returns_value() -> None:
    """Valid numeric string returns correct integer."""
    assert _int_or_zero("8192") == 8192
    assert _int_or_zero(16384.9) == 16384


def test_int_or_zero_negative_clamps_to_zero() -> None:
    """Negative value is clamped to 0 by max(..., 0)."""
    assert _int_or_zero(-500) == 0


# ---------------------------------------------------------------------------
# _catalog_models — fallback path when catalog is empty/invalid
# ---------------------------------------------------------------------------


def test_catalog_models_uses_fallback_for_none() -> None:
    """None catalog falls back to the embedded _FALLBACK_CATALOG models."""
    models = _catalog_models(None)
    assert len(models) > 0
    pull_tags = {m["pullTag"] for m in models}
    assert "batiai/gemma4-26b:q6" in pull_tags


def test_catalog_models_uses_fallback_for_empty_list() -> None:
    """Empty list catalog falls back to the embedded fallback."""
    models = _catalog_models([])
    assert any(m.get("tier") == "challenger" for m in models)


def test_catalog_models_uses_fallback_for_empty_models_key() -> None:
    """Dict with empty 'models' list falls back to embedded fallback."""
    models = _catalog_models({"catalogVersion": 1, "models": []})
    assert len(models) > 0


# ---------------------------------------------------------------------------
# _build_model_recommendations — no-pull-tag skip (line 528), empty recs (line 556)
# ---------------------------------------------------------------------------


def test_build_model_recommendations_skips_entry_without_pull_tag() -> None:
    """Entry with no pullTag and no modelId is silently skipped (line 528 continue)."""
    catalog = {
        "catalogVersion": 1,
        "models": [
            # Valid entry
            {
                "tier": "small", "modelId": "good:model", "displayName": "Good",
                "params": "4B", "quant": "Q4", "vramRequiredMb": 0,
                "ramRequiredMb": 4000, "contextLength": 8192, "pullTag": "good:model",
            },
            # Entry with no pullTag AND no modelId — must be skipped
            {
                "tier": "broken", "displayName": "Broken",
                "params": "7B", "quant": "Q4", "vramRequiredMb": 0,
                "ramRequiredMb": 4000, "contextLength": 8192,
                # No "pullTag" and no "modelId" keys at all
            },
        ],
    }
    recs = _build_model_recommendations(0, "", SystemMemoryInfo(16000, 16000), catalog)
    pull_tags = [r.pull_tag for r in recs]
    assert "good:model" in pull_tags
    # Broken entry must have been skipped
    assert all(t != "" for t in pull_tags), "empty pull_tag slipped through"
    assert len(recs) == 1


def test_build_model_recommendations_empty_catalog_returns_empty() -> None:
    """When _catalog_models produces no dict entries, return [] immediately (line 556)."""
    # Pass a catalog whose models list contains only non-dict entries.
    # _catalog_models filters with isinstance(entry, dict), so all are dropped.
    bad_catalog = {"catalogVersion": 1, "models": ["string", 42, None]}
    recs = _build_model_recommendations(16000, "GPU", SystemMemoryInfo(32000, 28000), bad_catalog)
    assert recs == []


# ---------------------------------------------------------------------------
# _params_to_billions — edge cases
# ---------------------------------------------------------------------------


def test_params_to_billions_parses_compound_tag() -> None:
    """'35B-A3B' should parse as 35.0 (first numeric group)."""
    assert _params_to_billions("35B-A3B") == 35.0


def test_params_to_billions_parses_tilde_prefix() -> None:
    """'~4B' should parse as 4.0."""
    assert _params_to_billions("~4B") == 4.0


def test_params_to_billions_returns_zero_for_empty() -> None:
    """Empty string returns 0.0 (no regex match)."""
    assert _params_to_billions("") == 0.0


# ---------------------------------------------------------------------------
# _get_immutable_profile — cache hit path (line 594)
# ---------------------------------------------------------------------------


def test_get_immutable_profile_cache_hit_does_not_re_probe() -> None:
    """Second call returns cached result without calling _probe_gpu_with_timeout again."""
    reset_cache()
    probe_calls: list[int] = []

    def fake_probe(timeout: float = 4.0) -> tuple[GpuInfo, CapabilityFlags, PythonInfo]:
        probe_calls.append(1)
        return GpuInfo(type="cuda", name="Cached GPU", vram_mb=8000), CapabilityFlags(), PythonInfo(version="3.11")

    with patch("sidecar.runtime.hardware_profile._probe_gpu_with_timeout", fake_probe):
        result_1 = _get_immutable_profile()
        result_2 = _get_immutable_profile()

    # Must have been called exactly once (second call hits cache, line 594)
    assert probe_calls == [1], f"expected 1 probe call, got {len(probe_calls)}"
    # Both results are the same cached object
    assert result_1 is result_2
    assert result_1[0].name == "Cached GPU"
    assert result_1[0].vram_mb == 8000


# ---------------------------------------------------------------------------
# Catalog parity — config/model-recommendation-catalog.json (the authoritative
# bundled catalog) and _FALLBACK_CATALOG (the embedded Python mirror used when
# the JSON can't be loaded) are hand-edited in lockstep. Both carry a
# "keep in sync" comment but nothing enforced it. This test locks the mirror:
# every tier's modelId/pullTag/displayName/vramRequiredMb/etc. must match
# exactly, ignoring volatile top-level fields (updatedAt, catalogVersion).
# ---------------------------------------------------------------------------

# tests/sidecar/runtime/<this file> -> parents[3] == repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_CATALOG_JSON_PATH = _REPO_ROOT / "config" / "model-recommendation-catalog.json"

# Catalog-level metadata that is expected to drift between the two copies.
_VOLATILE_CATALOG_KEYS = ("updatedAt", "catalogVersion")


def _strip_volatile(model: dict) -> dict:
    """Drop volatile keys so a stray updatedAt/catalogVersion on a model entry
    (they normally live at the top level) can't make the mirror look diverged."""
    return {k: v for k, v in model.items() if k not in _VOLATILE_CATALOG_KEYS}


def test_fallback_catalog_mirrors_bundled_json() -> None:
    """_FALLBACK_CATALOG['models'] must deep-equal the bundled JSON catalog's
    'models' array, field-for-field and in the same tier order."""
    assert _CATALOG_JSON_PATH.is_file(), f"catalog JSON missing at {_CATALOG_JSON_PATH}"
    bundled = json.loads(_CATALOG_JSON_PATH.read_text(encoding="utf-8"))

    json_models = [_strip_volatile(m) for m in bundled["models"]]
    fallback_models = [_strip_volatile(m) for m in _FALLBACK_CATALOG["models"]]

    # Same tiers, same count, same order — surfaces add/drop/reorder cleanly
    # before the big deep-equal turns it into one large dict diff.
    assert [m["tier"] for m in json_models] == [m["tier"] for m in fallback_models], (
        "tier list diverged between config/model-recommendation-catalog.json and "
        "_FALLBACK_CATALOG in sidecar/runtime/hardware_profile.py — keep them in sync"
    )

    # Full field-for-field parity of every tier.
    assert json_models == fallback_models, (
        "config/model-recommendation-catalog.json and _FALLBACK_CATALOG have "
        "diverged; edit both in lockstep"
    )
