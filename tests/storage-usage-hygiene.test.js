'use strict';

// "Your data" hardening (row 95 review): a plan whose budget runs out keeps what
// it did not measure, an empty fresh folder counts as recent, a preview belongs
// to the workspace it was taken in, the workspace lease is taken before the token
// is spent, and usage can be re-measured per category without duplicate walks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StorageUsageService } = require('../services/data-lifecycle/storage-usage');
const { CATEGORY_IDS } = require('../services/data-lifecycle/storage-usage-registry');

const DAY_MS = 24 * 60 * 60 * 1000;

function write(file, text = 'x'.repeat(10), ageMs = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
}

function age(dir, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
}

function unreferencedStore() {
  return {
    listSessions: () => [{ id: 'chat1', message_count: 1 }],
    peekSession: () => ({ messages: [{ role: 'user' }], turn_events: [] }),
  };
}

function createFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-usage-hygiene-'));
  const userDataPath = path.join(root, 'profile');
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  write(path.join(userDataPath, 'sessions', 'a.json'), 'a'.repeat(100));
  write(path.join(userDataPath, 'logs', 'shell.log.1'), 'm'.repeat(30), 2 * DAY_MS);
  const state = { workspaceRoot };
  const options = {
    userDataPath,
    runtimePath: path.join(root, 'home', '.companion'),
    getWorkspaceRoot: () => state.workspaceRoot,
    sessionStore: unreferencedStore(),
    getTrackedJobIds: () => [],
    deleteChat: async () => ({ deleted: true, freed: { files: 1, bytes: 1 }, cleanup_status: 'complete' }),
    platform: 'linux',
    env: {},
    ...overrides,
  };
  return {
    root, userDataPath, workspaceRoot, state, options, service: new StorageUsageService(options),
    artifact: (name, ...rest) => path.join(workspaceRoot, '.jenny', 'artifacts', name, ...rest),
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

function seedUnused(fixture, names, filesPer = 1) {
  for (const name of names) {
    for (let index = 0; index < filesPer; index += 1) write(fixture.artifact(name, `f${index}.bin`), 'o'.repeat(10), 3 * DAY_MS);
    age(fixture.artifact(name), 3 * DAY_MS);
  }
}

const UNMEASURED = 'Folders too large to check this time';

test('plan budget: a unit the budget never reached is kept, not cleared as a zero-byte unit', async () => {
  await withFixture({ planMaxFiles: 2 }, async (fixture) => {
    seedUnused(fixture, ['d1', 'd2', 'd3']);
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    assert.equal(preview.partial, true);
    assert.deepEqual(preview.items.map((item) => item.label), ['Generated files no chat uses']);
    assert.equal(preview.items[0].bytes, 20, 'only the two measured folders are targeted');
    assert.equal(preview.kept.includes(UNMEASURED), true);
    const cleared = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'ok');
    assert.equal(cleared.freedBytes, 20);
    assert.equal(fs.existsSync(fixture.artifact('d1')), false);
    assert.equal(fs.existsSync(fixture.artifact('d2')), false);
    assert.equal(fs.existsSync(fixture.artifact('d3', 'f0.bin')), true, 'the unmeasured folder survives');
  });
});

test('plan budget: a unit cut short mid-walk is kept whole', async () => {
  await withFixture({ planMaxFiles: 3 }, async (fixture) => {
    for (let index = 0; index < 5; index += 1) write(fixture.artifact('big', `s${index}`, 'f.bin'), 'o'.repeat(10), 3 * DAY_MS);
    age(fixture.artifact('big'), 3 * DAY_MS);
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    assert.deepEqual(preview.items, []);
    assert.equal(preview.partial, true);
    assert.equal(preview.kept.includes(UNMEASURED), true);
    const cleared = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(cleared.freedBytes, 0);
    assert.equal(fs.readdirSync(fixture.artifact('big')).length, 5);
  });
});

