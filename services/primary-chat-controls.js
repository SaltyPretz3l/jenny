'use strict';

/* services/primary-chat-controls.js - the primary Jenny chat's controls (row 76): the pause
 * flag, standing launch permissions, the user's per-action rules (row 87; the matcher is
 * primary-action-rules.js) and the short control history, kept in the profile's
 * `primaryChat` shell-config block (shell-config-primary-chat.js owns its shape).
 *
 * Composition-root style (like session-directory-service.js): every dependency is an
 * injected getter, a missing or throwing one yields a refusal or an "off" answer, never a
 * throw to the caller. Other slices read it through ports: the wake asks `isPaused`, the
 * proposal publish asks `matchLaunchPermission`, the IPC layer and the activity log use
 * `getState` / `recordHistory`. It only records state; it never starts a chat or sends mail.
 * Diagnostics carry reasons only, never titles, project names or ids of chats.
 */

const { randomBytes } = require('crypto');
const { findPrimarySessions, isPrimarySession } = require('./backend/primary-session');
const {
  DEFAULT_DIGEST, PRIMARY_CHAT_HISTORY_KINDS, PRIMARY_CHAT_LIMITS, RULE_HISTORY_KINDS, SCHEDULE_HISTORY_KINDS, isLivePermission,
  isPermissionId, isReadOnlyPrimaryChat, isRuleId, normalizeActionRule, normalizePrimaryChat, normalizeProjectId, normalizeRunModes,
} = require('./shell-config-primary-chat');

const SCHEMA_VERSION = 1;
// written only through recordSetting* / recordChat* / recordScheduleEvent / recordDigestSkipped / the rule methods
const MANAGED_KINDS = new Set([
  'setting_changed', 'setting_undone', 'chat_changed', 'chat_change_undone', 'digest_skipped', ...SCHEDULE_HISTORY_KINDS,
  ...RULE_HISTORY_KINDS,
]);
const RULE_DENIED_COALESCE_MS = 60 * 60 * 1000; // one rule_denied entry per rule per hour: a looping model cannot flood history
const DIGEST_FIELDS = Object.freeze(Object.keys(DEFAULT_DIGEST));
const refusal = (reason) => ({ ok: false, reason });
const isRecordLike = (value) => Boolean(value) && typeof value === 'object' && typeof value.permission_id === 'string';

function read(getter) {
  try { return typeof getter === 'function' ? getter() || null : null; } catch (_error) { return null; }
}

function attempt(fn, fallback) {
  try { return fn(); } catch (_error) { return fallback; }
}

const sameModes = (left, right) => (left === null || right === null
  ? left === right : left.length === right.length && left.every((mode, index) => mode === right[index]));

