'use strict';

// Opt-in GPU power/temperature watchdog for the managed NInfer runtime (row 54,
// Step 6b). RTX 5090 owners worry about the 12V-2x6 connector: while NInfer
// serves, one `nvidia-smi` sample a second is compared with the user's own
// thresholds and three consecutive breaches stop the server through the
// manager (never a respawn). The thresholds are settings, not constants: a card
// limited below 450 W wants a lower trip point. Off by default.
//
// The sampler reuses the eligibility probe's spawn posture (execFile, sanitized
// env, timeout, windowsHide) and never logs raw nvidia-smi output.

const { execFile: nodeExecFile } = require('child_process');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_STRIKES = 3;
const SAMPLE_TIMEOUT_MS = 900;
const NVIDIA_SMI_WATCHDOG_ARGS = Object.freeze([
  '--query-gpu=power.draw,temperature.gpu',
  '--format=csv,noheader,nounits',
]);

// "123.45, 61" -> { watts: 123.45, tempC: 61 }; null for anything else.
function parseGpuSample(stdout) {
  const line = String(stdout || '').split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) || '';
  const [wattsRaw, tempRaw] = line.split(',').map((entry) => entry.trim());
  const watts = Number(wattsRaw);
  const tempC = Number(tempRaw);
  if (!Number.isFinite(watts) || !Number.isFinite(tempC) || watts < 0) return null;
  return { watts, tempC };
}

function createNvidiaSmiSampler({ execFile = nodeExecFile, gpuIndex = null, timeoutMs = SAMPLE_TIMEOUT_MS } = {}) {
  const args = [...NVIDIA_SMI_WATCHDOG_ARGS];
  if (Number.isInteger(gpuIndex) && gpuIndex >= 0) args.push(`--id=${gpuIndex}`);
  return () => new Promise((resolve) => {
    try {
      execFile('nvidia-smi', args, { timeout: timeoutMs, windowsHide: true, env: sanitizeSpawnEnv(process.env) },
        (error, stdout) => resolve(error ? null : parseGpuSample(stdout)));
    } catch (_error) {
      resolve(null);
    }
  });
}

// A breach is a sample above maxWatts or at/above maxTempC.
function sampleBreaches(sample, settings) {
  if (!sample) return false;
  const maxWatts = Number(settings?.maxWatts);
  const maxTempC = Number(settings?.maxTempC);
  return (Number.isFinite(maxWatts) && sample.watts > maxWatts)
    || (Number.isFinite(maxTempC) && sample.tempC >= maxTempC);
}

function createNinferGpuWatchdog({
  // Re-read before every sample so a Settings toggle or a new threshold takes
  // effect without a restart. `enabled: false` samples nothing.
  getSettings = () => null,
  sample = createNvidiaSmiSampler(),
  // Called once per trip with { watts, tempC, maxWatts, maxTempC, strikes }.
  onTrip = () => {},
  intervalMs = DEFAULT_INTERVAL_MS,
  strikes = DEFAULT_STRIKES,
  log = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let running = false;
  let timer = null;
  let breaches = 0;
  let generation = 0;
  let inFlight = null;

  function schedule(currentGeneration) {
    if (!running || currentGeneration !== generation) return;
    timer = setTimeoutImpl(() => { timer = null; void tick(currentGeneration); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // One sample. Exposed so tests drive the loop without timers.
  async function tick(currentGeneration = generation) {
    if (!running || currentGeneration !== generation) return { sampled: false };
    const settings = getSettings();
    if (!settings || settings.enabled !== true) {
      breaches = 0;
      schedule(currentGeneration);
      return { sampled: false };
    }
    let reading;
    try {
      inFlight = Promise.resolve(sample());
      reading = await inFlight;
    } catch (_error) {
      reading = null;
    } finally {
      inFlight = null;
    }
    if (!running || currentGeneration !== generation) return { sampled: false };
    // An unreadable sample proves nothing either way: the count stands.
    if (reading) breaches = sampleBreaches(reading, settings) ? breaches + 1 : 0;
    if (reading && breaches >= strikes) {
      const trip = {
        watts: reading.watts, tempC: reading.tempC,
        maxWatts: Number(settings.maxWatts), maxTempC: Number(settings.maxTempC), strikes: breaches,
      };
      stop();
      log('WARN', 'ninfer.watchdog.tripped', trip);
      try { onTrip(trip); } catch (_error) { /* the stop is the manager's; a listener fault stays local */ }
      return { sampled: true, tripped: true, ...trip };
    }
    schedule(currentGeneration);
    return { sampled: true, tripped: false, breaches, ...reading };
  }

  function start() {
    if (running) return;
    running = true;
    breaches = 0;
    generation += 1;
    schedule(generation);
  }

  function stop() {
    if (!running) return;
    running = false;
    breaches = 0;
    generation += 1;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => running,
    settle: () => Promise.resolve(inFlight).then(() => undefined, () => undefined),
  };
}

module.exports = {
  DEFAULT_STRIKES,
  NVIDIA_SMI_WATCHDOG_ARGS,
  createNinferGpuWatchdog,
  createNvidiaSmiSampler,
  parseGpuSample,
  sampleBreaches,
};
