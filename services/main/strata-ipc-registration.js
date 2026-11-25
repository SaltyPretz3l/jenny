'use strict';
// `strata.*` IPC namespace (row 200 S2 step 8): Settings/Models control of the
// managed Strata runtime. Every channel goes through the trusted-sender
// authorizer. Flag off (or not Windows) answers getState with only
// { eligible: false, reason: 'strata_flag_off' } and every action with that
// reason; no manager answers strata_unavailable; no service is touched first.
// Results are { ok, reason, detail } shaped: a colon reason such as
// `strata_exited:1` crosses as { reason: 'strata_exited', detail: '1' }, and
// anything else falls back to strata_operation_failed. The per-launch key, the
// PIDs and every path stay in main: the manager status is an allowlist.
// Jenny never installs Strata, so there is no setup, cancel or remove here.
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const {
  MAX_CONTEXT, MIN_CONTEXT, STRATA_DRAFTING, STRATA_KV_FORMATS, STRATA_SLOTS,
} = require('../strata-settings');

const REASON = /^[a-z0-9_]{1,100}$/u;
const DETAIL = /^[a-z0-9_]{0,100}$/u;
const ENUMS = Object.freeze({ slots: STRATA_SLOTS, kv: STRATA_KV_FORMATS, drafting: STRATA_DRAFTING });
// The watchdog bounds the settings normalizer enforces; refused here so a bad
// value never silently resets the saved one.
const WATCHDOG_BOUNDS = Object.freeze({ maxWatts: [100, 1000], maxTempC: [40, 110] });
// Main-only bookkeeping the renderer may never write.
const PRIVATE_SETTINGS = Object.freeze(['lastUsed', 'learnedFits']);
const STATUS_FIELDS = Object.freeze(['state', 'phase', 'port', 'alias', 'displayName', 'slots', 'kv', 'contextSize',
  'contextFit', 'fitSource', 'vision', 'drafting', 'runtimeLabel', 'stoppedBy', 'watchdogWatts', 'watchdogTempC',
  'identityRetained', 'changedAt']);

const fail = (reason) => { throw Object.assign(new Error(reason), { reason }); };
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// `head:tail` -> { reason: head, detail: tail }, each a bare code. A bad head is
// the fallback; a bad tail (`strata_exited:SIGTERM`) is dropped, keeping the head.
function splitReason(raw, fallback = 'strata_operation_failed') {
  if (typeof raw !== 'string') return { reason: fallback, detail: '' };
  const at = raw.indexOf(':');
  const reason = at === -1 ? raw : raw.slice(0, at);
  const detail = at === -1 ? '' : raw.slice(at + 1);
  if (!REASON.test(reason)) return { reason: fallback, detail: '' };
  return { reason, detail: DETAIL.test(detail) ? detail : '' };
}

function safeStatus(status) {
  const source = isPlainObject(status) ? status : {};
  const safe = Object.fromEntries(STATUS_FIELDS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  const error = source.lastError ? splitReason(source.lastError) : { reason: '', detail: '' };
  return { ...safe, lastError: error.reason, lastErrorDetail: error.detail };
}

const noPayload = (payload) => { if (payload !== undefined) fail('unexpected_payload'); };

// Known keys only, each validated; unknown keys are dropped, a bad value or a
// private key is invalid_payload (never a silent default).
function launchKeys(payload) {
  if (!isPlainObject(payload)) fail('invalid_payload');
  if (PRIVATE_SETTINGS.some((key) => payload[key] !== undefined)) fail('invalid_payload');
  const picked = {};
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (payload[key] === undefined) continue;
    if (!allowed.includes(payload[key])) fail('invalid_payload');
    picked[key] = payload[key];
  }
  if (payload.context !== undefined) {
    const ok = payload.context === null
      || (Number.isInteger(payload.context) && payload.context >= MIN_CONTEXT && payload.context <= MAX_CONTEXT);
    if (!ok) fail('invalid_payload');
    picked.context = payload.context;
  }
  if (payload.vision !== undefined) {
    if (typeof payload.vision !== 'boolean') fail('invalid_payload');
    picked.vision = payload.vision;
  }
  return picked;
}

