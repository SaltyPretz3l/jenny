'use strict';

// Row 117: a chat a person starts copies the Browser choice last made in the composer; a fresh
// profile stays off and nothing else (Jenny-started, primary, children, CLI, hosted) is seeded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { ShellConfigService } = require('../services/shell-config-service');
const { ElectronSessionStore, createSessionId } = require('../services/backend/electron-session-store');
const { createSession, createLinkedChildSession } = require('../services/backend/backend-sessions');
const { ensurePrimarySession } = require('../services/backend/primary-session');
const { registerSessionIpcHandlers } = require('../services/main/ipc-registration/sessions-ipc');
const { seedRememberedBrowserChoice } = require('../services/backend/new-chat-browser-seed');
const { SHELL_CONFIG_PORTABILITY } = require('../services/data-lifecycle/portable-preferences-store');

const KEY = 'browserOnInNewChats';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-browser-seed-'));
  const config = new ShellConfigService({ userDataPath: root });
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {}, writeDebounceMs: 60000 });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const service = {
    sessionStore: store, configService: config,
    projectAuthority: { captureProject: (id) => ({ project_id: id }) },
  };
  const handlers = new Map();
  registerSessionIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    backendService: { createSession: (options) => createSession(service, options) },
    shellConfigService: config, startDeferredServices() {},
    workspaceAuthorization: { authorize: () => true, unauthorizedResult: () => null },
  });
  const personStarts = async (payload = {}) => {
    const created = await handlers.get(getBridgeChannel('sessions.create', 'invoke'))({}, { projectId: 'project_a', ...payload });
    return store.getSession(created.data.id);
  };
  return { root, config, store, service, personStarts };
}

const childSpec = () => ({
  childSessionId: createSessionId(), childIncarnation: `inc_${'c'.repeat(32)}`, title: 'Child', projectId: 'project_a',
  spawnedFrom: {
    schema_version: 1, parent_session_id: 'sess_parent', parent_session_incarnation: `inc_${'a'.repeat(32)}`,
    proposal_id: `proposal_${'b'.repeat(64)}`, created_at: '2026-10-15T10:00:00.000Z',
    child_creation_hash: 'd'.repeat(64), reporting_consent_id: '11111111-1111-4111-8111-111111111111',
  },
});

test('a fresh profile starts new chats with Browser off', async (t) => {
  const { config, personStarts } = fixture(t);
  assert.equal(config.getChatUiState()[KEY], false);
  assert.deepEqual((await personStarts()).tool_category_overrides, {});
});

test('the remembered choice decides the next chat a person starts, and survives a restart', async (t) => {
  const { root, config, personStarts } = fixture(t);
  config.updateChatUiSettings({ [KEY]: true });
  assert.deepEqual((await personStarts()).tool_category_overrides, { browser_use: true });
  assert.equal(new ShellConfigService({ userDataPath: root }).getChatUiState()[KEY], true);
  config.updateChatUiSettings({ [KEY]: false });
  assert.deepEqual((await personStarts()).tool_category_overrides, {});
});

test('the key is a strict boolean top-level scalar and never a retired browser name', (t) => {
  const { root, config } = fixture(t);
  for (const junk of ['true', 1, {}, null]) {
    assert.equal(config.updateChatUiSettings({ [KEY]: junk })[KEY], false, String(junk));
  }
  config.updateChatUiSettings({ [KEY]: true });
  assert.equal(Object.hasOwn(config.getState().chatUi, KEY), false);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'shell-config.json'), 'utf8'));
  assert.equal(onDisk[KEY], true);
  assert.equal(onDisk.tools_browser_enabled, undefined);
  assert.equal(onDisk.tools?.browser, undefined);
});

test('a caller that names its own tool switches is never overridden', async (t) => {
  const { config, personStarts } = fixture(t);
  config.updateChatUiSettings({ [KEY]: true });
  const explicit = await personStarts({ preferences: { tool_category_overrides: { browser_use: false } } });
  assert.deepEqual(explicit.tool_category_overrides, { browser_use: false });
  const empty = await personStarts({ preferences: { tool_category_overrides: {} } });
  assert.deepEqual(empty.tool_category_overrides, {});
});

test('the seed keeps the other preferences and leaves the payload it was given alone', () => {
  const on = { getChatUiState: () => ({ [KEY]: true }) };
  const payload = { title: 't', preferences: { preferred_model: 'm' } };
  const seeded = seedRememberedBrowserChoice(payload, on);
  assert.deepEqual(seeded, { title: 't', preferences: { preferred_model: 'm', tool_category_overrides: { browser_use: true } } });
  assert.deepEqual(payload, { title: 't', preferences: { preferred_model: 'm' } });
  assert.deepEqual(seedRememberedBrowserChoice(undefined, on), { preferences: { tool_category_overrides: { browser_use: true } } });
  assert.deepEqual(seedRememberedBrowserChoice({ preferences: null }, on), { preferences: { tool_category_overrides: { browser_use: true } } });
});

test('nothing is seeded when the choice is off, unknown, or the request is not an ordinary chat', () => {
  const on = { getChatUiState: () => ({ [KEY]: true }) };
  const payload = { title: 't' };
  assert.equal(seedRememberedBrowserChoice(payload, { getChatUiState: () => ({ [KEY]: false }) }), payload);
  assert.equal(seedRememberedBrowserChoice(payload, { getChatUiState: () => ({ [KEY]: 'true' }) }), payload);
  assert.equal(seedRememberedBrowserChoice(payload, {}), payload);
  assert.equal(seedRememberedBrowserChoice(payload, null), payload);
  const primary = { sessionRole: 'primary' };
  assert.equal(seedRememberedBrowserChoice(primary, on), primary);
  assert.equal(seedRememberedBrowserChoice(null, on), null);
  assert.equal(seedRememberedBrowserChoice('x', on), 'x');
  const listed = { preferences: [] };
  assert.equal(seedRememberedBrowserChoice(listed, on), listed);
});

test('the primary Jenny chat is never seeded', async (t) => {
  const { config, store, service } = fixture(t);
  config.updateChatUiSettings({ [KEY]: true });
  const result = await ensurePrimarySession({ sessionStore: store, createSession: (options) => createSession(service, options) });
  assert.equal(result.created, true);
  assert.deepEqual(store.getSession(result.session_id).tool_category_overrides, {});
});

test('children and every non-IPC start (Jenny-started, CLI, hosted) are never seeded', async (t) => {
  const { config, store, service } = fixture(t);
  config.updateChatUiSettings({ [KEY]: true });
  const spec = childSpec();
  assert.equal(createLinkedChildSession(service, spec).ok, true);
  assert.deepEqual(store.getSession(spec.childSessionId).tool_category_overrides, {});
  const direct = await createSession(service, { title: 'cli or hosted', projectId: 'project_a' });
  assert.deepEqual(store.getSession(direct.data.id).tool_category_overrides, {});
});

test('a model cannot reach the key and an imported file cannot carry it', () => {
  for (const file of ['services/primary-settings-allowlist.js', 'services/primary-settings-contract.js',
    'services/tools/builtin/settings-change-tool.js', 'services/tools/tool-manifest.json']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', file), 'utf8').includes(KEY), false, file);
  }
  assert.equal(Object.hasOwn(SHELL_CONFIG_PORTABILITY.portable, KEY), false);
  assert.equal(Object.hasOwn(SHELL_CONFIG_PORTABILITY.excluded, KEY), true, 'classified not portable, so a restore keeps the default');
});
