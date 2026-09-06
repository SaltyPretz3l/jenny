"""Staged hardware detection and structured runtime profile.

Runs lazily on first ``hardware.profile`` RPC call — never at sidecar
startup.  GPU/Python info is cached for the session lifetime.  Ollama
status is re-probed on every call.

All GPU probes enforce a timeout to avoid hanging on misconfigured drivers.
"""

from __future__ import annotations

import json
import logging
import math
import multiprocessing
import platform
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

from sidecar.ai.dependency_status import probe_dependencies
from sidecar.runtime.hardware_recommendations import (
    MAX_MODEL_SIZE_MB,
    disk_required_mb,
    rank_model_recommendations,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_GPU_PROBE_TIMEOUT_SECONDS = 4.0
_GPU_PROBE_MAX_PAYLOAD_BYTES = 16 * 1024
_GPU_PROBE_MAX_TEXT_CHARS = 512
_GPU_PROBE_REAP_GRACE_SECONDS = 0.2
_OLLAMA_PROBE_TIMEOUT_SECONDS = 3.0
_UNIFIED_MODEL_MEMORY_FRACTION = 0.5
# IPv4 literal; see catalog.py for the Windows IPv6 rationale.
_DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"

# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GpuInfo:
    type: str = "cpu"  # "cuda" | "rocm" | "xpu" | "metal" | "cpu"
    name: str = ""
    vram_mb: int = 0
    memory_architecture: str = ""
    unified_memory_mb: int = 0
    compute_capability: str = ""
    driver_version: str = ""
    probe_timeout: bool = False


@dataclass(frozen=True)
class CapabilityFlags:
    bfloat16: bool = False
    flash_attention: bool = False
    quantization_4bit: bool = False
    quantization_8bit: bool = False


@dataclass(frozen=True)
class PythonInfo:
    version: str = ""
    torch_version: str = ""
    cuda_version: str = ""


@dataclass(frozen=True)
class OllamaStatus:
    installed: bool = False
    version: str = ""
    running: bool = False


@dataclass(frozen=True)
class SystemMemoryInfo:
    total_mb: int = 0
    available_mb: int = 0


@dataclass(frozen=True)
class ModelRecommendation:
    """One ranked local-model option for the detected hardware.

    ``pull_tag`` is the literal ``ollama pull`` argument.  Exactly one entry in a
    recommendation list carries ``recommended=True`` (the auto-pick).  ``preferred``
    mirrors the catalog's ``preferred`` flag: a hardware-ranked recommended default
    that outranks larger non-preferred models of equal fit (see
    ``_build_model_recommendations``).
    """

    tier: str = ""
    model_id: str = ""
    display_name: str = ""
    params: str = ""
    quant: str = ""
    vram_required_mb: int = 0
    ram_required_mb: int = 0
    context_length: int = 0
    fits: bool = False
    fits_in_vram: bool = False
    fits_in_accelerator: bool = False
    fits_on_cpu: bool = False
    download_size_mb: int = 0
    disk_required_mb: int = 0
    recommended: bool = False
    preferred: bool = False
    reason: str = ""
    pull_tag: str = ""


@dataclass(frozen=True)
class HardwareProfile:
    gpu: GpuInfo = field(default_factory=GpuInfo)
    capabilities: CapabilityFlags = field(default_factory=CapabilityFlags)
    python: PythonInfo = field(default_factory=PythonInfo)
    ollama: OllamaStatus = field(default_factory=OllamaStatus)
    memory: SystemMemoryInfo = field(default_factory=SystemMemoryInfo)
    dependencies: dict[str, str] = field(default_factory=dict)
    recommendations: list[str] = field(default_factory=list)
    model_recommendations: list[ModelRecommendation] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        gpu: dict[str, Any] = {
            "type": self.gpu.type,
            "name": self.gpu.name,
            "vram_mb": self.gpu.vram_mb,
            "memory_architecture": self.gpu.memory_architecture,
            "unified_memory_mb": self.gpu.unified_memory_mb,
            "compute_capability": self.gpu.compute_capability,
            "driver_version": self.gpu.driver_version,
        }
        if self.gpu.probe_timeout:
            gpu["probe_timeout"] = True
        return {
            "gpu": gpu,
            "capabilities": {
                "bfloat16": self.capabilities.bfloat16,
                "flash_attention": self.capabilities.flash_attention,
                "quantization_4bit": self.capabilities.quantization_4bit,
                "quantization_8bit": self.capabilities.quantization_8bit,
            },
            "python": {
                "version": self.python.version,
                "torch_version": self.python.torch_version,
                "cuda_version": self.python.cuda_version,
            },
            "ollama": {
                "installed": self.ollama.installed,
                "version": self.ollama.version,
                "running": self.ollama.running,
            },
            "memory": {
                "total_mb": self.memory.total_mb,
                "available_mb": self.memory.available_mb,
            },
            "dependencies": dict(self.dependencies),
            "recommendations": list(self.recommendations),
            "model_recommendations": [
                {
                    "tier": rec.tier,
                    "model_id": rec.model_id,
                    "display_name": rec.display_name,
                    "params": rec.params,
                    "quant": rec.quant,
                    "vram_required_mb": rec.vram_required_mb,
                    "ram_required_mb": rec.ram_required_mb,
                    "context_length": rec.context_length,
                    "fits": rec.fits,
                    "fits_in_vram": rec.fits_in_vram,
                    "fits_in_accelerator": rec.fits_in_accelerator,
                    "fits_on_cpu": rec.fits_on_cpu,
                    "download_size_mb": rec.download_size_mb,
                    "disk_required_mb": rec.disk_required_mb,
                    "recommended": rec.recommended,
                    "preferred": rec.preferred,
                    "reason": rec.reason,
                    "pull_tag": rec.pull_tag,
                }
                for rec in self.model_recommendations
            ],
        }


# ---------------------------------------------------------------------------
# GPU detection (runs inside a killable subprocess)
# ---------------------------------------------------------------------------


def _probe_gpu_inner() -> tuple[GpuInfo, CapabilityFlags, PythonInfo]:
    """Staged GPU detection: ROCm -> CUDA -> XPU -> CPU."""
    gpu = GpuInfo()
    caps = CapabilityFlags()
    py = PythonInfo(version=platform.python_version())

    try:
        import torch  # type: ignore[import-untyped,import-not-found]
    except ImportError:
        return gpu, caps, py

    torch_version = str(getattr(torch, "__version__", ""))
    py = PythonInfo(
        version=platform.python_version(),
        torch_version=torch_version,
        cuda_version=str(getattr(torch.version, "cuda", "") or ""),
    )

    # Stage 1: AMD ROCm
    if getattr(torch.version, "hip", None):
        device_name = ""
        vram_mb = 0
        try:
            if torch.cuda.is_available():
                device_name = str(torch.cuda.get_device_name(0))
                mem = torch.cuda.get_device_properties(0).total_mem
                vram_mb = int(mem / (1024 * 1024))
        except Exception:  # noqa: BLE001
            pass
        gpu = GpuInfo(type="rocm", name=device_name, vram_mb=vram_mb)
        caps = CapabilityFlags(bfloat16=True, quantization_4bit=True, quantization_8bit=True)
        return gpu, caps, py

    # Stage 2: NVIDIA CUDA
    if torch.cuda.is_available():
        device_name = ""
        vram_mb = 0
        compute_cap = ""
        driver = ""
        try:
            device_name = str(torch.cuda.get_device_name(0))
            mem = torch.cuda.get_device_properties(0).total_mem
            vram_mb = int(mem / (1024 * 1024))
            cc = torch.cuda.get_device_capability(0)
            compute_cap = f"{cc[0]}.{cc[1]}"
            driver = str(getattr(torch.cuda, "get_driver_version", lambda: "")() or "")
        except Exception:  # noqa: BLE001
            pass

        bf16 = False
        try:
            bf16 = torch.cuda.is_bf16_supported()
        except Exception:  # noqa: BLE001
            pass

        has_flash_attn = False
        try:
            import flash_attn as _flash_attn  # type: ignore[import-untyped,import-not-found] # noqa: F811

            has_flash_attn = bool(_flash_attn)
        except ImportError:
            pass

        gpu = GpuInfo(
            type="cuda",
            name=device_name,
            vram_mb=vram_mb,
            compute_capability=compute_cap,
            driver_version=driver,
        )
        caps = CapabilityFlags(
            bfloat16=bf16,
            flash_attention=has_flash_attn,
            quantization_4bit=True,
            quantization_8bit=True,
        )
        return gpu, caps, py

    # Stage 3: Intel XPU
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        device_name = ""
        try:
            device_name = str(torch.xpu.get_device_name(0))
        except Exception:  # noqa: BLE001
            pass
        gpu = GpuInfo(type="xpu", name=device_name)
        caps = CapabilityFlags(bfloat16=True)
        return gpu, caps, py

    # Stage 4: CPU-only
    return gpu, caps, py


def _bounded_probe_text(value: Any) -> str:
    return str(value or "")[:_GPU_PROBE_MAX_TEXT_CHARS]


def _gpu_probe_result_payload(
    result: tuple[GpuInfo, CapabilityFlags, PythonInfo],
) -> bytes:
    gpu, caps, py = result
    payload = {
        "gpu": {
            "type": _bounded_probe_text(gpu.type),
            "name": _bounded_probe_text(gpu.name),
            "vram_mb": max(min(int(gpu.vram_mb), 2**31 - 1), 0),
            "compute_capability": _bounded_probe_text(gpu.compute_capability),
            "driver_version": _bounded_probe_text(gpu.driver_version),
        },
        "capabilities": {
            "bfloat16": bool(caps.bfloat16),
            "flash_attention": bool(caps.flash_attention),
            "quantization_4bit": bool(caps.quantization_4bit),
            "quantization_8bit": bool(caps.quantization_8bit),
        },
        "python": {
            "version": _bounded_probe_text(py.version),
            "torch_version": _bounded_probe_text(py.torch_version),
            "cuda_version": _bounded_probe_text(py.cuda_version),
        },
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8", errors="strict")
    if len(encoded) > _GPU_PROBE_MAX_PAYLOAD_BYTES:
        raise ValueError("GPU probe result exceeded the IPC budget")
    return encoded


def _gpu_probe_child(send_connection: Any) -> None:
    """Probe in an isolated child and emit one bounded result frame."""
    try:
        payload = _gpu_probe_result_payload(_probe_gpu_inner())
        send_connection.send_bytes(payload)
    except BaseException:  # noqa: BLE001 - child must fail closed across driver faults.
        return
    finally:
        send_connection.close()


def _decode_gpu_probe_payload(
    payload: bytes,
) -> tuple[GpuInfo, CapabilityFlags, PythonInfo]:
    decoded = json.loads(payload.decode("utf-8", errors="strict"))
    if not isinstance(decoded, dict):
        raise ValueError("GPU probe result must be an object")
    gpu_payload = decoded.get("gpu")
    caps_payload = decoded.get("capabilities")
    python_payload = decoded.get("python")
    if not all(isinstance(item, dict) for item in (gpu_payload, caps_payload, python_payload)):
        raise ValueError("GPU probe result is incomplete")
    assert isinstance(gpu_payload, dict)
    assert isinstance(caps_payload, dict)
    assert isinstance(python_payload, dict)
    gpu_type = _bounded_probe_text(gpu_payload.get("type"))
    if gpu_type not in {"cpu", "cuda", "rocm", "xpu"}:
        gpu_type = "cpu"
    raw_vram_mb = gpu_payload.get("vram_mb", 0)
    if isinstance(raw_vram_mb, bool) or not isinstance(raw_vram_mb, int):
        raise ValueError("GPU probe VRAM must be an integer")
    vram_mb = max(min(raw_vram_mb, 2**31 - 1), 0)

    def strict_bool(key: str) -> bool:
        value = caps_payload.get(key, False)
        if not isinstance(value, bool):
            raise ValueError(f"GPU capability {key} must be boolean")
        return value

    return (
        GpuInfo(
            type=gpu_type,
            name=_bounded_probe_text(gpu_payload.get("name")),
            vram_mb=vram_mb,
            compute_capability=_bounded_probe_text(
                gpu_payload.get("compute_capability")
            ),
            driver_version=_bounded_probe_text(gpu_payload.get("driver_version")),
        ),
        CapabilityFlags(
            bfloat16=strict_bool("bfloat16"),
            flash_attention=strict_bool("flash_attention"),
            quantization_4bit=strict_bool("quantization_4bit"),
            quantization_8bit=strict_bool("quantization_8bit"),
        ),
        PythonInfo(
            version=_bounded_probe_text(python_payload.get("version")),
            torch_version=_bounded_probe_text(python_payload.get("torch_version")),
            cuda_version=_bounded_probe_text(python_payload.get("cuda_version")),
        ),
    )


def _stop_gpu_probe_process(process: Any) -> None:
    """Terminate, kill if necessary, and reap within one small cleanup budget."""
    cleanup_deadline = time.monotonic() + _GPU_PROBE_REAP_GRACE_SECONDS

    def is_alive() -> bool:
        try:
            return bool(process.is_alive())
        except Exception:  # noqa: BLE001
            logger.warning("GPU probe worker state inspection failed", exc_info=True)
            return True

    def join_until(*, timeout: float, stage: str) -> None:
        try:
            process.join(timeout=max(timeout, 0.0))
        except Exception:  # noqa: BLE001
            logger.warning("GPU probe worker %s join failed", stage, exc_info=True)

    if not is_alive():
        join_until(timeout=0.0, stage="completed")
    else:
        try:
            process.terminate()
        except Exception:  # noqa: BLE001
            logger.warning("GPU probe worker terminate failed", exc_info=True)
        join_until(
            timeout=min(0.05, max(cleanup_deadline - time.monotonic(), 0.0)),
            stage="terminate",
        )
    if is_alive():
        try:
            kill = getattr(process, "kill", None)
            if callable(kill):
                kill()
            else:
                logger.error("GPU probe worker has no kill primitive")
        except Exception:  # noqa: BLE001
            logger.warning("GPU probe worker kill failed", exc_info=True)
        join_until(
            timeout=max(cleanup_deadline - time.monotonic(), 0.0),
            stage="kill",
        )
    if is_alive():
        logger.error("GPU probe worker could not be reaped within its cleanup budget")
        return
    try:
        process.close()
    except (AttributeError, ValueError):
        pass


def _probe_gpu_with_timeout(
    timeout: float = _GPU_PROBE_TIMEOUT_SECONDS,
    *,
    process_context: Any | None = None,
    probe_target: Callable[[Any], None] | None = None,
) -> tuple[GpuInfo, CapabilityFlags, PythonInfo]:
    """Run GPU detection with a hard timeout.

    Returns partial results with ``probe_timeout=True`` if the probe
    exceeds the deadline.
    """
    timeout_seconds = float(timeout)
    if not timeout_seconds >= 0.0:
        timeout_seconds = 0.0
    deadline = time.monotonic() + timeout_seconds
    context = process_context or multiprocessing.get_context("spawn")
    receive_connection = None
    send_connection = None
    process = None
    try:
        receive_connection, send_connection = context.Pipe(duplex=False)
        process = context.Process(
            target=probe_target or _gpu_probe_child,
            args=(send_connection,),
            daemon=True,
            name="gpu-capability-probe",
        )
        process.start()
        send_connection.close()
        send_connection = None
        remaining = max(deadline - time.monotonic(), 0.0)
        if not receive_connection.poll(remaining):
            logger.warning(
                "GPU probe timed out after %.1fs; returning partial results.",
                timeout_seconds,
            )
            return (
                GpuInfo(probe_timeout=True),
                CapabilityFlags(),
                PythonInfo(version=platform.python_version()),
            )
        payload = receive_connection.recv_bytes(
            maxlength=_GPU_PROBE_MAX_PAYLOAD_BYTES
        )
        result = _decode_gpu_probe_payload(payload)
        process.join(timeout=max(deadline - time.monotonic(), 0.0))
        return result
    except (EOFError, OSError, UnicodeError, ValueError, json.JSONDecodeError):
        logger.warning("GPU probe worker returned an invalid or incomplete result")
        return GpuInfo(), CapabilityFlags(), PythonInfo(version=platform.python_version())
    except Exception as exc:  # noqa: BLE001
        logger.warning("GPU probe failed: %s", type(exc).__name__)
        return GpuInfo(), CapabilityFlags(), PythonInfo(version=platform.python_version())
    finally:
        if send_connection is not None:
            send_connection.close()
        if receive_connection is not None:
            receive_connection.close()
        if process is not None:
            _stop_gpu_probe_process(process)


# ---------------------------------------------------------------------------
# Ollama status probe (always fresh)
# ---------------------------------------------------------------------------


def _probe_ollama(
    host: str | None = None,
    timeout: float = _OLLAMA_PROBE_TIMEOUT_SECONDS,
) -> OllamaStatus:
    """Probe Ollama installation and run state."""
    base_url = str(host or "").strip().rstrip("/") or _DEFAULT_OLLAMA_HOST

    # Check if running via API
    running = False
    version = ""
    try:
        req = urllib.request.Request(
            f"{base_url}/api/version",
            method="GET",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            version = str(data.get("version", ""))
            running = True
    except Exception:  # noqa: BLE001
        pass

    # Check if installed (binary on PATH)
    installed = running  # If running, it's installed
    if not installed:
        import shutil

        installed = shutil.which("ollama") is not None

    return OllamaStatus(installed=installed, version=version, running=running)


# ---------------------------------------------------------------------------
# Recommendations engine
# ---------------------------------------------------------------------------


def _build_recommendations(
    gpu: GpuInfo,
    caps: CapabilityFlags,
    deps: dict[str, str],
) -> list[str]:
    recs: list[str] = []

    if gpu.type == "metal":
        unified_gb = round(gpu.unified_memory_mb / 1024) if gpu.unified_memory_mb else 0
        suffix = f" with {unified_gb}GB unified memory" if unified_gb else ""
        recs.append(
            "Apple Silicon Metal acceleration detected"
            f"{suffix}. Model recommendations reserve memory for macOS and the app."
        )
    elif gpu.type == "cpu":
        recs.append(
            "No GPU detected. Local models will run on CPU only, which is "
            "significantly slower. Models up to ~3B parameters are practical."
        )
    elif gpu.type == "cuda" and gpu.vram_mb > 0:
        if gpu.vram_mb >= 24000:
            recs.append("GPU supports 4-bit quantized models up to about 30B parameters.")
        elif gpu.vram_mb >= 16000:
            recs.append("GPU supports 4-bit quantized models up to about 13B parameters.")
        elif gpu.vram_mb >= 8000:
            recs.append("GPU supports 4-bit quantized models up to about 7B parameters.")
        elif gpu.vram_mb >= 4000:
            recs.append("GPU supports small quantized models (up to about 3B parameters).")
        else:
            recs.append("Limited VRAM. Consider CPU-only models or very small quantized models.")

    if not caps.flash_attention and gpu.type == "cuda":
        recs.append(
            "Flash Attention is not installed. Installing flash-attn can "
            "significantly reduce memory usage and improve throughput."
        )

    if deps.get("tiktoken") == "missing":
        recs.append(
            "tiktoken is not installed. Token counting will use character "
            "estimation (~10-15% less accurate)."
        )

    return recs


# ---------------------------------------------------------------------------
# System memory probe (always fresh; fail-open if psutil is unavailable)
# ---------------------------------------------------------------------------


def _probe_system_memory() -> SystemMemoryInfo:
    """Best-effort total/available system RAM in MB (0/0 when psutil missing)."""
    try:
        import psutil  # type: ignore[import-not-found, import-untyped]

        vm = psutil.virtual_memory()
        total_mb = int(getattr(vm, "total", 0) // (1024 * 1024))
        available_mb = int(getattr(vm, "available", 0) // (1024 * 1024))
        return SystemMemoryInfo(total_mb=max(total_mb, 0), available_mb=max(available_mb, 0))
    except Exception:  # noqa: BLE001 - fail-open; recommendations still work via VRAM tiers.
        return SystemMemoryInfo()


# ---------------------------------------------------------------------------
# Effective GPU (nvidia-smi fallback for packaged builds where torch is absent)
# ---------------------------------------------------------------------------


def _detect_apple_silicon_gpu(
    gpu: GpuInfo,
    memory: SystemMemoryInfo,
    *,
    system_name: str | None = None,
    machine_name: str | None = None,
) -> GpuInfo:
    """Promote a CPU fallback to the built-in Metal GPU on Apple Silicon."""
    if gpu.type != "cpu":
        return gpu
    system = str(system_name if system_name is not None else platform.system()).lower()
    machine = str(machine_name if machine_name is not None else platform.machine()).lower()
    if system != "darwin" or machine not in {"arm64", "aarch64"}:
        return gpu
    return replace(
        gpu,
        type="metal",
        name="Apple Silicon GPU",
        memory_architecture="unified",
        unified_memory_mb=max(int(memory.total_mb or 0), 0),
    )


def _effective_gpu(gpu: GpuInfo) -> tuple[int, str, str]:
    """Return (vram_mb, name, gpu_type), filling VRAM/name from nvidia-smi.

    The packaged sidecar excludes torch, so ``_probe_gpu_inner`` reports CPU with
    ``vram_mb=0`` even on a real NVIDIA card.  nvidia-smi is a system binary (no
    torch dependency), so we use it to recover real VRAM + name when torch could
    not.  torch values take precedence when present (dev builds).
    """
    vram_mb = int(gpu.vram_mb or 0)
    name = str(gpu.name or "")
    gpu_type = str(gpu.type or "cpu")
    if vram_mb > 0 or gpu_type == "metal":
        return vram_mb, name, gpu_type
    try:
        from sidecar.runtime.hardware_vram_usage import get_gpu_static_info

        static = get_gpu_static_info()
        if static.get("available") is True and int(static.get("total_mb") or 0) > 0:
            vram_mb = int(static["total_mb"])
            gpu_type = str(static.get("gpu_type") or "cuda")
            if not name:
                name = str(static.get("name") or "")
    except Exception:  # noqa: BLE001 - nvidia-smi unavailable -> CPU/RAM path.
        pass
    return vram_mb, name, gpu_type


# ---------------------------------------------------------------------------
# Model recommendation engine (ranks a supplied catalog; embedded fallback)
# ---------------------------------------------------------------------------

# Embedded fallback so recommendations work even with no provided/cached catalog.
# Mirrors config/model-recommendation-catalog.json (camelCase keys). TUNABLE.
_FALLBACK_CATALOG: dict[str, Any] = {
    "catalogVersion": 8,
    "updatedAt": "",
    "models": [
        {
            "tier": "challenger", "modelId": "batiai/gemma4-26b:q6",
            "displayName": "Gemma 4 26B A4B", "params": "26B-A4B", "quant": "Q6_K",
            "vramRequiredMb": 20000, "ramRequiredMb": 24000, "contextLength": 32768,
            "downloadSizeMb": 23000,
            "pullTag": "batiai/gemma4-26b:q6",
        },
        {
            "tier": "daily", "modelId": "batiai/gemma4-12b:q6",
            "displayName": "Gemma 4 12B", "params": "12B", "quant": "Q6_K",
            "vramRequiredMb": 13000, "ramRequiredMb": 16000, "contextLength": 32768,
            "downloadSizeMb": 9800,
            "pullTag": "batiai/gemma4-12b:q6",
        },
        {
            "tier": "coder", "modelId": "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0",
            "displayName": "Ornith 1.5 9B (coder)", "params": "9B", "quant": "Q8_0",
            "vramRequiredMb": 12000, "ramRequiredMb": 14000, "contextLength": 49152,
            "downloadSizeMb": 9530,
            "pullTag": "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0", "preferred": True,
        },
        {
            "tier": "coder-lite", "modelId": "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M",
            "displayName": "Ornith 1.5 9B (lean coder)", "params": "9B", "quant": "Q4_K_M",
            "vramRequiredMb": 7500, "ramRequiredMb": 10000, "contextLength": 32768,
            "downloadSizeMb": 5630,
            "pullTag": "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M", "preferred": True,
        },
        {
            "tier": "compact", "modelId": "batiai/gemma4-12b:q4",
            "displayName": "Gemma 4 12B (lean)", "params": "12B", "quant": "Q4_K",
            "vramRequiredMb": 9000, "ramRequiredMb": 12000, "contextLength": 16384,
            "downloadSizeMb": 7400,
            "pullTag": "batiai/gemma4-12b:q4",
        },
        {
            "tier": "small", "modelId": "batiai/gemma4-e4b:q6",
            "displayName": "Gemma 4 E4B", "params": "4B", "quant": "Q6_K",
            "vramRequiredMb": 7500, "ramRequiredMb": 8000, "contextLength": 32768,
            "downloadSizeMb": 6200,
            "pullTag": "batiai/gemma4-e4b:q6",
        },
        {
            "tier": "baseline", "modelId": "batiai/gemma4-e4b:q6",
            "displayName": "Gemma 4 E4B (CPU)", "params": "4B", "quant": "Q6_K",
            "vramRequiredMb": 0, "ramRequiredMb": 8000, "contextLength": 8192,
            "downloadSizeMb": 6200,
            "pullTag": "batiai/gemma4-e4b:q6",
        },
        {
            "tier": "tiny", "modelId": "batiai/gemma4-e2b:q4",
            "displayName": "Gemma 4 E2B", "params": "2B", "quant": "Q4_K",
            "vramRequiredMb": 0, "ramRequiredMb": 4000, "contextLength": 8192,
            "downloadSizeMb": 3400,
            "pullTag": "batiai/gemma4-e2b:q4",
        },
    ],
}


def _catalog_models(catalog: Any) -> list[dict[str, Any]]:
    """Extract the models list from a catalog object/list, fallback if empty."""
    source = catalog
    if isinstance(source, dict):
        source = source.get("models")
    if not isinstance(source, list) or not source:
        source = _FALLBACK_CATALOG["models"]
    return [entry for entry in source if isinstance(entry, dict)]


def _entry_get(entry: dict[str, Any], *keys: str) -> Any:
    """Read the first present key (tolerates camelCase or snake_case catalogs)."""
    for key in keys:
        if key in entry and entry[key] not in (None, ""):
            return entry[key]
    return None


def _int_or_zero(value: Any) -> int:
    try:
        if isinstance(value, int):
            return min(max(value, 0), MAX_MODEL_SIZE_MB)
        parsed = float(value)
        if not math.isfinite(parsed):
            return 0
        return min(max(int(parsed), 0), MAX_MODEL_SIZE_MB)
    except (TypeError, ValueError, OverflowError):
        return 0


def _model_fit_reason(
    *,
    fits_in_vram: bool,
    fits_in_accelerator: bool,
    fits_on_cpu: bool,
    vram_mb: int,
    unified_budget_mb: int,
) -> str:
    if fits_in_vram:
        return f"Fits in your {round(vram_mb / 1024)}GB of VRAM."
    if fits_in_accelerator:
        return (
            "Fits within a conservative "
            f"{round(unified_budget_mb / 1024)}GB unified-memory model budget."
        )
    if fits_on_cpu:
        return "Runs on CPU (no GPU acceleration; slower)."
    return "Likely exceeds your available memory."


def _build_model_recommendations(
    vram_mb: int,
    gpu_name: str,
    memory: SystemMemoryInfo,
    catalog: Any,
    gpu: GpuInfo | None = None,
) -> list[ModelRecommendation]:
    """Rank catalog models against accelerator memory plus RAM fallback.

    Exactly one entry is flagged ``recommended`` (the auto-pick). Discrete GPUs
    rank against VRAM. Apple Silicon ranks against half of total unified memory
    and requires both catalog memory estimates to fit that budget. Every model
    may also fit available system RAM for CPU inference.
    """
    avail_ram = memory.available_mb if memory.available_mb > 0 else memory.total_mb
    accelerator = gpu or GpuInfo(type="cuda" if vram_mb > 0 else "cpu", name=gpu_name)
    unified_budget_mb = (
        int(max(accelerator.unified_memory_mb, 0) * _UNIFIED_MODEL_MEMORY_FRACTION)
        if accelerator.type == "metal"
        else 0
    )
    recs: list[ModelRecommendation] = []
    for entry in _catalog_models(catalog):
        vreq = _int_or_zero(_entry_get(entry, "vramRequiredMb", "vram_required_mb"))
        rreq = _int_or_zero(_entry_get(entry, "ramRequiredMb", "ram_required_mb"))
        fits_in_vram = vram_mb > 0 and vreq > 0 and vram_mb >= vreq
        fits_in_accelerator = (
            unified_budget_mb > 0
            and vreq > 0
            and max(vreq, rreq) <= unified_budget_mb
        )
        fits_on_cpu = avail_ram >= rreq if rreq > 0 else True
        fits = fits_in_vram or fits_in_accelerator or fits_on_cpu
        model_id = str(_entry_get(entry, "modelId", "model_id") or "")
        pull_tag = str(_entry_get(entry, "pullTag", "pull_tag") or model_id)
        if not pull_tag:
            continue
        preferred = bool(_entry_get(entry, "preferred"))
        download_mb = _int_or_zero(
            _entry_get(entry, "downloadSizeMb", "download_size_mb")
        )
        reason = _model_fit_reason(
            fits_in_vram=fits_in_vram,
            fits_in_accelerator=fits_in_accelerator,
            fits_on_cpu=fits_on_cpu,
            vram_mb=vram_mb,
            unified_budget_mb=unified_budget_mb,
        )
        recs.append(
            ModelRecommendation(
                tier=str(_entry_get(entry, "tier") or ""),
                model_id=model_id,
                display_name=str(_entry_get(entry, "displayName", "display_name") or model_id),
                params=str(_entry_get(entry, "params") or ""),
                quant=str(_entry_get(entry, "quant") or ""),
                vram_required_mb=vreq,
                ram_required_mb=rreq,
                context_length=_int_or_zero(
                    _entry_get(entry, "contextLength", "context_length")
                ),
                fits=fits,
                fits_in_vram=fits_in_vram,
                fits_in_accelerator=fits_in_accelerator,
                fits_on_cpu=fits_on_cpu,
                download_size_mb=download_mb,
                disk_required_mb=disk_required_mb(download_mb),
                recommended=False,
                preferred=preferred,
                reason=reason,
                pull_tag=pull_tag,
            )
        )

    return rank_model_recommendations(
        recs,
        gpu_name=gpu_name,
        vram_mb=vram_mb,
        unified_budget_mb=unified_budget_mb,
        available_ram_mb=avail_ram,
    )


# ---------------------------------------------------------------------------
# Session cache
# ---------------------------------------------------------------------------

_cached_immutable: tuple[GpuInfo, CapabilityFlags, PythonInfo] | None = None
_immutable_cache_condition = threading.Condition()
_immutable_probe_in_flight = False
_immutable_probe_generation = 0


def _get_immutable_profile() -> tuple[GpuInfo, CapabilityFlags, PythonInfo]:
    """Return GPU/Python info, cached for session lifetime."""
    global _cached_immutable, _immutable_probe_in_flight  # noqa: PLW0603
    with _immutable_cache_condition:
        while _immutable_probe_in_flight and _cached_immutable is None:
            _immutable_cache_condition.wait()
        if _cached_immutable is not None:
            return _cached_immutable
        _immutable_probe_in_flight = True
        generation = _immutable_probe_generation
    try:
        result = _probe_gpu_with_timeout()
    except BaseException:
        with _immutable_cache_condition:
            _immutable_probe_in_flight = False
            _immutable_cache_condition.notify_all()
        raise
    with _immutable_cache_condition:
        if generation == _immutable_probe_generation:
            _cached_immutable = result
        _immutable_probe_in_flight = False
        _immutable_cache_condition.notify_all()
        return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_hardware_profile(
    *,
    ollama_host: str | None = None,
    model_catalog: Any = None,
) -> HardwareProfile:
    """Build a full hardware profile.

    GPU/Python info is cached.  Ollama status, system memory, dependency report,
    and model recommendations are refreshed on every call.  ``model_catalog`` is
    the (camelCase) catalog object supplied by the main process; when absent, an
    embedded fallback catalog is used so recommendations always populate.
    """
    gpu, caps, py_info = _get_immutable_profile()
    ollama = _probe_ollama(host=ollama_host)
    memory = _probe_system_memory()
    dep_report = probe_dependencies()
    deps = dep_report.to_dict()

    # In packaged builds torch is excluded, so the cached probe reports CPU/0 VRAM.
    # Recover real VRAM/name via nvidia-smi and reflect it into the returned gpu so
    # both the text tiers and the structured recommendations are accurate.
    gpu = _detect_apple_silicon_gpu(gpu, memory)
    eff_vram_mb, eff_name, eff_type = _effective_gpu(gpu)
    if eff_vram_mb != gpu.vram_mb or eff_name != gpu.name or eff_type != gpu.type:
        gpu = replace(gpu, vram_mb=eff_vram_mb, name=eff_name, type=eff_type)

    recs = _build_recommendations(gpu, caps, deps)
    model_recs = _build_model_recommendations(
        eff_vram_mb,
        eff_name,
        memory,
        model_catalog,
        gpu=gpu,
    )

    return HardwareProfile(
        gpu=gpu,
        capabilities=caps,
        python=py_info,
        ollama=ollama,
        memory=memory,
        dependencies=deps,
        recommendations=recs,
        model_recommendations=model_recs,
    )


def get_cached_hardware_summary() -> dict[str, Any] | None:
    """Return a cached summary if already probed, else ``None``.

    Safe to call from ``initialize`` — never triggers a probe.
    """
    with _immutable_cache_condition:
        cached = _cached_immutable
    if cached is None:
        return None
    gpu, caps, _ = cached
    return {
        "gpu_type": gpu.type,
        "gpu_name": gpu.name,
        "vram_mb": gpu.vram_mb,
        "bfloat16": caps.bfloat16,
        "flash_attention": caps.flash_attention,
    }


def reset_cache() -> None:
    """Clear all cached state (test helper)."""
    global _cached_immutable, _immutable_probe_generation  # noqa: PLW0603
    with _immutable_cache_condition:
        _immutable_probe_generation += 1
        _cached_immutable = None
        _immutable_cache_condition.notify_all()
