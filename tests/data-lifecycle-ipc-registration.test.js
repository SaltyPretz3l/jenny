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
  normalizeStorageRequest,
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

test('cleanup preparation forwards the workspace removal scope to the cleanup', async () => {
  const received = [];
  const prepare = createRemovalPreparation({
    cleanupOptions: { userDataPath: 'profile' },
    cleanupData: async (options) => { received.push(options); return { ok: true }; },
  });
  await prepare({
    choice: 'archive_and_remove', removeWorkspaceData: true, workspaceRemovalScope: 'archived', workspaceRoot: 'ws',
  });
  await prepare({
    choice: 'permanent', removeWorkspaceData: true, workspaceRemovalScope: 'all', workspaceRoot: 'ws',
  });
  assert.deepEqual(
    received.map((options) => [options.workspaceRoot, options.removeWorkspaceData, options.workspaceRemovalScope, options.includeUserData]),
    [['ws', true, 'archived', false], ['ws', true, 'all', false]]
  );
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

test('Settings provides package-appropriate removal instructions for packaged Linux', async () => {
  const appImage = await launchOfficialRemovalEntry({
    platform: 'linux',
    isPackaged: true,
    env: {
      APPIMAGE: '/home/u/Jenny-x86_64.AppImage',
      APPDIR: '/tmp/.mount_Jenny',
    },
    execPath: '/tmp/.mount_Jenny/usr/bin/jenny',
  });
  assert.equal(appImage.status, 'manual_file_removal_required');
  assert.match(appImage.instructions, /\/home\/u\/Jenny-x86_64\.AppImage/);

  const deb = await launchOfficialRemovalEntry({ platform: 'linux', isPackaged: true, env: {} });
  assert.equal(deb.status, 'package_manager_required');
  assert.match(deb.instructions, /apt remove jenny/);

  const clone = await launchOfficialRemovalEntry({ platform: 'linux', isPackaged: false, env: {} });
  assert.equal(clone.status, 'clone_command_required');
});

test('Settings ignores inherited AppImage variables for packaged Linux removal', async () => {
  const result = await launchOfficialRemovalEntry({
    platform: 'linux',
    isPackaged: true,
    env: { APPIMAGE: '/tools/Other.AppImage', APPDIR: '/tmp/.mount_Other' },
    execPath: '/opt/Jenny/jenny',
  });
  assert.equal(result.status, 'package_manager_required');
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
      homeDir: path.join(root, 'home'),
    });
    assert.equal(registration.service.appVersion, '0.0.0');
    assert.equal(handlers.size > 0, true);
    registration.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime removal cleans the runtime folder under the home it is given', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-data-ipc-runtime-cleanup-'));
  try {
    // The removal cleans the runtime folder under the home it is given. Without
    // an injected home this test deleted the real ~/.companion logs and memory.
    const homeDir = path.join(root, 'home');
    const runtimeLog = path.join(homeDir, '.companion', 'sidecar.log');
    fs.mkdirSync(path.dirname(runtimeLog), { recursive: true });
    fs.writeFileSync(runtimeLog, 'log');
    const registration = registerDataLifecycleRuntime({ handle() {} }, {
      app: {
        getPath: (name) => path.join(root, name),
        getVersion: () => '1.0.0',
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
      homeDir,
    });
    await registration.service.prepareRemoval({
      choice: 'permanent',
      confirmation: 'REMOVE JENNY',
    });
    assert.equal(fs.existsSync(runtimeLog), false);
    registration.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function storageUsageFake(calls) {
  return {
    getStorageUsage: async () => ({ ok: true, status: 'ok', categories: [] }),
    previewClear: async (request) => { calls.push(['previewClear', request]); return { ok: true, status: 'ok' }; },
    clearCategory: async (request) => { calls.push(['clearCategory', request]); return { ok: true, status: 'ok' }; },
    revealCategory: async (request) => { calls.push(['revealCategory', request]); return { ok: true, status: 'ok' }; },
  };
}

function registerStorage(options = {}) {
  const registrations = new Map();
  const trusted = trustedSender();
  const calls = [];
  registerDataLifecycleIpcHandlers({ handle: (channel, handler) => registrations.set(channel, handler) }, {
    service: createService(),
    dialog: {},
    getMainWindow: () => trusted.window,
    storageUsage: storageUsageFake(calls),
    ...options,
  });
  const invoke = (methodPath, event, ...args) => registrations.get(getBridgeChannel(methodPath, 'invoke'))(event, ...args);
  return { invoke, trusted, calls };
}

test('Your data channels refuse foreign senders and never reach the service', async () => {
  const { invoke, calls } = registerStorage();
  for (const methodPath of [
    'dataLifecycle.getStorageUsage', 'dataLifecycle.previewClear', 'dataLifecycle.clearCategory', 'dataLifecycle.revealCategory',
  ]) {
    const result = await invoke(methodPath, { sender: {}, senderFrame: {} }, { categoryId: 'logs', previewToken: 'x' });
    assert.equal(result.authorized, false, methodPath);
    assert.equal(result.ok, false, methodPath);
  }
  assert.deepEqual(calls, []);
});

test('Your data channels validate payload shapes strictly', async () => {
  const { invoke, trusted, calls } = registerStorage();
  const rejected = [
    ['dataLifecycle.previewClear', undefined],
    ['dataLifecycle.previewClear', null],
    ['dataLifecycle.previewClear', []],
    ['dataLifecycle.previewClear', 'logs'],
    ['dataLifecycle.previewClear', {}],
    ['dataLifecycle.previewClear', { categoryId: 'unknown' }],
    ['dataLifecycle.previewClear', { categoryId: ['logs'] }],
    ['dataLifecycle.previewClear', { categoryId: 'logs', path: 'C:\\Windows' }],
    ['dataLifecycle.revealCategory', { categoryId: 'logs', path: 'C:\\Windows' }],
    ['dataLifecycle.revealCategory', { categoryId: '../logs' }],
    ['dataLifecycle.clearCategory', { categoryId: 'logs' }],
    ['dataLifecycle.clearCategory', { categoryId: 'logs', previewToken: '' }],
    ['dataLifecycle.clearCategory', { categoryId: 'logs', previewToken: 'x'.repeat(129) }],
    ['dataLifecycle.clearCategory', { categoryId: 'logs', previewToken: 7 }],
    ['dataLifecycle.clearCategory', { categoryId: 'chats', previewToken: 'x', confirmCount: '2' }],
    ['dataLifecycle.clearCategory', { categoryId: 'chats', previewToken: 'x', confirmCount: 1.5 }],
    ['dataLifecycle.clearCategory', { categoryId: 'chats', previewToken: 'x', confirmCount: -1 }],
    ['dataLifecycle.clearCategory', { categoryId: 'chats', previewToken: 'x', confirmCount: 1_000_001 }],
    ['dataLifecycle.clearCategory', { categoryId: 'logs', previewToken: 'x', target: 'C:\\' }],
  ];
  for (const [methodPath, payload] of rejected) {
    const result = await invoke(methodPath, trusted.event, payload);
    assert.equal(result.ok, false, `${methodPath} ${JSON.stringify(payload)}`);
    assert.equal(result.error.code, 'CMP-DATA-0001');
  }
  assert.deepEqual(calls, []);
  assert.equal((await invoke('dataLifecycle.getStorageUsage', trusted.event)).ok, true);
  assert.equal((await invoke('dataLifecycle.previewClear', trusted.event, { categoryId: 'logs' })).ok, true);
  assert.equal((await invoke('dataLifecycle.revealCategory', trusted.event, { categoryId: 'caches' })).ok, true);
  assert.equal((await invoke('dataLifecycle.clearCategory', trusted.event, {
    categoryId: 'chats', previewToken: 'token', confirmCount: 2,
  })).ok, true);
  assert.deepEqual(calls, [
    ['previewClear', { categoryId: 'logs' }],
    ['revealCategory', { categoryId: 'caches' }],
    ['clearCategory', { categoryId: 'chats', previewToken: 'token', confirmCount: 2 }],
  ]);
});

test('getStorageUsage takes no payload or a closed categoryIds list and nothing else', async () => {
  const seen = [];
  const storageUsage = {
    ...storageUsageFake([]),
    getStorageUsage: async (request) => { seen.push(request); return { ok: true, status: 'ok', categories: [] }; },
  };
  const { invoke, trusted } = registerStorage({ storageUsage });
  for (const payload of [undefined, null, {}, { categoryIds: undefined }, { categoryIds: ['logs', 'chats', 'logs'] }]) {
    assert.equal((await invoke('dataLifecycle.getStorageUsage', trusted.event, payload)).ok, true, JSON.stringify(payload));
  }
  assert.deepEqual(seen, [{}, {}, {}, {}, { categoryIds: ['logs', 'chats'] }]);
  const rejected = [
    [], 'logs', ['logs'], { categoryIds: [] }, { categoryIds: ['nope'] }, { categoryIds: 'logs' }, { categoryIds: null },
    { categoryIds: Array(8).fill('logs') }, { categoryIds: ['logs'], path: '/etc' }, { path: '/etc' },
  ];
  for (const payload of rejected) {
    const result = await invoke('dataLifecycle.getStorageUsage', trusted.event, payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.error.code, 'CMP-DATA-0001');
  }
  assert.equal(seen.length, 5);
});

test('Your data channels are inert without a service and when the kill switch is off', async () => {
  const noService = registerStorage({ storageUsage: null });
  const missing = await noService.invoke('dataLifecycle.getStorageUsage', noService.trusted.event);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.reason, 'storage_usage_unavailable');
  const off = registerStorage({ storageUsageEnabled: () => false });
  const disabled = await off.invoke('dataLifecycle.previewClear', off.trusted.event, { categoryId: 'logs' });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error.reason, 'feature_disabled');
  assert.deepEqual(off.calls, []);
});

