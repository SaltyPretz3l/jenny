'use strict';

// Row 69: the conversations_* scope widens to every project for the primary
// Jenny chat only, and only on trusted state (live call binding + canonical
// caller summary), never on tool arguments.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConversationsScope, visibleFilter } = require('../services/tools/builtin/conversations-scope');
const { liveCallFields } = require('./helpers/primary-live-call');

function fixture({ role = 'primary', flag = true, activeTurn } = {}) {
  const live = liveCallFields('jenny');
  const service = {
    featureFlags: { primary_chat: flag },
    sessionRuntime: { lineageStore: { exportPortableSnapshot: () => ({ records: [] }) } },
    sessionStore: { getActiveTurn: () => (activeTurn === undefined ? live.activeTurn : activeTurn) },
  };
  const caller = { id: 'jenny', project_id: 'project_general', session_role: role };
  return { caller, context: { ...live.fields, backendService: service } };
}

test('the primary chat on a live call spans every project', () => {
  const { caller, context } = fixture();
  assert.deepEqual(resolveConversationsScope(context, caller), { all_projects: true, project_id: 'project_general' });
});

test('ordinary chats, the kill switch and an untrusted call keep the project scope', () => {
  for (const options of [{ role: null }, { role: 'Primary' }, { flag: false }, { activeTurn: null },
    { activeTurn: { stream_id: 'other', turn_id: 'turn_live', session_incarnation: 'inc_live' } }]) {
    const { caller, context } = fixture(options);
    assert.deepEqual(resolveConversationsScope(context, caller), { all_projects: false, project_id: 'project_general' },
      JSON.stringify(options));
  }
  const { caller, context } = fixture();
  assert.equal(resolveConversationsScope({ ...context, sessionId: 'someone_else' }, caller).all_projects, false,
    'a context naming another session never borrows the binding');
  assert.equal(resolveConversationsScope({ ...context, executionAuthority: {} }, caller).all_projects, false);
  assert.deepEqual(resolveConversationsScope({ ...context, projectAuthority: null }, caller),
    { all_projects: false, project_id: null }, 'no trusted project fails closed even for the primary');
});

test('the widened filter keeps every hidden-chat exclusion', () => {
  const { context } = fixture();
  const service = context.backendService;
  const chat = (id, extra = {}) => ({ id, project_id: 'project_b', message_count: 1, ...extra });
  const wide = visibleFilter(service, { all_projects: true, project_id: 'project_general' }, 'jenny');
  const narrow = visibleFilter(service, { all_projects: false, project_id: 'project_general' }, 'jenny');
  assert.equal(wide(chat('other_project')), true);
  assert.equal(narrow(chat('other_project')), false);
  const primary = chat('primary', { project_id: 'project_general', session_role: 'primary' });
  assert.equal(narrow(primary), false, 'a General chat never reads the primary');
  assert.equal(wide(primary), false);
  for (const hidden of [chat('jenny'), chat('locked', { lockdown: true }), chat('empty', { message_count: 0 }),
    chat('optout', { context_preferences: { memory_opt_out: true } }), chat('plugin', { session_type: 'plugin' }),
    chat('diagnostic', { diagnostic_mode: true }), null]) {
    assert.equal(wide(hidden), false, JSON.stringify(hidden));
  }
});
