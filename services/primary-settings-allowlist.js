'use strict';

/* services/primary-settings-allowlist.js - the main-side registry of row 88, the Jenny chat's
 * settings writes (docs/plans/PRIMARY_SETTINGS_WRITES_2026-10-27.md D1/D4). One frozen entry per
 * key in primary-settings-contract.js, in contract order:
 *   { id, group, target, label, label_key, kind: 'boolean' | 'enum' | 'integer',
 *     read(ctx), options(ctx), validate(value, ctx), apply(ctx, value) }
 * `read` returns the stored value (throws reason `unavailable`); `options` lists the allowed
 * `{ value, label }` (null for a boolean); `validate` is strict, never coerces and answers
 * `{ ok: true, value }` or `{ ok: false, reason: 'not_allowed' | 'invalid_value' }`; `apply` writes
 * ONE field through the service writer the Settings page uses (never `_commitState`, never the
 * config file), reads it back and throws reason `apply_failed` when the stored value is not the one
 * asked for (the normalizers coerce silently).
 *
 * ctx = { shellConfigService, applyFeatureSettingsPatch, appearanceRelay }
 *   shellConfigService          the real ShellConfigService
 *   applyFeatureSettingsPatch   (patch) => Promise, a bound services/feature-settings-service.js
 *                               applyFeatureSettingsPatch({ patch, shellConfigService, ... }); this
 *                               module passes `{ memory: { <field>: boolean } }` only
 *   appearanceRelay             { read(), apply(values) } -> Promise<{ ok: true, values, options }
 *                               | { ok: false, reason }> (D8; keys per APPEARANCE_RELAY_FIELDS)
 *
 * Allowed values come from the module that normalizes them: languages (UI_LANGUAGE_TAGS), app zoom
 * (the normalizer's stepped range), editor font and tab size (probed through
 * normalizeWorkspaceIdePreferences), notification categories (NOTIFICATION_CATEGORIES), run modes
 * (the contract). Only the transcript views and the auto-save modes are private to their modules;
 * those two are mirrored here and tests/primary-settings-allowlist.test.js pins them to the
 * normalizers. Adding an entry is a security review (see the never-list test).
 */

const {
  APPEARANCE_RELAY_FIELDS,
  PRIMARY_SETTINGS_GROUPS,
  PRIMARY_SETTINGS_KEYS,
  PRIMARY_SETTINGS_LIMITS,
  NOTIFICATION_CATEGORY_KEYS,
  PRIMARY_SETTINGS_RUN_MODES,
  VALUE_TOKEN,
} = require('./primary-settings-contract');
const { UI_LANGUAGE_TAGS, normalizeMemorySettings } = require('./shell-config-normalizers');
const { APP_ZOOM_MAX, APP_ZOOM_MIN, APP_ZOOM_STEP, normalizeWindowUiZoomPercent } = require('./shell-config-zoom-state');
const { NOTIFICATION_CATEGORIES } = require('./shell-config-notifications-schema');
const { normalizeWorkspaceIdePreferences } = require('./workspace-ide-config-schema');
const { isPlainObject } = require('./value-utils');

// Private to shell-config-zoom-state.js / workspace-ide-config-schema.js; pinned by the test.
const TRANSCRIPT_VIEWS = Object.freeze(['answers', 'thinking', 'everything']);
const AUTO_SAVE_MODES = Object.freeze(['off', 'afterDelay', 'onFocusChange', 'onWindowChange']);

const fail = (reason, message) => Object.assign(new Error(message || reason), { reason });
const opt = (value, label) => ({ value, label });

// A reader that cannot read is `unavailable`, whatever it threw (a reasoned error passes through).
async function guardedRead(fn) {
  try {
    return await fn();
  } catch (error) {
    throw error?.reason ? error : fail('unavailable', error?.message || 'unavailable');
  }
}

// Allowed values probed through the owning normalizer: a candidate is allowed when it round-trips.
const probed = (candidates, roundTrip) => candidates.filter((n) => roundTrip(n) === n);
const memo = (build) => { let cached; return () => (cached ||= build()); };

const languageLabel = (tag) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag; } catch { return tag; }
};

const zoomOptions = memo(() => {
  const steps = [];
  for (let n = APP_ZOOM_MIN; n <= APP_ZOOM_MAX; n += APP_ZOOM_STEP) steps.push(n);
  return probed(steps, normalizeWindowUiZoomPercent).map((n) => opt(n, `${n}%`));
});
const fontSizeOptions = memo(() => probed(
  Array.from({ length: 41 }, (_, n) => n), (n) => normalizeWorkspaceIdePreferences({ fontSize: n }).fontSize
).map((n) => opt(n, n === 0 ? 'Match text size' : `${n}px`)));
const tabSizeOptions = memo(() => probed(
  Array.from({ length: 16 }, (_, n) => n + 1), (n) => normalizeWorkspaceIdePreferences({ tabSize: n }).tabSize
).map((n) => opt(n, `${n} spaces`)));

