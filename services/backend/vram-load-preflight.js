'use strict';

/* services/backend/vram-load-preflight.js - the free-VRAM check before a model loads.
 *
 * 2026-11-13: a benchmark llama-server another tool had started held 24 GB of
 * the 32 GB card. Jenny then started NInfer (~30 GB at 196K) on top of it; the
 * overflow spilled into system RAM the other server had mostly taken and the
 * whole PC froze until the app was closed. Nothing checked what was free:
 * NInfer eligibility reads only the card's total, and the llama.cpp fit trusts
 * CUDA's free figure, which ignores other processes under Windows WDDM.
 *
 * Before a managed llama-server or NInfer launch (boot autostart and the chat
 * restart included) and before an Ollama load, the estimated need is compared
 * with nvidia-smi's free memory. Only memory the load itself frees counts as
 * free: the engine it replaces, Jenny's own orphan from an earlier run (the
 * launch reaps it by its pidfile), and Ollama's resident models (Ollama evicts
 * them). A load is refused only when other programs are the reason it does not
 * fit; a model larger than the whole card, or a profile that places layers on
 * the CPU, is the owner's offload choice and is not checked. The refusal names
 * the biggest holders. Any failure of the check admits the load.
 * Kill switch: JENNY_ENABLE_VRAM_LOAD_CHECK=0.
 */

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n-main');
const { buildFeatureFlags } = require('../feature-flags');
const { largestGpuDevice, probeNvidiaSmiVram } = require('../gpu-vram-probe');
const { listGpuMemoryHolders } = require('../gpu-memory-holders');
const { getPidFilePath, readPidFile } = require('../llama-server-pidfile');
const { isPortOpen } = require('./process-utils');

const VRAM_REFUSAL_REASON = 'vram_in_use';
const MIB = 1024 * 1024;
// Estimates are within about a gigabyte of measured use; a shortfall smaller
// than this is slow at worst, never the freeze this check exists for.
const TOLERANCE_MB = 1024;
// A just-stopped engine's memory comes back a beat after its process exits.
const SETTLE_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 500;
const MAX_NAMED_HOLDERS = 3;
// Context and compute buffers a llama-server needs beyond its files at the
// smallest context Jenny launches; a draft model keeps its own context.
const LLAMA_FLOOR_MB = 1024;
const LLAMA_DRAFT_CONTEXT_MB = 1024;
// Profile flags that keep layers or experts on the CPU (or pick devices).
const CPU_PLACEMENT_FLAGS = new Set([
  '-ot', '--override-tensor', '-cmoe', '--cpu-moe', '-ncmoe', '--n-cpu-moe',
  '-ts', '--tensor-split', '-dev', '--device',
]);
// NInfer, measured on the 5090 for the pinned Qwen3.8-27B artifact (config/ninfer-artifacts.json):
// weights + KV per token + the vision tower + the LM-head draft match ninfer-serve's free figure within ~0.1 GiB.
const NINFER_KV_BYTES_PER_TOKEN = Object.freeze({ bf16: 65536, fp8: 32768 });
const NINFER_VISION_MB = 1024;
const NINFER_LM_HEAD_DRAFT_MB = 370;
// Strata Inkling 2 Mini (row 200, S0b on the RTX 5090): the trunk the engine
// loads beside the experts (3.67 GB), the vision pack, and the KV cost per
// token per slot by KV format, from the engine's own window sizing at four
// slots (about 12.5 GB of free VRAM after the weights).
const STRATA_TRUNK_MB = 3500;
const STRATA_VISION_MB = 607;
const STRATA_KV_MB_PER_TOKEN = Object.freeze({ auto: 0.0541, k8v8: 0.0274, k8v4: 0.0209 });
const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const OLLAMA_TIMEOUT_MS = 2000;

function fileMb(filePath, fsImpl = fs) {
  if (!filePath) return 0;
  try {
    return fsImpl.statSync(filePath).size / MIB;
  } catch (_error) {
    return 0;
  }
}

// A split GGUF ("<model>-00001-of-00003.gguf") loads every shard.
function ggufWeightsMb(modelPath, fsImpl = fs) {
  const match = SHARD.exec(path.basename(String(modelPath || '')));
  if (!match) return fileMb(modelPath, fsImpl);
  const dir = path.dirname(modelPath);
  let total = 0;
  try {
    for (const name of fsImpl.readdirSync(dir)) {
      const shard = SHARD.exec(name);
      if (shard && shard[1] === match[1] && shard[3] === match[3]) total += fileMb(path.join(dir, name), fsImpl);
    }
  } catch (_error) {
    return fileMb(modelPath, fsImpl);
  }
  return total;
}

