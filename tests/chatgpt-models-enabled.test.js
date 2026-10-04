'use strict';

// The "Show ChatGPT models in Composer" choice (plugin platform retirement,
// stage 2) and the one-time hand-over from the retired ChatGPT plugin.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chatgptModelsEnabled,
  chatgptChoiceFromRetiredPlugin,
  createChatgptRetiredChoiceCarrier,
} = require('../services/backend/chatgpt-models-enabled');

const config = (state) => ({ getState: () => state });

test('unset counts as on; only an explicit false turns ChatGPT models off', () => {
  assert.equal(chatgptModelsEnabled(config({})), true);
  assert.equal(chatgptModelsEnabled(config({ chatgptModelsEnabled: null })), true);
  assert.equal(chatgptModelsEnabled(config({ chatgptModelsEnabled: true })), true);
  assert.equal(chatgptModelsEnabled(config({ chatgptModelsEnabled: false })), false);
  assert.equal(chatgptModelsEnabled(null), true);
  assert.equal(chatgptModelsEnabled({ getState() { throw new Error('boom'); } }), true);
});

test('an enabled plugin carries over as on', () => {
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'installed', auto_enabled: false }, desiredState: 'active',
  }), true);
  assert.equal(chatgptChoiceFromRetiredPlugin({ receipt: null, desiredState: 'active' }), true);
});

test('a plugin the user removed, or turned off after the migration enabled it, carries over as off', () => {
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'removed', auto_enabled: false }, desiredState: '',
  }), false);
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'installed', auto_enabled: true }, desiredState: 'disabled',
  }), false);
});

// auto_enabled only says whether the migration turned the plugin on; a user
// who turned it on by hand and later off left an "active" generation behind.
test('a plugin the user turned on by hand and later off carries over as off', () => {
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'installed', auto_enabled: false }, desiredState: 'installed_disabled', everActive: true,
  }), false);
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'installed', auto_enabled: false }, desiredState: 'installed_disabled', everActive: false,
  }), null);
});

test('a plugin that was never turned on, or unreadable facts, leave the choice unset', () => {
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'installed', auto_enabled: false }, desiredState: 'disabled',
  }), null);
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'failed', auto_enabled: false }, desiredState: '',
  }), null);
  assert.equal(chatgptChoiceFromRetiredPlugin({ receipt: null, desiredState: '' }), null);
  assert.equal(chatgptChoiceFromRetiredPlugin(), null);
});

test('an unreadable plugin store is unknown, not "off"; only a removed receipt still counts', () => {
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'installed', auto_enabled: true }, desiredState: null,
  }), null);
  assert.equal(chatgptChoiceFromRetiredPlugin({
    receipt: { status: 'removed', auto_enabled: false }, desiredState: null,
  }), false);
});

const CHATGPT = { publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription' };

function carrier(state, result = { ok: true }) {
  const writes = [];
  const carry = createChatgptRetiredChoiceCarrier({
    configService: config(state),
    setChatgptModelsEnabled: async (value) => { writes.push(value); return result; },
  });
  return { carry, writes };
}

test('the carrier saves the plugin choice through the Settings switch owner', async () => {
  const off = carrier({ chatgptModelsEnabled: null });
  await off.carry(CHATGPT, { receipt: { status: 'removed' }, desiredState: '' });
  assert.deepEqual(off.writes, [false]);

  const on = carrier({});
  await on.carry(CHATGPT, { receipt: null, desiredState: 'active' });
  assert.deepEqual(on.writes, [true]);
});

test('the carrier leaves a choice made in Settings, other plugins and unset facts alone', async () => {
  const chosen = carrier({ chatgptModelsEnabled: true });
  await chosen.carry(CHATGPT, { receipt: { status: 'removed' }, desiredState: '' });
  assert.deepEqual(chosen.writes, []);

  const other = carrier({});
  await other.carry({ publisher_id: 'jenny-official', plugin_id: 'remote-control' },
    { receipt: { status: 'removed' }, desiredState: '' });
  assert.deepEqual(other.writes, []);

  const unset = carrier({});
  await unset.carry(CHATGPT, { receipt: { status: 'installed', auto_enabled: false }, desiredState: '' });
  assert.deepEqual(unset.writes, []);
});

test('a refused save throws so the plugin is kept for the next start', async () => {
  const refused = carrier({}, { ok: false, reason: 'invalid_value' });
  await assert.rejects(refused.carry(CHATGPT, { receipt: null, desiredState: 'active' }),
    /invalid_value/);
});
