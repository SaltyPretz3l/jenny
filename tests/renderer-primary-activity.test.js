'use strict';

// The Jenny chat's Activity dialog (row 76): an Activity pane and a Permissions pane over
// window.jennyShell.primaryChat, with revoke rows and a grant form.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPrimaryActivity, getDefaultPrimaryActivity, statusFor } = require('../renderer/chat/renderer-primary-activity');
const stepModal = require('../renderer/inventory/step-modal');
const actionButton = require('../renderer/inventory/action-button');
const checkbox = require('../renderer/inventory/checkbox');
const selectField = require('../renderer/inventory/select-field');
const segmentedControl = require('../renderer/inventory/segmented-control');

const SID = 'primary-1';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function entry(overrides) {
  return {
    id: 'e', kind: 'message_sent', at: '2026-10-25T09:00:00.000Z', status: null, title: null, detail: null,
    session_id: null, project: null, authorization: null, permission_id: null, ...overrides,
  };
}

function entries() {
  return [
    entry({ id: '1', kind: 'paused', at: '2026-10-25T09:05:00.000Z' }),
    entry({ id: '2', kind: 'report_received', title: 'Website <b>redesign</b>', detail: 'Finished <i>hero</i> copy', status: 'queued', project: { id: 'p1', name: 'Website' } }),
    entry({ id: '3', kind: 'proposal', title: 'Hero copy', detail: 'Draft three variants', status: 'accepted/start', authorization: 'permission', project: { id: 'p1', name: 'Website' } }),
    entry({ id: '4', kind: 'proposal', title: 'Other', status: 'declined/start', authorization: 'offer' }),
    entry({ id: '5', kind: 'message_sent', title: 'Release notes', detail: 'Mention the API bump', status: 'delivered', authorization: 'approval' }),
    entry({ id: '6', kind: 'stop', title: 'Sweep', status: 'denied' }),
    entry({ id: '7', kind: 'woken', title: 'by a report', status: 'running' }),
    entry({ id: '8', kind: 'reset' }),
  ];
}

function fixtures() {
  return {
    paused: false,
    activity: { entries: entries(), truncated: true },
    permissions: {
      launch: [
        { permission_id: 'perm-1', project_id: 'p1', run_modes: null, max_children_per_turn: 1, created_at: '2026-10-24T09:00:00.000Z', revoked_at: null, project: { id: 'p1', name: 'Website <b>x</b>' } },
        { permission_id: 'perm-2', project_id: '*', run_modes: ['auto'], max_children_per_turn: 3, created_at: '2026-10-22T09:00:00.000Z', revoked_at: null, project: null },
        { permission_id: 'perm-3', project_id: 'p2', run_modes: null, max_children_per_turn: 1, created_at: '2026-10-20T09:00:00.000Z', revoked_at: '2026-10-21T09:00:00.000Z', project: { id: 'p2', name: 'Gone' } },
      ],
      message_grants: [
        { grant_id: 'g-1', destination: { session_id: 'd1', title: 'Release notes' }, purpose: 'Keep notes in step', created_at: '2026-10-24T09:00:00.000Z', expires_at: '2026-10-31T09:00:00.000Z', remaining_sends: 97, revoked_at: null, live: true },
        { grant_id: 'g-2', destination: { session_id: 'd2', title: 'Dead' }, purpose: 'old', created_at: '2026-10-01T09:00:00.000Z', expires_at: '2026-10-02T09:00:00.000Z', remaining_sends: 0, revoked_at: null, live: false },
      ],
      turn_grants: [],
    },
    flags: { controls: true, launch_permission: true, activity_log: true },
  };
}