const STATIC_OPTIONS = {
  ui_language: () => UI_LANGUAGE_TAGS.map((tag) => opt(tag, languageLabel(tag))),
  default_run_mode: () => PRIMARY_SETTINGS_RUN_MODES.map((mode) => opt(mode, mode[0].toUpperCase() + mode.slice(1))),
  transcript_view_default: () => TRANSCRIPT_VIEWS.map((view) => opt(view, view[0].toUpperCase() + view.slice(1))),
  app_zoom_percent: zoomOptions,
  editor_font_size: fontSizeOptions,
  editor_tab_size: tabSizeOptions,
  editor_auto_save: () => [opt('off', 'Off'), opt('afterDelay', 'After a delay'),
    opt('onFocusChange', 'When the editor loses focus'), opt('onWindowChange', 'When the window loses focus')],
};

// Relay-supplied options are untrusted: tokens only, capped count and label length.
function cleanRelayOptions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (out.length >= PRIMARY_SETTINGS_LIMITS.options_max) break;
    if (isPlainObject(item) && typeof item.value === 'string' && VALUE_TOKEN.test(item.value)) {
      const label = typeof item.label === 'string' && item.label ? item.label : item.value;
      out.push(opt(item.value, label.slice(0, PRIMARY_SETTINGS_LIMITS.label_chars)));
    }
  }
  return out;
}

async function relayRead(ctx) {
  const reply = await guardedRead(() => ctx.appearanceRelay.read());
  if (!isPlainObject(reply) || reply.ok !== true || !isPlainObject(reply.values)) {
    throw fail('unavailable', 'The appearance relay could not be read.');
  }
  return reply;
}

// Builds one entry. `spec`: { id, target, label, kind, read(ctx), write(ctx, value), options?(ctx),
// confirms? } - `write` may return { value } when its own reply already carries the stored value.
function makeEntry(spec) {
  const { id, kind } = spec;
  const options = kind === 'boolean' ? async () => null
    : async (ctx) => (spec.options ? spec.options(ctx) : STATIC_OPTIONS[id]());
  const read = async (ctx) => guardedRead(() => spec.read(ctx));
  const validate = async (value, ctx) => {
    if (kind === 'boolean') return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'invalid_value' };
    if (id === 'default_run_mode' && value === 'auto') return { ok: false, reason: 'not_allowed' };
    const typeOk = kind === 'integer' ? Number.isInteger(value) : typeof value === 'string' && value.length > 0
      && value.length <= PRIMARY_SETTINGS_LIMITS.value_chars;
    if (!typeOk) return { ok: false, reason: 'invalid_value' };
    let list;
    try {
      list = await options(ctx);
    } catch (error) {
      if (error?.reason === 'unavailable') throw error; // the relay could not list the options
      return { ok: false, reason: 'invalid_value' };
    }
    return list.some((item) => item.value === value) ? { ok: true, value } : { ok: false, reason: 'invalid_value' };
  };
  const entry = {
    id, group: PRIMARY_SETTINGS_GROUPS[id], target: spec.target, label: spec.label,
    label_key: `primarySettings.key.${id}`, kind, read, options, validate,
    async apply(ctx, value) {
      if (!(await validate(value, ctx)).ok) throw fail('apply_failed', `${id}: value not allowed`);
      let confirmed;
      try {
        confirmed = await spec.write(ctx, value);
      } catch (error) {
        throw error?.reason ? error : Object.assign(fail('apply_failed', `${id}: ${error?.message || 'write failed'}`), { cause: error });
      }
      const stored = confirmed && Object.hasOwn(confirmed, 'value') ? confirmed.value : await read(ctx);
      if (stored !== value) throw fail('apply_failed', `${id}: the stored value is not the requested one`);
    },
  };
  return Object.freeze(entry);
}

const chatUi = (id, label, kind, target, field, pick) => makeEntry({
  id, target, label, kind,
  read: async ({ shellConfigService }) => pick(shellConfigService.getChatUiState()),
  write: async ({ shellConfigService }, value) => { shellConfigService.updateChatUiSettings({ [field]: value }); },
});

// The notifications object is replaced whole by the section merge, so the write carries the
// current siblings (and, for a category, the sibling categories) along.
const notification = (id, label, field, category) => makeEntry({
  id, kind: 'boolean', label,
  target: category ? `windowUi.notifications.categories.${category}` : `windowUi.notifications.${field}`,
  read: async ({ shellConfigService }) => {
    const { notifications } = shellConfigService.getWindowUiState();
    return category ? notifications.categories[category] : notifications[field];
  },
  write: async ({ shellConfigService }, value) => {
    const { notifications } = shellConfigService.getWindowUiState();
    shellConfigService.updateWindowUiSettings({
      notifications: category
        ? { ...notifications, categories: { ...notifications.categories, [category]: value } }
        : { ...notifications, [field]: value },
    });
  },
});

