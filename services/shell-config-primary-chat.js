'use strict';

/* services/shell-config-primary-chat.js - the `primaryChat` shell-config block
 * (row 76): `{schemaVersion:1, pausedAt, launchPermissions, actionRules, history, digest}`. It holds
 * the profile's one primary Jenny chat's pause flag, its standing launch permissions
 * (D4 record, snake_case on the wire like the message grants), the user's per-action
 * rules (row 87) and a short control history. Invalid entries are dropped, never repaired. A block written by a NEWER
 * build (schemaVersion > 1) is preserved verbatim and treated read-only here, so an
 * older build never rewrites it. Additive: no CONFIG_VERSION bump; excluded from the
 * portable-preferences export (permissions belong to this machine). It owns shape
 * and bounds only; the controls service (primary-chat-controls.js) owns the rules.
 */

const { CHANGE_ID, PRIMARY_SETTINGS_KEYS, PRIMARY_SETTINGS_LIMITS, VALUE_TOKEN } = require('./primary-settings-contract');

const SCHEMA_VERSION = 1;
const PRIMARY_LAUNCH_RUN_MODES = Object.freeze(['ask', 'auto', 'plan', 'propose']);
const PRIMARY_CHAT_HISTORY_KINDS = Object.freeze([
  'paused', 'resumed', 'reset', 'forgot', 'permission_granted', 'permission_revoked',
  'setting_changed', 'setting_undone', // row 88: a Jenny-made settings batch and its undo
  'chat_changed', 'chat_change_undone', // row 94: a Jenny-made change to another chat and its undo
  // row 85: a scheduled check created, edited, turned on or off or cancelled (by Jenny or the user), or an
  // occurrence that was skipped or missed
  'schedule_created', 'schedule_updated', 'schedule_enabled', 'schedule_disabled', 'schedule_cancelled', 'schedule_skipped',
  'schedule_missed',
  'digest_skipped', // row 86: a "While you were away" digest that was due but held back (reason token)
  'rule_added', 'rule_revoked', 'rule_denied', // row 87: a user rule created or revoked, and a deny rule that refused an action
]);
const RULE_HISTORY_KINDS = Object.freeze(['rule_added', 'rule_revoked', 'rule_denied']);
// Row 87 (plan PRIMARY_ACTION_RULES_2026-10-27.md section 2, Q1): the effects and targets each action offers.
// A launch `allow` is row 76's launch permission (projected into the rules list, never stored here).
const PRIMARY_ACTION_RULE_SHAPES = Object.freeze({
  message: Object.freeze({ effects: Object.freeze(['allow', 'ask', 'deny']), targets: Object.freeze(['linked_children', 'project', 'chat', 'any']) }),
  launch: Object.freeze({ effects: Object.freeze(['deny']), targets: Object.freeze(['project', 'any']) }),
  stop: Object.freeze({ effects: Object.freeze(['deny']), targets: Object.freeze(['linked_children', 'project', 'chat', 'any']) }),
  schedule: Object.freeze({ effects: Object.freeze(['deny']), targets: Object.freeze(['any']) }),
  setting: Object.freeze({ effects: Object.freeze(['deny']), targets: Object.freeze(['any']) }),
});
const SCHEDULE_HISTORY_KINDS = Object.freeze(PRIMARY_CHAT_HISTORY_KINDS.filter((kind) => kind.startsWith('schedule_')));
const SCHEDULE_REMINDER_ID_MAX = 128;
const SCHEDULE_REASON = /^[a-z_]{1,32}$/;
// Row 94: the closed vocabularies of a chat change, mirroring primary-chat-manage-service.js. Row 94 P2 adds
// `project_create` / `project` (primary-chat-placement-service.js): the row sits on the calling chat, after is
// the new project's id. An older build drops such a row.
const CHAT_CHANGE_ACTIONS = Object.freeze([
  'rename', 'pin', 'unpin', 'archive', 'unarchive', 'move_to_project', 'set_model', 'set_effort', 'set_run_mode', 'project_create',
]);
const CHAT_CHANGE_FIELDS = Object.freeze([
  'title', 'pinned', 'archived_at', 'project_id', 'preferred_model', 'reasoning_effort', 'run_mode', 'project',
]);
const CHAT_CHANGE_TEXT_MAX = 200;
const CHAT_SESSION_ID_MAX = 128;
const PRIMARY_CHAT_LIMITS = Object.freeze({
  permissions_max: 32,
  history_max: 200, // row 88 Q6 (shared with rows 85-87): undo lives as long as the entry
  revoked_retention_ms: 30 * 24 * 60 * 60 * 1000,
  project_id_chars: 128,
  max_children_per_turn_max: 3,
  action_rules_max: 64, // row 87 D1: stored records, revoked ones included (dropped first to make room)
  rule_message_sends_per_day: 60, // row 87 D5: sends one message allow rule authorizes per rolling 24 h, then a card
});
// Row 86 (plan PRIMARY_DIGESTS_2026-10-27.md D8): the digest cursors. Whether digests run at all is the
// user-overridable `primary_digests` feature flag (default off); quiet hours are chatUi settings
// (`digestQuietStart` / `digestQuietEnd`), so neither is a field here.
const DEFAULT_DIGEST = Object.freeze({ lastPresentAt: null, lastDigestAt: null, lastDigestUntil: null });
const DEFAULT_PRIMARY_CHAT = Object.freeze({
  schemaVersion: SCHEMA_VERSION, pausedAt: null, launchPermissions: Object.freeze([]), actionRules: Object.freeze([]),
  history: Object.freeze([]), digest: DEFAULT_DIGEST,
});

