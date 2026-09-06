const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
  normalizeSession,
} = require('../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// run_mode must survive the whole store surface — normalizeSession (disk
// load/repair), setSessionPreferences round trip, summaries, and a full
// reload — or the switcher can never read back what it wrote
// (docs/plans/COMPOSER_RUN_MODE_SPEC.md §3.1).

function buildStore() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-run-mode-store-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  return { storePath, store: new ElectronSessionStore(storePath, { logger() {} }) };
}

test('normalizeSession materializes run_mode with the legacy plan_mode migration', () => {
  assert.equal(normalizeSession('s1', {}).run_mode, 'ask');
  assert.equal(normalizeSession('s1', { plan_mode: true }).run_mode, 'plan');
  assert.equal(normalizeSession('s1', { run_mode: 'auto' }).run_mode, 'auto');
  assert.equal(normalizeSession('s1', { run_mode: 'JUNK' }).run_mode, 'ask');
  assert.equal(
    normalizeSession('s1', { run_mode: 'plan', pre_plan_run_mode: 'auto' }).pre_plan_run_mode,
    'auto'
  );
  assert.equal(normalizeSession('s1', { pre_plan_run_mode: 'garbage' }).pre_plan_run_mode, '');
});

test('run_mode survives the preference round trip, the summary surface, and a reload', () => {
  const { storePath, store } = buildStore();
  const { id } = store.createSession({ title: 'Run mode', preferences: { run_mode: 'auto' } });
  assert.equal(store.getSession(id).run_mode, 'auto');

  const updated = store.setSessionPreferences(id, { run_mode: 'auto' });
  assert.ok(updated, 'preference write accepted');
  assert.equal(updated.run_mode, 'auto', 'the returned summary carries run_mode');

  const listed = store.listSessions().find((session) => session.id === id);
  assert.ok(listed, 'session listed');
  assert.equal(listed.run_mode, 'auto', 'listed summaries carry run_mode');

  const reloaded = new ElectronSessionStore(storePath, { logger() {} });
  assert.equal(reloaded.getSession(id).run_mode, 'auto', 'run_mode survives reload');
});

test('a legacy plan-exit write restores the persisted pre-plan mode through the real store', () => {
  const { store } = buildStore();
  const { id } = store.createSession({ title: 'Plan exit', preferences: { run_mode: 'auto' } });

  store.setSessionPreferences(id, { run_mode: 'plan' });
  assert.equal(store.getSession(id).run_mode, 'plan');
  assert.equal(store.getSession(id).plan_mode, true);
  assert.equal(store.getSession(id).pre_plan_run_mode, 'auto');

  // The exit_plan_mode tool executor still writes { plan_mode: false }.
  const updated = store.setSessionPreferences(id, { plan_mode: false });
  assert.ok(updated, 'plan exit accepted');
  assert.equal(store.getSession(id).run_mode, 'auto', 'pre-plan mode restored');
  assert.equal(store.getSession(id).plan_mode, false);
});

test('summaries surface pre_plan_run_mode so the renderer plan toggle can restore it', () => {
  const { store } = buildStore();
  const { id } = store.createSession({ title: 'Pre-plan surface', preferences: { run_mode: 'auto' } });

  const updated = store.setSessionPreferences(id, { run_mode: 'plan' });
  assert.equal(updated.run_mode, 'plan');
  assert.equal(updated.pre_plan_run_mode, 'auto', 'the returned summary carries pre_plan_run_mode');

  const listed = store.listSessions().find((session) => session.id === id);
  assert.equal(listed.pre_plan_run_mode, 'auto', 'listed summaries carry pre_plan_run_mode');
});
