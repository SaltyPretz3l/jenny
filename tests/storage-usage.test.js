'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KNOWN_USER_DATA_CHILDREN, KNOWN_RUNTIME_CHILDREN } = require('../services/data-lifecycle/cleanup-service');
const { StorageUsageService } = require('../services/data-lifecycle/storage-usage');
const {
  CATEGORY_IDS,
  categoryForUserDataChild,
  displayLocation,
  listClaimedNames,
} = require('../services/data-lifecycle/storage-usage-registry');

const DAY_MS = 24 * 60 * 60 * 1000;
const QUARANTINE_NAME = 'artifacts-sess_x-retention-20260101T000000-0123456789abcdef';

function write(file, text = 'x'.repeat(10), ageMs = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
}

function makeSessionStore(sessions, artifactDirByChat = {}) {
  return {
    listSessions: () => sessions.map((entry) => ({ ...entry })),
    peekSession: (id) => ({
      messages: artifactDirByChat[id]
        ? [{ tool_result: { generated_artifacts: [{ absolute_path: artifactDirByChat[id] }] } }]
        : [{ role: 'user' }],
      turn_events: [],
    }),
  };
}

function createFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-storage-usage-'));
  const userDataPath = path.join(root, 'profile');
  const runtimePath = path.join(root, 'home', '.companion');
  const workspaceRoot = path.join(root, 'workspace');
  const old = 2 * DAY_MS;
  write(path.join(userDataPath, 'sessions', 'a.json'), 'a'.repeat(100));
  write(path.join(userDataPath, 'sessions.json'), 's'.repeat(20));
  write(path.join(userDataPath, 'attachments', 'x.bin'), 'b'.repeat(50));
  write(path.join(userDataPath, 'background-memory', 'ipc-payloads', 'p.json'), 'p'.repeat(40));
  write(path.join(userDataPath, 'background-memory', 'repo-anchors', 'a.json'), 'r'.repeat(15));
  write(path.join(userDataPath, 'logs', 'shell.log'), 'l'.repeat(50));
  write(path.join(userDataPath, 'logs', 'shell.log.1'), 'm'.repeat(30), old);
  write(path.join(userDataPath, 'logs', 'shell.log.2'), 'n'.repeat(25), old);
  write(path.join(userDataPath, 'logs', 'notes.txt'), 'keep');
  write(path.join(userDataPath, 'diagnostics', '2026-10-01', 'stream_a.json'), 'd'.repeat(12), old);
  write(path.join(userDataPath, 'diagnostics', '2026-10-02', 'stream_b.json'), 'd'.repeat(13), old);
  write(path.join(userDataPath, 'Cache', 'data_0'), 'c'.repeat(200));
  write(path.join(userDataPath, 'GPUCache', 'g'), 'g'.repeat(30));
  write(path.join(userDataPath, 'compile-cache', 'v1', 'a.bin'), 'v'.repeat(60), old);
  write(path.join(userDataPath, 'image-engine-scratch', 'old.png'), 'i'.repeat(70), old);
  write(path.join(userDataPath, 'image-engine-scratch', 'fresh.png'), 'f'.repeat(5));
  write(path.join(userDataPath, 'exports', 'reset.md'), 'e'.repeat(35), old);
  write(path.join(userDataPath, 'sessions.json.corrupt-1700000000000'), 'z'.repeat(9), old);
  write(path.join(userDataPath, 'engines', 'ninfer', 'model.bin'), 'm'.repeat(500));
  write(path.join(userDataPath, 'image-models.json'), '{}');
  write(path.join(userDataPath, 'shell-config.json'), '{"a":1}');
  write(path.join(userDataPath, 'secure-state.json'), '{}');
  write(path.join(runtimePath, 'logs', 'sidecar.log'), 'q'.repeat(45));
  write(path.join(runtimePath, 'logs', 'sidecar.log.1'), 'q'.repeat(33), old);
  write(path.join(runtimePath, 'memory.db'), 'M'.repeat(22));
  const artifacts = path.join(workspaceRoot, '.jenny', 'artifacts');
  write(path.join(artifacts, 'sess_a', 'img.png'), 'k'.repeat(80), old);
  write(path.join(artifacts, 'sess_b', 'old.png'), 'u'.repeat(60), old);
  write(path.join(artifacts, 'sess_c', 'new.png'), 'n'.repeat(5));
  write(path.join(workspaceRoot, '.jenny', 'quarantine', QUARANTINE_NAME, 'f.bin'), 'q'.repeat(44), old);
  write(path.join(workspaceRoot, '.jenny', 'quarantine', 'guarded-other', 'f.bin'), 'g'.repeat(4), old);
  write(path.join(workspaceRoot, '.jenny', 'tool-results', 'aaaaaaaaaaaa', 'output.txt'), 'o'.repeat(33), old);
  write(path.join(workspaceRoot, '.jenny', 'tool-results', 'bbbbbbbbbbbb', 'output.txt'), 'o'.repeat(11), old);
  const sessions = overrides.sessions || [
    { id: 'primary1', session_role: 'primary', message_count: 1 },
    { id: 'chat1', message_count: 1 },
    { id: 'chat2', message_count: 1 },
  ];
  const deleted = [];
  const calls = { browser: 0, opened: [] };
  const options = {
    userDataPath,
    runtimePath,
    getWorkspaceRoot: () => workspaceRoot,
    sessionStore: makeSessionStore(sessions, { chat1: path.join(artifacts, 'sess_a', 'img.png') }),
    deleteChat: async (id) => {
      if (id === 'primary1') return { deleted: false, reason: 'primary_protected' };
      deleted.push(id);
      return { deleted: true, freed: { files: 2, bytes: 7 }, cleanup_status: 'complete' };
    },
    clearBrowserCaches: async () => {
      calls.browser += 1;
      fs.rmSync(path.join(userDataPath, 'Cache', 'data_0'));
    },
    openPath: async (target) => { calls.opened.push(target); return ''; },
    getTrackedJobIds: () => ['bbbbbbbbbbbb'],
    platform: 'linux',
    env: {},
    ...overrides.options,
  };
  const service = new StorageUsageService(options);
  return {
    root, userDataPath, runtimePath, workspaceRoot, service, deleted, calls, options,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function withFixture(overrides, run) {
  const fixture = createFixture(overrides);
  try {
    await run(fixture);
  } finally {
    fixture.cleanup();
  }
}

function category(result, id) {
  return result.categories.find((entry) => entry.id === id);
}

test('every known profile child maps to exactly one category', () => {
  const claims = listClaimedNames();
  const knownLower = new Set(KNOWN_USER_DATA_CHILDREN.map((name) => name.toLowerCase()));
  for (const name of claims) assert.equal(knownLower.has(name), true, `claimed ${name} is not a known child`);
  const seen = new Map();
  for (const name of KNOWN_USER_DATA_CHILDREN) {
    const id = categoryForUserDataChild(name);
    assert.equal(CATEGORY_IDS.includes(id), true, name);
    seen.set(name, id);
  }
  assert.equal(seen.size, KNOWN_USER_DATA_CHILDREN.length);
  assert.equal(categoryForUserDataChild('sessions'), 'chats');
  assert.equal(categoryForUserDataChild('diagnostics'), 'logs');
  assert.equal(categoryForUserDataChild('Code Cache'), 'caches');
  assert.equal(categoryForUserDataChild('exports'), 'leftovers');
  assert.equal(categoryForUserDataChild('engines'), 'engines');
  assert.equal(categoryForUserDataChild('secure-state.json'), 'personal');
  assert.equal(categoryForUserDataChild('some-future-store.json'), 'personal');
  assert.equal(KNOWN_RUNTIME_CHILDREN.includes('logs'), true);
});

test('displayLocation shortens the win32 AppData prefix and keeps other paths real', () => {
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
  assert.equal(displayLocation('C:\\Users\\me\\AppData\\Roaming\\jenny\\logs', { platform: 'win32', env }), '%APPDATA%\\jenny\\logs');
  assert.equal(displayLocation('C:\\Users\\me\\AppData\\Roaming\\jenny', { platform: 'win32', env }), '%APPDATA%\\jenny');
  assert.equal(displayLocation('D:\\other\\jenny\\logs', { platform: 'win32', env }), 'D:\\other\\jenny\\logs');
  assert.equal(displayLocation('/home/me/.config/jenny/logs', { platform: 'linux', env }), '/home/me/.config/jenny/logs');
});

test('getStorageUsage reports size, files, clearable and a display location per category', async () => {
  await withFixture({}, async (fixture) => {
    const usage = await fixture.service.getStorageUsage();
    assert.equal(usage.ok, true);
    assert.deepEqual(usage.categories.map((entry) => entry.id), CATEGORY_IDS);
    const chats = category(usage, 'chats');
    assert.equal(chats.bytes, 100 + 20 + 50 + 40);
    assert.equal(chats.files, 4);
    assert.equal(chats.clearable, true);
    assert.equal(chats.locationDisplay, path.join(fixture.userDataPath, 'sessions'));
    const logs = category(usage, 'logs');
    assert.equal(logs.bytes, 50 + 30 + 25 + 4 + 12 + 13 + 45 + 33);
    const artifacts = category(usage, 'artifacts');
    assert.equal(artifacts.bytes, 80 + 60 + 5 + 44 + 4 + 33 + 11);
    assert.equal(artifacts.available, true);
    assert.equal(category(usage, 'caches').bytes, 200 + 30 + 60 + 70 + 5);
    assert.equal(category(usage, 'leftovers').bytes, 35 + 9);
    assert.equal(category(usage, 'engines').bytes, 500 + 2);
    const personal = category(usage, 'personal');
    assert.equal(personal.clearable, false);
    assert.equal(personal.bytes >= 15 + 7 + 2 + 22, true);
    assert.equal(category(usage, 'engines').clearable, false);
    assert.equal(usage.totalBytes, usage.categories.reduce((sum, entry) => sum + entry.bytes, 0));
    assert.equal(usage.categories.every((entry) => entry.partial === false), true);
  });
});

test('an absent workspace reports artifacts as unavailable and refuses to clear it', async () => {
  await withFixture({ options: { getWorkspaceRoot: () => '' } }, async (fixture) => {
    const usage = await fixture.service.getStorageUsage();
    const artifacts = category(usage, 'artifacts');
    assert.equal(artifacts.available, false);
    assert.equal(artifacts.bytes, 0);
    assert.equal(artifacts.locationDisplay, '');
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    assert.equal(preview.ok, false);
    assert.equal(preview.error.reason, 'category_unavailable');
  });
});

test('a capped walk reports partial', async () => {
  await withFixture({ options: { caps: { maxFiles: 3 } } }, async (fixture) => {
    const usage = await fixture.service.getStorageUsage();
    assert.equal(category(usage, 'logs').partial, true);
    assert.equal(category(usage, 'logs').bytes < 212, true);
  });
  await withFixture({ options: { caps: { maxMs: 0 } } }, async (fixture) => {
    const usage = await fixture.service.getStorageUsage();
    assert.equal(usage.categories.some((entry) => entry.partial), true);
  });
});

test('links inside a category are neither counted, followed nor removed through', async () => {
  await withFixture({}, async (fixture) => {
    const outside = path.join(fixture.root, 'outside');
    write(path.join(outside, 'precious.txt'), 'P'.repeat(999));
    const link = path.join(fixture.userDataPath, 'diagnostics', '2026-10-03');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM') return;
      throw error;
    }
    const usage = await fixture.service.getStorageUsage();
    assert.equal(category(usage, 'logs').bytes, 50 + 30 + 25 + 4 + 12 + 13 + 45 + 33);
    const preview = await fixture.service.previewClear({ categoryId: 'logs' });
    assert.equal(preview.items.some((item) => item.label.includes('3 days')), false);
    const cleared = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: preview.previewToken });
    assert.equal(cleared.ok, true);
    assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8').length, 999);
  });
});