function harness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><button id="trigger">open</button></main></body></html>');
  const doc = dom.window.document;
  const data = options.data || fixtures();
  const calls = [];
  const listeners = new Set();
  const bridge = options.noBridge ? null : {
    getState: async (request) => { calls.push({ method: 'getState', request }); return { schema_version: 1, ok: true, session_id: SID, paused: data.paused, paused_at: null, permissions: [], history: [], flags: data.flags }; },
    activity: async (request) => { calls.push({ method: 'activity', request }); if (options.failActivity) return { schema_version: 1, ok: false, reason: 'unavailable' }; return { schema_version: 1, ok: true, session_id: SID, ...data.activity }; },
    permissions: async (request) => { calls.push({ method: 'permissions', request }); return { schema_version: 1, ok: true, ...data.permissions }; },
    grantLaunch: async (request) => { calls.push({ method: 'grantLaunch', request }); return options.grantAnswer || { schema_version: 1, ok: true, created: true, permission: {} }; },
    revokeLaunch: async (request) => { calls.push({ method: 'revokeLaunch', request }); return { schema_version: 1, ok: true, permission: {} }; },
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const messages = { revokeGrant: async (request) => { calls.push({ method: 'revokeGrant', request }); return { schema_version: 1, ok: true }; } };
  dom.window.jennyShell = { chatMessages: messages };
  const savedWindow = globalThis.window;
  globalThis.window = dom.window;
  const activity = createPrimaryActivity({
    documentRef: doc, stepModal, actionButton, checkbox, selectField, segmentedControl,
    getBridge: () => bridge, state: {}, appendClientLog: () => {},
    listProjects: () => options.projects || [{ id: 'p1', name: 'Website' }, { id: 'p2', name: 'Perf' }],
  });
  t.after(() => { activity.dispose(); dom.window.close(); globalThis.window = savedWindow; });
  const $ = (selector) => doc.querySelector(selector);
  return {
    doc, data, calls, listeners, activity, $,
    all: (selector) => Array.from(doc.querySelectorAll(selector)),
    open: (args) => activity.open({ sessionId: SID, trigger: doc.getElementById('trigger'), ...(args || {}) }),
    calledWith: (method) => calls.filter((call) => call.method === method),
    showPermissions: () => $('[data-inv-segmented="primary-activity-tabs"] [data-value="permissions"]').click(),
  };
}

test('open paints one row per entry in order, with kind labels, status tones and history text', async (t) => {
  const h = harness(t);
  assert.equal(h.open(), true);
  await flush();
  const dialog = h.$('[data-step-modal="primary-chat-activity"]');
  assert.ok(dialog);
  assert.match(dialog.querySelector('.inv-step-modal-title').textContent, /Activity/u);
  const rows = h.all('[data-primary-pane="activity"] li.chat-review__item');
  assert.deepEqual(rows.map((li) => li.getAttribute('data-activity-kind')), ['paused', 'report_received', 'proposal', 'proposal', 'message_sent', 'stop', 'woken', 'reset']);
  assert.deepEqual(rows.map((li) => li.querySelector('.primary-activity__kind').textContent),
    ['Paused', 'Report received', 'Started a chat', 'Proposed a chat', 'Message sent', 'Stop requested', 'Woken', 'Reset']);
  assert.equal(rows[0].querySelector('.chat-review__body').textContent, 'You paused Jenny.');
  assert.equal(rows[7].querySelector('.chat-review__body').textContent, 'You reset the Jenny chat.');
  assert.equal(rows[0].querySelector('.chat-review__status'), null);
  assert.equal(rows[1].querySelector('.chat-review__status').getAttribute('data-tone'), 'pending');
  assert.equal(rows[1].querySelector('.chat-review__state').textContent, 'Queued');
  assert.equal(rows[2].querySelector('.chat-review__state').textContent, 'Accepted · under your permission');
  assert.equal(rows[2].querySelector('.chat-review__status').getAttribute('data-tone'), 'ok');
  assert.equal(rows[3].querySelector('.chat-review__state').textContent, 'Declined · you chose');
  assert.equal(rows[4].querySelector('.chat-review__state').textContent, 'Delivered · approved by you');
  assert.equal(rows[5].querySelector('.chat-review__status').getAttribute('data-tone'), 'error');
  assert.equal(rows[5].querySelector('.status-dot').className, 'status-dot status-dot--error');
  assert.equal(rows[6].querySelector('.chat-review__status').getAttribute('data-tone'), 'pending');
  assert.match(rows[2].querySelector('.chat-review__meta').textContent, /Website/u);
  assert.match(h.$('[data-primary-pane="activity"] .chat-review__note').textContent, /Older entries are not shown\./u);
  assert.deepEqual(h.calledWith('activity')[0].request, { schema_version: 1, limit: 60 });
});

test('titles and details are plain text, never markup', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  const row = h.all('[data-primary-pane="activity"] li.chat-review__item')[1];
  assert.equal(row.querySelector('strong').textContent, 'Website <b>redesign</b>');
  assert.equal(row.querySelector('.chat-review__body').textContent, 'Finished <i>hero</i> copy');
  assert.equal(h.$('[data-primary-pane="activity"] b'), null);
  assert.equal(h.$('[data-primary-pane="activity"] i'), null);
});