const PERMISSION_ID = /^lp_[0-9a-f]{32}$/;
const RULE_ID = /^ar_[0-9a-f]{32}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// True when the stored block belongs to a newer schema than this build understands.
function isReadOnlyPrimaryChat(value) {
  return isRecord(value) && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > SCHEMA_VERSION;
}

// `YYYY-MM-DDTHH:MM:SS.mmmZ` that is a real instant (the round trip rejects 2026-13-45).
function isIsoInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPermissionId(value) {
  return typeof value === 'string' && PERMISSION_ID.test(value);
}

function isRuleId(value) {
  return typeof value === 'string' && RULE_ID.test(value);
}

function hasControlChars(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function normalizeProjectId(value) {
  if (value === '*') return '*';
  if (typeof value !== 'string' || !value || value.length > PRIMARY_CHAT_LIMITS.project_id_chars) return null;
  return hasControlChars(value) ? null : value;
}

// Sorted, unique, known run modes; null (every mode) stays null; anything else is invalid (undefined).
function normalizeRunModes(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const unique = new Set(value);
  if (unique.size !== value.length) return undefined;
  if (!value.every((mode) => PRIMARY_LAUNCH_RUN_MODES.includes(mode))) return undefined;
  return PRIMARY_LAUNCH_RUN_MODES.filter((mode) => unique.has(mode));
}

function normalizeLaunchPermission(value) {
  if (!isRecord(value)) return null;
  const projectId = normalizeProjectId(value.project_id);
  const runModes = normalizeRunModes(value.run_modes);
  const cap = value.max_children_per_turn;
  const capOk = Number.isSafeInteger(cap) && cap >= 1 && cap <= PRIMARY_CHAT_LIMITS.max_children_per_turn_max;
  const revokedOk = value.revoked_at === null || isIsoInstant(value.revoked_at);
  if (!isPermissionId(value.permission_id) || projectId === null || runModes === undefined || !capOk
    || !isIsoInstant(value.created_at) || !revokedOk) return null;
  return {
    permission_id: value.permission_id,
    project_id: projectId,
    run_modes: runModes,
    max_children_per_turn: cap,
    created_at: value.created_at,
    revoked_at: value.revoked_at,
  };
}

function isLivePermission(record) {
  return isRecord(record) && record.revoked_at === null;
}

function normalizePermissions(value) {
  const seen = new Set();
  const records = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const record = normalizeLaunchPermission(entry);
    if (!record || seen.has(record.permission_id)) continue;
    seen.add(record.permission_id);
    records.push(record);
  }
  if (records.length <= PRIMARY_CHAT_LIMITS.permissions_max) return records;
  // Over the cap: keep the newest by created_at, in their stored order.
  const newest = new Set([...records]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, PRIMARY_CHAT_LIMITS.permissions_max));
  return records.filter((record) => newest.has(record));
}

// Row 87: `{kind:'any'}`, `{kind:'linked_children'}`, or `{kind:'project'|'chat', id}` (a bounded id, never '*'),
// and only a target the action offers. Anything else is invalid (null).
function normalizeRuleTarget(action, value) {
  const shape = PRIMARY_ACTION_RULE_SHAPES[action];
  if (!shape || !isRecord(value) || !shape.targets.includes(value.kind)) return null;
  if (value.kind === 'any' || value.kind === 'linked_children') {
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  }
  const id = normalizeProjectId(value.id);
  return id && id !== '*' && Object.keys(value).length === 2 ? { kind: value.kind, id } : null;
}

