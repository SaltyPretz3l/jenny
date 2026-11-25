'use strict';

// The runtime facet's managed-server parts for jenny-status-composer.js:
// `llama_server` (wire-shaped like local_runtime) and `managed_server`, the one
// managed server the health pill and Diagnostics name. One managed server is up
// at a time, ranked as the GPU launch gates rank them (row 200): Strata over
// NInfer over llama-server. Both are allowlists: never a key, a path or a raw
// manager object, whatever fields a manager status grows.

const { normalizeText: normalizeString } = require('../shared/normalize');

const RUNTIME_LABEL_PATTERN = /^[A-Za-z0-9 ._-]{0,32}$/;
const MANAGED_SERVER_STATES = ['stopped', 'starting', 'ready', 'stopping', 'crashed'];
const managedInteger = (value) => (Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const managedState = (value) => MANAGED_SERVER_STATES.find((state) => state === normalizeString(value).toLowerCase()) || 'unknown';
// model_path / last_error can carry the user's home directory.
const managedText = (redactor, value) => (redactor?.text ? redactor.text(value) : normalizeString(value));
// A bounded build/version token ('bundled', 'env', 'build 10683', '0.9.1'); never a path.
const managedRuntimeLabel = (value) => (typeof value === 'string' && RUNTIME_LABEL_PATTERN.test(value) ? value : '');
const live = (state) => ['starting', 'ready', 'stopping'].includes(state);

function buildLlamaServerFacet(service, redactor) {
  const manager = service?.options?.getLlamaServerManager?.();
  if (!manager || typeof manager.getStatus !== 'function') return null;
  try {
    const status = manager.getStatus() || {};
    return {
      state: managedState(status.state),
      pid: managedInteger(status.pid),
      port: managedInteger(status.port),
      alias: normalizeString(status.alias),
      model_path: managedText(redactor, status.modelPath),
      profile_id: normalizeString(status.profileId),
      acceleration_mode: normalizeString(status.accelerationMode),
      acceleration_reason: normalizeString(status.accelerationReason),
      reused: status.reused === true,
      last_error: managedText(redactor, status.lastError),
      runtime_label: managedRuntimeLabel(status.runtimeLabel),
      changed_at: managedInteger(status.changedAt),
    };
  } catch (_error) {
    return null;
  }
}

function readStatus(getManager) {
  try { return getManager?.()?.getStatus?.() || null; } catch (_error) { return null; }
}

// A NInfer or Strata manager status as the facet carries it.
function rankedFacet(kind, status, redactor) {
  const watts = Number(status.watchdogWatts);
  const accelerated = kind === 'ninfer' ? status.mtp === true : status.drafting === 'dspark';
  return {
    kind, state: managedState(status.state), alias: normalizeString(status.alias),
    port: managedInteger(status.port), acceleration_mode: accelerated ? (kind === 'ninfer' ? 'mtp' : 'dspark') : 'off',
    last_error: managedText(redactor, status.lastError), runtime_label: managedRuntimeLabel(status.runtimeLabel),
    stopped_by: normalizeString(status.stoppedBy) === 'watchdog' ? 'watchdog' : '',
    watchdog_watts: Number.isFinite(watts) && watts > 0 ? Math.round(watts) : 0,
    changed_at: managedInteger(status.changedAt),
  };
}

// The serving or launching manager wins, highest rank first; a retained
// failure (crashed, or stopped with an error) shows only while nothing below it
// serves, so a live lower-ranked server is never hidden behind it.
function buildManagedServerFacet(service, redactor, llama) {
  const ranked = [
    ['strata', readStatus(service?.options?.getStrataManager)],
    ['ninfer', readStatus(service?.options?.getNinferManager)],
  ].filter(([, status]) => status);
  const states = ranked.map(([, status]) => managedState(status.state));
  for (let index = 0; index < ranked.length; index += 1) {
    const [kind, status] = ranked[index];
    const lowerLive = states.slice(index + 1).some(live) || live(llama?.state);
    const retained = !(states[index] === 'stopped' && !managedText(redactor, status.lastError));
    if (live(states[index]) || (retained && !lowerLive)) return rankedFacet(kind, status, redactor);
  }
  return llama ? {
    kind: 'llama-server', state: llama.state, alias: llama.alias, port: llama.port,
    acceleration_mode: llama.acceleration_mode, last_error: llama.last_error, runtime_label: llama.runtime_label,
    stopped_by: '', watchdog_watts: 0, changed_at: llama.changed_at,
  } : null;
}

module.exports = { buildLlamaServerFacet, buildManagedServerFacet };
