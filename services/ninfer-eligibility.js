'use strict';

// Main-process eligibility probe for the managed NInfer runtime (row 54).
//
// NInfer is a CUDA server built only for the desktop RTX 5090. On any other GPU
// nothing NInfer-related renders, so every later NInfer surface gates on this
// probe. It reuses the spawn pattern of services/gpu-vram-probe.js (execFile,
// sanitized env, timeout, windowsHide) with one nvidia-smi query, never logs the
// raw nvidia-smi output and never throws: every failure resolves a typed shape.

const { execFile: nodeExecFile } = require('child_process');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');

const NVIDIA_SMI_ELIGIBILITY_ARGS = Object.freeze([
  '--query-gpu=name,compute_cap,memory.total',
  '--format=csv,noheader,nounits',
]);

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const REQUIRED_COMPUTE_CAPABILITY = '12.0';
const MIN_MEMORY_TOTAL_MIB = 30000;

const REASON_GPU_UNSUPPORTED = 'ninfer_gpu_unsupported';
const REASON_FLAG_OFF = 'ninfer_flag_off';
const REASON_PLATFORM_UNSUPPORTED = 'ninfer_platform_unsupported';
const REASON_PROBE_FAILED = 'ninfer_probe_failed';

// One row per non-empty nvidia-smi line; `index` is the line's position, which is
// the CUDA device index a later `--device N` would use. Malformed lines are
// skipped (they still occupy their index) rather than throwing.
function parseNvidiaEligibilityCsv(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const gpus = [];
  lines.forEach((line, index) => {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 3) {
      return;
    }
    const memoryText = parts[parts.length - 1];
    const computeCapability = parts[parts.length - 2];
    const name = parts.slice(0, -2).join(', ');
    const memoryTotalMib = memoryText === '' ? Number.NaN : Number(memoryText);
    if (!name || !/^\d+\.\d+$/.test(computeCapability) || !Number.isFinite(memoryTotalMib)) {
      return;
    }
    gpus.push({ index, name, computeCapability, memoryTotalMib });
  });
  return gpus;
}

function isEligibleGpu(gpu) {
  return Boolean(gpu)
    && gpu.computeCapability === REQUIRED_COMPUTE_CAPABILITY
    && gpu.memoryTotalMib >= MIN_MEMORY_TOTAL_MIB
    && /RTX 5090/i.test(gpu.name)
    && !/Laptop/i.test(gpu.name);
}

function evaluateNinferEligibility(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  const match = list.find(isEligibleGpu);
  if (!match) {
    return { eligible: false, reason: REASON_GPU_UNSUPPORTED, device: null };
  }
  return {
    eligible: true,
    reason: '',
    device: {
      index: match.index,
      name: match.name,
      computeCapability: match.computeCapability,
      memoryTotalMib: match.memoryTotalMib,
    },
  };
}

function refusal(reason, probed) {
  return { eligible: false, reason, device: null, probed };
}

function runExecFile(execFile, args, options) {
  return new Promise((resolve) => {
    try {
      execFile('nvidia-smi', args, options, (error, stdout) => {
        resolve({ error: error || null, stdout: stdout || '' });
      });
    } catch (error) {
      resolve({ error, stdout: '' });
    }
  });
}

async function probeNinferEligibility({
  flags,
  execFile = nodeExecFile,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  platform = process.platform,
} = {}) {
  // Only an explicit false turns the flag off; undefined flags or a missing key
  // count as ON (the flag is default-ON).
  if (flags && flags.ninfer === false) {
    return refusal(REASON_FLAG_OFF, false);
  }
  // Linux/macOS are out of scope for this slice (row 54 N2 is Windows-only).
  if (platform !== 'win32') {
    return refusal(REASON_PLATFORM_UNSUPPORTED, false);
  }
  try {
    const { error, stdout } = await runExecFile(execFile, [...NVIDIA_SMI_ELIGIBILITY_ARGS], {
      timeout: timeoutMs,
      windowsHide: true,
      env: sanitizeSpawnEnv(process.env),
    });
    const gpus = error ? [] : parseNvidiaEligibilityCsv(stdout);
    if (gpus.length === 0) {
      return refusal(REASON_PROBE_FAILED, true);
    }
    return { ...evaluateNinferEligibility(gpus), probed: true };
  } catch {
    return refusal(REASON_PROBE_FAILED, true);
  }
}

// Memoizes the first resolved result per process: one nvidia-smi call ever,
// concurrent callers share the in-flight promise. Failures and the flag-off path
// are cached too (no retry loop; restarting the app re-probes).
function createNinferEligibilityProbe(options) {
  let inFlight = null;
  function getEligibility() {
    if (!inFlight) {
      inFlight = probeNinferEligibility(options);
    }
    return inFlight;
  }
  getEligibility.reset = () => {
    inFlight = null;
  };
  return getEligibility;
}

module.exports = {
  NVIDIA_SMI_ELIGIBILITY_ARGS,
  createNinferEligibilityProbe,
  evaluateNinferEligibility,
  parseNvidiaEligibilityCsv,
  probeNinferEligibility,
};
