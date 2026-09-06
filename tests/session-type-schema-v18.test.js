'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
  STORE_SCHEMA_VERSION,
  normalizeSession,
  normalizeSessionType,
  sessionAllowsChatSend,
} = require('../services/backend/electron-session-store');
const {
  migrateStorePayload,
  repairSessionForV17,
  repairSessionForV18,
} = require('../services/backend/session-store-migrations');
const {
  CHAT_SESSION_TYPE,
  OFFICIAL_IMAGE_PROVIDER,
  PLUGIN_OPERATION_SESSION_MAX_BYTES,
  PLUGIN_SESSION_TYPE,
  createOfficialImagePluginSession,
  enforcePluginOperationMetadataBudget,
  normalizeImageConfig,
  normalizePluginSession,
} = require('../services/backend/session-type');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

const IMAGE_CONFIG = Object.freeze({
  model_id: 'HiDream-ai/HiDream-O1-Image',
  resolution: '2048x2048',
  steps: 50,
});

test.afterEach(async () => cleanupTrackedResources());

function makeUserDataDir(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  fs.mkdirSync(path.join(userDataPath, 'sessions'), { recursive: true });
  return userDataPath;
}

function officialPluginSession(state = IMAGE_CONFIG) {
  return createOfficialImagePluginSession(state);
}

test('store schema version is 19 and only chat/plugin types remain live', () => {
  assert.equal(STORE_SCHEMA_VERSION, 20);
  assert.equal(normalizeSessionType('chat'), CHAT_SESSION_TYPE);
  assert.equal(normalizeSessionType('plugin'), PLUGIN_SESSION_TYPE);
  assert.equal(normalizeSessionType('image'), PLUGIN_SESSION_TYPE);
  for (const value of [undefined, null, '', 'video', 0, {}, []]) {
    assert.equal(normalizeSessionType(value), CHAT_SESSION_TYPE);
  }
});

test('legacy image config validation remains bounded for migration/adoption only', () => {
  assert.deepEqual(normalizeImageConfig(IMAGE_CONFIG), IMAGE_CONFIG);
  assert.deepEqual(normalizeImageConfig({ modelId: 'm', resolution: '1440X2560', steps: 8 }), {
    model_id: 'm', resolution: '1440x2560', steps: 8,
  });
  for (const value of [null, [], 'bad', { ...IMAGE_CONFIG, steps: 0 },
    { ...IMAGE_CONFIG, resolution: '2048*2048' }, { ...IMAGE_CONFIG, model_id: '' }]) {
    assert.equal(normalizeImageConfig(value), null);
  }
});

test('plugin session normalization is idempotent, bounded, and future-version fail-closed', () => {
  const normalized = normalizePluginSession(officialPluginSession());
  assert.deepEqual(normalized, officialPluginSession());
  assert.deepEqual(normalizePluginSession(normalized), normalized);
  assert.equal(normalizePluginSession({ ...normalized, schema_version: 2 }), null);
  assert.equal(normalizePluginSession({ ...normalized, state: { value: 'x'.repeat(17 * 1024) } }), null);
  assert.equal(normalizePluginSession({ ...normalized, state_revision: -1 }), null);
});

test('normalization adopts a legacy image row into the official provider', () => {
  const session = normalizeSession('legacy-image', {
    title: 'Image', session_type: 'image', image_config: IMAGE_CONFIG,
  });
  assert.equal(session.session_type, PLUGIN_SESSION_TYPE);
  assert.deepEqual(session.plugin_session, officialPluginSession());
  assert.equal(Object.hasOwn(session, 'image_config'), false);
  assert.deepEqual(normalizeSession('legacy-image', session), session);
});

test('chat-send admission rejects plugin sessions and unknown input stays chat-compatible', () => {
  const chat = normalizeSession('chat', { title: 'Chat' });
  const plugin = normalizeSession('plugin', {
    title: 'Image', session_type: 'plugin', plugin_session: officialPluginSession(),
  });
  assert.equal(sessionAllowsChatSend(chat), true);
  assert.equal(sessionAllowsChatSend(plugin), false);
  assert.equal(sessionAllowsChatSend(null), true);
});