test('a link planted in a previewed unit between preview and clear is refused, not followed', async () => {
  await withFixture({}, async (fixture) => {
    const outside = path.join(fixture.root, 'outside2');
    write(path.join(outside, 'precious.txt'), 'P'.repeat(10));
    const preview = await fixture.service.previewClear({ categoryId: 'leftovers' });
    const exportsDir = path.join(fixture.userDataPath, 'exports');
    fs.rmSync(path.join(exportsDir, 'reset.md'));
    try {
      fs.symlinkSync(outside, path.join(exportsDir, 'reset.md'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM') return;
      throw error;
    }
    const cleared = await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: preview.previewToken });
    // The unit set changed (the exports copy is gone), so the clear refuses before touching anything.
    assert.equal(cleared.status, 'stale');
    assert.equal(fs.existsSync(path.join(outside, 'precious.txt')), true);
  });
});

test('unknown, personal and engines categories are refused', async () => {
  await withFixture({}, async (fixture) => {
    for (const categoryId of ['nope', '', null, 'engines', 'personal', '../logs']) {
      const preview = await fixture.service.previewClear({ categoryId });
      assert.equal(preview.ok, false, String(categoryId));
      const cleared = await fixture.service.clearCategory({ categoryId, previewToken: 'x' });
      assert.equal(cleared.ok, false, String(categoryId));
    }
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'engines', 'ninfer', 'model.bin')), true);
    const reveal = await fixture.service.revealCategory({ categoryId: 'nope' });
    assert.equal(reveal.ok, false);
  });
});

