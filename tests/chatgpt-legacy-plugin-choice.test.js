'use strict';

// services/main/chatgpt-legacy-plugin-choice.js: the retired ChatGPT plugin's
// receipt and desired state, read from the plugin store's files before the
// first engine start (plugin platform retirement, stage 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readRetiredChatgptPluginFacts } = require('../services/main/chatgpt-legacy-plugin-choice');

const STAGE7_STORE = path.join(__dirname, 'release-compat', 'fixtures', 'plugin-store-v5-stage7');

function profile(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-legacy-choice-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const store = path.join(userDataDir, 'plugins');
  const write = (relative, value) => {
    const target = path.join(store, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { userDataDir, write };
}

// A real committed store (the stage 7 release-compat fixture), optionally with plugin entries.
function commitStore(write, plugins = null) {
  const pointer = JSON.parse(fs.readFileSync(path.join(STAGE7_STORE, 'active-generation.json'), 'utf8'));
  const record = JSON.parse(fs.readFileSync(
    path.join(STAGE7_STORE, 'generations', 'gen-stage7', 'control-plane.json'), 'utf8'));
  if (plugins) record.plugins = plugins;
  write('active-generation.json', pointer);
  write('generations/gen-stage7/control-plane.json', record);
  return { pointer, record };
}

const RECEIPT = 'provider-migrations/chatgpt-subscription.json';

test('a profile that never had the plugin gives no facts', async (t) => {
  const { userDataDir } = profile(t);
  assert.equal(await readRetiredChatgptPluginFacts({ userDataDir }), null);
});

test('a receipt with nothing committed gives the receipt and an empty desired state', async (t) => {
  const { userDataDir, write } = profile(t);
  write(RECEIPT, { status: 'removed', auto_enabled: false });
  assert.deepEqual(await readRetiredChatgptPluginFacts({ userDataDir }), {
    receipt: { status: 'removed', auto_enabled: false }, desiredState: '', everActive: false,
  });
});

test('the committed desired state of the plugin is read from the active generation', async (t) => {
  const { userDataDir, write } = profile(t);
  write(RECEIPT, { status: 'installed', auto_enabled: true });
  commitStore(write, [{ publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription',
    desired_state: 'active' }]);
  assert.deepEqual(await readRetiredChatgptPluginFacts({ userDataDir }), {
    receipt: { status: 'installed', auto_enabled: true }, desiredState: 'active', everActive: true,
  });
});

test('an older retained generation with the plugin active is evidence it was turned on once', async (t) => {
  const { userDataDir, write } = profile(t);
  write(RECEIPT, { status: 'installed', auto_enabled: false });
  const { record } = commitStore(write, [{ publisher_id: 'jenny-official',
    plugin_id: 'chatgpt-subscription', desired_state: 'installed_disabled' }]);
  assert.equal((await readRetiredChatgptPluginFacts({ userDataDir })).everActive, false);
  write('generations/gen-older/control-plane.json', { ...record, plugins: [{
    publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription', desired_state: 'active' }] });
  write('generations/gen-unrelated/control-plane.json', '{ not json');
  assert.deepEqual(await readRetiredChatgptPluginFacts({ userDataDir }), {
    receipt: { status: 'installed', auto_enabled: false },
    desiredState: 'installed_disabled', everActive: true,
  });
});

test('a committed generation without the plugin gives an empty desired state', async (t) => {
  const { userDataDir, write } = profile(t);
  write(RECEIPT, { status: 'installed', auto_enabled: true });
  commitStore(write);
  assert.equal((await readRetiredChatgptPluginFacts({ userDataDir })).desiredState, '');
});

test('a store that does not hang together leaves the desired state unknown', async (t) => {
  const { userDataDir, write } = profile(t);
  write(RECEIPT, { status: 'installed', auto_enabled: true });
  const { pointer } = commitStore(write);
  write('active-generation.json', { ...pointer, generation_digest: 'f'.repeat(64) });
  assert.equal((await readRetiredChatgptPluginFacts({ userDataDir })).desiredState, null);

  write('active-generation.json', '{not json');
  assert.equal((await readRetiredChatgptPluginFacts({ userDataDir })).desiredState, null);

  write('active-generation.json', { ...pointer, generation_id: '../escape' });
  assert.equal((await readRetiredChatgptPluginFacts({ userDataDir })).desiredState, null);
});

test('a corrupt receipt still counts as having had the plugin', async (t) => {
  const { userDataDir, write } = profile(t);
  write(RECEIPT, '{not json');
  assert.deepEqual(await readRetiredChatgptPluginFacts({ userDataDir }), { receipt: null, desiredState: '', everActive: false });
});