// Row 87 D1: `{rule_id, action, target, effect, run_modes, created_at, revoked_at}`; invalid records are dropped.
function normalizeActionRule(value) {
  if (!isRecord(value) || !Object.hasOwn(PRIMARY_ACTION_RULE_SHAPES, value.action)) return null;
  const target = normalizeRuleTarget(value.action, value.target);
  const runModes = normalizeRunModes(value.run_modes);
  const revokedOk = value.revoked_at === null || isIsoInstant(value.revoked_at);
  if (!isRuleId(value.rule_id) || !target || !PRIMARY_ACTION_RULE_SHAPES[value.action].effects.includes(value.effect)
    || runModes === undefined || !isIsoInstant(value.created_at) || !revokedOk) return null;
  return {
    rule_id: value.rule_id, action: value.action, target, effect: value.effect, run_modes: runModes,
    created_at: value.created_at, revoked_at: value.revoked_at,
  };
}

function normalizeActionRules(value) {
  const seen = new Set();
  const records = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const record = normalizeActionRule(entry);
    if (!record || seen.has(record.rule_id)) continue;
    seen.add(record.rule_id);
    records.push(record);
  }
  if (records.length <= PRIMARY_CHAT_LIMITS.action_rules_max) return records;
  const newest = new Set([...records]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, PRIMARY_CHAT_LIMITS.action_rules_max));
  return records.filter((record) => newest.has(record));
}

// Row 87: `{kind, at, rule_id}` for a rule's creation, revocation or a refusal it caused.
function normalizeRuleEntry(value) {
  return isRuleId(value.rule_id) ? { kind: value.kind, at: value.at, rule_id: value.rule_id } : null;
}

// A settings value as history stores it: a boolean, a finite number or an enum/language token.
function isSettingValue(value) {
  return typeof value === 'boolean' || Number.isFinite(value) || (typeof value === 'string' && VALUE_TOKEN.test(value));
}

// A value label as the card showed it (an option name, "On"); optional, dropped when unreadable.
function settingLabel(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text && text.length <= PRIMARY_SETTINGS_LIMITS.label_chars ? text : null;
}

// `[{ key, before, after, before_label?, after_label? }]`, 1..changes_max, allowlisted unique keys;
// anything else drops the entry. The labels are display text only; undo reads the values.
function normalizeSettingChanges(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PRIMARY_SETTINGS_LIMITS.changes_max) return null;
  const keys = new Set();
  const changes = [];
  for (const change of value) {
    if (!isRecord(change) || !PRIMARY_SETTINGS_KEYS.includes(change.key) || keys.has(change.key)) return null;
    if (!isSettingValue(change.before) || !isSettingValue(change.after)) return null;
    keys.add(change.key);
    const labels = { before_label: settingLabel(change.before_label), after_label: settingLabel(change.after_label) };
    changes.push({
      key: change.key, before: change.before, after: change.after,
      ...Object.fromEntries(Object.entries(labels).filter(([, label]) => label !== null)),
    });
  }
  return changes;
}

function normalizeSettingEntry(value) {
  if (typeof value.change_id !== 'string' || !CHANGE_ID.test(value.change_id)) return null;
  if (value.kind === 'setting_undone') return { kind: value.kind, at: value.at, change_id: value.change_id };
  const changes = normalizeSettingChanges(value.changes);
  return changes ? { kind: value.kind, at: value.at, change_id: value.change_id, changes } : null;
}

// A chat field as history stores it: a bounded string, a boolean or null (never an object; absent is not null).
const isChatValue = (value) => value === null || typeof value === 'boolean'
  || (typeof value === 'string' && value.length <= CHAT_CHANGE_TEXT_MAX);

function normalizeChatEntry(value) {
  if (typeof value.change_id !== 'string' || !CHANGE_ID.test(value.change_id)) return null;
  if (value.kind === 'chat_change_undone') return { kind: value.kind, at: value.at, change_id: value.change_id };
  const sessionId = value.session_id;
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > CHAT_SESSION_ID_MAX) return null;
  if (!CHAT_CHANGE_ACTIONS.includes(value.action) || !CHAT_CHANGE_FIELDS.includes(value.field)) return null;
  if (!isChatValue(value.before) || !isChatValue(value.after)) return null;
  return {
    kind: value.kind, at: value.at, change_id: value.change_id, session_id: sessionId,
    action: value.action, field: value.field, before: value.before, after: value.after,
  };
}

// Row 86: `{kind: 'digest_skipped', at, reason}`.
function normalizeDigestEntry(value) {
  return typeof value.reason === 'string' && SCHEDULE_REASON.test(value.reason)
    ? { kind: value.kind, at: value.at, reason: value.reason } : null;
}