test('logs: preview then clear removes exactly the previewed files and truncates active logs', async () => {
  await withFixture({}, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'logs' });
    assert.equal(preview.ok, true);
    assert.equal(preview.status, 'ok');
    assert.deepEqual(preview.items.map((item) => item.label), [
      'Old app logs', 'Old engine logs', 'Turn diagnostics, 2 days', 'Current log files (emptied, not deleted)',
    ]);
    assert.deepEqual(preview.items.map((item) => item.bytes), [55, 33, 25, 95]);
    assert.equal(preview.totalBytes, 55 + 33 + 25 + 95);
    assert.equal(typeof preview.previewToken, 'string');
    const cleared = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'ok');
    assert.equal(cleared.freedBytes, 55 + 33 + 25 + 95);
    assert.deepEqual(cleared.failed, []);
    const logs = path.join(fixture.userDataPath, 'logs');
    assert.equal(fs.existsSync(path.join(logs, 'shell.log.1')), false);
    assert.equal(fs.existsSync(path.join(logs, 'shell.log.2')), false);
    assert.equal(fs.statSync(path.join(logs, 'shell.log')).size, 0);
    assert.equal(fs.readFileSync(path.join(logs, 'notes.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'diagnostics', '2026-10-01')), false);
    assert.equal(fs.statSync(path.join(fixture.runtimePath, 'logs', 'sidecar.log')).size, 0);
    assert.equal(fs.existsSync(path.join(fixture.runtimePath, 'logs', 'sidecar.log.1')), false);
  });
});