test('v17 repair remains stable and v18 converts every image terminal shape to readable text', () => {
  const base = repairSessionForV17({ title: 'Legacy', messages: [] });
  assert.equal(base.session_type, 'chat');
  const migrated = repairSessionForV18({
    title: 'Image work',
    session_type: 'image',
    image_config: IMAGE_CONFIG,
    messages: [
      { id: 'ok', role: 'assistant', kind: 'image_operation', image_operation: {
        operation_id: 'op_ok', status: 'succeeded', width: 2048, height: 2048, seed: 42,
      }, attachments: [{ id: 'image-1', kind: 'image' }] },
      { id: 'failed', role: 'assistant', image_operation: {
        operation_id: 'op_failed', status: 'failed', error_code: 'worker_failed',
      } },
      { id: 'cancelled', role: 'assistant', image_operation: {
        operation_id: 'op_cancelled', status: 'cancelled',
      } },
      { id: 'running', role: 'assistant', image_operation: {
        operation_id: 'op_running', status: 'running',
      } },
    ],
  });
  assert.equal(migrated.session_type, PLUGIN_SESSION_TYPE);
  assert.deepEqual(migrated.plugin_session.state, IMAGE_CONFIG);
  assert.match(migrated.messages[0].content, /2048.*2048.*seed 42/);
  assert.equal(migrated.messages[0].attachments[0].id, 'image-1');
  assert.match(migrated.messages[1].content, /failed \(worker_failed\)/);
  assert.equal(migrated.messages[2].content, 'Image generation was cancelled.');
  assert.equal(migrated.messages[3].content, 'Image generation was interrupted before it finished.');
  assert.deepEqual(repairSessionForV18(migrated), migrated);
});

test('v17 store migration is idempotent and preserves chat rows while adopting images', () => {
  const payload = {
    schema_version: 17,
    sessions: {
      chat: { id: 'chat', title: 'Chat', session_type: 'chat', messages: [{ id: 'm', role: 'user', content: 'hi' }] },
      image: { id: 'image', title: 'Image', session_type: 'image', image_config: IMAGE_CONFIG, messages: [] },
    },
  };
  const migrated = migrateStorePayload(payload, { normalizeMessage: (message) => message });
  assert.equal(migrated.schema_version, 20);
  assert.equal(migrated.sessions.chat.session_type, CHAT_SESSION_TYPE);
  assert.deepEqual(migrated.sessions.chat.messages, payload.sessions.chat.messages);
  assert.equal(migrated.sessions.chat.plugin_session, null);
  assert.equal(migrated.sessions.image.session_type, PLUGIN_SESSION_TYPE);
  assert.deepEqual(migrated.sessions.image.plugin_session.state, IMAGE_CONFIG);
  assert.match(migrated.sessions.image.session_incarnation, /^inc_plugin_/);
  assert.deepEqual(migrateStorePayload(migrated), migrated);
});

test('metadata pressure strips oldest terminal metadata without deleting text or attachments', () => {
  const messages = [];
  for (let index = 0; index < 3_000; index += 1) {
    messages.push({
      id: `message-${index}`,
      role: 'assistant',
      content: `Readable result ${index}`,
      attachments: [{ id: `attachment-${index}` }],
      plugin_operation: {
        operation_id: `operation_${index}`,
        attempt: 1,
        action_id: 'generate',
        status: 'failed',
        reason_code: `failure_${index}`,
      },
    });
  }
  const bounded = enforcePluginOperationMetadataBudget(messages);
  assert.equal(bounded.length, messages.length);
  assert.equal(bounded[0].plugin_operation, undefined);
  assert.equal(bounded[0].content, 'Readable result 0');
  assert.equal(bounded[0].attachments[0].id, 'attachment-0');
  const metadataBytes = bounded.reduce((total, message) => total
    + (message.plugin_operation
      ? Buffer.byteLength(JSON.stringify(message.plugin_operation), 'utf8') : 0), 0);
  assert.ok(metadataBytes <= PLUGIN_OPERATION_SESSION_MAX_BYTES);
});

test('create and reload preserve the explicit plugin authority tuple and state', () => {
  const userDataPath = makeUserDataDir('jenny-session-type-v18-');
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath);
  const chat = store.createSession({ title: 'Chat' });
  assert.equal(chat.session_type, CHAT_SESSION_TYPE);
  const plugin = store.createSession({
    title: 'Image', sessionType: 'plugin', pluginSession: officialPluginSession(),
  });
  assert.equal(plugin.session_type, PLUGIN_SESSION_TYPE);
  store.flush();
  store.dispose();

  const reopened = new ElectronSessionStore(storePath);
  const record = reopened.getSession(plugin.id);
  assert.deepEqual(record.plugin_session, officialPluginSession());
  assert.equal(reopened.getSession(chat.id).plugin_session, null);
  assert.deepEqual(record.plugin_session.publisher_id, OFFICIAL_IMAGE_PROVIDER.publisher_id);
  reopened.dispose();
});
