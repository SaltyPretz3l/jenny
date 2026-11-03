'use strict';

/* Row 88 S3: the settings port. Every write is a card (no card or a moved value -> stale, nothing
 * written); a batch is all or nothing (a failing writer reverts the earlier ones); history records
 * each applied batch; undo restores only while every key still holds Jenny's value; Auto is never
 * a model-reachable value but a user's own Auto comes back on Undo. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { normalizePrimaryChat } = require('../services/shell-config-primary-chat');
const { createPrimaryChatControls } = require('../services/primary-chat-controls');
const { createPrimarySettingsService } = require('../services/primary-settings-service');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => { await cleanupTrackedResources(); });

const OPTIONS = {
  paletteId: [{ value: 'slate', label: 'Slate' }, { value: 'jenny-night', label: 'Jenny night' }],
  typographyId: [{ value: 'technical', label: 'Technical' }],
  fontScaleId: [{ value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }],
  chatWidthId: [{ value: 'standard', label: 'Standard' }, { value: 'wide', label: 'Wide' }],
};

function fakeRelay() {
  const values = { paletteId: 'slate', typographyId: 'technical', fontScaleId: 'default', chatWidthId: 'standard' };
  const relay = {
    values, reads: 0, fail: false, failApply: false,
    async read() { relay.reads += 1; return relay.fail ? { ok: false, reason: 'unavailable' } : { ok: true, values: { ...values }, options: OPTIONS }; },
    async apply(patch) {
      if (relay.fail || relay.failApply) return { ok: false, reason: 'unavailable' };
      Object.assign(values, patch);
      return { ok: true, values: { ...values }, options: OPTIONS };
    },
  };
  return relay;
}

// A real ShellConfigService and real primary-chat controls (history through the real normalizer).
function harness({ flags = {}, now } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-primary-settings-svc-'));
  trackDirectory(userDataPath);
  const config = new ShellConfigService({ userDataPath, env: {} });
  const relay = fakeRelay();
  const state = { flags: { ...flags }, ids: 0, logs: [] };
  const controls = createPrimaryChatControls({
    configService: () => config, sessionStore: () => ({ listSessions: () => [] }), featureFlags: () => state.flags,
  });
  const service = createPrimarySettingsService({
    shellConfigService: () => config,
    applyFeatureSettingsPatch: () => async (patch) => config.updateFeatureSettings(patch),
    appearanceRelay: () => relay,
    controls: () => controls,
    featureFlags: () => state.flags,
    primarySessionId: () => 'primary',
    createId: () => `sc_${(state.ids += 1).toString(16).padStart(32, '0')}`,
    log: (level, event, details) => state.logs.push({ level, event, details }),
    ...(now ? { now } : {}),
  });
  const history = () => normalizePrimaryChat(config.getState().primaryChat).history;
  return { config, relay, state, service, controls, history };
}

const call = (n = 1) => ({ session_id: 'primary', tool_call_id: `call_${n}` });
const TWO = [{ key: 'time_format_24h', value: true }, { key: 'default_run_mode', value: 'plan' }];

test('the card rows come from the registry and remember the call; change applies them and records history', async () => {
  const { config, service, history } = harness();
  const card = await service.prepareCard({ ...call(), changes: TWO });
  assert.equal(card.ok, true);
  assert.deepEqual(card.rows.map(({ key, before, after, before_label, after_label }) => ({ key, before, after, before_label, after_label })), [
    { key: 'time_format_24h', before: false, after: true, before_label: 'Off', after_label: 'On' },
    { key: 'default_run_mode', before: 'ask', after: 'plan', before_label: 'Ask', after_label: 'Plan' },
  ]);
  const result = await service.change({ ...call(), changes: TWO, purpose: 'x' });
  assert.deepEqual(result, {
    ok: true, change_id: `sc_${'1'.padStart(32, '0')}`, undo_available: true,
    applied: [
      { key: 'time_format_24h', before: false, after: true, before_label: 'Off', after_label: 'On' },
      { key: 'default_run_mode', before: 'ask', after: 'plan', before_label: 'Ask', after_label: 'Plan' },
    ],
  });
  assert.equal(config.getChatUiState().use24HourTime, true);
  assert.equal(config.getChatUiState().defaultRunMode, 'plan');
  assert.deepEqual(history().map((row) => row.kind), ['setting_changed']);
  assert.deepEqual(history()[0].changes, result.applied);
});

test('no card, another call id, or a reused card never writes', async () => {
  const { config, service } = harness();
  assert.deepEqual(await service.change({ ...call(), changes: TWO }), { ok: false, reason: 'stale' });
  await service.prepareCard({ ...call(1), changes: TWO });
  assert.deepEqual(await service.change({ ...call(2), changes: TWO }), { ok: false, reason: 'stale' });
  assert.deepEqual(await service.change({ session_id: 'other', tool_call_id: 'call_1', changes: TWO }), { ok: false, reason: 'not_primary' });
  assert.equal(config.getChatUiState().use24HourTime, false);
  assert.equal((await service.change({ ...call(1), changes: TWO })).ok, true);
  config.updateChatUiSettings({ use24HourTime: false });
  assert.deepEqual(await service.change({ ...call(1), changes: [TWO[0]] }), { ok: false, reason: 'stale' }, 'a card is spent once');
});

test('only the primary Jenny chat gets a card or a write', async () => {
  const { config, service } = harness();
  const other = { session_id: 'sess_other', tool_call_id: 'call_1' };
  assert.deepEqual(await service.prepareCard({ ...other, changes: TWO }), { ok: false, reason: 'not_primary' });
  assert.deepEqual(await service.change({ ...other, changes: TWO }), { ok: false, reason: 'not_primary' });
  assert.equal(config.getChatUiState().use24HourTime, false);
});

test('a value that moves between the card and the apply is stale; the model cannot widen the batch', async () => {
  const { config, service } = harness();
  await service.prepareCard({ ...call(), changes: TWO });
  config.updateChatUiSettings({ defaultRunMode: 'propose' });
  assert.deepEqual(await service.change({ ...call(), changes: TWO }), { ok: false, reason: 'stale' });
  assert.equal(config.getChatUiState().use24HourTime, false);
  await service.prepareCard({ ...call(2), changes: [TWO[0]] });
  assert.deepEqual(await service.change({ ...call(2), changes: TWO }), { ok: false, reason: 'stale' });
  assert.equal(config.getChatUiState().use24HourTime, false);
});

test('refusals: shape, unknown key, Auto, bad value, all unchanged, relay down, kill switch', async () => {
  const { service, relay, state } = harness();
  const prep = (changes) => service.prepareCard({ ...call(), changes });
  assert.deepEqual(await prep([]), { ok: false, reason: 'invalid_input' });
  assert.deepEqual(await prep([TWO[0], TWO[0]]), { ok: false, reason: 'invalid_input' });
  assert.deepEqual(await prep(Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, value: 1 }))), { ok: false, reason: 'invalid_input' });
  assert.deepEqual(await prep([{ key: 'safety_mode', value: 'off' }]), { ok: false, reason: 'not_allowed', key: 'safety_mode' });
  assert.deepEqual(await prep([{ key: 'default_run_mode', value: 'auto' }]), { ok: false, reason: 'not_allowed', key: 'default_run_mode' });
  assert.deepEqual(await prep([{ key: 'time_format_24h', value: 'true' }]), { ok: false, reason: 'invalid_value', key: 'time_format_24h' });
  assert.deepEqual(await prep([{ key: 'time_format_24h', value: false }]), { ok: false, reason: 'unchanged' });
  relay.fail = true;
  assert.deepEqual(await prep([{ key: 'palette', value: 'jenny-night' }]), { ok: false, reason: 'unavailable', key: 'palette' });
  state.flags.primary_settings_writes = false;
  assert.deepEqual(await prep(TWO), { ok: false, reason: 'disabled' });
  assert.deepEqual(await service.describe({ session_id: 'primary' }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await service.undo({ change_id: `sc_${'1'.padStart(32, '0')}` }), { ok: false, reason: 'disabled' });
});

test('an unchanged row is dropped from the card; appearance reads the window once per card', async () => {
  const { service, relay } = harness();
  const card = await service.prepareCard({ ...call(), changes: [
    { key: 'time_format_24h', value: false }, { key: 'palette', value: 'jenny-night' }, { key: 'chat_width', value: 'wide' },
  ] });
  assert.deepEqual(card.rows.map((row) => [row.key, row.before_label, row.after_label]), [
    ['palette', 'Slate', 'Jenny night'], ['chat_width', 'Standard', 'Wide'],
  ]);
  assert.equal(relay.reads, 1);
});

test('a failing writer reverts the earlier writes of the batch and records nothing', async () => {
  const { config, service, relay, history } = harness();
  const changes = [{ key: 'time_format_24h', value: true }, { key: 'palette', value: 'jenny-night' }];
  await service.prepareCard({ ...call(), changes });
  relay.failApply = true;
  const result = await service.change({ ...call(), changes });
  assert.deepEqual(result, { ok: false, reason: 'unavailable', key: 'palette', reverted: true });
  assert.equal(config.getChatUiState().use24HourTime, false);
  assert.deepEqual(history(), []);
});

test('a write that lands and then fails is put back too (review R2)', async () => {
  const { service, relay, history } = harness();
  const changes = [{ key: 'palette', value: 'jenny-night' }];
  await service.prepareCard({ ...call(), changes });
  const apply = relay.apply;
  let first = true;
  relay.apply = async (patch) => { // the renderer applies, but the reply is lost (a timeout)
    const answer = await apply(patch);
    if (first) { first = false; return { ok: false, reason: 'unavailable' }; }
    return answer;
  };
  const result = await service.change({ ...call(), changes });
  assert.deepEqual(result, { ok: false, reason: 'unavailable', key: 'palette', reverted: true });
  assert.equal(relay.values.paletteId, 'slate');
  assert.deepEqual(history(), []);
});

test('only the primary chat reads, and an expired card is stale (review R4, R5)', async () => {
  let clock = 1_000_000;
  const { config, service } = harness({ now: () => clock });
  assert.deepEqual(await service.describe({ session_id: 'other' }), { ok: false, reason: 'not_primary' });
  assert.deepEqual(await service.describe(), { ok: false, reason: 'not_primary' });
  await service.prepareCard({ ...call(), changes: TWO });
  clock += 31 * 60 * 1000;
  assert.deepEqual(await service.change({ ...call(), changes: TWO }), { ok: false, reason: 'stale' });
  assert.equal(config.getChatUiState().use24HourTime, false);
});

test('undo restores while every key holds what Jenny set; then it is spent', async () => {
  const { config, service, history } = harness();
  await service.prepareCard({ ...call(), changes: TWO });
  const { change_id: changeId } = await service.change({ ...call(), changes: TWO });
  assert.deepEqual(await service.undo({ change_id: changeId }), {
    ok: true, change_id: changeId, restored: [{ key: 'time_format_24h', value: false }, { key: 'default_run_mode', value: 'ask' }],
  });
  assert.equal(config.getChatUiState().use24HourTime, false);
  assert.equal(config.getChatUiState().defaultRunMode, 'ask');
  assert.deepEqual(history().map((row) => row.kind), ['setting_changed', 'setting_undone']);
  assert.deepEqual(await service.undo({ change_id: changeId }), { ok: false, reason: 'already_undone' });
  assert.deepEqual(await service.undo({ change_id: `sc_${'f'.repeat(32)}` }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.undo({ change_id: 'nope' }), { ok: false, reason: 'invalid_input' });
});

test('undo refuses when a key changed since, and writes nothing', async () => {
  const { config, service } = harness();
  await service.prepareCard({ ...call(), changes: TWO });
  const { change_id: changeId } = await service.change({ ...call(), changes: TWO });
  config.updateChatUiSettings({ defaultRunMode: 'propose' });
  assert.deepEqual(await service.undo({ change_id: changeId }), { ok: false, reason: 'changed_since', key: 'default_run_mode' });
  assert.equal(config.getChatUiState().use24HourTime, true);
});

test("a user's own Auto default comes back on Undo, though the model can never set Auto", async () => {
  const { config, service } = harness();
  config.updateChatUiSettings({ defaultRunMode: 'auto' });
  const changes = [{ key: 'default_run_mode', value: 'plan' }];
  await service.prepareCard({ ...call(), changes });
  const { change_id: changeId } = await service.change({ ...call(), changes });
  assert.equal(config.getChatUiState().defaultRunMode, 'plan');
  assert.equal((await service.undo({ change_id: changeId })).ok, true);
  assert.equal(config.getChatUiState().defaultRunMode, 'auto');
});

test('describe lists values and allowed values for the asked keys; a relay failure is listed, not thrown', async () => {
  const { service, relay } = harness();
  const answer = await service.describe({ keys: ['time_format_24h', 'default_run_mode', 'palette'], session_id: 'primary' });
  assert.deepEqual(answer.settings.map(({ key, value, value_label, allowed }) => ({ key, value, value_label, allowed })), [
    { key: 'time_format_24h', value: false, value_label: 'Off', allowed: undefined },
    { key: 'default_run_mode', value: 'ask', value_label: 'Ask', allowed: ['ask', 'plan', 'propose'] },
    { key: 'palette', value: 'slate', value_label: 'Slate', allowed: ['slate', 'jenny-night'] },
  ]);
  assert.equal((await service.describe({ session_id: 'primary' })).settings.length, 24);
  relay.fail = true;
  const partial = await service.describe({ keys: ['palette', 'time_format_24h'], session_id: 'primary' });
  assert.deepEqual(partial.unavailable, ['palette']);
  assert.deepEqual(partial.settings.map((row) => row.key), ['time_format_24h']);
  assert.deepEqual(await service.describe({ keys: ['api_key'], session_id: 'primary' }), { ok: false, reason: 'not_allowed', key: 'api_key' });
  assert.deepEqual(await service.describe({ keys: [], session_id: 'primary' }), { ok: false, reason: 'invalid_input' });
});

test('a missing config service or controls is a refusal, never a throw', async () => {
  const service = createPrimarySettingsService({});
  assert.deepEqual(await service.describe({ session_id: 'primary' }), { ok: false, reason: 'not_primary' });
  assert.deepEqual(await service.prepareCard({ ...call(), changes: TWO }), { ok: false, reason: 'not_primary' }, 'no primary chat known: fail closed');
  assert.deepEqual(await service.undo({ change_id: `sc_${'1'.padStart(32, '0')}` }), { ok: false, reason: 'unavailable' });
});