test('plan budget: logs and leftovers plans keep unmeasured units too', async () => {
  await withFixture({ planMaxFiles: 1 }, async (fixture) => {
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      write(path.join(fixture.userDataPath, 'diagnostics', day, 's.json'), 'd'.repeat(12), 2 * DAY_MS);
    }
    const preview = await fixture.service.previewClear({ categoryId: 'logs' });
    assert.equal(preview.partial, true);
    assert.equal(preview.kept.includes(UNMEASURED), true);
    const cleared = await fixture.service.clearCategory({ categoryId: 'logs', previewToken: preview.previewToken });
    assert.equal(cleared.ok, true);
    const survivors = fs.readdirSync(path.join(fixture.userDataPath, 'diagnostics'));
    assert.equal(survivors.includes('2026-10-03'), true, 'the last day was never measured');
  });
});

test('recency: a scratch folder created seconds ago is kept even though it holds no files', async () => {
  await withFixture({}, async (fixture) => {
    fs.mkdirSync(fixture.artifact('fresh-empty'), { recursive: true });
    fs.mkdirSync(fixture.artifact('old-empty'), { recursive: true });
    age(fixture.artifact('old-empty'), 3 * DAY_MS);
    seedUnused(fixture, ['old-full']);
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    assert.equal(preview.kept.includes('Files used in the last few minutes'), true);
    const cleared = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(cleared.status, 'ok');
    assert.equal(fs.existsSync(fixture.artifact('fresh-empty')), true);
    assert.equal(fs.existsSync(fixture.artifact('old-empty')), false);
    assert.equal(fs.existsSync(fixture.artifact('old-full')), false);
  });
  await withFixture({}, async (fixture) => {
    fs.mkdirSync(path.join(fixture.userDataPath, 'image-engine-scratch', 'fresh-empty'), { recursive: true });
    const preview = await fixture.service.previewClear({ categoryId: 'caches' });
    const cleared = await fixture.service.clearCategory({ categoryId: 'caches', previewToken: preview.previewToken });
    assert.equal(cleared.ok, true);
    assert.equal(fs.existsSync(path.join(fixture.userDataPath, 'image-engine-scratch', 'fresh-empty')), true);
  });
});

test('identity: a preview taken in one workspace cannot clear another workspace after a switch', async () => {
  await withFixture({}, async (fixture) => {
    seedUnused(fixture, ['same-name']);
    const other = path.join(fixture.root, 'other-workspace');
    write(path.join(other, '.jenny', 'artifacts', 'same-name', 'f0.bin'), 'o'.repeat(10), 3 * DAY_MS);
    age(path.join(other, '.jenny', 'artifacts', 'same-name'), 3 * DAY_MS);

    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    fixture.state.workspaceRoot = other;
    const cleared = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });

    assert.equal(cleared.status, 'stale');
    assert.equal(cleared.error.reason, 'target_set_changed');
    assert.equal(fs.existsSync(path.join(other, '.jenny', 'artifacts', 'same-name', 'f0.bin')), true);
    assert.equal(fs.existsSync(fixture.artifact('same-name', 'f0.bin')), true);

    const again = await fixture.service.previewClear({ categoryId: 'artifacts' });
    assert.equal((await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: again.previewToken })).status, 'ok');
    assert.equal(fs.existsSync(path.join(other, '.jenny', 'artifacts', 'same-name')), false);
  });
});

test('lease: a workspace that is switching refuses as busy and leaves the token valid', async () => {
  const leases = [{ acquired: false }];
  let released = 0;
  await withFixture({
    acquireWorkspaceLease: () => leases.shift() || { acquired: true, release: () => { released += 1; } },
  }, async (fixture) => {
    seedUnused(fixture, ['d1']);
    const preview = await fixture.service.previewClear({ categoryId: 'artifacts' });
    const busy = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(busy.status, 'busy');
    assert.equal(busy.error.reason, 'workspace_transitioning');
    assert.equal(fs.existsSync(fixture.artifact('d1', 'f0.bin')), true);
    const retried = await fixture.service.clearCategory({ categoryId: 'artifacts', previewToken: preview.previewToken });
    assert.equal(retried.status, 'ok');
    assert.equal(released, 1);
    assert.equal(fs.existsSync(fixture.artifact('d1')), false);
  });
});