const optionalSpec = (payload) => (payload === undefined ? undefined : launchKeys(payload));

function settingsPatch(payload) {
  const patch = launchKeys(payload);
  if (payload.watchdog === undefined) return patch;
  if (!isPlainObject(payload.watchdog)) fail('invalid_payload');
  const watchdog = {};
  if (payload.watchdog.enabled !== undefined) {
    if (typeof payload.watchdog.enabled !== 'boolean') fail('invalid_payload');
    watchdog.enabled = payload.watchdog.enabled;
  }
  for (const [key, [min, max]] of Object.entries(WATCHDOG_BOUNDS)) {
    const value = payload.watchdog[key];
    if (value === undefined) continue;
    if (!(Number.isInteger(value) && value >= min && value <= max)) fail('invalid_payload');
    watchdog[key] = value;
  }
  return { ...patch, watchdog };
}

function publicSettings(settings) {
  const source = isPlainObject(settings) ? settings : {};
  return Object.fromEntries(Object.entries(source).filter(([key]) => !PRIVATE_SETTINGS.includes(key)));
}

const failed = (raw, fallback) => ({ ok: false, ...splitReason(raw, fallback) });
const statusResult = (status) => (status?.state === 'ready'
  ? { ok: true, status: safeStatus(status) }
  : { ...failed(status?.lastError, 'strata_start_failed'), status: safeStatus(status) });

function registerStrataIpc(ipcMain, { backendService, authorization, log = () => {} }) {
  const runtime = () => backendService.strataRuntime || null;
  const manager = () => backendService.options?.getStrataManager?.() || null;
  const config = () => backendService.configService;

  function availability() {
    if (runtime()?.enabled !== true) return { eligible: false, reason: 'strata_flag_off' };
    if (!manager()) return { eligible: false, reason: 'strata_unavailable' };
    return { eligible: true, reason: '' };
  }

  // One log line per action: the outcome and its reason, never a status blob.
  const finish = (method, result) => {
    log(result.ok ? 'INFO' : 'WARN', `strata.ipc_${method}`, { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) });
    return result;
  };
  const action = (method, validate, run) => async (_event, payload) => {
    let result;
    try {
      const gate = availability();
      if (!gate.eligible) result = { ok: false, reason: gate.reason, detail: '' };
      else result = await run(validate(payload));
      const raw = result?.detail ? `${result.reason}:${result.detail}` : result?.reason;
      result = result?.ok === false ? { ...result, ...splitReason(raw) } : { ...result, ok: true };
    } catch (error) {
      result = failed(error?.reason);
    }
    return finish(method, result);
  };

  async function getState(_event, payload) {
    try {
      noPayload(payload);
      const gate = availability();
      if (!gate.eligible) return gate;
      let facts = { pins: null, fits: {} };
      try { facts = await runtime().uiFacts(); } catch (_error) { /* pins and fits unknown */ }
      return {
        eligible: true, reason: '', enabled: true,
        runtime: runtime().getState(),
        pins: facts.pins,
        manager: safeStatus(manager().getStatus()),
        settings: publicSettings(config().getLocalEngines().strata),
        fits: facts.fits,
      };
    } catch (error) {
      return failed(error?.reason);
    }
  }

  return registerIpcInvokeHandlers(ipcMain, {
    'strata.getState': getState,
    'strata.start': action('start', optionalSpec, async (spec) => statusResult(await manager().ensureRunning(spec))),
    'strata.stop': action('stop', noPayload, async () => ({ ok: true, status: safeStatus(await manager().stop()) })),
    'strata.restart': action('restart', optionalSpec, async (spec) => statusResult(await manager().restart(spec))),
    'strata.updateSettings': action('update_settings', settingsPatch, (patch) => (
      { ok: true, settings: publicSettings(config().updateStrataSettings(patch)) })),
    'strata.reverify': action('reverify', noPayload, async () => {
      const result = await runtime().reverify();
      return result?.ok === true ? { ok: true } : failed(result?.reason, 'strata_reverify_failed');
    }),
  }, authorization);
}

module.exports = { registerStrataIpc, splitReason };
