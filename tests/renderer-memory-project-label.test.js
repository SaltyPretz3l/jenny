'use strict';

// D10 (Projects PO review 2026-09-27): a memory's project is named in words,
// never by its raw `project_…` id. A deleted project (whose memories were
// left behind by an older backend) reads "Deleted project"; before any
// project registry read lands it reads "Project".

const test = require('node:test');
const assert = require('node:assert/strict');

const memorySettingsUtils = require('../renderer/features/renderer-memory-settings-utils');
const { createMemoryManager } = require('../renderer/features/renderer-memory-utils');

// The page renderer receives the label function; capture it there (the same
// route the Memory page uses for its project badges and filter options).
function captureProjectLabel(state) {
  const original = memorySettingsUtils.createMemorySettingsRenderer;
  let captured = null;
  memorySettingsUtils.createMemorySettingsRenderer = (deps) => { captured = deps.getProjectLabel; return null; };
  try {
    createMemoryManager({ state, callbacks: {} });
  } finally {
    memorySettingsUtils.createMemorySettingsRenderer = original;
  }
  return captured;
}

test('D10: the memory project label is a name, "General", or "Deleted project", never a raw id', () => {
  const state = { ui: {}, memoryManager: { projects: [{ id: 'project_general', name: 'General' }, { id: 'project_garden', name: 'Garden' }] } };
  const label = captureProjectLabel(state);
  assert.equal(typeof label, 'function');
  assert.equal(label('project_garden'), 'Garden');
  assert.equal(label('project_general'), 'General');
  assert.equal(label('project_7f3a91'), 'Deleted project', 'a project the registry no longer lists');
  assert.equal(label(''), '', 'no project, no label');

  state.memoryManager.projects = [];
  const labels = ['project_7f3a91', 'project_garden'].map(label);
  assert.deepEqual(labels, ['Project', 'Project'], 'before the registry is read, a generic word');
  for (const text of labels) assert.doesNotMatch(text, /project_/);
});

// N5 (2026-09-27 gate): the source line named "Session sess_1790…". A chat is
// named by its title instead (row 58 W4 page: "This chat only" rows and the
// pending "from" line), or not at all when the chat is gone.
test('N5: a memory names its chat by title, never a raw session id', () => {
  const memory = (id, sessionId) => ({ id, session_id: sessionId, scope_session_id: sessionId, title: 'Tea', lesson_text: 'Prefers tea',
    lesson_kind: 'preference', project_id: 'project_general', updated_at: '2026-09-27T10:00:00.000Z', provenance: 'user_approved' });
  const state = {
    sessions: [{ id: 'sess_1790525892562_7893f165f918', title: 'Morning routine' }],
    memoryManager: {
      memories: [memory(1, 'sess_1790525892562_7893f165f918'), memory(2, 'sess_gone_1')],
      pendingCandidates: [{ session_id: 'sess_1790525892562_7893f165f918', content_fingerprint: 'sha256:1', lesson_text: 'Likes walks', lesson_kind: 'preference' }],
      filter: 'all', searchQuery: '', pendingActionById: new Map(), pendingReviewActionByKey: new Map(),
      archivedByScope: new Map(), operationsByScope: new Map(),
    },
  };
  const node = () => ({ innerHTML: '', textContent: '', hidden: false });
  const dom = { memorySection: {}, approvedMemoryList: node(), pendingMemoryHost: node() };
  const renderer = memorySettingsUtils.createMemorySettingsRenderer({
    state, escapeHtml: (value) => String(value), getDom: () => dom,
    getFieldValue: (entry, key) => entry[key], hasDraftChanges: () => false, searchText: () => '', sortPending: (list) => list,
    buildPendingKey: (sessionId, fingerprint) => `${sessionId}:${fingerprint}`, getKindLabel: (kind) => kind,
  });
  renderer.renderMemoryPage();
  const list = dom.approvedMemoryList.innerHTML;
  assert.match(list, /This chat only: “Morning routine”/);
  assert.match(list, /<span class="memory-meta-item">This chat only<\/span>/, 'a chat that is gone reads as plain "This chat only"');
  assert.match(dom.pendingMemoryHost.innerHTML, /Jenny · from “Morning routine”/);
  const visibleText = (html) => html.replace(/<[^>]*>/g, ' ');
  for (const html of [list, dom.pendingMemoryHost.innerHTML]) assert.doesNotMatch(visibleText(html), /sess_|Session /);
});
