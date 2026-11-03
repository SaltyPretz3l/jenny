'use strict';

/* Row 88 S1: the main-side settings registry. Every key reads, validates strictly (no coercion),
 * applies through the real ShellConfigService writer (or the fake feature wrapper / appearance
 * relay) and reads back. The private option lists are pinned to their normalizers. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { UI_LANGUAGE_TAGS } = require('../services/shell-config-normalizers');
const { normalizeChatUiSettings } = require('../services/shell-config-zoom-state');
const { normalizeWorkspaceIdePreferences } = require('../services/workspace-ide-config-schema');
const {
  APPEARANCE_RELAY_FIELDS, PRIMARY_SETTINGS_GROUPS, PRIMARY_SETTINGS_KEYS, PRIMARY_SETTINGS_LIMITS,
} = require('../services/primary-settings-contract');
const { PRIMARY_SETTINGS_ALLOWLIST, getPrimarySettingEntry } = require('../services/primary-settings-allowlist');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => { await cleanupTrackedResources(); });

const OPTION_VALUES = (list) => list.map((item) => item.value);
const RELAY_OPTIONS = {
  paletteId: [{ value: 'midnight', label: 'Midnight' }, { value: 'paper', label: 'Paper' }],
  typographyId: [{ value: 'system', label: 'System' }, { value: 'serif', label: 'Serif' }],
  fontScaleId: [{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }],
  chatWidthId: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'wide', label: 'Wide' }],
};

function fakeRelay(overrides = {}) {
  const values = { paletteId: 'midnight', typographyId: 'system', fontScaleId: 'normal', chatWidthId: 'comfortable' };
  const relay = {
    values, applied: [], fail: null, mismatch: false,
    async read() {
      return relay.fail ? { ok: false, reason: relay.fail } : { ok: true, values: { ...values }, options: RELAY_OPTIONS };
    },
    async apply(patch) {
      relay.applied.push(patch);
      if (relay.fail) return { ok: false, reason: relay.fail };
      if (!relay.mismatch) Object.assign(values, patch);
      return { ok: true, values: { ...values }, options: RELAY_OPTIONS };
    },
    ...overrides,
  };
  return relay;
}

function makeCtx() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-primary-settings-'));
  trackDirectory(userDataPath);
  const shellConfigService = new ShellConfigService({ userDataPath, env: {} });
  const featureCalls = [];
  const appearanceRelay = fakeRelay();
  const ctx = {
    shellConfigService,
    appearanceRelay,
    async applyFeatureSettingsPatch(patch) { featureCalls.push(patch); return shellConfigService.updateFeatureSettings(patch); },
  };
  return { ctx, userDataPath, featureCalls, relay: appearanceRelay };
}

// Writers that accept the call and store nothing (what a silent normalizer coercion looks like).
function coercingCtx(ctx) {
  const service = Object.assign(Object.create(ctx.shellConfigService), {
    updateChatUiSettings() {}, updateWindowUiSettings() {}, tryUpdateWorkspaceIdePreferences: () => ({ updated: true }),
  });
  return { ...ctx, shellConfigService: service, async applyFeatureSettingsPatch() {} };
}

const unavailable = (error) => error?.reason === 'unavailable';
const applyFailed = (error) => error?.reason === 'apply_failed';
const nonRelay = PRIMARY_SETTINGS_ALLOWLIST.filter((entry) => entry.group !== 'appearance');

test('every entry has the contract shape and a bounded option list', async () => {
  const { ctx } = makeCtx();
  for (const entry of PRIMARY_SETTINGS_ALLOWLIST) {
    assert.equal(entry.group, PRIMARY_SETTINGS_GROUPS[entry.id], entry.id);
    assert.equal(entry.label_key, `primarySettings.key.${entry.id}`);
    assert.ok(entry.label && entry.label.length <= PRIMARY_SETTINGS_LIMITS.label_chars, entry.id);
    assert.ok(['boolean', 'enum', 'integer'].includes(entry.kind), entry.id);
    for (const fn of ['read', 'options', 'validate', 'apply']) assert.equal(typeof entry[fn], 'function', `${entry.id}.${fn}`);
    const options = await entry.options(ctx);
    if (entry.kind === 'boolean') { assert.equal(options, null, entry.id); continue; }
    assert.ok(options.length >= 2 && options.length <= PRIMARY_SETTINGS_LIMITS.options_max, `${entry.id} ${options.length}`);
    assert.equal(new Set(OPTION_VALUES(options)).size, options.length, entry.id);
    for (const item of options) {
      assert.ok(typeof item.label === 'string' && item.label.length > 0 && item.label.length <= PRIMARY_SETTINGS_LIMITS.label_chars, entry.id);
      assert.equal(typeof item.value, entry.kind === 'integer' ? 'number' : 'string', entry.id);
    }
  }
  assert.equal(PRIMARY_SETTINGS_ALLOWLIST.length, PRIMARY_SETTINGS_KEYS.length);
  assert.equal(getPrimarySettingEntry('__proto__'), null);
  assert.equal(getPrimarySettingEntry('hasOwnProperty'), null);
  assert.equal(getPrimarySettingEntry('palette'), PRIMARY_SETTINGS_ALLOWLIST.find((e) => e.id === 'palette'));
});

test('option sources match their owning normalizers', async () => {
  const { ctx } = makeCtx();
  const values = async (id) => OPTION_VALUES(await getPrimarySettingEntry(id).options(ctx));
  assert.deepEqual(await values('ui_language'), [...UI_LANGUAGE_TAGS]);
  assert.deepEqual(await values('default_run_mode'), ['ask', 'plan', 'propose']);
  // The private transcript-view list: each listed view survives the normalizer, anything else falls back.
  const views = await values('transcript_view_default');
  for (const view of views) assert.equal(normalizeChatUiSettings({ transcriptViewDefault: view }).transcriptViewDefault, view);
  assert.equal(normalizeChatUiSettings({ transcriptViewDefault: 'verbose' }).transcriptViewDefault, 'thinking');
  assert.deepEqual(views, ['answers', 'thinking', 'everything']);
  // The private auto-save mode list: each listed mode survives, an unknown mode falls back to off.
  const modes = await values('editor_auto_save');
  for (const mode of modes) assert.equal(normalizeWorkspaceIdePreferences({ autoSaveMode: mode }).autoSaveMode, mode);
  assert.equal(normalizeWorkspaceIdePreferences({ autoSaveMode: 'onSave' }).autoSaveMode, 'off');
  assert.deepEqual(modes, ['off', 'afterDelay', 'onFocusChange', 'onWindowChange']);
  assert.deepEqual(await values('editor_tab_size'), [2, 4, 8]);
  const zoom = await values('app_zoom_percent');
  assert.deepEqual(zoom, [80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150]);
  const sizes = await values('editor_font_size');
  assert.ok(sizes.includes(0) && sizes.includes(12) && sizes.includes(8) && sizes.includes(40));
  assert.ok(!sizes.includes(13) && !sizes.includes(7) && !sizes.includes(41) && !sizes.includes(-1));
  for (const size of sizes) assert.equal(normalizeWorkspaceIdePreferences({ fontSize: size }).fontSize, size);
});

test('read returns the stored defaults for every key', async () => {
  const { ctx } = makeCtx();
  const expected = {
    time_format_24h: false, ui_language: 'en', default_run_mode: 'ask', transcript_view_default: 'thinking',
    app_zoom_percent: 110, palette: 'midnight', typography: 'system', font_scale: 'normal', chat_width: 'comfortable',
    notifications_enabled: true, notifications_sound: true, notifications_only_when_unfocused: true,
    notifications_category_replies: true, notifications_category_failures: true, notifications_category_permissions: true,
    notifications_category_questions: true, notifications_category_reminders: true,
    memory_take_notes: true, memory_ask_before_saving: false, memory_pause_saving: false, memory_use_in_chats: true,
    editor_font_size: 0, editor_tab_size: 2, editor_auto_save: 'off',
  };
  assert.deepEqual(Object.keys(expected), [...PRIMARY_SETTINGS_KEYS]);
  for (const [id, value] of Object.entries(expected)) assert.equal(await getPrimarySettingEntry(id).read(ctx), value, id);
});

test('validate accepts every listed value and rejects wrong types and unlisted values without coercion', async () => {
  const { ctx } = makeCtx();
  for (const entry of PRIMARY_SETTINGS_ALLOWLIST) {
    const options = await entry.options(ctx);
    if (entry.kind === 'boolean') {
      for (const value of [true, false]) assert.deepEqual(await entry.validate(value, ctx), { ok: true, value }, entry.id);
      for (const value of ['true', 'false', 1, 0, null, undefined, {}, [], 'on']) {
        assert.deepEqual(await entry.validate(value, ctx), { ok: false, reason: 'invalid_value' }, `${entry.id} ${String(value)}`);
      }
      continue;
    }
    for (const { value } of options) assert.deepEqual(await entry.validate(value, ctx), { ok: true, value }, `${entry.id} ${value}`);
    const wrongTypes = entry.kind === 'integer'
      ? [...OPTION_VALUES(options).slice(0, 3).map(String), 1.5, NaN, Infinity, true, null, undefined, [], {}, 1000, -1]
      : [7, true, null, undefined, '', ['a'], {}, 'x'.repeat(PRIMARY_SETTINGS_LIMITS.value_chars + 1), 'not-a-listed-value'];
    for (const value of wrongTypes) {
      const verdict = await entry.validate(value, ctx);
      assert.equal(verdict.ok, false, `${entry.id} ${String(value)}`);
      assert.equal(verdict.reason, 'invalid_value', `${entry.id} ${String(value)}`);
    }
  }
  // Case-variants and padded forms are not the listed value (the normalizers would coerce them).
  assert.equal((await getPrimarySettingEntry('ui_language').validate('EN', ctx)).ok, false);
  assert.equal((await getPrimarySettingEntry('ui_language').validate('pt-br', ctx)).ok, false);
  assert.equal((await getPrimarySettingEntry('transcript_view_default').validate(' answers', ctx)).ok, false);
  assert.equal((await getPrimarySettingEntry('app_zoom_percent').validate(112, ctx)).ok, false);
  assert.equal((await getPrimarySettingEntry('editor_font_size').validate(13, ctx)).ok, false);
  assert.equal((await getPrimarySettingEntry('editor_tab_size').validate(3, ctx)).ok, false);
});

test('default_run_mode refuses auto as not_allowed and anything else unlisted as invalid_value', async () => {
  const entry = getPrimarySettingEntry('default_run_mode');
  assert.deepEqual(await entry.validate('auto', {}), { ok: false, reason: 'not_allowed' });
  for (const value of ['Auto', 'plan ', 'yolo', 7, null]) assert.deepEqual(await entry.validate(value, {}), { ok: false, reason: 'invalid_value' }, String(value));
  const { ctx } = makeCtx();
  await assert.rejects(() => entry.apply(ctx, 'auto'), applyFailed);
  assert.equal(await entry.read(ctx), 'ask');
});

test('apply then read back equals the value for every non-relay key, and persists', async () => {
  const { ctx, userDataPath } = makeCtx();
  const written = {};
  for (const entry of nonRelay) {
    const current = await entry.read(ctx);
    const options = await entry.options(ctx);
    const next = entry.kind === 'boolean' ? !current : OPTION_VALUES(options).find((value) => value !== current);
    await entry.apply(ctx, next);
    assert.equal(await entry.read(ctx), next, entry.id);
    written[entry.id] = next;
  }
  const reloaded = { ...ctx, shellConfigService: new ShellConfigService({ userDataPath, env: {} }) };
  for (const [id, value] of Object.entries(written)) assert.equal(await getPrimarySettingEntry(id).read(reloaded), value, `reload ${id}`);
});

test('every allowed value of every enum and integer key applies and reads back', async () => {
  const { ctx } = makeCtx();
  for (const id of ['ui_language', 'default_run_mode', 'transcript_view_default', 'app_zoom_percent', 'editor_tab_size', 'editor_auto_save']) {
    const entry = getPrimarySettingEntry(id);
    for (const { value } of await entry.options(ctx)) {
      await entry.apply(ctx, value);
      assert.equal(await entry.read(ctx), value, `${id} ${value}`);
    }
  }
  const font = getPrimarySettingEntry('editor_font_size');
  for (const { value } of await font.options(ctx)) {
    await font.apply(ctx, value);
    assert.equal(await font.read(ctx), value, `font ${value}`);
  }
});

test('a chat_ui write touches only its one field', async () => {
  const { ctx } = makeCtx();
  const service = ctx.shellConfigService;
  await getPrimarySettingEntry('ui_language').apply(ctx, 'fr');
  await getPrimarySettingEntry('time_format_24h').apply(ctx, true);
  await getPrimarySettingEntry('transcript_view_default').apply(ctx, 'everything');
  const state = service.getChatUiState();
  assert.equal(state.uiLanguage, 'fr');
  assert.equal(state.use24HourTime, true);
  assert.equal(state.transcriptViewDefault, 'everything');
  assert.equal(state.defaultRunMode, 'ask');
  assert.equal(state.safetyMode, 'normal');
  assert.equal(state.zoomPercent, 100);
});

test('a notifications change leaves every sibling field and category untouched', async () => {
  const { ctx } = makeCtx();
  const service = ctx.shellConfigService;
  service.updateWindowUiSettings({ notifications: {
    enabled: true, sound: false, onlyWhenUnfocused: false, replyPreview: true,
    categories: { replies: true, failures: false, permissions: true, questions: false, reminders: true },
  } });
  const before = service.getWindowUiState();
  const sections = [
    ['notifications_enabled', (n) => n.enabled], ['notifications_sound', (n) => n.sound],
    ['notifications_only_when_unfocused', (n) => n.onlyWhenUnfocused],
    ...['replies', 'failures', 'permissions', 'questions', 'reminders'].map((c) => [`notifications_category_${c}`, (n) => n.categories[c]]),
  ];
  for (const [id, pick] of sections) {
    const entry = getPrimarySettingEntry(id);
    const was = pick(before.notifications);
    await entry.apply(ctx, !was);
    const after = service.getWindowUiState();
    assert.equal(pick(after.notifications), !was, id);
    // Flip it back: the whole state must equal the start, so no sibling moved.
    await entry.apply(ctx, was);
    assert.deepEqual(service.getWindowUiState(), before, id);
  }
  assert.equal(before.notifications.replyPreview, true, 'replyPreview is not a key and survives');
  assert.equal(service.getWindowUiState().appZoomPercent, 110);
});

test('a window zoom write leaves notifications and dictation alone', async () => {
  const { ctx } = makeCtx();
  const before = ctx.shellConfigService.getWindowUiState();
  await getPrimarySettingEntry('app_zoom_percent').apply(ctx, 125);
  const after = ctx.shellConfigService.getWindowUiState();
  assert.equal(after.appZoomPercent, 125);
  assert.deepEqual({ ...after, appZoomPercent: 0 }, { ...before, appZoomPercent: 0 });
});

test('memory keys go through the feature patch wrapper with exactly one field', async () => {
  const { ctx, featureCalls } = makeCtx();
  await getPrimarySettingEntry('memory_pause_saving').apply(ctx, true);
  await getPrimarySettingEntry('memory_take_notes').apply(ctx, false);
  await getPrimarySettingEntry('memory_use_in_chats').apply(ctx, false);
  await getPrimarySettingEntry('memory_ask_before_saving').apply(ctx, true);
  assert.deepEqual(featureCalls, [
    { memory: { pauseSaving: true } }, { memory: { takeNotes: false } },
    { memory: { useInChats: false } }, { memory: { askBeforeSaving: true } },
  ]);
  const memory = ctx.shellConfigService.getState().memory;
  assert.deepEqual({ ...memory }, { takeNotes: false, askBeforeSaving: true, pauseSaving: true, useInChats: false });
  // The main-owned stamp is never written by this key: turning notes back on stamps it, a no-op does not.
  await getPrimarySettingEntry('memory_take_notes').apply(ctx, true);
  assert.equal(typeof ctx.shellConfigService.getState().memory.takeNotesSince, 'string');
});

test('editor keys write only their preference, one field at a time', async () => {
  const { ctx } = makeCtx();
  const service = ctx.shellConfigService;
  const before = service.getWorkspaceIdeStore().preferences;
  await getPrimarySettingEntry('editor_font_size').apply(ctx, 16);
  await getPrimarySettingEntry('editor_tab_size').apply(ctx, 8);
  await getPrimarySettingEntry('editor_auto_save').apply(ctx, 'onFocusChange');
  const after = service.getWorkspaceIdeStore().preferences;
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])).sort();
  assert.deepEqual(changed, ['autoSaveEnabled', 'autoSaveMode', 'fontSize', 'tabSize'].sort());
  assert.deepEqual([after.fontSize, after.tabSize, after.autoSaveMode], [16, 8, 'onFocusChange']);
});

test('appearance keys read and apply through the relay only', async () => {
  const { ctx, relay } = makeCtx();
  const stateBefore = ctx.shellConfigService.getState();
  for (const [id, field] of Object.entries(APPEARANCE_RELAY_FIELDS)) {
    const entry = getPrimarySettingEntry(id);
    assert.equal(entry.target, `appearance.${field}`);
    assert.deepEqual(await entry.options(ctx), RELAY_OPTIONS[field]);
    const next = RELAY_OPTIONS[field][1].value;
    await entry.apply(ctx, next);
    assert.deepEqual(relay.applied.at(-1), { [field]: next });
    assert.equal(await entry.read(ctx), next);
    assert.deepEqual(await entry.validate(next, ctx), { ok: true, value: next });
    assert.equal((await entry.validate('not-registered', ctx)).ok, false);
  }
  assert.equal(relay.applied.length, 4);
  assert.deepEqual(ctx.shellConfigService.getState(), stateBefore, 'the shell config is never written');
});

test('relay options are sanitized: tokens only, capped, labels bounded', async () => {
  const { ctx, relay } = makeCtx();
  const many = Array.from({ length: 100 }, (_, i) => ({ value: `p${i}`, label: 'x'.repeat(500) }));
  relay.read = async () => ({ ok: true, values: { paletteId: 'p0' }, options: { paletteId: [
    ...many, { value: 'bad value', label: 'a' }, { value: 5, label: 'a' }, null, 'str', { value: '', label: '' },
  ] } });
  const options = await getPrimarySettingEntry('palette').options(ctx);
  assert.equal(options.length, PRIMARY_SETTINGS_LIMITS.options_max);
  assert.ok(options.every((item) => item.label.length <= PRIMARY_SETTINGS_LIMITS.label_chars && /^p\d+$/.test(item.value)));
  relay.read = async () => ({ ok: true, values: { paletteId: 'p0' }, options: { paletteId: 'nope' } });
  assert.deepEqual(await getPrimarySettingEntry('palette').options(ctx), []);
  assert.equal((await getPrimarySettingEntry('palette').validate('p0', ctx)).ok, false);
});

test('a failing or malformed relay read makes read and validate unavailable', async () => {
  const { ctx, relay } = makeCtx();
  for (const id of Object.keys(APPEARANCE_RELAY_FIELDS)) {
    const entry = getPrimarySettingEntry(id);
    relay.fail = 'unavailable';
    await assert.rejects(() => entry.read(ctx), unavailable, id);
    await assert.rejects(() => entry.validate('midnight', ctx), unavailable, id);
    relay.fail = 'no_window';
    await assert.rejects(() => entry.read(ctx), unavailable, id);
  }
  relay.fail = null;
  relay.read = async () => { throw new Error('timed out'); };
  await assert.rejects(() => getPrimarySettingEntry('palette').read(ctx), unavailable);
  relay.read = async () => ({ ok: true, values: null });
  await assert.rejects(() => getPrimarySettingEntry('palette').read(ctx), unavailable);
  relay.read = async () => undefined;
  await assert.rejects(() => getPrimarySettingEntry('chat_width').read(ctx), unavailable);
  await assert.rejects(() => getPrimarySettingEntry('palette').read({}), unavailable);
});

test('a relay apply that reports another value, refuses, or throws fails the apply', async () => {
  const { ctx, relay } = makeCtx();
  const entry = getPrimarySettingEntry('palette');
  relay.mismatch = true;
  await assert.rejects(() => entry.apply(ctx, 'paper'), applyFailed);
  relay.mismatch = false;
  relay.apply = async () => ({ ok: false, reason: 'rejected' });
  await assert.rejects(() => entry.apply(ctx, 'paper'), applyFailed);
  relay.apply = async () => ({ ok: false, reason: 'unavailable' });
  await assert.rejects(() => entry.apply(ctx, 'paper'), unavailable);
  relay.apply = async () => ({ ok: true });
  await assert.rejects(() => entry.apply(ctx, 'paper'), applyFailed);
  relay.apply = async () => { throw new Error('boom'); };
  await assert.rejects(() => entry.apply(ctx, 'paper'), unavailable);
  relay.apply = async () => { throw Object.assign(new Error('x'), { reason: 'apply_failed' }); };
  await assert.rejects(() => entry.apply(ctx, 'paper'), applyFailed);
  await assert.rejects(() => entry.apply(ctx, 'unregistered'), applyFailed);
});

test('a writer that silently coerces or stores nothing fails every non-relay apply', async () => {
  const { ctx } = makeCtx();
  const coercing = coercingCtx(ctx);
  for (const entry of nonRelay) {
    const current = await entry.read(coercing);
    const options = await entry.options(coercing);
    const next = entry.kind === 'boolean' ? !current : OPTION_VALUES(options).find((value) => value !== current);
    await assert.rejects(() => entry.apply(coercing, next), applyFailed, entry.id);
  }
});

test('a writer that throws surfaces apply_failed, and a blocked IDE write is refused', async () => {
  const { ctx } = makeCtx();
  const throwing = { ...ctx, shellConfigService: Object.assign(Object.create(ctx.shellConfigService), {
    updateChatUiSettings() { throw new Error('disk full'); },
    tryUpdateWorkspaceIdePreferences: () => ({ updated: false, code: 'config_write_blocked' }),
  }), applyFeatureSettingsPatch: async () => { throw new Error('refresh failed'); } };
  await assert.rejects(() => getPrimarySettingEntry('time_format_24h').apply(throwing, true), applyFailed);
  await assert.rejects(() => getPrimarySettingEntry('memory_pause_saving').apply(throwing, true), applyFailed);
  await assert.rejects(() => getPrimarySettingEntry('editor_tab_size').apply(throwing, 4), applyFailed);
  assert.equal(await getPrimarySettingEntry('editor_tab_size').read(ctx), 2);
});

test('a missing service makes read unavailable, and apply never writes an unvalidated value', async () => {
  const { ctx, featureCalls } = makeCtx();
  for (const entry of nonRelay) await assert.rejects(() => entry.read({}), unavailable, entry.id);
  for (const value of ['true', 1, null]) {
    await assert.rejects(() => getPrimarySettingEntry('memory_pause_saving').apply(ctx, value), applyFailed);
    await assert.rejects(() => getPrimarySettingEntry('time_format_24h').apply(ctx, value), applyFailed);
  }
  assert.deepEqual(featureCalls, []);
  assert.equal(await getPrimarySettingEntry('time_format_24h').read(ctx), false);
});
