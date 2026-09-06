'use strict';
// Metadata-only, bounded, append-only run history for the Workspace IDE Test
// Runner. Records carry { runId, configId, status, exitCode, durationMs,
// startedAt, finishedAt, terminationConfirmed? } — NEVER raw stdout (that stays ephemeral in the IDE
// panel). Backed by an injected store ({ read(default), write(value) }); the
// production store is a FileJsonStore (whole-file atomic rewrite), acceptable
// because the set is bounded (ring of last N per config).
//
// Attribution: a run started on the model's behalf (the `verify` tool, or the
// turn-finalization gate) carries `initiator: 'jenny'` from recordStart on, and a
// gate run also carries its 1-based `gateAttempt`. Both are absent -- not null --
// on a user-started run so every pre-existing record shape is unchanged. A
// `skipped` record (recordSkip) is a Jenny run that was requested but never
// started because the user's own run held the single-run lock: it has no
// duration and no exit code, only the reason.

const DEFAULT_MAX_PER_CONFIG = 100;
const FINISH_KEYS = [
  'status', 'exitCode', 'durationMs', 'finishedAt', 'startedAt', 'errorCode',
  // S17 advisory summary-parse counts (omitted unless a config's summaryRegex matched).
  'passedCount', 'failedCount',
  // WIDE-016: a timeout/abort record must preserve whether descendant death was confirmed.
  'terminationConfirmed', 'terminationWarning',
];
const MAX_INITIATOR_LENGTH = 32;
const MAX_SKIP_REASON_LENGTH = 64;

function attributionOf(record) {
  const out = {};
  const initiator = record && typeof record.initiator === 'string' ? record.initiator.trim() : '';
  if (initiator) {
    out.initiator = initiator.slice(0, MAX_INITIATOR_LENGTH);
  }
  const attempt = record ? Number(record.gateAttempt) : NaN;
  if (Number.isInteger(attempt) && attempt > 0) {
    out.gateAttempt = attempt;
  }
  return out;
}

/**
 * @param {{ store:{read:Function,write:Function}, maxPerConfig?:number, now?:Function }} deps
 */
function createTestRunnerHistory(deps = {}) {
  const store = deps.store && typeof deps.store === 'object' ? deps.store : null;
  const maxPerConfig = Number.isInteger(deps.maxPerConfig) && deps.maxPerConfig > 0
    ? deps.maxPerConfig
    : DEFAULT_MAX_PER_CONFIG;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();

  function read() {
    const raw = store && typeof store.read === 'function' ? store.read({ byConfig: {} }) : { byConfig: {} };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { byConfig: {} };
    }
    const byConfig = raw.byConfig;
    if (!byConfig || typeof byConfig !== 'object' || Array.isArray(byConfig)) {
      return { byConfig: {} };
    }
    return { byConfig };
  }

  function write(state) {
    if (store && typeof store.write === 'function') {
      store.write(state);
    }
  }

  function recordsFor(state, configId) {
    return Array.isArray(state.byConfig[configId]) ? state.byConfig[configId].slice() : [];
  }

  function getHistory(configId) {
    const records = read().byConfig[configId];
    return Array.isArray(records) ? records : [];
  }

  function recordStart(configId, record) {
    const state = read();
    const records = recordsFor(state, configId);
    records.push({
      runId: String((record && record.runId) || ''),
      configId,
      status: 'running',
      startedAt: (record && record.startedAt) || null,
      exitCode: null,
      durationMs: null,
      finishedAt: null,
      ...attributionOf(record),
    });
    while (records.length > maxPerConfig) {
      records.shift();
    }
    state.byConfig[configId] = records;
    write(state);
  }

  // A requested run that never started (the single-run lock was held). Terminal
  // on arrival: no finish follows, and reconcileRunning never touches it.
  function recordSkip(configId, record) {
    const state = read();
    const records = recordsFor(state, configId);
    const reason = record && typeof record.reason === 'string' ? record.reason.trim() : '';
    records.push({
      runId: String((record && record.runId) || ''),
      configId,
      status: 'skipped',
      startedAt: (record && record.startedAt) || null,
      exitCode: null,
      durationMs: null,
      finishedAt: (record && record.startedAt) || null,
      ...(reason ? { skipReason: reason.slice(0, MAX_SKIP_REASON_LENGTH) } : {}),
      ...attributionOf(record),
    });
    while (records.length > maxPerConfig) {
      records.shift();
    }
    state.byConfig[configId] = records;
    write(state);
  }

  function recordFinish(configId, runId, patch) {
    const state = read();
    const records = recordsFor(state, configId);
    const applied = {};
    for (const key of FINISH_KEYS) {
      if (patch && patch[key] !== undefined) {
        applied[key] = patch[key];
      }
    }
    const index = records.findIndex((entry) => entry && entry.runId === runId);
    if (index >= 0) {
      records[index] = { ...records[index], ...applied };
    } else {
      // Append-safe: a finish with no matching start still records the run.
      records.push({
        runId: String(runId || ''),
        configId,
        status: 'error',
        startedAt: null,
        exitCode: null,
        durationMs: null,
        finishedAt: null,
        ...applied,
      });
      while (records.length > maxPerConfig) {
        records.shift();
      }
    }
    state.byConfig[configId] = records;
    write(state);
  }

  function reconcileRunning() {
    const state = read();
    const stamp = now().toISOString();
    let changed = 0;
    for (const configId of Object.keys(state.byConfig)) {
      const records = state.byConfig[configId];
      if (!Array.isArray(records)) {
        continue;
      }
      state.byConfig[configId] = records.map((entry) => {
        if (entry && entry.status === 'running') {
          changed += 1;
          return { ...entry, status: 'interrupted', finishedAt: entry.finishedAt || stamp };
        }
        return entry;
      });
    }
    if (changed > 0) {
      write(state);
    }
    return changed;
  }

  return { read, getHistory, recordStart, recordSkip, recordFinish, reconcileRunning };
}

module.exports = {
  createTestRunnerHistory,
};
