'use strict';

const { stableJson } = require('./contracts');
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA = /^[a-f0-9]{64}$/u;
function fail() { throw Object.assign(new Error('quota_state_invalid'), { code: 'quota_state_invalid' }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail();
  return value;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
function normalizeCooldowns(value) {
  exact(value, ['schema_version', 'namespace', 'captured_at_ms', 'entries']);
  if (value.schema_version !== 1 || value.namespace !== 'tool_quota'
    || !Array.isArray(value.entries) || value.entries.length > 2000) fail();
  integer(value.captured_at_ms, 0, Number.MAX_SAFE_INTEGER);
  const entries = Array.from(value.entries, item => {
    exact(item, ['name', 'expires_at_ms', 'reason']);
    if (typeof item.name !== 'string' || !item.name.length || [...item.name].length > 256
      || item.name.trim().toLowerCase() !== item.name
      || !['web_per_turn', 'code_intelligence_per_turn', 'session_tool_budget'].includes(item.reason)) fail();
    integer(item.expires_at_ms, value.captured_at_ms + 1,
      Math.min(value.captured_at_ms + 604800000, Number.MAX_SAFE_INTEGER));
    return { ...item };
  });
  if (new Set(entries.map(item => item.name)).size !== entries.length) fail();
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { ...value, entries };
}
function normalizeQuotaState(value) {
  exact(value, ['schema_version', 'enabled', 'policy', 'session_baseline', 'admissions', 'cooldowns']);
  if (value.schema_version !== 1 || typeof value.enabled !== 'boolean'
    || !Array.isArray(value.admissions) || value.admissions.length > 2000) fail();
  integer(value.session_baseline, 0, Number.MAX_SAFE_INTEGER);
  exact(value.policy, ['web_per_turn', 'code_per_turn', 'session_calls', 'cooldown_ms']);
  for (const [key, max] of Object.entries({ web_per_turn: 100, code_per_turn: 100, session_calls: 2000, cooldown_ms: 604800000 })) {
    integer(value.policy[key], key === 'cooldown_ms' ? 0 : 1, max);
  }
  const admissions = Array.from(value.admissions, item => {
    exact(item, ['call_id', 'tool_id', 'arguments_sha256', 'web', 'code', 'web_refunded']);
    if (typeof item.call_id !== 'string' || !ID.test(item.call_id)
      || typeof item.tool_id !== 'string' || !TOOL.test(item.tool_id)
      || typeof item.arguments_sha256 !== 'string' || !SHA.test(item.arguments_sha256)
      || ['web', 'code', 'web_refunded'].some(key => typeof item[key] !== 'boolean')
      || (item.web_refunded && !item.web)) fail();
    return { ...item };
  });
  const cooldowns = normalizeCooldowns(value.cooldowns);
  if (new Set(admissions.map(item => item.call_id)).size !== admissions.length
    || !Number.isSafeInteger(value.session_baseline + admissions.length)
    || (!value.enabled && (admissions.length || value.session_baseline || cooldowns.entries.length))
    || admissions.filter(item => item.web && !item.web_refunded).length > value.policy.web_per_turn
    || admissions.filter(item => item.code).length > value.policy.code_per_turn
    || (admissions.length && value.session_baseline + admissions.length > value.policy.session_calls)) fail();
  return { ...value, policy: { ...value.policy }, admissions, cooldowns };
}

// Argument hashes are opaque Python-canonical digests. Python rechecks exact
// visible arguments and current tool classification before any resumed dispatch.
// Project accounting facts only; canonical selection and the decision/journal
// owners independently prove effects, including any completed mutation.
function quotaEffects(events) {
  if (!Array.isArray(events) || events.length > 4096) fail();
  const effects = events.filter(event => event.kind === 'tool_result').map(event => {
    const effect = { call_id: event.tool_call_id, tool_id: event.payload?.tool_name,
      success: event.payload?.success };
    if (typeof effect.call_id !== 'string' || !ID.test(effect.call_id)
      || typeof effect.tool_id !== 'string' || !TOOL.test(effect.tool_id)
      || typeof effect.success !== 'boolean') fail();
    return effect;
  });
  if (new Set(effects.map(effect => effect.call_id)).size !== effects.length) fail();
  return effects;
}
function assertQuotaCoverage(value, calls, effects = []) {
  const state = normalizeQuotaState(value);
  if (!state.enabled) return state;
  const pending = new Map(calls.map(call => [call.call_id, call]));
  const completed = new Map(effects.map(effect => [effect.call_id, effect]));
  for (const call of calls) {
    const admission = state.admissions.find(item => item.call_id === call.call_id);
    if (!admission || admission.tool_id !== call.tool_id || admission.web_refunded) fail();
  }
  for (const admission of state.admissions) {
    const effect = completed.get(admission.call_id);
    if (!pending.has(admission.call_id) && (!effect || effect.tool_id !== admission.tool_id)) fail();
    if (admission.web_refunded && (!effect || effect.success !== false)) fail();
  }
  return state;
}
function assertQuotaProgress(previous, current, calls, effects) {
  if (!previous && !current) return;
  if (!current) fail();
  const after = assertQuotaCoverage(current, calls, effects);
  // Legacy state can gain explicit proof that discipline was off. It cannot
  // acquire fresh enabled usage or drop previously captured accounting.
  if (!previous) { if (after.enabled) fail(); return; }
  const before = normalizeQuotaState(previous);
  if (before.enabled !== after.enabled || before.session_baseline !== after.session_baseline
    || stableJson(before.policy) !== stableJson(after.policy)
    || before.cooldowns.captured_at_ms > after.cooldowns.captured_at_ms
    || before.admissions.length > after.admissions.length) fail();
  for (const old of before.cooldowns.entries) {
    if (old.expires_at_ms <= after.cooldowns.captured_at_ms) continue;
    const next = after.cooldowns.entries.find(item => item.name === old.name);
    const refunded = old.reason === 'web_per_turn' && after.admissions.some(item =>
      item.tool_id.toLowerCase() === old.name && item.web_refunded
      && !before.admissions.find(prior => prior.call_id === item.call_id)?.web_refunded);
    if (!refunded && (!next || next.expires_at_ms < old.expires_at_ms || next.reason !== old.reason)) fail();
  }
  for (let index = 0; index < before.admissions.length; index += 1) {
    const old = before.admissions[index];
    const next = after.admissions[index];
    if (stableJson({ ...old, web_refunded: false }) !== stableJson({ ...next, web_refunded: false })
      || (old.web_refunded && !next.web_refunded)) fail();
  }
}
module.exports = { normalizeQuotaState, quotaEffects, assertQuotaCoverage, assertQuotaProgress };
