'use strict';

/* services/primary-settings-service.js - the port behind the Jenny chat's `settings_get` /
 * `settings_change` tools, their approval card and Activity's Undo (row 88,
 * docs/plans/PRIMARY_SETTINGS_WRITES_2026-10-27.md D2-D5).
 *
 * Invariant: every write is a card. `prepareCard` computes the card's rows (setting, now, after)
 * from the registry (primary-settings-allowlist.js), never from model text, and remembers them
 * under the call id. `change` writes only when that call's card exists and the values still
 * match what the card showed (else `stale`), so a call that reached execution without a card
 * (a refused card, a restart, another chat) can never write. A batch is all or nothing: a writer
 * that fails reverts the earlier writes of the batch. Each applied batch is one `setting_changed`
 * history entry, and `undo` restores its "before" values only while every key still holds the
 * value Jenny set.
 *
 * Composition-root style: dependencies are injected getters; a missing or throwing one is a
 * refusal (`unavailable`), never a throw. Change, undo and the card's reads are serialized so two
 * batches never interleave. Answers carry stable reasons only, never exception text.
 */

const { randomBytes } = require('crypto');
const { CHANGE_ID, PRIMARY_SETTINGS_KEYS, PRIMARY_SETTINGS_LIMITS, PRIMARY_SETTINGS_REASONS: R } = require('./primary-settings-contract');
const { getPrimarySettingEntry } = require('./primary-settings-allowlist');
const { isPlainObject } = require('./value-utils');

const CARD_TTL_MS = 30 * 60 * 1000;
const CARDS_MAX = 16;

const refusal = (reason, key) => (key ? { ok: false, reason, key } : { ok: false, reason });
const reasonOf = (error, fallback) => (Object.values(R).includes(error?.reason) ? error.reason : fallback);

function read(getter) {
  try { return typeof getter === 'function' ? getter() || null : null; } catch (_error) { return null; }
}

function attempt(fn, fallback) {
  try { return fn(); } catch (_error) { return fallback; }
}

// A relay that reads the window once per operation (the card asks for several appearance keys);
// an apply invalidates the cached read.
function cachedRelay(relay) {
  let pending = null;
  return {
    read() {
      if (!relay) return Promise.resolve(refusal(R.unavailable));
      pending ||= Promise.resolve().then(() => relay.read()).catch(() => refusal(R.unavailable));
      return pending;
    },
    async apply(values) {
      pending = null;
      if (!relay) return refusal(R.unavailable);
      try { return await relay.apply(values); } catch (_error) { return refusal(R.unavailable); }
    },
  };
}

function labelOf(entry, value, options) {
  if (entry.kind === 'boolean') return value ? 'On' : 'Off';
  const found = Array.isArray(options) ? options.find((option) => option.value === value) : null;
  return found ? found.label : String(value);
}

// The closed request shape (the tool checks it first; this is the second line).
function checkChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > PRIMARY_SETTINGS_LIMITS.changes_max) {
    return refusal(R.invalid_input);
  }
  const seen = new Set();
  for (const change of changes) {
    if (!isPlainObject(change) || seen.has(change.key)) return refusal(R.invalid_input);
    seen.add(change.key);
    if (!getPrimarySettingEntry(change.key)) return refusal(R.not_allowed, typeof change.key === 'string' ? change.key.slice(0, 64) : undefined);
  }
  return null;
}

