'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const { getBridgeChannel } = require('../services/ipc-contract');
const { MAIN_DOCUMENT_PATH } = require('../services/main/ipc-sender-authorization');
const {
  createRemovalPreparation,
  launchOfficialRemovalEntry,
  normalizeArchiveOptions,
  normalizeWorkspaceRestoreOptions,
  registerDataLifecycleIpcHandlers,
  registerDataLifecycleRuntime,
} = require('../services/main/data-lifecycle-ipc-registration');

function trustedSender() {
  const url = pathToFileURL(MAIN_DOCUMENT_PATH).href;
  const mainFrame = { url };
  const webContents = { id: 1, mainFrame, isDestroyed: () => false, getURL: () => url };
  return {
    window: { webContents, isDestroyed: () => false },
    event: { sender: webContents, senderFrame: mainFrame },
  };
}

function createService() {
  const service = new EventEmitter();
  Object.assign(service, {
    getOverview: async () => ({ ok: true, status: 'ready' }),
    createArchive: async (options) => ({ ok: true, status: 'archive_verified', options }),
    previewWorkspaceArchive: async () => ({ ok: true, status: 'workspace_review_ready', reviewId: 'review-archive' }),
    findRestoreCandidates: () => ({ ok: true, candidates: [] }),
    stageRestore: async () => ({ ok: true, status: 'restart_required' }),
    previewWorkspaceRestore: async (options) => ({ ok: true, status: 'workspace_restore_review_ready', options }),
    restoreWorkspace: async (options) => ({ ok: true, status: 'workspace_restored', options }),
    syncPortablePreferences: () => ({ ok: true, status: 'saved' }),
  });
  return service;
}

test('data lifecycle IPC rejects foreign senders and bounds archive requests', async () => {
  const registrations = new Map();
  const trusted = trustedSender();
  const service = createService();
  registerDataLifecycleIpcHandlers({ handle: (channel, handler) => registrations.set(channel, handler) }, {
    service,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => trusted.window,
  });
  const handler = registrations.get(getBridgeChannel('dataLifecycle.createArchive', 'invoke'));
  const foreign = await handler({ sender: {}, senderFrame: {} }, {});
  assert.equal(foreign.authorized, false);
  assert.equal(foreign.operationId, '');
  assert.equal(foreign.error.code, 'CMP-DATA-0001');
  assert.deepEqual(foreign.counts, {});
  assert.deepEqual(foreign.warnings, []);
  const invalid = await handler(trusted.event, { encrypted: true, passphrase: 'x'.repeat(1025), passphraseConfirmation: 'x'.repeat(1025) });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'CMP-DATA-0001');
  const valid = await handler(trusted.event, { encrypted: false, destinationRoot: '' });
  assert.equal(valid.ok, true);
  assert.equal(valid.options.encrypted, false);
  const canceled = await registrations.get(getBridgeChannel('dataLifecycle.chooseArchiveDestination', 'invoke'))(trusted.event);
  assert.deepEqual(canceled, {
    ok: true,
    operationId: '',
    status: 'canceled',
    counts: {},
    warnings: [],
    destinationRoot: '',
  });
});

test('manual restore selection preserves archive error codes in the common result envelope', async () => {
  const registrations = new Map();
  const trusted = trustedSender();
  registerDataLifecycleIpcHandlers({ handle: (channel, handler) => registrations.set(channel, handler) }, {
    service: createService(),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(os.tmpdir(), 'missing.jenny-archive')] }) },
    getMainWindow: () => trusted.window,
  });
  const result = await registrations.get(getBridgeChannel('dataLifecycle.findRestoreCandidates', 'invoke'))(
    trusted.event,
    { chooseAnother: true }
  );
  assert.equal(result.ok, false);
  assert.equal(result.operationId, '');
  assert.equal(result.error.code, 'CMP-DATA-0007');
  assert.deepEqual(result.counts, {});
  assert.deepEqual(result.warnings, []);
});

test('data lifecycle IPC converts hostile payload access into a structured redacted failure', async () => {
  const registrations = new Map();
  const trusted = trustedSender();
  registerDataLifecycleIpcHandlers({ handle: (channel, handler) => registrations.set(channel, handler) }, {
    service: createService(),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => trusted.window,
  });
  const hostile = {};
  Object.defineProperty(hostile, 'encrypted', { get() { throw new Error('C:\\Users\\private\\secret'); } });
  const result = await registrations.get(getBridgeChannel('dataLifecycle.createArchive', 'invoke'))(trusted.event, hostile);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('Users'), false);
  // "structured" was never checked: returning a bare { ok: false } satisfied both
  // assertions above while dropping the whole failure envelope.
  assert.equal(result.status, 'failed');
  assert.equal(typeof result.error.code, 'string');
  assert.match(result.error.code, /^CMP-DATA-\d{4}$/);
  assert.equal(typeof result.error.reason, 'string');
  assert.deepEqual(result.counts, {});
  assert.deepEqual(result.warnings, []);
});

