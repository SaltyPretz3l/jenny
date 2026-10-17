'use strict';
// `ninfer.*` IPC namespace (row 54 N2 step 7): Settings/Models control of the
// managed NInfer runtime. Every channel goes through the trusted-sender
// authorizer. Flag off, no manager or an ineligible GPU answers getState with
// only { eligible: false, reason } and every action with ninfer_unavailable,
// before any service is touched. Results are { ok, reason } shaped; thrown
// errors never cross the bridge as a stack, message or path.
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { NINFER_ARTIFACT_ID, NINFER_CONTEXT_SIZES } = require('../shell-config-engines');

const REASON = /^[a-z][a-z0-9_]{0,99}$/u;
const SPEC_TYPES = Object.freeze({ artifactId: 'string', contextSize: 'number', mtp: 'boolean', vision: 'boolean' });
const SETTINGS_TYPES = Object.freeze({ contextSize: 'number', mtp: 'boolean', vision: 'boolean' });
const WATCHDOG_TYPES = Object.freeze({ enabled: 'boolean', maxWatts: 'number', maxTempC: 'number' });
const PIN_FIELDS = Object.freeze(['id', 'display_name', 'model_id', 'size_bytes', 'supports_mtp',
  'context_windows', 'fp8_kv_windows', 'default_context_window']);
// The watchdog bounds the settings normalizer enforces; refused here so a bad
// value never silently resets the saved one.
const WATCHDOG_BOUNDS = Object.freeze({ maxWatts: [100, 1000], maxTempC: [40, 110] });

const fail = (reason) => { throw Object.assign(new Error(reason), { reason }); };
const safeReason = (reason, fallback = 'ninfer_operation_failed') => (
  typeof reason === 'string' && REASON.test(reason) ? reason : fallback);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Known keys only, each of its declared type; unknown keys are dropped.
function pick(payload, types) {
  if (!isPlainObject(payload)) fail('invalid_payload');
  const picked = {};
  for (const [key, type] of Object.entries(types)) {
    if (payload[key] === undefined) continue;
    if (typeof payload[key] !== type || (type === 'string' && payload[key].length > 64)
      || (type === 'number' && !Number.isFinite(payload[key]))) fail('invalid_payload');
    picked[key] = payload[key];
  }
  return picked;
}

const noPayload = (payload) => { if (payload !== undefined) fail('unexpected_payload'); };
const optionalSpec = (payload) => (payload === undefined ? undefined : pick(payload, SPEC_TYPES));

function settingsPatch(payload) {
  const patch = pick(payload, SETTINGS_TYPES);
  if (payload.watchdog !== undefined) patch.watchdog = pick(payload.watchdog, WATCHDOG_TYPES);
  return patch;
}

function removeOptions(payload) {
  if (!isPlainObject(payload)) fail('invalid_payload');
  if (payload.deleteModel !== undefined && typeof payload.deleteModel !== 'boolean') fail('invalid_payload');
  return { confirmed: payload.confirmed === true, deleteModel: payload.deleteModel === true };
}

const failed = (result, fallback) => ({ ok: false, reason: safeReason(result?.reason, fallback) });
const statusResult = (status) => (status?.state === 'ready'
  ? { ok: true, status }
  : { ok: false, reason: safeReason(status?.lastError, 'ninfer_start_failed'), status });