const memory = (id, label, field) => makeEntry({
  id, kind: 'boolean', label, target: `memory.${field}`,
  read: async ({ shellConfigService }) => normalizeMemorySettings(shellConfigService.getState().memory)[field],
  write: async (ctx, value) => { await ctx.applyFeatureSettingsPatch({ memory: { [field]: value } }); },
});

const editor = (id, label, kind, field) => makeEntry({
  id, kind, label, target: `workspaceIde.${field}`,
  read: async ({ shellConfigService }) => shellConfigService.getWorkspaceIdeStore().preferences[field],
  write: async ({ shellConfigService }, value) => {
    const outcome = shellConfigService.tryUpdateWorkspaceIdePreferences({ [field]: value });
    if (!outcome || outcome.updated !== true) throw fail('apply_failed', `workspace IDE preferences were not written (${outcome?.code || 'unknown'})`);
  },
});

const appearance = (id, label) => {
  const field = APPEARANCE_RELAY_FIELDS[id];
  return makeEntry({
    id, kind: 'enum', label, target: `appearance.${field}`,
    options: async (ctx) => cleanRelayOptions((await relayRead(ctx)).options?.[field]),
    read: async (ctx) => (await relayRead(ctx)).values[field],
    write: async (ctx, value) => {
      const reply = await guardedRead(() => ctx.appearanceRelay.apply({ [field]: value }));
      if (!isPlainObject(reply) || reply.ok !== true) throw fail(reply?.reason === 'unavailable' ? 'unavailable' : 'apply_failed', `${id}: the appearance relay refused`);
      return { value: isPlainObject(reply.values) ? reply.values[field] : undefined };
    },
  });
};

const DEFINITIONS = [
  chatUi('time_format_24h', '24-hour time', 'boolean', 'use24HourTime', 'use24HourTime', (s) => s.use24HourTime),
  chatUi('ui_language', 'Language', 'enum', 'uiLanguage', 'uiLanguage', (s) => s.uiLanguage),
  chatUi('default_run_mode', 'Default run mode', 'enum', 'defaultRunMode', 'defaultRunMode', (s) => s.defaultRunMode),
  chatUi('transcript_view_default', 'Transcript view', 'enum', 'chatUi.transcriptViewDefault',
    'transcriptViewDefault', (s) => s.transcriptViewDefault),
  makeEntry({
    id: 'app_zoom_percent', kind: 'integer', label: 'Overall app zoom', target: 'windowUi.appZoomPercent',
    read: async ({ shellConfigService }) => shellConfigService.getWindowUiState().appZoomPercent,
    write: async ({ shellConfigService }, value) => { shellConfigService.updateWindowUiSettings({ appZoomPercent: value }); },
  }),
  appearance('palette', 'Palette'),
  appearance('typography', 'Typography'),
  appearance('font_scale', 'Text size'),
  appearance('chat_width', 'Chat width'),
  notification('notifications_enabled', 'Desktop notifications', 'enabled'),
  notification('notifications_sound', 'Play sound', 'sound'),
  notification('notifications_only_when_unfocused', 'Only when Jenny is in the background', 'onlyWhenUnfocused'),
  // The contract stays closed: a category added to the schema later (row 89 `jenny`) is not writable until listed there.
  ...NOTIFICATION_CATEGORIES.filter((category) => NOTIFICATION_CATEGORY_KEYS.includes(`notifications_category_${category}`)).map((category) => notification(
    `notifications_category_${category}`,
    { replies: 'A reply is ready', failures: 'A run fails', permissions: 'Jenny needs permission',
      questions: 'Jenny asks a question or a plan is ready', reminders: 'A reminder is due' }[category],
    null, category
  )),
  memory('memory_take_notes', 'Jenny takes notes automatically', 'takeNotes'),
  memory('memory_ask_before_saving', 'Ask before Jenny saves', 'askBeforeSaving'),
  memory('memory_pause_saving', 'Pause saving', 'pauseSaving'),
  memory('memory_use_in_chats', 'Use memory in chats', 'useInChats'),
  editor('editor_font_size', 'Editor font size', 'integer', 'fontSize'),
  editor('editor_tab_size', 'Editor tab size', 'integer', 'tabSize'),
  editor('editor_auto_save', 'Editor auto save', 'enum', 'autoSaveMode'),
];

const BY_ID = new Map(DEFINITIONS.map((entry) => [entry.id, entry]));
const PRIMARY_SETTINGS_ALLOWLIST = Object.freeze(PRIMARY_SETTINGS_KEYS.map((id) => {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`primary-settings-allowlist: no entry for ${id}`);
  return entry;
}));
if (BY_ID.size !== PRIMARY_SETTINGS_ALLOWLIST.length) throw new Error('primary-settings-allowlist: entry outside the contract');

// Own-key lookup only: '__proto__', 'constructor' and non-strings have no entry.
function getPrimarySettingEntry(key) {
  return typeof key === 'string' ? BY_ID.get(key) || null : null;
}

module.exports = { PRIMARY_SETTINGS_ALLOWLIST, getPrimarySettingEntry };