function argValue(args, names) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (names.includes(args[index])) return String(args[index + 1] || '');
  }
  return '';
}

function placesLayersOnCpu(args) {
  if (args.some((arg) => CPU_PLACEMENT_FLAGS.has(arg))) return true;
  const layers = argValue(args, ['-ngl', '--gpu-layers', '--n-gpu-layers']);
  return /^\d+$/.test(layers) && Number(layers) < 99;
}

/** The floor a llama-server launch needs (0: not checked): every file it loads plus the smallest context. */
function estimateLlamaServerMb(options = {}, fsImpl = fs) {
  const args = Array.isArray(options.extraArgs) ? options.extraArgs.map(String) : [];
  if (placesLayersOnCpu(args)) return 0;
  const weights = ggufWeightsMb(options.modelPath, fsImpl);
  if (weights <= 0) return 0;
  const drafted = /draft/.test(argValue(args, ['--spec-type']));
  const drafter = drafted ? fileMb(argValue(args, ['-md', '--model-draft']), fsImpl) : 0;
  return Math.ceil(weights + fileMb(options.projectorPath, fsImpl) + drafter
    + LLAMA_FLOOR_MB + (drafted ? LLAMA_DRAFT_CONTEXT_MB : 0));
}

/** What a NInfer launch holds once loaded, from its launch options. */
function estimateNinferMb(options = {}, fsImpl = fs) {
  const weights = fileMb(options.artifactPath, fsImpl);
  if (weights <= 0) return 0;
  const kvBytes = NINFER_KV_BYTES_PER_TOKEN[options.kvDtype === 'fp8' ? 'fp8' : 'bf16'];
  const context = Number(options.contextSize) > 0 ? Number(options.contextSize) : 0;
  return Math.ceil(weights + (context * kvBytes) / MIB
    + (options.vision ? NINFER_VISION_MB : 0)
    + (options.mtp && options.lmHeadDraft !== false ? NINFER_LM_HEAD_DRAFT_MB : 0));
}

function strataArg(args, flag) {
  const at = args.indexOf(flag);
  return at >= 0 && at + 1 < args.length ? String(args[at + 1]) : '';
}

// The experts Setup placed on the card (--vram-experts-gb, GiB), else the whole
// pack; plus the trunk, vision and the KV at the capped context for every slot.
// The context is capped at the measured fit, so this is about what the engine
// grows into, and a launch with less free VRAM would spill KV into system RAM.
function estimateStrataMb(options = {}, fsImpl = fs) {
  const args = Array.isArray(options.config?.args) ? options.config.args.map(String) : [];
  const packMb = fileMb(strataArg(args, '--native'), fsImpl);
  if (packMb <= 0) return 0;
  const expertsGib = Number(strataArg(args, '--vram-experts-gb'));
  const weights = Number.isFinite(expertsGib) && expertsGib > 0 ? expertsGib * 1024 + STRATA_TRUNK_MB : packMb;
  const kv = STRATA_KV_MB_PER_TOKEN[strataArg(args, '--kv')] || STRATA_KV_MB_PER_TOKEN.auto;
  const context = Number(strataArg(args, '--max-context')) || 0;
  const slots = [1, 2, 4].includes(options.slots) ? options.slots : 1;
  return Math.ceil(weights + (args.includes('--vision') ? STRATA_VISION_MB : 0) + context * slots * kv);
}

function gb(mb) {
  return (Math.max(Number(mb) || 0, 0) / 1024).toFixed(1);
}

function refusalMessage(refusal) {
  const params = { model: refusal.model || t('error.gpu.vramInUseModel', 'This model'), need: gb(refusal.requiredMb), free: gb(refusal.freeMb) };
  if (refusal.holders.length === 0) {
    return t('error.gpu.vramInUseUnnamed',
      '{model} needs about {need} GB of GPU memory, but only {free} GB is free. Close other programs that use the GPU, then load the model again.',
      params);
  }
  const named = (holder) => holder.name || `PID ${holder.pid}`;
  const message = t('error.gpu.vramInUse',
    '{model} needs about {need} GB of GPU memory, but only {free} GB is free. Using it now: {holders}. Close them, then load the model again.',
    { ...params, holders: refusal.holders.map((holder) => `${named(holder)} (${gb(holder.mb)} GB)`).join(', ') });
  const live = refusal.holders.find((holder) => holder.liveRun);
  if (!live) return message;
  return `${message} ${t('error.gpu.vramInUseLiveRun',
    '{program} was started from the Live tab: stop it there to free its memory.', { program: named(live) })}`;
}