function registerNinferIpc(ipcMain, { backendService, authorization, log = () => {} }) {
  const runtime = () => backendService.ninferRuntime || null;
  const manager = () => backendService.options?.getNinferManager?.() || null;
  const config = () => backendService.configService;
  const pins = () => (Array.isArray(runtime()?.artifacts?.artifacts) ? runtime().artifacts.artifacts : []);
  let setupRunning = false;

  // Validation before delegation: an artifact id must look like one, a context
  // size must be one of the pin's windows and watchdog thresholds must sit in
  // the bounds the UI offers; anything else is invalid_payload, never a default.
  const windowsFor = (artifactId) => {
    const pin = pins().find((entry) => entry?.id === artifactId) || pins()[0];
    return Array.isArray(pin?.context_windows) && pin.context_windows.length ? pin.context_windows : NINFER_CONTEXT_SIZES;
  };
  const specPayload = (payload) => {
    const spec = optionalSpec(payload);
    if (spec?.artifactId !== undefined && !NINFER_ARTIFACT_ID.test(spec.artifactId)) fail('invalid_payload');
    if (spec?.contextSize !== undefined && !windowsFor(spec.artifactId).includes(spec.contextSize)) fail('invalid_payload');
    return spec;
  };
  const settingsPayload = (payload) => {
    const patch = settingsPatch(payload);
    if (patch.contextSize !== undefined && !windowsFor().includes(patch.contextSize)) fail('invalid_payload');
    for (const [key, [min, max]] of Object.entries(WATCHDOG_BOUNDS)) {
      const value = patch.watchdog?.[key];
      if (value !== undefined && !(Number.isInteger(value) && value >= min && value <= max)) fail('invalid_payload');
    }
    return patch;
  };

  async function availability() {
    const rt = runtime();
    if (!rt || rt.enabled !== true) return { eligible: false, reason: 'ninfer_flag_off' };
    if (!rt.install || !rt.artifacts || !manager()) return { eligible: false, reason: 'ninfer_unavailable' };
    try {
      const verdict = await rt.eligibility();
      if (verdict?.eligible === true) return { eligible: true, reason: '' };
      return { eligible: false, reason: safeReason(verdict?.reason, 'ninfer_ineligible') };
    } catch (_error) {
      return { eligible: false, reason: 'ninfer_eligibility_failed' };
    }
  }

  // One log line per action: the outcome and its reason, never a status blob.
  const finish = (method, result) => {
    log(result.ok ? 'INFO' : 'WARN', `ninfer.ipc_${method}`, { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) });
    return result;
  };
  const action = (method, validate, run) => async (_event, payload) => {
    let result;
    try {
      if ((await availability()).eligible !== true) result = { ok: false, reason: 'ninfer_unavailable' };
      else result = await run(validate(payload));
      result = result?.ok === false ? { ...result, reason: safeReason(result.reason) } : { ...result, ok: true };
    } catch (error) {
      result = { ok: false, reason: safeReason(error?.reason) };
    }
    return finish(method, result);
  };

  async function getState(_event, payload) {
    try {
      noPayload(payload);
      const gate = await availability();
      if (!gate.eligible) return gate;
      const { install, artifacts } = runtime();
      const installed = [];
      for (const pin of pins()) {
        const resolved = await artifacts.resolveArtifactPath(pin.id);
        installed.push({ id: pin.id, present: resolved?.ok === true });
      }
      return {
        eligible: true, reason: '', enabled: true,
        runtime: {
          install: install.getState(),
          artifacts: artifacts.getState(),
          pins: pins().map((pin) => Object.fromEntries(PIN_FIELDS.map((key) => [key,
            Array.isArray(pin[key]) ? [...pin[key]] : pin[key]]))),
        },
        installed,
        manager: manager().getStatus(),
        settings: config().getLocalEngines().ninfer,
      };
    } catch (error) {
      return { ok: false, reason: safeReason(error?.reason) };
    }
  }

  async function setup() {
    if (setupRunning) return { ok: false, reason: 'busy' };
    setupRunning = true;
    try {
      const { install, artifacts } = runtime();
      const installed = await install.install({ confirmed: true });
      if (installed?.ok !== true) return failed(installed, 'ninfer_install_failed');
      const pin = pins()[0];
      if (!pin) return { ok: false, reason: 'unknown_artifact' };
      const downloaded = await artifacts.download({ id: pin.id, confirmed: true });
      return downloaded?.ok === true ? { ok: true } : failed(downloaded, 'ninfer_download_failed');
    } finally {
      setupRunning = false;
    }
  }

  async function cancelSetup() {
    const { install, artifacts } = runtime();
    await install.cancel();
    await artifacts.cancel();
    return { ok: true };
  }

  async function remove({ confirmed, deleteModel }) {
    if (!confirmed) return { ok: false, reason: 'opt_in_required' };
    const current = manager();
    // A stop whose exit was never confirmed may still hold the runtime files
    // and the GPU: retry the cleanup and refuse every deletion until it settles.
    if (!['stopped', 'crashed'].includes(current.getStatus().state) || current.cleanupUnconfirmed?.() === true) {
      const stopped = await current.stop();
      if (stopped?.lastError || current.cleanupUnconfirmed?.() === true) return { ok: false, reason: 'ninfer_stop_unconfirmed' };
    }
    const { install, artifacts } = runtime();
    const removed = await install.remove({ confirmed: true });
    if (removed?.ok !== true) return failed(removed, 'ninfer_remove_failed');
    config().updateNinferSettings({ lastUsedArtifactId: '' });
    if (!deleteModel) return { ok: true };
    for (const pin of pins()) {
      const result = await artifacts.remove({ id: pin.id, confirmed: true });
      if (result?.ok !== true) return failed(result, 'ninfer_remove_failed');
    }
    return { ok: true };
  }

  return registerIpcInvokeHandlers(ipcMain, {
    'ninfer.getState': getState,
    'ninfer.setup': action('setup', noPayload, setup),
    'ninfer.cancelSetup': action('cancel_setup', noPayload, cancelSetup),
    'ninfer.remove': action('remove', removeOptions, remove),
    'ninfer.start': action('start', specPayload, async (spec) => statusResult(await manager().ensureRunning(spec))),
    'ninfer.stop': action('stop', noPayload, async () => ({ ok: true, status: await manager().stop() })),
    'ninfer.restart': action('restart', specPayload, async (spec) => statusResult(await manager().restart(spec))),
    'ninfer.dismissSuggestion': action('dismiss_suggestion', noPayload, () => {
      config().updateNinferSettings({ suggestionDismissed: true });
      return { ok: true };
    }),
    'ninfer.updateSettings': action('update_settings', settingsPayload, (patch) => (
      { ok: true, settings: config().updateNinferSettings(patch) })),
  }, authorization);
}

module.exports = { registerNinferIpc };