test('a file added after the preview makes the clear stale and removes nothing', async () => {
  await withFixture({}, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'logs' });
    write(path.join(fixture.userDataPath, 'logs', 'shell.log.3'), 'late');
    const cleared = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: preview.previewToken });
    assert.equal(cleared.ok, false);
    assert.equal(cleared.status, 'stale');
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'logs', 'shell.log.1')), true);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'logs', 'shell.log.3')), true);
  });
});

test('a token is single use, bound to its category, and expires', async () => {
  let clock = 1_000_000;
  await withFixture({ options: { now: () => clock } }, async (fixture) => {
    const first = await fixture.service.previewClear({ categoryId: 'leftovers' });
    const wrongCategory = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: first.previewToken });
    assert.equal(wrongCategory.status, 'stale');
    const cleared = await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: first.previewToken });
    assert.equal(cleared.status, 'ok');
    const reused = await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: first.previewToken });
    assert.equal(reused.status, 'stale');
    const unknown = await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: 'deadbeef' });
    assert.equal(unknown.status, 'stale');
    const second = await fixture.service.previewClear({ categoryId: 'logs' });
    clock += 5 * 60 * 1000 + 1;
    const expired = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: second.previewToken });
    assert.equal(expired.status, 'stale');
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'logs', 'shell.log.1')), true);
  });
});

test('a second preview of the same category replaces the first token', async () => {
  await withFixture({}, async (fixture) => {
    const first = await fixture.service.previewClear({ categoryId: 'leftovers' });
    const second = await fixture.service.previewClear({ categoryId: 'leftovers' });
    assert.equal((await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: first.previewToken })).status, 'stale');
    assert.equal((await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: second.previewToken })).status, 'ok');
  });
});