// A holder as the refusal names it; `liveRun` (and the `liveRunPid` that matched) when a program the Live tab
// started is it or its parent.
function namedHolder({ pid, name, mb, chain }, liveRunPids) {
  let live = [];
  try { live = Array.isArray(liveRunPids()) ? liveRunPids() : []; } catch (_error) { /* unnamed */ }
  const match = live.length > 0 ? (Array.isArray(chain) ? chain : [{ pid }]).find((link) => live.includes(link.pid)) : null;
  return match ? { pid, name, mb, liveRun: true, liveRunPid: match.pid } : { pid, name, mb };
}

/** The Live-tab program a refusal blames, `{ project_id, program }`, or null (none, unknown project, or garbage). */
function liveRunOf(service, refusal) {
  try {
    const holder = (Array.isArray(refusal?.holders) ? refusal.holders : []).find((entry) => entry?.liveRun);
    if (!holder) return null;
    const projectId = String(service?.runView?.projectForPid?.(holder.liveRunPid) || '').trim();
    if (!projectId || projectId.length > 200) return null;
    return { project_id: projectId, program: String(holder.name || `PID ${holder.pid}`).trim().slice(0, 200) };
  } catch (_error) {
    return null;
  }
}

function createVramLoadPreflight({
  probeVram = probeNvidiaSmiVram,
  listHolders = listGpuMemoryHolders,
  isEnabled = () => buildFeatureFlags(process.env).vram_load_check === true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  settleTimeoutMs = SETTLE_TIMEOUT_MS,
  log = () => {},
  liveRunPids = () => [],
} = {}) {
  let lastRefusal = null;

  async function sample() {
    try {
      return largestGpuDevice(await probeVram());
    } catch (_error) {
      return null;
    }
  }

  function admit(reason, extra = {}) {
    if (reason !== 'fits' && reason !== 'disabled') log('INFO', 'vram_preflight.admitted', { reason, ...extra });
    return { ok: true, reason };
  }

  /**
   * Resolves { ok: true, reason } or { ok: false, reason: 'vram_in_use', message, requiredMb, freeMb, holders }.
   * Consulted only once the load is short, cheapest first: `admitIf()` (a reason to skip the check),
   * `creditMb()` (memory the load frees without naming a process), then `reclaimPids` (processes the
   * load frees; a holder counts when one of them is in its parent chain).
   */
  async function check({
    engine = '', model = '', requiredMb = 0, admitIf = null, creditMb = null, reclaimPids = [],
  } = {}) {
    try {
      if (!isEnabled()) return admit('disabled');
      const need = Math.ceil(Number(typeof requiredMb === 'function' ? requiredMb() : requiredMb) || 0);
      if (need <= 0) return admit('no_estimate', { engine });
      let device = await sample();
      if (!device) return admit('probe_unavailable', { engine });
      if (need > device.totalMb) return admit('exceeds_card', { engine, requiredMb: need, totalMb: device.totalMb });
      let credit = 0;
      const short = () => need - (device.totalMb - device.usedMb) - credit - TOLERANCE_MB;
      if (short() <= 0) return admit('fits');
      const skip = typeof admitIf === 'function' ? await admitIf() : '';
      if (skip) return admit(skip, { engine });
      credit += typeof creditMb === 'function' ? Math.max(Number(await creditMb()) || 0, 0) : 0;
      if (short() <= 0) return admit('credited', { engine, creditMb: credit });
      let holders = [];
      try {
        holders = await listHolders();
      } catch (_error) { /* unnamed refusal below */ }
      const pids = new Set((Array.isArray(reclaimPids) ? reclaimPids : []).filter((pid) => Number(pid) > 0));
      const reclaimed = (holder) => holder.chain.some((link) => pids.has(link.pid));
      credit += holders.filter(reclaimed).reduce((sum, holder) => sum + holder.mb, 0);
      if (short() <= 0) return admit('reclaimable', { engine, creditMb: credit });
      const deadline = now() + settleTimeoutMs;
      while (short() > 0 && now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        device = (await sample()) || device;
      }
      if (short() <= 0) return admit('settled', { engine });
      const refusal = {
        reason: VRAM_REFUSAL_REASON,
        engine,
        model: String(model || ''),
        requiredMb: need,
        freeMb: Math.max(device.totalMb - device.usedMb, 0) + credit,
        totalMb: device.totalMb,
        holders: holders.filter((holder) => !reclaimed(holder)).sort((a, b) => b.mb - a.mb)
          .slice(0, MAX_NAMED_HOLDERS).map((holder) => namedHolder(holder, liveRunPids)),
      };
      refusal.message = refusalMessage(refusal);
      lastRefusal = refusal;
      log('WARN', 'vram_preflight.refused', {
        engine, model: refusal.model, requiredMb: need, freeMb: refusal.freeMb, totalMb: refusal.totalMb,
        holders: refusal.holders.map(({ name, mb }) => ({ name, mb })),
      });
      return { ok: false, ...refusal };
    } catch (error) {
      return admit('check_failed', { engine, message: String(error?.message || error).slice(0, 200) });
    }
  }

  return {
    check,
    getLastRefusal: () => lastRefusal,
  };
}