test('archive option normalization never accepts relative destination authority', () => {
  assert.equal(normalizeArchiveOptions({ encrypted: false, destinationRoot: '..\\elsewhere' }), null);
});

test('workspace review IPC routes require bounded absolute archive authority and explicit review ids', async () => {
  assert.equal(normalizeWorkspaceRestoreOptions({ archivePath: 'relative' }), null);
  assert.equal(normalizeWorkspaceRestoreOptions({ archivePath: path.resolve('archive'), reviewId: '' }, { requireReview: true }), null);
  const registrations = new Map();
  const trusted = trustedSender();
  registerDataLifecycleIpcHandlers({ handle: (channel, handler) => registrations.set(channel, handler) }, {
    service: createService(),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => trusted.window,
  });
  const previewArchive = await registrations.get(getBridgeChannel('dataLifecycle.previewWorkspaceArchive', 'invoke'))(trusted.event);
  assert.equal(previewArchive.reviewId, 'review-archive');
  const archivePath = path.resolve('reviewed.jenny-archive');
  const previewRestore = await registrations.get(getBridgeChannel('dataLifecycle.previewWorkspaceRestore', 'invoke'))(
    trusted.event,
    { archivePath }
  );
  assert.equal(previewRestore.options.archivePath, archivePath);
  const restored = await registrations.get(getBridgeChannel('dataLifecycle.restoreWorkspace', 'invoke'))(
    trusted.event,
    { archivePath, reviewId: 'review-restore' }
  );
  assert.equal(restored.options.reviewId, 'review-restore');
});

test('app-only preparation drains the app but cannot invoke data cleanup', async () => {
  const calls = [];
  const prepare = createRemovalPreparation({
    flush: async () => calls.push('flush'),
    stop: async () => calls.push('stop'),
    cleanupData: async () => { calls.push('cleanup'); return { ok: true }; },
  });
  const result = await prepare({ choice: 'app_only', removeWorkspaceData: true, workspaceRoot: 'ignored' });
  assert.deepEqual(calls, ['flush', 'stop']);
  assert.equal(result.status, 'data_preserved');
});

test('cleanup preparation fails closed when any selected target is incomplete', async () => {
  const prepare = createRemovalPreparation({
    cleanupData: async () => ({ ok: false, status: 'incomplete' }),
  });
  const result = await prepare({ choice: 'permanent', removeWorkspaceData: false, workspaceRoot: '' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'incomplete');
});

test('Settings delegates installed Windows removal to the official system uninstaller', async () => {
  const opened = [];
  const result = await launchOfficialRemovalEntry({
    platform: 'win32',
    isPackaged: true,
    shellLike: { openExternal: async (target) => opened.push(target) },
  });
  assert.deepEqual(opened, ['ms-settings:appsfeatures']);
  assert.equal(result.status, 'system_uninstaller_opened');
  assert.match(result.instructions, /Select Jenny in Installed apps/);
});

test('Settings provides fixed helper instructions for packaged macOS and clones', async () => {
  const packaged = await launchOfficialRemovalEntry({ platform: 'darwin', isPackaged: true });
  assert.equal(packaged.status, 'manual_helper_required');
  const clone = await launchOfficialRemovalEntry({ platform: 'linux', isPackaged: false });
  assert.equal(clone.status, 'clone_command_required');
  // The status alone is not the helper. These strings are the whole user-facing
  // payload of this route, and emptying either left the statuses unchanged.
  assert.match(packaged.instructions, /Uninstall Jenny\.command/);
  assert.match(clone.instructions, /npm run uninstall/);
  assert.notEqual(packaged.instructions, clone.instructions);
});

test('runtime registration tolerates older or fake Electron app objects without getVersion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-data-ipc-runtime-'));
  try {
    const handlers = new Map();
    const registration = registerDataLifecycleRuntime({
      handle: (channel, handler) => handlers.set(channel, handler),
    }, {
      app: {
        getPath: (name) => path.join(root, name),
        isPackaged: false,
      },
      backendService: {
        sessionStore: { listSessions: () => [], flushAsync: async () => {} },
        stop: async () => {},
      },
      attachmentStore: null,
      shellConfigService: { getState: () => ({}) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      getMainWindow: () => null,
      sendBridgeEvent: () => {},
      log: () => {},
    });
    assert.equal(registration.service.appVersion, '0.0.0');
    assert.equal(handlers.size > 0, true);
    registration.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
