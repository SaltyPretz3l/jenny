'use strict';

// D7 (Projects PO review 2026-09-27): New Chat under a Chats project filter
// that excludes the new chat's project must not make the chat vanish.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

function setup(filter, createdProjectId) {
  const state = { ui: { chatsProjectFilter: filter }, sessions: [] };
  let renders = 0;
  const controller = createShellRuntimeController({
    state,
    callbacks: {
      handleCreateSession: async () => {
        state.sessions.push({ id: 'sess_new', project_id: createdProjectId });
        return 'sess_new';
      },
      renderSessions: () => { renders += 1; },
    },
  });
  return { state, controller, renders: () => renders };
}

test('a new chat outside the active project filter moves the filter to its project', async () => {
  const { state, controller, renders } = setup('project_other', 'project_work');
  assert.equal(await controller.handleCreateSessionWithWorkspace(), 'sess_new');
  assert.equal(state.ui.chatsProjectFilter, 'project_work');
  assert.equal(renders(), 1);
});

test('a new chat with no project id counts as General for the filter', async () => {
  const { state, controller } = setup('project_other', undefined);
  await controller.handleCreateSessionWithWorkspace();
  assert.equal(state.ui.chatsProjectFilter, 'project_general');
});

test('the filter is left alone when it already shows the new chat, or when no filter is set', async () => {
  const same = setup('project_work', 'project_work');
  await same.controller.handleCreateSessionWithWorkspace();
  assert.equal(same.state.ui.chatsProjectFilter, 'project_work');
  assert.equal(same.renders(), 0);
  const all = setup('', 'project_work');
  await all.controller.handleCreateSessionWithWorkspace();
  assert.equal(all.state.ui.chatsProjectFilter, '');
  assert.equal(all.renders(), 0);
});