test('caches: the Chromium caches go through the injected clearer, compile-cache and old scratch are removed', async () => {
  await withFixture({}, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'caches' });
    assert.deepEqual(preview.items.map((item) => item.label), [
      'Browser caches', 'Startup compile cache', 'Image engine scratch files',
    ]);
    assert.equal(preview.kept.length, 1);
    const cleared = await fixture.service.clearCategory({ categoryId: 'caches', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'ok');
    assert.equal(fixture.calls.browser, 1);
    // Chromium's own directories are never removed by Jenny.
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'Cache')), true);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'GPUCache', 'g')), true);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'compile-cache')), true);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'compile-cache', 'v1')), false);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'image-engine-scratch', 'old.png')), false);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'image-engine-scratch', 'fresh.png')), true);
    assert.equal(cleared.freedBytes, 200 + 60 + 70);
  });
});

test('caches: a Chromium clear that throws is reported as a bounded failure without a path', async () => {
  await withFixture({
    options: { clearBrowserCaches: async () => { throw Object.assign(new Error('C:\\secret\\path'), { code: 'EBUSY' }); } },
  }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'caches' });
    const cleared = await fixture.service.clearCategory({ categoryId: 'caches', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'partial');
    assert.deepEqual(cleared.failed, [{ label: 'Browser caches', reason: 'EBUSY', count: 1 }]);
    assert.equal(JSON.stringify(cleared).includes('secret'), false);
  });
});

test('leftovers: exports and the owned derived files go, the live store stays', async () => {
  await withFixture({}, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'leftovers' });
    assert.deepEqual(preview.items.map((item) => item.label), [
      'Reset and export copies', 'Old backups and damaged-file copies',
    ]);
    const cleared = await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'ok');
    assert.equal(cleared.freedBytes, 44);
    assert.equal(cleared.freedFiles, 2);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'exports')), true);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'exports', 'reset.md')), false);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'sessions.json.corrupt-1700000000000')), false);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'sessions.json')), true);
  });
});

test('artifacts: only unreferenced, unused, set-aside and untracked job output goes', async () => {
  await withFixture({}, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    assert.deepEqual(preview.items.map((item) => item.label), [
      'Generated files no chat uses', 'Generated files already set aside', 'Output of finished background jobs',
    ]);
    assert.deepEqual(preview.items.map((item) => item.bytes), [60, 44, 33]);
    assert.equal(preview.kept.length, 4);
    const cleared = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'ok');
    assert.equal(cleared.freedBytes, 60 + 44 + 33);
    const jenny = path.join(fixture.workspaceRoot, '.jenny');
    assert.equal(fs.existsSync(path.join(jenny, 'artifacts', 'sess_a', 'img.png')), true);
    assert.equal(fs.existsSync(path.join(jenny, 'artifacts', 'sess_b')), false);
    assert.equal(fs.existsSync(path.join(jenny, 'artifacts', 'sess_c', 'new.png')), true);
    assert.equal(fs.existsSync(path.join(jenny, 'quarantine', QUARANTINE_NAME)), false);
    assert.equal(fs.existsSync(path.join(jenny, 'quarantine', 'guarded-other', 'f.bin')), true);
    assert.equal(fs.existsSync(path.join(jenny, 'tool-results', 'aaaaaaaaaaaa')), false);
    assert.equal(fs.existsSync(path.join(jenny, 'tool-results', 'bbbbbbbbbbbb', 'output.txt')), true);
  });
});

test('artifacts: a chat that cannot be read fails closed and no job output is guessed without a tracker', async () => {
  const unreadable = makeSessionStore([{ id: 'chat1', message_count: 3 }]);
  unreadable.peekSession = () => ({ messages: [], turn_events: [] });
  await withFixture({ options: { sessionStore: unreadable, getTrackedJobIds: null } }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    assert.deepEqual(preview.items, []);
    assert.equal(preview.kept.length >= 1, true);
    const cleared = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(cleared.freedBytes, 0);
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, '.jenny', 'artifacts', 'sess_b', 'old.png')), true);
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, '.jenny', 'tool-results', 'aaaaaaaaaaaa', 'output.txt')), true);
  });
});

