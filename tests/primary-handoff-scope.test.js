'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listHandoffProjects, otherWorkNames, resolvePrimaryHandoffScope, suggestHandoffProject,
} = require('../services/backend/primary-handoff-scope');

const PROJECTS = [
  { id: 'project_general', name: 'General', created_at: '2026-01-01' },
  { id: 'project_zeta', name: 'Zeta site', created_at: '2026-01-02' },
  { id: 'project_atlas', name: 'Atlas', created_at: '2026-01-03' },
];

function service({ projects = PROJECTS, summaries = [], messages = [] } = {}) {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  return {
    projectService: { list: () => projects },
    sessionStore: {
      listSessions: () => summaries,
      peekSessionSummary: (id) => byId.get(id) || null,
      peekSessionMessages: () => messages,
    },
  };
}

const toolUse = (toolName, input) => ({ kind: 'tool_use', role: 'assistant', tool_call: { tool_name: toolName, input } });

test('projects list by name with General last; nameless or broken entries drop', () => {
  const svc = service({ projects: [...PROJECTS, { id: 'project_x', name: '   ' }, null] });
  assert.deepEqual(listHandoffProjects(svc).map((project) => project.id), ['project_atlas', 'project_zeta', 'project_general']);
  assert.deepEqual(listHandoffProjects({ projectService: { list: () => { throw new Error('boom'); } } }), []);
});

test('the suggestion is the project of the chat Jenny looked at last', () => {
  const summaries = [
    { id: 'chat_z', project_id: 'project_zeta', updated_at: '2026-10-21' },
    { id: 'chat_a', project_id: 'project_atlas', updated_at: '2026-10-01' },
  ];
  const messages = [
    toolUse('session_status', { session_id: 'chat_z' }),
    { role: 'assistant', content: 'Atlas is waiting on review.' },
    toolUse('session_message', { action: 'send', destination_session_id: 'chat_a', body: 'hi' }),
    toolUse('jenny_help', { topic: 'x' }),
  ];
  const svc = service({ summaries, messages });
  assert.equal(suggestHandoffProject(svc, 'primary', listHandoffProjects(svc)), 'project_atlas');
});

test('a session_transcript read counts as looking at that chat', () => {
  const summaries = [
    { id: 'chat_z', project_id: 'project_zeta', updated_at: '2026-10-21' },
    { id: 'chat_a', project_id: 'project_atlas', updated_at: '2026-10-01' },
  ];
  const svc = service({ summaries, messages: [toolUse('session_transcript', { session_id: 'chat_a', rows: 5 })] });
  assert.equal(suggestHandoffProject(svc, 'primary', listHandoffProjects(svc)), 'project_atlas');
});

test('a tool input naming a project wins; the primary itself and unknown chats are skipped', () => {
  const summaries = [
    { id: 'primary', project_id: 'project_general', session_role: 'primary' },
    { id: 'chat_z', project_id: 'project_zeta', updated_at: '2026-10-21' },
  ];
  const messages = [
    toolUse('sessions_list', { project_id: 'project_atlas' }),
    toolUse('session_status', { session_id: 'missing' }),
    toolUse('session_status', { session_id: 'primary' }),
  ];
  const svc = service({ summaries, messages });
  assert.equal(suggestHandoffProject(svc, 'primary', listHandoffProjects(svc)), 'project_atlas');
});

test('without a tool signal the most recently active ordinary chat decides; nothing known is null', () => {
  const summaries = [
    { id: 'primary', project_id: 'project_general', session_role: 'primary' },
    { id: 'chat_old', project_id: 'project_gone' },
    { id: 'chat_arch', project_id: 'project_atlas', archived_at: '2026-10-20' },
    { id: 'chat_z', project_id: 'project_zeta' },
  ];
  const svc = service({ summaries });
  assert.equal(suggestHandoffProject(svc, 'primary', listHandoffProjects(svc)), 'project_zeta');
  const unassigned = service({ summaries: [{ id: 'chat_n', project_id: null }] });
  assert.equal(suggestHandoffProject(unassigned, 'primary', listHandoffProjects(unassigned)), 'project_general',
    'a chat without a project reads as General');
  const empty = service({ summaries: [summaries[0]] });
  assert.equal(suggestHandoffProject(empty, 'primary', listHandoffProjects(empty)), null);
});

test('other work names: other projects and other chats, never General, generic titles or the chosen work', () => {
  const summaries = [
    { id: 'primary', title: 'Jenny', project_id: 'project_general', session_role: 'primary' },
    { id: 'c1', title: 'Fix login flow', project_id: 'project_zeta' },
    { id: 'c2', title: 'Atlas parser', project_id: 'project_atlas' },
    { id: 'c3', title: 'New chat', project_id: 'project_general' },
    { id: 'c4', title: 'abc', project_id: 'project_general' },
    { id: 'c5', title: 'fix LOGIN flow', project_id: 'project_general' },
    { id: 'c6', title: 'Atlas', project_id: 'project_general' },
  ];
  const svc = service({ summaries });
  assert.deepEqual(otherWorkNames(svc, 'project_atlas', listHandoffProjects(svc)), ['Zeta site', 'Fix login flow']);
});

test('the scope resolves a known project, else asks for one with the list and a suggestion', () => {
  const svc = service({ summaries: [{ id: 'chat_z', project_id: 'project_zeta' }] });
  const required = resolvePrimaryHandoffScope(svc, 'primary', undefined);
  assert.equal(required.ok, false);
  assert.equal(required.reason, 'project_required');
  assert.equal(required.suggestedProjectId, 'project_zeta');
  assert.equal(required.projects.length, 3);
  assert.equal(resolvePrimaryHandoffScope(svc, 'primary', 'project_nope').reason, 'project_invalid');
  const ok = resolvePrimaryHandoffScope(svc, 'primary', ' project_atlas ');
  assert.deepEqual(ok.project, { id: 'project_atlas', name: 'Atlas' });
  assert.deepEqual(ok.otherNames, ['Zeta site']);
});
