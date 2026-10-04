'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  RETIRED_RUNTIME_FILES,
  RETIRED_STAGING_DIR,
  retirePrivilegedTierState,
} = require('../../../services/plugins/lifecycle/privileged-tier-retirement');

async function seed(facade, baseDir) {
  const runtime = baseDir ? `${baseDir}/runtime` : 'runtime';
  await facade.mkdir(runtime);
  for (const name of RETIRED_RUNTIME_FILES) await facade.writeFile(`${runtime}/${name}`, '{}');
  await facade.writeFile(`${runtime}/unrelated.json`, '{}');
  const staging = baseDir ? `${baseDir}/${RETIRED_STAGING_DIR}` : RETIRED_STAGING_DIR;
  await facade.mkdir(`${staging}/op-1`);
  await facade.writeFile(`${staging}/op-1/image.png`, 'x');
  return { runtime, staging };
}

test('retired state names are the exact full-host and session-provider paths', () => {
  assert.deepEqual([...RETIRED_RUNTIME_FILES].sort(), [
    'full-host-cleanup-v6.json',
    'full-host-crash-quarantine-v6.json',
    'hook-outbox-v6.json',
    'secret-delivery-grants-v6.json',
  ]);
  assert.equal(RETIRED_STAGING_DIR, 'session-provider-staging');
});

for (const baseDir of ['', 'plugins']) {
  test(`sweep removes the leftover privileged-tier state (baseDir=${JSON.stringify(baseDir)})`, async () => {
    const facade = createMemoryFsFacade();
    const { runtime, staging } = await seed(facade, baseDir);
    const logs = [];
    const result = await retirePrivilegedTierState({
      facade, baseDir, log: (level, event, data) => logs.push({ level, event, data }),
    });
    assert.deepEqual({ ok: result.ok, removed: result.removed, failed: result.failed },
      { ok: true, removed: 5, failed: 0 });
    for (const name of RETIRED_RUNTIME_FILES) {
      assert.equal((await facade.stat(`${runtime}/${name}`)).exists, false, name);
    }
    assert.equal((await facade.stat(staging)).exists, false);
    assert.equal((await facade.stat(`${runtime}/unrelated.json`)).exists, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'plugins.privileged_tier_retired');
    assert.deepEqual(logs[0].data, { removed_count: 5, failed_count: 0 });
  });
}

test('sweep is idempotent and silent when nothing is left', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, '');
  await retirePrivilegedTierState({ facade, baseDir: '' });
  const logs = [];
  const second = await retirePrivilegedTierState({ facade, baseDir: '', log: (...args) => logs.push(args) });
  assert.deepEqual({ ok: second.ok, removed: second.removed, failed: second.failed },
    { ok: true, removed: 0, failed: 0 });
  assert.equal(logs.length, 0);
});

test('sweep never throws, counts failures, and keeps going', async () => {
  const facade = createMemoryFsFacade();
  const { runtime } = await seed(facade, '');
  const remove = facade.remove.bind(facade);
  facade.remove = async (target) => {
    if (target.endsWith('hook-outbox-v6.json')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return remove(target);
  };
  const logs = [];
  const result = await retirePrivilegedTierState({ facade, baseDir: '',
    log: (level, event, data) => logs.push({ level, event, data }) });
  assert.deepEqual({ ok: result.ok, removed: result.removed, failed: result.failed },
    { ok: false, removed: 4, failed: 1 });
  assert.equal((await facade.stat(`${runtime}/full-host-cleanup-v6.json`)).exists, false);
  assert.equal(logs[0].level, 'WARN');
  assert.ok(!JSON.stringify(logs).includes('hook-outbox'), 'no paths in the log');
});

test('sweep is skipped in plugins safe mode and tolerates a missing facade', async () => {
  const facade = createMemoryFsFacade();
  const { runtime } = await seed(facade, '');
  const skipped = await retirePrivilegedTierState({ facade, baseDir: '', safeMode: { active: true } });
  assert.equal(skipped.skipped, 'safe_mode');
  assert.equal((await facade.stat(`${runtime}/hook-outbox-v6.json`)).exists, true);
  const broken = await retirePrivilegedTierState({ facade: null, baseDir: '' });
  assert.equal(broken.ok, false);
});