function createPrimarySettingsService({
  shellConfigService = () => null, applyFeatureSettingsPatch = () => null, appearanceRelay = () => null,
  controls = () => null, featureFlags = () => ({}), primarySessionId = () => null,
  createId = () => `sc_${randomBytes(16).toString('hex')}`, now = () => Date.now(), log = () => {},
} = {}) {
  const cards = new Map(); // `${session_id}\n${tool_call_id}` -> { rows, at }
  let tail = Promise.resolve();

  const enabled = () => {
    const flags = read(featureFlags) || {};
    return flags.primary_chat !== false && flags.primary_settings_writes !== false;
  };
  // The tools are offered only to the primary chat; the port re-checks the caller (fails closed).
  const isPrimary = (sessionId) => typeof sessionId === 'string' && sessionId !== '' && read(primarySessionId) === sessionId;
  const note = (level, event, details) => { try { log(level, event, details); } catch (_error) { /* never changes an answer */ } };

  function serialize(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  }

  function context() {
    const config = read(shellConfigService);
    if (!config) return null;
    const patch = read(applyFeatureSettingsPatch);
    return {
      shellConfigService: config,
      applyFeatureSettingsPatch: typeof patch === 'function' ? patch : async () => { throw Object.assign(new Error('memory'), { reason: R.unavailable }); },
      appearanceRelay: cachedRelay(read(appearanceRelay)),
    };
  }

  // ---------- read ----------

  async function describe({ keys, session_id: sessionId } = {}) {
    if (!enabled()) return refusal(R.disabled);
    if (!isPrimary(sessionId)) return refusal(R.not_primary);
    const wanted = keys === undefined ? PRIMARY_SETTINGS_KEYS : keys;
    if (!Array.isArray(wanted) || wanted.length === 0 || new Set(wanted).size !== wanted.length) return refusal(R.invalid_input);
    const unknown = wanted.find((key) => !getPrimarySettingEntry(key));
    if (unknown !== undefined) return refusal(R.not_allowed, typeof unknown === 'string' ? unknown.slice(0, 64) : undefined);
    const ctx = context();
    if (!ctx) return refusal(R.unavailable);
    const settings = [];
    const unavailable = [];
    for (const key of wanted) {
      const entry = getPrimarySettingEntry(key);
      try {
        const value = await entry.read(ctx);
        const options = await entry.options(ctx);
        settings.push({
          key, label: entry.label, kind: entry.kind, value, value_label: labelOf(entry, value, options),
          ...(options ? { allowed: options.map((option) => option.value) } : {}),
        });
      } catch (_error) {
        unavailable.push(key);
      }
    }
    return { ok: true, settings, ...(unavailable.length ? { unavailable } : {}) };
  }

  // ---------- the card ----------

  // Validates and reads "before" for each change; drops changes that already hold their value.
  async function prepare(ctx, changes) {
    const invalid = checkChanges(changes);
    if (invalid) return invalid;
    const rows = [];
    for (const { key, value } of changes) {
      const entry = getPrimarySettingEntry(key);
      let verdict;
      let before;
      let options;
      try {
        verdict = await entry.validate(value, ctx);
        if (!verdict.ok) return refusal(verdict.reason, key);
        before = await entry.read(ctx);
        options = await entry.options(ctx);
      } catch (error) {
        return refusal(reasonOf(error, R.unavailable), key);
      }
      if (before === verdict.value) continue;
      rows.push({
        key, label: entry.label, label_key: entry.label_key, kind: entry.kind, before, after: verdict.value,
        before_label: labelOf(entry, before, options), after_label: labelOf(entry, verdict.value, options),
      });
    }
    return rows.length ? { ok: true, rows } : refusal(R.unchanged);
  }

  const cardKey = (sessionId, callId) => `${sessionId}\n${callId}`;

  function pruneCards() {
    const cutoff = now() - CARD_TTL_MS;
    for (const [key, card] of cards) if (card.at < cutoff) cards.delete(key);
    while (cards.size > CARDS_MAX) cards.delete(cards.keys().next().value);
  }

  /** The approval card's trusted rows for one call; remembered so `change` can match them. */
  function prepareCard({ session_id: sessionId, tool_call_id: callId, changes } = {}) {
    return serialize(async () => {
      if (!enabled()) return refusal(R.disabled);
      if (typeof sessionId !== 'string' || !sessionId || typeof callId !== 'string' || !callId) return refusal(R.invalid_input);
      if (!isPrimary(sessionId)) return refusal(R.not_primary);
      const ctx = context();
      if (!ctx) return refusal(R.unavailable);
      const prepared = await prepare(ctx, changes);
      if (prepared.ok) {
        pruneCards();
        cards.set(cardKey(sessionId, callId), { rows: prepared.rows, at: now() });
      }
      return prepared;
    });
  }

  // ---------- writes ----------

  // Applies `[{ entry, value }]` in order; on a failure, puts back `[{ entry, value: revertTo }]` for
  // the failing step and the steps already applied, newest first: the failing write may have landed
  // before it threw (a relay reply after its timeout, a read-back that disagreed), and putting back an
  // unchanged value is a no-op. Answers `{ ok }` or `{ ok:false, reason, key, reverted }`.
  async function applyAll(ctx, steps) {
    const done = [];
    for (const step of steps) {
      try {
        await step.write(ctx);
        done.push(step);
      } catch (error) {
        let reverted = true;
        try { await step.revert(ctx); } catch (_revertError) { /* best effort: it may never have landed */ }
        for (const prior of done.reverse()) {
          try { await prior.revert(ctx); } catch (_revertError) { reverted = false; }
        }
        note('WARN', 'primary_settings.apply_failed', { key: step.key, reverted });
        return { ...refusal(reasonOf(error, R.apply_failed) === R.unavailable ? R.unavailable : R.apply_failed, step.key), reverted };
      }
    }
    return { ok: true };
  }

  const sameRows = (left, right) => left.length === right.length && left.every((row, index) => (
    row.key === right[index].key && row.before === right[index].before && row.after === right[index].after));

  /** `settings_change` after the card was approved. */
  function change({ changes, session_id: sessionId, tool_call_id: callId } = {}) {
    return serialize(async () => {
      if (!enabled()) return refusal(R.disabled);
      if (!isPrimary(sessionId)) return refusal(R.not_primary);
      const found = typeof sessionId === 'string' && typeof callId === 'string' ? cards.get(cardKey(sessionId, callId)) : null;
      if (found) cards.delete(cardKey(sessionId, callId));
      const card = found && found.at >= now() - CARD_TTL_MS ? found : null; // an expired card is stale
      const ctx = context();
      if (!ctx) return refusal(R.unavailable);
      const prepared = await prepare(ctx, changes);
      if (!prepared.ok) return prepared;
      // No card for this call, or a value moved since the card was shown: nothing is written.
      if (!card || !sameRows(card.rows, prepared.rows)) return refusal(R.stale);
      const steps = prepared.rows.map((row) => {
        const entry = getPrimarySettingEntry(row.key);
        return { key: row.key, write: (c) => entry.apply(c, row.after), revert: (c) => restore(entry, c, row.before) };
      });
      const applied = await applyAll(ctx, steps);
      if (!applied.ok) return applied;
      const changeId = createId();
      const record = prepared.rows.map(({ key, before, after, before_label, after_label }) => ({ key, before, after, before_label, after_label }));
      const controlService = read(controls);
      const recorded = attempt(() => controlService?.recordSettingChange?.({ change_id: changeId, changes: record }) === true, false);
      if (!recorded) note('WARN', 'primary_settings.history_write_failed', { count: record.length });
      // The interface language takes effect after a restart (the Settings page says the same).
      const restart = record.some((item) => item.key === 'ui_language') ? { restart_required: true } : {};
      return { ok: true, applied: record, change_id: changeId, undo_available: recorded, ...restart };
    });
  }

  // Restoring a "before" value is the user's own click in Activity (trusted IPC), never a model
  // request: a default run mode the user had set to Auto themselves goes back to Auto through the
  // same writer, which the registry (closed to the model) refuses. Every other key uses its entry.
  async function restore(entry, ctx, value) {
    if (entry.id !== 'default_run_mode' || value !== 'auto') return entry.apply(ctx, value);
    ctx.shellConfigService.updateChatUiSettings({ defaultRunMode: 'auto' });
    if (ctx.shellConfigService.getChatUiState().defaultRunMode !== 'auto') {
      throw Object.assign(new Error('default_run_mode: not restored'), { reason: R.apply_failed });
    }
    return undefined;
  }

  /** Activity's Undo: restore a batch's "before" values while every key still holds "after". */
  function undo({ change_id: changeId } = {}) {
    return serialize(async () => {
      if (!enabled()) return refusal(R.disabled);
      if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId)) return refusal(R.invalid_input);
      const controlService = read(controls);
      const found = typeof controlService?.findSettingChange === 'function'
        ? attempt(() => controlService.findSettingChange(changeId) ?? null, undefined) : undefined;
      if (found === undefined) return refusal(R.unavailable);
      if (!found) return refusal(R.not_found);
      if (found.undone) return refusal(R.already_undone);
      const ctx = context();
      if (!ctx) return refusal(R.unavailable);
      const changes = found.entry.changes.filter((item) => getPrimarySettingEntry(item.key));
      for (const item of changes) {
        let current;
        try { current = await getPrimarySettingEntry(item.key).read(ctx); } catch (error) { return refusal(reasonOf(error, R.unavailable), item.key); }
        if (current !== item.after) return refusal(R.changed_since, item.key);
      }
      const steps = changes.map((item) => {
        const entry = getPrimarySettingEntry(item.key);
        return { key: item.key, write: (c) => restore(entry, c, item.before), revert: (c) => entry.apply(c, item.after) };
      });
      const applied = await applyAll(ctx, steps);
      if (!applied.ok) return applied;
      const recorded = attempt(() => controlService.recordSettingUndone?.(changeId) === true, false);
      if (!recorded) note('WARN', 'primary_settings.history_write_failed', { count: 0 });
      return { ok: true, change_id: changeId, restored: changes.map(({ key, before }) => ({ key, value: before })) };
    });
  }

  return { change, describe, enabled, prepareCard, undo };
}

module.exports = { createPrimarySettingsService };