function createPrimaryChatControls({
  configService = () => null, sessionStore = () => null, featureFlags = () => ({}), projectService = () => null,
  resumeWake = null, createId = () => `lp_${randomBytes(16).toString('hex')}`,
  createRuleId = () => `ar_${randomBytes(16).toString('hex')}`, now = () => new Date(), log = () => {}, emit = () => {},
} = {}) {
  const flags = () => read(featureFlags) || {};
  const primaryOn = () => flags().primary_chat !== false;
  const flagOn = (key) => primaryOn() && flags()[key] !== false;
  const controlsEnabled = () => flagOn('primary_chat_controls');
  const launchPermissionEnabled = () => flagOn('primary_launch_permission');
  const actionRulesEnabled = () => flagOn('primary_action_rules');
  const nowIso = () => new Date(now()).toISOString();

  function primarySessionId() {
    if (!primaryOn()) return null;
    return attempt(() => findPrimarySessions(read(sessionStore)?.listSessions())[0]?.id ?? null, null);
  }

  // Row 87: the caller's own role (one summary peek), so a rule check never lists every session for an ordinary chat.
  const isPrimary = (sessionId) => primaryOn() && attempt(() => isPrimarySession(read(sessionStore), sessionId), false);

  const currentBlock = () => attempt(() => {
    const block = read(configService)?.getState()?.primaryChat;
    return block ? normalizePrimaryChat(block) : null;
  }, null);
  const isPausedBlock = (block) => controlsEnabled() && typeof block?.pausedAt === 'string';

  function isPaused(sessionId) {
    return attempt(() => {
      if (!controlsEnabled() || typeof sessionId !== 'string' || !sessionId) return false;
      const block = currentBlock();
      return isPausedBlock(block) && sessionId === primarySessionId();
    }, false);
  }

  function projectOf(projectId) {
    if (projectId === '*') return null;
    const project = attempt(() => read(projectService)?.get?.(projectId), null);
    return project && typeof project.id === 'string' ? { id: project.id, name: String(project.name ?? '') } : null;
  }
  const withProject = (record) => ({ ...record, project: projectOf(record.project_id) });
  const permissionsOf = (block) => (Array.isArray(block?.launchPermissions) ? block.launchPermissions.filter(isRecordLike) : []);
  const rulesOf = (block) => (Array.isArray(block?.actionRules) ? block.actionRules.filter((rule) => isRuleId(rule?.rule_id)) : []);

  // Read-modify-write through the config service. `build(block, at)` returns a patch, or null for
  // "nothing to change". Revoked permissions and rules past retention are pruned as part of every write.
  function write(build) {
    const config = read(configService);
    const current = currentBlock();
    if (!config || typeof config.updatePrimaryChat !== 'function' || !current || isReadOnlyPrimaryChat(current)) {
      return refusal('unavailable');
    }
    const at = nowIso();
    const cutoff = Date.parse(at) - PRIMARY_CHAT_LIMITS.revoked_retention_ms;
    const fresh = (record) => isLivePermission(record) || Date.parse(record.revoked_at) > cutoff;
    const kept = current.launchPermissions.filter(fresh);
    const keptRules = current.actionRules.filter(fresh);
    const base = { ...current, launchPermissions: kept, actionRules: keptRules };
    const patch = build(base, at);
    if (!patch) return { ok: true, changed: false, block: current };
    try {
      const block = normalizePrimaryChat(config.updatePrimaryChat({ launchPermissions: kept, actionRules: keptRules, ...patch }));
      attempt(() => emit({ schema_version: SCHEMA_VERSION, session_id: primarySessionId(), paused: isPausedBlock(block) }), null);
      return { ok: true, changed: true, block };
    } catch (error) {
      const token = typeof error?.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(error.reason) ? error.reason : 'write_failed';
      attempt(() => log('WARN', 'primary_chat.write_failed', { reason: token }), null);
      return refusal('unavailable');
    }
  }
  const withHistory = (block, entry) => [...block.history, entry];

  // Gate shared by the mutating controls: returns a refusal, or the primary id.
  function guard(enabled) {
    if (!enabled()) return refusal('disabled');
    const id = primarySessionId();
    return id ? { ok: true, id } : refusal('not_found');
  }

  function pause() {
    const gate = guard(controlsEnabled);
    if (!gate.ok) return gate;
    const written = write((block, at) => (block.pausedAt ? null
      : { pausedAt: at, history: withHistory(block, { kind: 'paused', at }) }));
    return written.ok ? { ok: true, paused: true, paused_at: written.block.pausedAt } : written;
  }

  async function resume() {
    const gate = guard(controlsEnabled);
    if (!gate.ok) return gate;
    const written = write((block, at) => (block.pausedAt === null ? null
      : { pausedAt: null, history: withHistory(block, { kind: 'resumed', at }) }));
    if (!written.ok) return written;
    let woke = null;
    if (written.changed && typeof resumeWake === 'function') {
      try { woke = (await resumeWake(gate.id)) ?? null; } catch (_error) { woke = null; }
    }
    return { ok: true, paused: false, paused_at: null, woke };
  }

  function listPermissions({ include_revoked: includeRevoked = true } = {}) {
    const block = currentBlock();
    if (!block) return [];
    return permissionsOf(block).filter((record) => includeRevoked || isLivePermission(record)).map(withProject);
  }

  function grantLaunch(input) {
    if (!launchPermissionEnabled()) return refusal('disabled');
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const projectId = normalizeProjectId(source.project_id);
    const runModes = normalizeRunModes(source.run_modes === undefined ? null : source.run_modes);
    const cap = source.max_children_per_turn === undefined ? 1 : source.max_children_per_turn;
    if (projectId === null || runModes === undefined
      || !Number.isSafeInteger(cap) || cap < 1 || cap > PRIMARY_CHAT_LIMITS.max_children_per_turn_max) return refusal('invalid_request');
    const gate = guard(launchPermissionEnabled);
    if (!gate.ok) return gate;
    if (projectId !== '*' && !attempt(() => read(projectService)?.get?.(projectId), null)) return refusal('unknown_project');
    let outcome = null;
    const written = write((block, at) => {
      const same = block.launchPermissions.find((record) => isLivePermission(record) && record.project_id === projectId
        && record.max_children_per_turn === cap && sameModes(record.run_modes, runModes));
      if (same) { outcome = { ok: true, permission: same, created: false }; return null; }
      if (block.launchPermissions.filter(isLivePermission).length >= PRIMARY_CHAT_LIMITS.permissions_max) {
        outcome = refusal('capacity');
        return null;
      }
      const record = {
        permission_id: createId(), project_id: projectId, run_modes: runModes, max_children_per_turn: cap,
        created_at: at, revoked_at: null,
      };
      if (!isPermissionId(record.permission_id)) { outcome = refusal('unavailable'); return null; }
      const list = [...block.launchPermissions, record];
      // The stored cap counts revoked entries too: make room by dropping revoked ones first.
      while (list.length > PRIMARY_CHAT_LIMITS.permissions_max) list.splice(list.findIndex((entry) => !isLivePermission(entry)), 1);
      outcome = { ok: true, permission: record, created: true };
      return { launchPermissions: list, history: withHistory(block, { kind: 'permission_granted', at, permission_id: record.permission_id }) };
    });
    return written.ok ? outcome : written;
  }

  function revokeLaunch(input) {
    const permissionId = input && typeof input === 'object' ? input.permission_id : null;
    if (!isPermissionId(permissionId)) return refusal('invalid_request');
    const gate = guard(primaryOn);
    if (!gate.ok) return gate;
    let outcome = null;
    const written = write((block, at) => {
      const found = block.launchPermissions.find((record) => record.permission_id === permissionId);
      if (!found) { outcome = refusal('not_found'); return null; }
      if (!isLivePermission(found)) { outcome = { ok: true, permission: found, created: false }; return null; }
      const revoked = { ...found, revoked_at: at };
      outcome = { ok: true, permission: revoked };
      return {
        launchPermissions: block.launchPermissions.map((record) => (record === found ? revoked : record)),
        history: withHistory(block, { kind: 'permission_revoked', at, permission_id: permissionId }),
      };
    });
    return written.ok ? outcome : written;
  }

  // The most specific live permission for the primary chat, or null. Never throws.
  function matchLaunchPermission({ sessionId, destinationProjectId, runMode } = {}) {
    return attempt(() => {
      if (!launchPermissionEnabled() || !isPrimarySession(read(sessionStore), sessionId)) return null;
      const block = currentBlock();
      if (!block || isReadOnlyPrimaryChat(block)) return null; // a newer build's record may narrow in ways this one cannot read
      const candidates = permissionsOf(block).filter((record) => isLivePermission(record)
        && (record.project_id === '*' || record.project_id === destinationProjectId)
        && (record.run_modes === null || record.run_modes.includes(runMode)));
      candidates.sort((left, right) => (right.project_id !== '*') - (left.project_id !== '*')
        || right.created_at.localeCompare(left.created_at));
      const best = candidates[0];
      return best ? Object.freeze({ permission_id: best.permission_id, max_children_per_turn: best.max_children_per_turn }) : null;
    }, null);
  }

  // ---------- row 87: per-action rules ----------

  function listActionRules({ include_revoked: includeRevoked = true } = {}) {
    const block = currentBlock();
    if (!block || isReadOnlyPrimaryChat(block)) return [];
    return rulesOf(block).filter((rule) => includeRevoked || isLivePermission(rule));
  }

  // The rule's target must exist now: a known project, or another chat (never the Jenny chat itself).
  function targetKnown(target, primaryId) {
    if (target.kind === 'project') return Boolean(attempt(() => read(projectService)?.get?.(target.id), null));
    if (target.kind !== 'chat') return true;
    return target.id !== primaryId && Boolean(attempt(() => read(sessionStore)?.peekSessionSummary?.(target.id), null));
  }

  // `{action, target, effect, run_modes?}` from the user (the Permissions list or a card's checkbox; never a model).
  // A launch allow is a launch permission (grantLaunch), not a rule.
  function addActionRule(input) {
    if (!actionRulesEnabled()) return refusal('disabled');
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const ruleId = createRuleId();
    if (!isRuleId(ruleId)) return refusal('unavailable');
    const draft = normalizeActionRule({
      rule_id: ruleId, action: source.action, target: source.target, effect: source.effect,
      run_modes: source.run_modes === undefined ? null : source.run_modes, created_at: nowIso(), revoked_at: null,
    });
    if (!draft) return refusal('invalid_request');
    const gate = guard(actionRulesEnabled);
    if (!gate.ok) return gate;
    if (!targetKnown(draft.target, gate.id)) return refusal(draft.target.kind === 'project' ? 'unknown_project' : 'not_found');
    let outcome = null;
    const written = write((block, at) => {
      const same = block.actionRules.find((rule) => isLivePermission(rule) && rule.action === draft.action
        && rule.effect === draft.effect && rule.target.kind === draft.target.kind && rule.target.id === draft.target.id
        && sameModes(rule.run_modes, draft.run_modes));
      if (same) { outcome = { ok: true, rule: same, created: false }; return null; }
      if (block.actionRules.filter(isLivePermission).length >= PRIMARY_CHAT_LIMITS.action_rules_max) {
        outcome = refusal('capacity');
        return null;
      }
      const rule = { ...draft, created_at: at };
      const list = [...block.actionRules, rule];
      // The stored cap counts revoked entries too: make room by dropping revoked ones first.
      while (list.length > PRIMARY_CHAT_LIMITS.action_rules_max) list.splice(list.findIndex((entry) => !isLivePermission(entry)), 1);
      outcome = { ok: true, rule, created: true };
      return { actionRules: list, history: withHistory(block, { kind: 'rule_added', at, rule_id: rule.rule_id }) };
    });
    return written.ok ? outcome : written;
  }

  // Revoking stays possible with the rules flag off, so the user can always clear a rule.
  function revokeActionRule(input) {
    const ruleId = input && typeof input === 'object' ? input.rule_id : null;
    if (!isRuleId(ruleId)) return refusal('invalid_request');
    const gate = guard(primaryOn);
    if (!gate.ok) return gate;
    let outcome = null;
    const written = write((block, at) => {
      const found = block.actionRules.find((rule) => rule.rule_id === ruleId);
      if (!found) { outcome = refusal('not_found'); return null; }
      if (!isLivePermission(found)) { outcome = { ok: true, rule: found, created: false }; return null; }
      const revoked = { ...found, revoked_at: at };
      outcome = { ok: true, rule: revoked };
      return {
        actionRules: block.actionRules.map((rule) => (rule === found ? revoked : rule)),
        history: withHistory(block, { kind: 'rule_revoked', at, rule_id: ruleId }),
      };
    });
    return written.ok ? outcome : written;
  }

  // A deny rule refused an action (D7): at most one entry per rule per hour.
  function recordRuleDenied(ruleId) {
    if (!primaryOn() || !isRuleId(ruleId)) return false;
    const written = write((block, at) => {
      const recent = block.history.some((row) => row.kind === 'rule_denied' && row.rule_id === ruleId
        && Date.parse(at) - Date.parse(row.at) < RULE_DENIED_COALESCE_MS);
      return recent ? null : { history: withHistory(block, { kind: 'rule_denied', at, rule_id: ruleId }) };
    });
    return written.ok === true;
  }

  function recordHistory(kind, { permission_id: permissionId } = {}) {
    if (!primaryOn() || !PRIMARY_CHAT_HISTORY_KINDS.includes(kind) || MANAGED_KINDS.has(kind)) return false;
    const written = write((block, at) => ({
      history: withHistory(block, isPermissionId(permissionId) ? { kind, at, permission_id: permissionId } : { kind, at }),
    }));
    return written.ok === true;
  }

  // Row 88: a Jenny-made settings batch and its undo (primary-settings-service.js owns the rules;
  // the history normalizer owns the shape and drops anything malformed).
  function recordSettingChange({ change_id: changeId, changes } = {}) {
    if (!primaryOn()) return false;
    const written = write((block, at) => ({ history: withHistory(block, { kind: 'setting_changed', at, change_id: changeId, changes }) }));
    return written.ok === true && written.block.history.some((row) => row.kind === 'setting_changed' && row.change_id === changeId);
  }

  function recordSettingUndone(changeId) {
    if (!primaryOn()) return false;
    const written = write((block, at) => ({ history: withHistory(block, { kind: 'setting_undone', at, change_id: changeId }) }));
    return written.ok === true;
  }

  // `{ entry, undone }` for a recorded batch, or null (unknown or evicted by the history cap).
  function findSettingChange(changeId) {
    const history = currentBlock()?.history || [];
    const entry = history.find((row) => row.kind === 'setting_changed' && row.change_id === changeId);
    return entry ? { entry, undone: history.some((row) => row.kind === 'setting_undone' && row.change_id === changeId) } : null;
  }

  // Row 94: a Jenny-made change to another chat and its undo (primary-chat-manage-service.js owns the rules;
  // the history normalizer owns the shape and drops anything malformed).
  function recordChatChange(entry) {
    if (!primaryOn() || !entry || typeof entry !== 'object') return false;
    const { change_id: changeId, session_id: sessionId, action, field, before, after } = entry;
    const written = write((block, at) => ({
      history: withHistory(block, { kind: 'chat_changed', at, change_id: changeId, session_id: sessionId, action, field, before, after }),
    }));
    return written.ok === true && written.block.history.some((row) => row.kind === 'chat_changed' && row.change_id === changeId);
  }

  function recordChatChangeUndone(changeId) {
    if (!primaryOn()) return false;
    const written = write((block, at) => ({ history: withHistory(block, { kind: 'chat_change_undone', at, change_id: changeId }) }));
    return written.ok === true;
  }

  // `{ entry, undone }` for a recorded chat change, or null (unknown or evicted by the history cap).
  function findChatChange(changeId) {
    const history = currentBlock()?.history || [];
    const entry = history.find((row) => row.kind === 'chat_changed' && row.change_id === changeId);
    return entry ? { entry, undone: history.some((row) => row.kind === 'chat_change_undone' && row.change_id === changeId) } : null;
  }

  // Row 85: a scheduled-check event (primary-schedule-service.js for Jenny's changes, primary-scheduled-check.js for
  // fires that were skipped or missed). Absent optional fields stay absent; the normalizer drops a malformed entry.
  function recordScheduleEvent(entry) {
    if (!primaryOn() || !entry || typeof entry !== 'object' || !SCHEDULE_HISTORY_KINDS.includes(entry.kind)) return false;
    const { kind, reminder_id: reminderId, label, reason, by } = entry;
    let stamp = null;
    const written = write((block, at) => {
      stamp = at;
      return { history: withHistory(block, {
        kind, at, reminder_id: reminderId, label,
        ...(typeof reason === 'string' ? { reason } : {}), ...(typeof by === 'string' ? { by } : {}),
      }) };
    });
    return written.ok === true && written.block.history.some((row) => row.kind === kind && row.at === stamp && row.reminder_id === reminderId);
  }

  // Row 86: the digest cursors; read even when the flag is off, so the presence cursor
  // is already current on the day the user turns digests on.
  function getDigest() {
    return currentBlock()?.digest || null;
  }

  // Row 86: merge known digest fields; the normalizer drops an invalid value back to its default.
  function updateDigest(patch) {
    if (!primaryOn() || !patch || typeof patch !== 'object') return false;
    const fields = Object.fromEntries(DIGEST_FIELDS.filter((key) => Object.hasOwn(patch, key)).map((key) => [key, patch[key]]));
    if (!Object.keys(fields).length) return false;
    return write((block) => ({ digest: { ...block.digest, ...fields } })).ok === true;
  }

  // Row 86: a due digest held back (quiet_hours, cap, paused, engine_cold, ...), logged once per window by the caller.
  function recordDigestSkipped(reason) {
    if (!primaryOn() || typeof reason !== 'string') return false;
    let stamp = null;
    const written = write((block, at) => { stamp = at; return { history: withHistory(block, { kind: 'digest_skipped', at, reason }) }; });
    return written.ok === true && written.block.history.some((row) => row.kind === 'digest_skipped' && row.at === stamp);
  }

  function getState() {
    const block = currentBlock();
    if (!block) return refusal('unavailable');
    const controls = controlsEnabled();
    return {
      ok: true,
      schema_version: SCHEMA_VERSION,
      session_id: primarySessionId(),
      paused: isPausedBlock(block),
      paused_at: block.pausedAt,
      permissions: permissionsOf(block).map(withProject),
      rules: isReadOnlyPrimaryChat(block) ? [] : rulesOf(block),
      history: Array.isArray(block.history) ? block.history : [],
      flags: {
        controls, launch_permission: launchPermissionEnabled(), activity_log: flagOn('primary_activity_log'),
        action_rules: actionRulesEnabled(),
      },
    };
  }

  return {
    actionRulesEnabled, addActionRule, controlsEnabled, findChatChange, findSettingChange, getDigest, getState, grantLaunch, isPaused, isPrimary,
    launchPermissionEnabled, listActionRules, listPermissions, matchLaunchPermission, pause, primarySessionId, recordChatChange,
    recordChatChangeUndone, recordDigestSkipped, recordHistory, recordRuleDenied, recordScheduleEvent, recordSettingChange,
    recordSettingUndone, resume, revokeActionRule, revokeLaunch, updateDigest,
  };
}

module.exports = { createPrimaryChatControls };