function vramRefusalError(refusal, extra = {}) {
  return Object.assign(new Error(refusal?.message || VRAM_REFUSAL_REASON), {
    reason: VRAM_REFUSAL_REASON,
    code: VRAM_REFUSAL_REASON,
    category: 'model_busy',
    retryable: true,
    vramRefusal: refusal || null,
    ...extra,
  });
}

/** The plain-language refusal behind a managed launch status, or '' when the check did not refuse it. */
function refusalMessageForStatus(service, status) {
  if (status?.lastError !== VRAM_REFUSAL_REASON) return '';
  return String(service?.vramLoadPreflight?.getLastRefusal?.()?.message || '');
}

/**
 * A lifecycle whose `startKey` launch runs the check first. An identity
 * restore (the GPU handoff) relaunches what was running and is not checked; a
 * server already answering on the port may be the one an adopting launch
 * reuses; Jenny's orphan named in the pidfile is reaped by the launch, so its
 * memory counts as free. The thrown error's message is the reason code, which
 * the managers record as lastError; the user copy is getLastRefusal().
 */
function withVramPreflight(lifecycle, {
  startKey, engine, estimate, getPreflight, pidFileName = '', modelOf = () => '', isPortAnswering = isPortOpen,
} = {}) {
  const start = lifecycle?.[startKey];
  if (typeof start !== 'function') return lifecycle;
  return {
    ...lifecycle,
    [startKey]: async (options = {}) => {
      const preflight = getPreflight?.();
      if (preflight && !options.retainedApiKey) {
        const orphan = readPidFile(getPidFilePath(options.userDataPath, options.pidFileName || pidFileName)).pid;
        const verdict = await preflight.check({
          engine,
          model: modelOf(options),
          requiredMb: () => estimate(options),
          admitIf: async () => (options.adopt !== false && Number(options.port) > 0
            && await isPortAnswering(Number(options.port), options.host || '127.0.0.1') ? 'port_answering' : ''),
          reclaimPids: [orphan],
        });
        // A stop during the check is the launch's to report.
        if (!verdict.ok && !options.abortSignal?.aborted) throw vramRefusalError(verdict, { message: VRAM_REFUSAL_REASON });
      }
      return start(options);
    },
  };
}

function ollamaBaseUrl(service) {
  const ollama = service?.ollamaManager || {};
  return `http://${ollama._host || '127.0.0.1'}:${Number(ollama._port) || 11434}`;
}

async function ollamaJson(service, pathname) {
  try {
    const response = await fetch(`${ollamaBaseUrl(service)}${pathname}`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    return response.ok ? await response.json() : null;
  } catch (_error) {
    return null;
  }
}

const tagKey = (name) => String(name || '').trim().toLowerCase().replace(/:latest$/, '');

/**
 * An Ollama load, checked before anything is stopped. The need is the weights
 * Ollama reports plus the context floor; the models Ollama holds now (it evicts
 * them) and the managed servers this load stops count as free.
 */
async function checkOllamaLoad(service, model, { reclaimPids = [] } = {}) {
  const preflight = service?.vramLoadPreflight;
  if (!preflight) return { ok: true, reason: 'no_preflight' };
  const tags = await ollamaJson(service, '/api/tags');
  const hit = (tags?.models || []).find((entry) => tagKey(entry?.name || entry?.model) === tagKey(model));
  const weightsMb = hit ? (Number(hit.size) || 0) / MIB : 0;
  return preflight.check({
    engine: 'ollama',
    model,
    requiredMb: weightsMb > 0 ? weightsMb + LLAMA_FLOOR_MB : 0,
    creditMb: async () => ((await ollamaJson(service, '/api/ps'))?.models || [])
      .reduce((sum, entry) => sum + (Number(entry?.size_vram) || 0) / MIB, 0),
    reclaimPids,
  });
}

module.exports = {
  TOLERANCE_MB,
  VRAM_REFUSAL_REASON,
  checkOllamaLoad,
  createVramLoadPreflight,
  estimateLlamaServerMb,
  estimateNinferMb,
  estimateStrataMb,
  liveRunOf,
  refusalMessageForStatus,
  vramRefusalError,
  withVramPreflight,
};