test('an empty log reads Nothing yet and a paused chat shows the Paused status word', async (t) => {
  const data = fixtures();
  data.activity = { entries: [], truncated: false };
  data.paused = true;
  const h = harness(t, { data });
  h.open();
  await flush();
  assert.equal(h.$('[data-primary-pane="activity"] .chat-review__note').textContent, 'Nothing yet.');
  assert.equal(h.$('.inv-step-modal-status').textContent, 'Paused');
});

test('the Permissions tab lists live launch permissions with modes and children, hides revoked ones and escapes names', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  assert.equal(h.$('[data-primary-pane="permissions"]').hidden, true);
  h.showPermissions();
  assert.equal(h.$('[data-primary-pane="permissions"]').hidden, false);
  assert.equal(h.$('[data-primary-pane="activity"]').hidden, true);
  const rows = h.all('[data-primary-pane="permissions"] .primary-activity__perm');
  assert.deepEqual(rows.map((row) => row.getAttribute('data-permission-id')), ['perm-1', 'perm-2', 'g-1']);
  assert.equal(rows[0].querySelector('.primary-activity__perm-title').textContent, 'Website <b>x</b>');
  assert.equal(h.$('[data-primary-pane="permissions"] b'), null);
  assert.match(rows[0].querySelector('.primary-activity__perm-meta').textContent, /^Any run mode · 1 chat per request · granted /u);
  assert.equal(rows[1].querySelector('.primary-activity__perm-title').textContent, 'Every project');
  assert.match(rows[1].querySelector('.primary-activity__perm-meta').textContent, /^Only while Jenny is in Auto · 3 chats per request · granted /u);
  assert.equal(rows[0].querySelector('[data-primary-permission-revoke]').textContent, 'Revoke');
  assert.match(rows[2].querySelector('.primary-activity__perm-title').textContent, /Release notes/u);
  assert.match(rows[2].querySelector('.primary-activity__perm-meta').textContent, /^"Keep notes in step" · 97 sends left · expires /u);
  const notes = h.all('[data-primary-pane="permissions"] .chat-review__note').map((node) => node.textContent);
  assert.deepEqual(notes, ['None live. A /linked request grants one for an hour.']);
  const kickers = h.all('.primary-activity__kicker').map((node) => node.textContent);
  assert.deepEqual(kickers, ['Jenny may start chats in', 'Message grants', 'One-turn grants']);
});

test('no live permission reads None and the grant form is hidden when the launch_permission flag is off', async (t) => {
  const data = fixtures();
  data.permissions = { launch: [], message_grants: [], turn_grants: [{ authorization_ref: 'ref-1', created_at: '2026-10-25T08:00:00.000Z', expires_at: '2026-10-25T09:30:00.000Z', remaining: 1, revoked_at: null, live: true }] };
  data.flags.launch_permission = false;
  const h = harness(t, { data });
  h.open({ pane: 'permissions' });
  await flush();
  assert.equal(h.$('[data-primary-pane="permissions"]').hidden, false);
  assert.equal(h.$('.primary-activity__form'), null);
  const notes = h.all('[data-primary-pane="permissions"] .chat-review__note').map((node) => node.textContent);
  assert.deepEqual(notes, ['None. Jenny shows you a choice before starting a chat.', 'None live.']);
  const turn = h.$('[data-permission-id="ref-1"]');
  assert.equal(turn.querySelector('.primary-activity__perm-title').textContent, 'A /linked request');
  assert.equal(turn.querySelector('[data-primary-permission-revoke]'), null);
});

test('Allow sends grantLaunch with run_modes ["auto"] when checked, null otherwise, then refetches', async (t) => {
  const h = harness(t);
  h.open({ pane: 'permissions' });
  await flush();
  const select = h.$('[data-primary-grant-project]');
  assert.deepEqual(Array.from(select.options).map((option) => [option.value, option.textContent]), [['p1', 'Website'], ['p2', 'Perf'], ['*', 'Every project']]);
  select.value = 'p2';
  const before = h.calledWith('activity').length;
  h.$('[data-primary-grant-submit]').click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('grantLaunch')[0].request, { schema_version: 1, project_id: 'p2', run_modes: null });
  assert.equal(h.calledWith('activity').length, before + 1, 'refetched');
  assert.equal(h.$('[data-primary-grant-project]').value, 'p2', 'the form keeps its choice across the repaint');
  h.$('[data-primary-grant-auto]').click();
  h.$('[data-primary-grant-submit]').click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('grantLaunch')[1].request, { schema_version: 1, project_id: 'p2', run_modes: ['auto'] });
});