test('artifacts: a workspace lease that is not granted refuses the clear as busy', async () => {
  await withFixture({ options: { acquireWorkspaceLease: () => ({ acquired: false }) } }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    const cleared = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'busy');
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, '.jenny', 'artifacts', 'sess_b', 'old.png')), true);
  });
});

test('chats: the preview carries the count, the clear needs it, and the primary chat is skipped', async () => {
  await withFixture({}, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'chats' });
    assert.equal(preview.confirmCount, 2);
    assert.deepEqual(preview.items.map((item) => item.label), ['2 chats and their attachments']);
    assert.deepEqual(preview.kept, ['Your Jenny chat']);
    const wrong = await fixture.service.clearCategory({ categoryId: 'chats', previewToken: preview.previewToken, confirmCount: 3 });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.reason, 'confirm_count_mismatch');
    const missing = await fixture.service.clearCategory({ categoryId: 'chats', previewToken: preview.previewToken });
    assert.equal(missing.ok, false);
    assert.deepEqual(fixture.deleted, []);
    // A refused count does not spend the token.
    const cleared = await fixture.service.clearCategory({ categoryId: 'chats', previewToken: preview.previewToken, confirmCount: 2 });
    assert.equal(cleared.status, 'ok');
    assert.deepEqual(fixture.deleted, ['chat1', 'chat2']);
    assert.equal(cleared.freedBytes >= 14, true);
  });
});

test('chats: a new chat after the preview is stale, and failures are reported by bounded reason', async () => {
  const sessions = [
    { id: 'primary1', session_role: 'primary', message_count: 1 },
    { id: 'chat1', message_count: 1 },
    { id: 'chat2', message_count: 1 },
  ];
  await withFixture({
    sessions,
    options: {
      deleteChat: async (id) => {
        if (id === 'chat1') return { deleted: false };
        if (id === 'chat2') throw Object.assign(new Error('C:\\leak'), { code: 'EBUSY' });
        return { deleted: true };
      },
    },
  }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'chats' });
    sessions.push({ id: 'chat3', message_count: 1 });
    const stale = await fixture.service.clearCategory({ categoryId: 'chats', previewToken: preview.previewToken, confirmCount: 2 });
    assert.equal(stale.status, 'stale');
    sessions.pop();
    const fresh = await fixture.service.previewClear({ categoryId: 'chats' });
    const cleared = await fixture.service.clearCategory({ categoryId: 'chats', previewToken: fresh.previewToken, confirmCount: 2 });
    assert.equal(cleared.status, 'partial');
    assert.deepEqual(cleared.failed.map((entry) => entry.reason).sort(), ['EBUSY', 'delete_refused']);
    assert.equal(JSON.stringify(cleared).includes('leak'), false);
  });
});

test('chats: the clear is bounded by count', async () => {
  await withFixture({ options: { maxChatsPerClear: 1 } }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'chats' });
    const cleared = await fixture.service.clearCategory({ categoryId: 'chats', previewToken: preview.previewToken, confirmCount: 2 });
    assert.equal(cleared.status, 'partial');
    assert.deepEqual(fixture.deleted, ['chat1']);
    assert.deepEqual(cleared.failed, [{ label: '1 chat and its attachments', reason: 'limit_reached', count: 1 }]);
  });
});

test('a concurrent clear is busy and the first one completes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withFixture({
    options: { deleteChat: async () => { await gate; return { deleted: true }; } },
  }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'chats' });
    const logsPreview = await fixture.service.previewClear({ categoryId: 'logs' });
    const first = fixture.service.clearCategory({ categoryId: 'chats', previewToken: preview.previewToken, confirmCount: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: logsPreview.previewToken });
    assert.equal(second.status, 'busy');
    assert.equal(second.ok, false);
    release();
    assert.equal((await first).status, 'ok');
    // The refused call did not spend its token.
    assert.equal((await fixture.service.clearCategory({ categoryId: 'logs', previewToken: logsPreview.previewToken })).status, 'ok');
  });
});