function countMeasures(service) {
  const measured = [];
  const original = service._measure.bind(service);
  service._measure = (categoryId, context) => {
    measured.push(categoryId);
    return original(categoryId, context);
  };
  return measured;
}

test('getStorageUsage: categoryIds measures only those and leaves the total null', async () => {
  await withFixture({}, async (fixture) => {
    const measured = countMeasures(fixture.service);
    const usage = await fixture.service.getStorageUsage({ categoryIds: ['logs', 'chats', 'logs'] });
    assert.equal(usage.ok, true);
    assert.deepEqual(usage.categories.map((entry) => entry.id), ['chats', 'logs']);
    assert.equal(usage.totalBytes, null);
    assert.equal(usage.categories[0].bytes, 100);
    assert.deepEqual(measured, ['chats', 'logs']);
    const all = await fixture.service.getStorageUsage();
    assert.deepEqual(all.categories.map((entry) => entry.id), CATEGORY_IDS);
    assert.equal(all.totalBytes, all.categories.reduce((sum, entry) => sum + entry.bytes, 0));
    const empty = await fixture.service.getStorageUsage({});
    assert.equal(empty.categories.length, CATEGORY_IDS.length);
  });
});

test('getStorageUsage: a bad id list is refused', async () => {
  await withFixture({}, async (fixture) => {
    for (const categoryIds of [[], ['nope'], 'logs', [7], Array(8).fill('logs'), null]) {
      const result = await fixture.service.getStorageUsage({ categoryIds });
      assert.equal(result.ok, false, JSON.stringify(categoryIds));
      assert.equal(result.error.reason, 'unknown_category');
    }
  });
});

test('getStorageUsage: identical calls in flight share one measurement', async () => {
  await withFixture({}, async (fixture) => {
    const measured = countMeasures(fixture.service);
    const [first, second, third] = await Promise.all([
      fixture.service.getStorageUsage(),
      fixture.service.getStorageUsage(),
      fixture.service.getStorageUsage({ categoryIds: ['logs'] }),
    ]);
    assert.equal(first, second);
    assert.equal(third.categories.length, 1);
    assert.equal(measured.length, CATEGORY_IDS.length + 1);
    await fixture.service.getStorageUsage();
    assert.equal(measured.length, CATEGORY_IDS.length * 2 + 1, 'a finished call is not cached');
  });
});

test('chats clear: the refresh right after a clear reuses the re-measure the clear just made', async () => {
  const sessions = [
    { id: 'primary1', session_role: 'primary', message_count: 1 },
    { id: 'chat1', message_count: 1 },
    { id: 'chat2', message_count: 1 },
  ];
  await withFixture({ sessionStore: { ...unreferencedStore(), listSessions: () => sessions.map((entry) => ({ ...entry })) } }, async (fixture) => {
    const preview = await fixture.service.previewClear({ categoryId: 'chats' });
    const measured = countMeasures(fixture.service);
    const cleared = await fixture.service.clearCategory({ categoryId: 'chats', previewToken: preview.previewToken, confirmCount: 2 });
    assert.equal(cleared.status, 'ok');
    const refresh = await fixture.service.getStorageUsage({ categoryIds: ['chats'] });
    assert.equal(refresh.categories[0].id, 'chats');
    // The clear walks the category before (its baseline) and once after; the refresh adds none.
    assert.deepEqual(measured, ['chats', 'chats']);
    await fixture.service.getStorageUsage({ categoryIds: ['chats'] });
    assert.deepEqual(measured, ['chats', 'chats', 'chats'], 'the held measurement is used once');
  });
});