// Row 86: an invalid cursor falls back to null on its own (an old build simply drops the record).
function normalizeDigest(value) {
  const source = isRecord(value) ? value : {};
  const instant = (key) => (isIsoInstant(source[key]) ? source[key] : null);
  return { lastPresentAt: instant('lastPresentAt'), lastDigestAt: instant('lastDigestAt'), lastDigestUntil: instant('lastDigestUntil') };
}

// Row 85: `{kind, at, reminder_id, label, reason?, by?}`; the label is the reminder's (<= 200, may be empty).
function normalizeScheduleEntry(value) {
  const { reminder_id: reminderId, label, reason, by } = value;
  if (typeof reminderId !== 'string' || reminderId.length < 1 || reminderId.length > SCHEDULE_REMINDER_ID_MAX) return null;
  if (typeof label !== 'string' || label.length > CHAT_CHANGE_TEXT_MAX) return null;
  if (reason !== undefined && (typeof reason !== 'string' || !SCHEDULE_REASON.test(reason))) return null;
  if (by !== undefined && by !== 'jenny' && by !== 'user') return null;
  return {
    kind: value.kind, at: value.at, reminder_id: reminderId, label,
    ...(reason === undefined ? {} : { reason }), ...(by === undefined ? {} : { by }),
  };
}

function normalizeHistoryEntry(value) {
  if (!isRecord(value) || !PRIMARY_CHAT_HISTORY_KINDS.includes(value.kind) || !isIsoInstant(value.at)) return null;
  if (value.kind === 'setting_changed' || value.kind === 'setting_undone') return normalizeSettingEntry(value);
  if (value.kind === 'chat_changed' || value.kind === 'chat_change_undone') return normalizeChatEntry(value);
  if (SCHEDULE_HISTORY_KINDS.includes(value.kind)) return normalizeScheduleEntry(value);
  if (value.kind === 'digest_skipped') return normalizeDigestEntry(value);
  if (RULE_HISTORY_KINDS.includes(value.kind)) return normalizeRuleEntry(value);
  if (value.permission_id === undefined) return { kind: value.kind, at: value.at };
  if (!isPermissionId(value.permission_id)) return null;
  return { kind: value.kind, at: value.at, permission_id: value.permission_id };
}

function normalizeHistory(value) {
  const entries = (Array.isArray(value) ? value : []).map(normalizeHistoryEntry).filter(Boolean)
    .sort((left, right) => left.at.localeCompare(right.at)); // stable: oldest first
  return entries.slice(-PRIMARY_CHAT_LIMITS.history_max);
}

function normalizePrimaryChat(value) {
  if (isReadOnlyPrimaryChat(value)) return JSON.parse(JSON.stringify(value));
  const source = isRecord(value) ? value : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    pausedAt: isIsoInstant(source.pausedAt) ? source.pausedAt : null,
    launchPermissions: normalizePermissions(source.launchPermissions),
    actionRules: normalizeActionRules(source.actionRules),
    history: normalizeHistory(source.history),
    digest: normalizeDigest(source.digest),
  };
}

// Merge a `{pausedAt?, launchPermissions?, actionRules?, history?, digest?}` patch (shallow, then normalized). A read-only
// (future-version) block is returned untouched, so the write becomes a no-op. A patch cannot set the version.
function applyPrimaryChatPatch(current, patch) {
  if (isReadOnlyPrimaryChat(current)) return current;
  const { schemaVersion: _ignored, ...fields } = isRecord(patch) ? patch : {};
  return normalizePrimaryChat({ ...normalizePrimaryChat(current), ...fields });
}

module.exports = {
  CHAT_CHANGE_ACTIONS,
  CHAT_CHANGE_FIELDS,
  DEFAULT_DIGEST,
  DEFAULT_PRIMARY_CHAT,
  PRIMARY_CHAT_HISTORY_KINDS,
  PRIMARY_CHAT_LIMITS,
  PRIMARY_ACTION_RULE_SHAPES,
  PRIMARY_LAUNCH_RUN_MODES,
  RULE_HISTORY_KINDS,
  SCHEDULE_HISTORY_KINDS,
  SCHEMA_VERSION,
  applyPrimaryChatPatch,
  isIsoInstant,
  isLivePermission,
  isPermissionId,
  isReadOnlyPrimaryChat,
  isRuleId,
  normalizeActionRule,
  normalizeDigest,
  normalizeLaunchPermission,
  normalizePrimaryChat,
  normalizeProjectId,
  normalizeRuleTarget,
  normalizeRunModes,
};