test('Your data channels turn a thrown service error into the common failure envelope', async () => {
  const { invoke, trusted } = registerStorage({
    storageUsage: {
      ...storageUsageFake([]),
      previewClear: async () => { throw Object.assign(new Error('C:\\leak'), { reason: 'boom' }); },
    },
  });
  const result = await invoke('dataLifecycle.previewClear', trusted.event, { categoryId: 'logs' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.reason, 'boom');
  assert.equal(JSON.stringify(result).includes('leak'), false);
});

test('normalizeStorageRequest keeps only the closed request keys', () => {
  assert.deepEqual(normalizeStorageRequest({ categoryId: 'chats' }, 'preview'), { categoryId: 'chats' });
  assert.deepEqual(
    normalizeStorageRequest({ categoryId: 'chats', previewToken: 'abc', confirmCount: 0 }, 'clear'),
    { categoryId: 'chats', previewToken: 'abc', confirmCount: 0 },
  );
  assert.equal(normalizeStorageRequest({ categoryId: 'chats', previewToken: 'abc' }, 'preview'), null);
});

test('runtime registration wires the Your data service to the profile, home and workspace it was given', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-data-ipc-storage-'));
  try {
    const handlers = new Map();
    const userData = path.join(root, 'userData');
    const homeDir = path.join(root, 'home');
    fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'logs', 'shell.log.1'), 'x'.repeat(20));
    const trusted = trustedSender();
    const registration = registerDataLifecycleRuntime({
      handle: (channel, handler) => handlers.set(channel, handler),
    }, {
      app: {
        getPath: (name) => (name === 'userData' ? userData : path.join(root, name)),
        getVersion: () => '1.0.0',
        isPackaged: false,
      },
      backendService: {
        sessionStore: { listSessions: () => [], flushAsync: async () => {} },
        featureFlags: { data_usage_page: true },
        stop: async () => {},
      },
      attachmentStore: null,
      shellConfigService: { getState: () => ({}) },
      dialog: {},
      getMainWindow: () => trusted.window,
      sendBridgeEvent: () => {},
      log: () => {},
      homeDir,
    });
    const usage = await handlers.get(getBridgeChannel('dataLifecycle.getStorageUsage', 'invoke'))(trusted.event);
    assert.equal(usage.ok, true);
    assert.equal(usage.categories.find((entry) => entry.id === 'logs').bytes, 20);
    assert.equal(usage.categories.find((entry) => entry.id === 'artifacts').available, false);
    registration.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
