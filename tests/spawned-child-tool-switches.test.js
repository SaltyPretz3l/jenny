'use strict';

// A chat started by another chat's accepted New session proposal begins with that parent's tool
// switches, Browser included (owner report 2026-11-10: a browser test spawned from Jenny primary
// started with Browser off). Covers the plain child and the fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createLinkedChildSession } = require('../services/backend/backend-sessions');
const { createLinkedForkSession } = require('../services/backend/linked-fork-session');
const { inheritedToolCategoryOverrides } = require('../services/backend/spawned-child-tool-switches');

const CHILD = 'sess_1730000000000_abcdef012345';
const INC = `inc_${'1'.repeat(32)}`;

function setup(t, parentOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-child-tools-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const preferences = parentOverrides ? { tool_category_overrides: parentOverrides } : {};
  const parentId = store.createSession({ title: 'Jenny', sessionRole: 'primary', preferences }).id;
  const sourceId = store.createSession({ title: 'Parser work', projectId: 'project_two' }).id;
  store.appendMessage(sourceId, { id: 'msg_u1', role: 'user', content: 'Split it.' });
  store.appendMessage(sourceId, { id: 'msg_a1', role: 'assistant', content: 'Plan.' });
  const service = { sessionStore: store, projectAuthority: { captureProject: (id) => ({ project_id: id }) } };
  return { store, parentId, sourceId, service };
}

function spec(env, extra = {}) {
  return {
    childSessionId: CHILD, childIncarnation: INC, title: 'Browser gauge', projectId: 'project_two',
    spawnedFrom: {
      schema_version: 1, parent_session_id: env.parentId, parent_session_incarnation: 'inc_parent', proposal_id: `proposal_${'a'.repeat(64)}`,
      created_at: '2026-11-10T10:00:00.000Z', child_creation_hash: 'b'.repeat(64), reporting_consent_id: '11111111-1111-4111-8111-111111111111',
    },
    preferences: { preferred_model: 'm2', reasoning_effort: 'low', run_mode: 'ask' },
    lockdown: false,
    ...extra,
  };
}

test('inheritedToolCategoryOverrides reads the parent normalized and is {} for an unknown or bare parent', (t) => {
  const env = setup(t, { browser_use: true, terminal: false });
  assert.deepEqual(inheritedToolCategoryOverrides(env.store, env.parentId), { browser_use: true, terminal: false });
  assert.deepEqual(inheritedToolCategoryOverrides(env.store, env.sourceId), {});
  assert.deepEqual(inheritedToolCategoryOverrides(env.store, 'sess_gone'), {});
  assert.deepEqual(inheritedToolCategoryOverrides(env.store, null), {});
  assert.deepEqual(inheritedToolCategoryOverrides(null, env.parentId), {});
  const odd = { peekSession: () => ({ tool_category_overrides: { browser_use: 'yes', made_up: true, web: false } }) };
  assert.deepEqual(inheritedToolCategoryOverrides(odd, 'p'), { web: false }, 'only known keys with boolean values');
});

test('a plain linked child starts with its parent\'s Browser switch on', (t) => {
  const env = setup(t, { browser_use: true, terminal: false });
  assert.equal(createLinkedChildSession(env.service, spec(env)).ok, true);
  assert.deepEqual(env.store.getSession(CHILD).tool_category_overrides, { browser_use: true, terminal: false });
});

test('a linked child of a parent with no switches set keeps the defaults', (t) => {
  const env = setup(t);
  assert.equal(createLinkedChildSession(env.service, spec(env)).ok, true);
  assert.deepEqual(env.store.getSession(CHILD).tool_category_overrides, {});
});

test('a linked fork takes the spawning parent\'s switches, not the forked chat\'s', async (t) => {
  const env = setup(t, { browser_use: true });
  env.store.setSessionPreferences(env.sourceId, { tool_category_overrides: { browser_use: false, web: false } });
  assert.deepEqual(env.store.getSession(env.sourceId).tool_category_overrides, { browser_use: false, web: false });
  const created = await createLinkedForkSession(env.service, spec(env, { forkOfSessionId: env.sourceId }));
  assert.deepEqual(created, { ok: true, session_id: CHILD });
  const child = env.store.getSession(CHILD);
  assert.equal(child.branch_origin.source_session_id, env.sourceId);
  assert.deepEqual(child.tool_category_overrides, { browser_use: true });
});