test('a refused grant paints a notice, and a full list says to revoke one first', async (t) => {
  const h = harness(t, { grantAnswer: { schema_version: 1, ok: false, code: 'CMP-PRIMARY-0007', reason: 'capacity', retryable: false } });
  h.open({ pane: 'permissions' });
  await flush();
  h.$('[data-primary-grant-submit]').click();
  await flush();
  await flush();
  assert.equal(h.$('.chat-review__notice').textContent, 'The permission list is full; revoke one first.');
  const other = harness(t, { grantAnswer: { schema_version: 1, ok: false, reason: 'unknown_project' } });
  other.open({ pane: 'permissions' });
  await flush();
  other.$('[data-primary-grant-submit]').click();
  await flush();
  await flush();
  assert.equal(other.$('.chat-review__notice').textContent, 'Could not grant that permission.');
});

test('Revoke sends revokeLaunch with the id, then refetches; a message grant goes through chatMessages.revokeGrant', async (t) => {
  const h = harness(t);
  h.open({ pane: 'permissions' });
  await flush();
  const before = h.calledWith('permissions').length;
  h.$('[data-primary-permission-revoke="perm-2"]').click();
  await flush();
  await flush();
  assert.deepEqual(h.calledWith('revokeLaunch')[0].request, { schema_version: 1, permission_id: 'perm-2' });
  assert.equal(h.calledWith('permissions').length, before + 1);
  h.$('[data-primary-message-grant-revoke="g-1"]').click();
  await flush();
  assert.deepEqual(h.calledWith('revokeGrant')[0].request, { schema_version: 1, source_session_id: SID, grant_id: 'g-1' });
});

test('a bridge change while open refetches once, however many events arrive together', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  assert.equal(h.listeners.size, 1);
  const before = h.calledWith('activity').length;
  h.data.activity = { entries: [entry({ id: 'n', kind: 'resumed' })], truncated: false };
  for (const listener of h.listeners) { listener({ schema_version: 1 }); listener({ schema_version: 1 }); }
  await flush();
  await flush();
  assert.equal(h.calledWith('activity').length, before + 1);
  assert.equal(h.all('[data-primary-pane="activity"] li').length, 1);
  assert.equal(h.$('[data-activity-kind="resumed"] .chat-review__body').textContent, 'You resumed Jenny.');
});

test('a failing bridge paints the unavailable notice, and no bridge means no dialog', async (t) => {
  const h = harness(t, { failActivity: true });
  h.open();
  await flush();
  assert.equal(h.$('[data-primary-pane="activity"] .chat-review__notice').textContent, "Jenny's activity is not available right now.");
  const none = harness(t, { noBridge: true });
  assert.equal(none.open(), false);
});

test('the dialog shows a loading note before the first answer', (t) => {
  const h = harness(t);
  h.open();
  assert.equal(h.$('[data-primary-pane="activity"] .chat-review__note').textContent, 'Loading…');
});

test('Close removes the dialog, unsubscribes and restores focus; opening twice is one dialog', async (t) => {
  const h = harness(t);
  h.open();
  h.open();
  await flush();
  assert.equal(h.all('[data-step-modal="primary-chat-activity"]').length, 1);
  assert.equal(h.activity.isOpen(), true);
  h.$('[data-step-modal-action="close"]').click();
  assert.equal(h.activity.isOpen(), false);
  assert.equal(h.$('[data-step-modal="primary-chat-activity"]'), null);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.doc.activeElement, h.doc.getElementById('trigger'));
});

test('statusFor maps words to tones and appends the authorization', () => {
  assert.deepEqual(statusFor(entry({ kind: 'launch_grant', status: 'live' })), { tone: 'pending', label: 'Live' });
  assert.deepEqual(statusFor(entry({ kind: 'launch_grant', status: 'revoked' })), { tone: 'error', label: 'Revoked' });
  assert.deepEqual(statusFor(entry({ kind: 'stop', status: 'approved_auto' })), { tone: 'ok', label: 'Approved automatically' });
  assert.deepEqual(statusFor(entry({ kind: 'woken', status: 'completed' })), { tone: 'ok', label: 'Completed' });
  assert.deepEqual(statusFor(entry({ kind: 'message_sent', status: 'delivered', authorization: 'grant' })), { tone: 'ok', label: 'Delivered · under a grant' });
  assert.equal(statusFor(entry({ kind: 'proposal', status: 'accepted/start', authorization: 'linked' })).label, 'Accepted · by your request');
  assert.equal(statusFor(entry({ kind: 'paused', status: null })), null);
});

test('getDefaultPrimaryActivity is a singleton', () => {
  const a = getDefaultPrimaryActivity({ getBridge: () => null });
  assert.equal(getDefaultPrimaryActivity({}), a);
});