test('revealCategory opens the primary folder after an lstat, and refuses a link', async () => {
  await withFixture({}, async (fixture) => {
    const result = await fixture.service.revealCategory({ categoryId: 'logs' });
    assert.equal(result.status, 'ok');
    assert.deepEqual(fixture.calls.opened, [path.join(fixture.userDataPath, 'logs')]);
    const artifacts = await fixture.service.revealCategory({ categoryId: 'artifacts' });
    assert.equal(artifacts.ok, true);
    assert.equal(fixture.calls.opened.at(-1), path.join(fixture.workspaceRoot, '.jenny', 'artifacts'));
    const failing = new StorageUsageService({ ...fixture.options, openPath: async () => 'no handler' });
    const failed = await failing.revealCategory({ categoryId: 'logs' });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.reason, 'open_failed');
  });
  await withFixture({}, async (fixture) => {
    const outside = path.join(fixture.root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(fixture.userDataPath, 'logs'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(fixture.userDataPath, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM') return;
      throw error;
    }
    const result = await fixture.service.revealCategory({ categoryId: 'logs' });
    // The linked folder is skipped; the profile root is the fallback, never the link target.
    assert.equal(fixture.calls.opened.includes(outside), false);
    assert.equal(result.ok, true);
    assert.equal(fixture.calls.opened.at(-1), fixture.userDataPath);
  });
});

test('a linked log directory is neither measured nor emptied', async () => {
  await withFixture({}, async (fixture) => {
    const outside = path.join(fixture.root, 'elsewhere2');
    write(path.join(outside, 'shell.log.1'), 'X'.repeat(500));
    fs.rmSync(path.join(fixture.userDataPath, 'logs'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(fixture.userDataPath, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM') return;
      throw error;
    }
    const preview = await fixture.service.previewClear({ categoryId: 'logs' });
    const cleared = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: preview.previewToken });
    assert.equal(cleared.ok, true);
    assert.equal(fs.existsSync(path.join(outside, 'shell.log.1')), true);
  });
});

test('containment primitives refuse a link at any step and never remove through it', async () => {
  const { removeContained, resolveContained, truncateContained } = require('../services/fs-contained');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-contained-'));
  try {
    const base = path.join(root, 'base');
    const outside = path.join(root, 'outside');
    write(path.join(outside, 'keep.txt'), 'K'.repeat(40));
    write(path.join(base, 'real', 'file.log'), 'real');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.symlinkSync(outside, path.join(base, 'linked'), linkType);
      fs.symlinkSync(outside, path.join(base, 'real', 'inner'), linkType);
    } catch (error) {
      if (error.code === 'EPERM') return;
      throw error;
    }
    assert.throws(() => resolveContained(base, ['linked', 'keep.txt']), { reason: 'reparse_or_symlink' });
    assert.throws(() => resolveContained(base, ['real', 'inner']), { reason: 'reparse_or_symlink' });
    assert.throws(() => resolveContained(base, ['..', 'outside']), { reason: 'unsafe_target' });
    assert.throws(() => resolveContained(base, ['real/file.log']), { reason: 'unsafe_target' });
    await assert.rejects(() => removeContained(base, ['linked', 'keep.txt']), { reason: 'reparse_or_symlink' });
    await assert.rejects(() => removeContained(base, ['real', 'inner']), { reason: 'reparse_or_symlink' });
    await assert.rejects(() => truncateContained(base, ['linked', 'keep.txt']), { reason: 'reparse_or_symlink' });
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8').length, 40);
    assert.deepEqual(await removeContained(base, ['real', 'missing']), { removed: false });
    assert.deepEqual(await truncateContained(base, ['real', 'file.log']), { removed: true });
    assert.equal(fs.statSync(path.join(base, 'real', 'file.log')).size, 0);
    assert.deepEqual(await removeContained(base, ['real']), { removed: true });
    assert.equal(fs.existsSync(path.join(base, 'real')), false);
    assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the clear log line carries counts only, never a path', async () => {
  const lines = [];
  await withFixture({ options: { logger: (...args) => lines.push(args) } }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'leftovers' });
    await fixture.service.clearCategory({ categoryId: 'leftovers', previewToken: preview.previewToken });
    assert.equal(lines.length, 1);
    assert.equal(lines[0][1], 'data_usage.cleared');
    assert.equal(JSON.stringify(lines).includes(fixture.root), false);
  });
});
