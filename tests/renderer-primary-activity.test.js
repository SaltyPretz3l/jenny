'use strict';

// The Jenny chat's Activity dialog (row 76): an Activity pane and a Permissions pane over
// window.jennyShell.primaryChat. Row 87's rules list and add form are in renderer-primary-rules.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getDefaultPrimaryActivity, statusFor } = require('../renderer/chat/renderer-primary-activity');
const { flush, entry, entries, fixtures, harness } = require('./primary-activity-fixtures');

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

const CID = 'sc_0123456789abcdef0123456789abcdef';
const CID2 = 'sc_fedcba9876543210fedcba9876543210';

function settingEntry(overrides) {
  return {
    id: `set:${CID}`, kind: 'setting_changed', at: '2026-10-25T09:00:00.000Z', change_id: CID, undone_at: null,
    changes: [
      { key: 'time_format_24h', before: false, after: true },
      { key: 'palette', before: 'ember', after: 'tide', before_label: 'Ember', after_label: 'Tide' },
      { key: 'app_zoom_percent', before: 100, after: 125 },
      { key: 'not_a_setting', before: 'a', after: 'b' },
    ],
    ...overrides,
  };
}

function settingHarness(t, entriesList, options) {
  const data = fixtures();
  data.activity = { entries: entriesList, truncated: false };
  return harness(t, { data, ...(options || {}) });
}

test('a setting_changed entry lists each change with names, values and a screen-reader "to"; unknown keys are skipped', async (t) => {
  const h = settingHarness(t, [settingEntry()]);
  h.open();
  await flush();
  const row = h.$('[data-activity-kind="setting_changed"]');
  assert.equal(row.getAttribute('data-change-id'), CID);
  assert.equal(row.querySelector('.primary-activity__kind').textContent, 'Settings changed');
  const changes = Array.from(row.querySelectorAll('.primary-activity__change'));
  assert.deepEqual(changes.map((li) => [
    li.querySelector('.primary-activity__setting-name').textContent,
    li.querySelector('.primary-activity__setting-before').textContent,
    li.querySelector('.primary-activity__setting-after').textContent,
  ]), [['24-hour time', 'Off', 'On'], ['Palette', 'Ember', 'Tide'], ['App zoom', '100%', '125%']]);
  assert.equal(changes[0].querySelector('.sr-only').textContent, ' to ');
  assert.equal(changes[0].querySelector('.primary-activity__setting-arrow').getAttribute('aria-hidden'), 'true');
});

test('a setting_changed entry with no readable change omits the list', async (t) => {
  const h = settingHarness(t, [settingEntry({ changes: [{ key: 'nope', before: 1, after: 2 }] })]);
  h.open();
  await flush();
  assert.equal(h.$('.primary-activity__changes'), null);
  assert.ok(h.$('[data-primary-setting-undo]'));
});

test('an approved setting change shows Approved by you with an Undo; an undone one shows when and no Undo', async (t) => {
  const h = settingHarness(t, [settingEntry(), settingEntry({ id: `set:${CID2}`, change_id: CID2, undone_at: '2026-10-25T09:30:00.000Z' })]);
  h.open();
  await flush();
  const [open, undone] = h.all('[data-activity-kind="setting_changed"]');
  assert.equal(open.querySelector('.chat-review__state').textContent, 'Approved by you');
  assert.equal(open.querySelector('.chat-review__status').getAttribute('data-tone'), 'ok');
  assert.equal(open.querySelector('.status-dot').className, 'status-dot status-dot--ok');
  assert.equal(open.querySelector('[data-primary-setting-undo]').getAttribute('data-primary-setting-undo'), CID);
  assert.equal(open.querySelector('[data-primary-setting-undo]').textContent, 'Undo');
  assert.match(undone.querySelector('.chat-review__state').textContent, /^Undone by you · \S/u);
  assert.equal(undone.querySelector('.chat-review__status').getAttribute('data-tone'), 'muted');
  assert.equal(undone.querySelector('.status-dot').className, 'status-dot status-dot--muted');
  assert.equal(undone.querySelector('[data-primary-setting-undo]'), null);
});

test('Undo calls undoSettingChange once even on a double click, then reloads the activity', async (t) => {
  let release;
  const undoGate = new Promise((resolve) => { release = resolve; });
  const h = settingHarness(t, [settingEntry()], { undoGate });
  h.open();
  await flush();
  const before = h.calledWith('activity').length;
  const button = h.$('[data-primary-setting-undo]');
  button.click();
  assert.equal(h.$('.chat-review__state').textContent, 'Undoing…');
  assert.equal(h.$('[data-primary-setting-undo]'), null);
  button.click(); // the detached button no longer reaches the dialog
  h.$('.chat-review__item').click();
  release();
  await flush();
  await flush();
  assert.equal(h.calledWith('undoSettingChange').length, 1);
  assert.deepEqual(h.calledWith('undoSettingChange')[0].request, { schema_version: 1, change_id: CID });
  assert.equal(h.calledWith('activity').length, before + 1, 'reloaded');
  assert.equal(h.$('.chat-review__state').textContent, 'Approved by you');
});

test('Undo answered changed_since says so and keeps the Undo', async (t) => {
  const h = settingHarness(t, [settingEntry()], { undoAnswer: { schema_version: 1, ok: false, reason: 'changed_since' } });
  h.open();
  await flush();
  h.$('[data-primary-setting-undo]').click();
  await flush();
  await flush();
  assert.equal(h.$('.chat-review__state').textContent, 'Changed since; not undone');
  assert.equal(h.$('.chat-review__status').getAttribute('data-tone'), 'pending');
  assert.ok(h.$('[data-primary-setting-undo]'));
  assert.equal(h.$('.chat-review__notice'), null);
});

test('a failed Undo shows a notice and restores the Undo; already_undone shows no notice', async (t) => {
  const h = settingHarness(t, [settingEntry()], { undoAnswer: { schema_version: 1, ok: false, reason: 'apply_failed' } });
  h.open();
  await flush();
  h.$('[data-primary-setting-undo]').click();
  await flush();
  await flush();
  assert.equal(h.$('.chat-review__notice').textContent, 'Could not undo that change.');
  assert.equal(h.$('.chat-review__state').textContent, 'Approved by you');
  assert.ok(h.$('[data-primary-setting-undo]'));
  const again = settingHarness(t, [settingEntry()], { undoAnswer: { schema_version: 1, ok: false, reason: 'already_undone' } });
  again.open();
  await flush();
  again.$('[data-primary-setting-undo]').click();
  await flush();
  await flush();
  assert.equal(again.$('.chat-review__notice'), null);
});

test('a malformed change id renders no Undo and no data-change-id', async (t) => {
  const h = settingHarness(t, [settingEntry({ change_id: 'sc_<img src=x>' }), settingEntry({ id: 'x', change_id: undefined })]);
  h.open();
  await flush();
  const rows = h.all('[data-activity-kind="setting_changed"]');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.hasAttribute('data-change-id'), false);
    assert.equal(row.querySelector('[data-primary-setting-undo]'), null);
    assert.equal(row.querySelector('.chat-review__state').textContent, 'Approved by you');
  }
});

test('a hostile carried label is escaped', async (t) => {
  const h = settingHarness(t, [settingEntry({ changes: [{ key: 'palette', before: 'a', after: 'b', before_label: '<b>Bold</b>', after_label: '<img src=x onerror=alert(1)>' }] })]);
  h.open();
  await flush();
  assert.equal(h.$('[data-primary-pane="activity"] b'), null);
  assert.equal(h.$('[data-primary-pane="activity"] img'), null);
  assert.equal(h.$('.primary-activity__setting-before').textContent, '<b>Bold</b>');
});

// Row 94: a Jenny-made change to another chat.
function chatEntry(overrides) {
  return {
    id: `chat:${CID}`, kind: 'chat_changed', at: '2026-11-01T09:00:00.000Z', change_id: CID, undone_at: null, title: 'Target chat',
    session_id: 'sess_t', action: 'rename', field: 'title', before: 'Old name', after: 'New name', project: null, ...overrides,
  };
}

async function chatRows(t, list, options) {
  const h = settingHarness(t, list, options);
  h.open();
  await flush();
  return h;
}

test('a chat_changed entry names the target chat, says what changed and offers Undo (row 94)', async (t) => {
  const h = await chatRows(t, [chatEntry()]);
  const row = h.$('[data-activity-kind="chat_changed"]');
  assert.equal(row.getAttribute('data-change-id'), CID);
  assert.equal(row.querySelector('.primary-activity__kind').textContent, 'Chat changed');
  assert.equal(row.querySelector('strong').textContent, 'Target chat');
  assert.equal(row.querySelector('.chat-review__body').textContent, 'Renamed "Old name" to "New name"');
  assert.equal(row.querySelector('.chat-review__state').textContent, 'Done by Jenny');
  assert.equal(row.querySelector('[data-primary-chat-undo]').getAttribute('data-primary-chat-undo'), CID);
  assert.equal(row.querySelector('[data-primary-chat-undo]').textContent, 'Undo');
  assert.equal(row.querySelector('[data-primary-setting-undo]'), null, 'its own Undo hook, not the settings one');
});

test('each chat action reads as one plain line (row 94)', async (t) => {
  const cases = [
    [{ action: 'rename', before: null }, 'Renamed to "New name"'],
    [{ action: 'pin', field: 'pinned', before: false, after: true }, 'Pinned'],
    [{ action: 'unpin', field: 'pinned', before: true, after: false }, 'Unpinned'],
    [{ action: 'archive', field: 'archived_at', before: null, after: '2026-11-01T09:00:00.000Z' }, 'Archived'],
    [{ action: 'unarchive', field: 'archived_at', before: '2026-11-01T09:00:00.000Z', after: null }, 'Unarchived'],
    [{ action: 'move_to_project', field: 'project_id', before: 'p2', after: 'p1', project: { id: 'p1', name: 'Website' } }, 'Moved to Website'],
    [{ action: 'move_to_project', field: 'project_id', before: 'p2', after: 'p9', project: null }, 'Moved to another project'],
    [{ action: 'set_model', field: 'preferred_model', before: null, after: 'qwen3' }, 'Model: default → qwen3'],
    [{ action: 'set_effort', field: 'reasoning_effort', before: 'low', after: 'high' }, 'Effort: low → high'],
    [{ action: 'set_run_mode', field: 'run_mode', before: 'ask', after: 'plan' }, 'Run mode: Ask → Plan'],
    [{ action: 'set_run_mode', field: 'run_mode', before: 'propose', after: 'weird' }, 'Run mode: Propose → weird'],
  ];
  const h = await chatRows(t, cases.map(([overrides], index) => chatEntry({ id: `chat:${index}`, change_id: `sc_${String(index).padStart(32, '0')}`, ...overrides })));
  const lines = h.all('[data-activity-kind="chat_changed"] .chat-review__body').map((p) => p.textContent);
  assert.deepEqual(lines, cases.map(([, line]) => line));
});

test('a created project reads as its own kind with no chat title, and still after the project is gone (row 94 P2)', async (t) => {
  const h = await chatRows(t, [
    chatEntry({ action: 'project_create', field: 'project', title: null, before: null, after: 'pr_1', project: { id: 'pr_1', name: 'Website' } }),
    chatEntry({ id: 'chat:2', change_id: `sc_${'2'.repeat(32)}`, action: 'project_create', field: 'project', title: null, before: null, after: 'pr_1' }),
  ]);
  const [named, gone] = h.all('[data-activity-kind="chat_changed"]');
  assert.equal(named.querySelector('.primary-activity__kind').textContent, 'Project created');
  assert.equal(named.querySelector('strong'), null);
  assert.equal(named.querySelector('.chat-review__body').textContent, 'Created the project Website');
  assert.ok(named.querySelector('[data-primary-chat-undo]'));
  assert.equal(gone.querySelector('.chat-review__body').textContent, 'Created a project');
});

test('an undone chat change shows when and no Undo; a malformed id shows no Undo (row 94)', async (t) => {
  const h = await chatRows(t, [
    chatEntry({ undone_at: '2026-11-01T09:30:00.000Z' }),
    chatEntry({ id: 'x', change_id: 'sc_<img src=x>' }),
  ]);
  const [undone, bad] = h.all('[data-activity-kind="chat_changed"]');
  assert.match(undone.querySelector('.chat-review__state').textContent, /^Undone by you · \S/u);
  assert.equal(undone.querySelector('[data-primary-chat-undo]'), null);
  assert.equal(bad.hasAttribute('data-change-id'), false);
  assert.equal(bad.querySelector('[data-primary-chat-undo]'), null);
});

test('chat Undo calls undoChatChange once with the change id, then reloads the activity (row 94)', async (t) => {
  const h = await chatRows(t, [chatEntry()]);
  const before = h.calledWith('activity').length;
  const button = h.$('[data-primary-chat-undo]');
  button.click();
  button.click();
  await flush();
  await flush();
  assert.equal(h.calledWith('undoChatChange').length, 1);
  assert.deepEqual(h.calledWith('undoChatChange')[0].request, { schema_version: 1, change_id: CID });
  assert.equal(h.calledWith('undoSettingChange').length, 0);
  assert.equal(h.calledWith('activity').length, before + 1, 'reloaded');
});

test('a refused chat Undo says why (row 94)', async (t) => {
  const refuse = (reason) => ({ schema_version: 1, ok: false, reason });
  const changed = await chatRows(t, [chatEntry()], { chatUndoAnswer: refuse('changed_since') });
  changed.$('[data-primary-chat-undo]').click();
  await flush();
  await flush();
  assert.equal(changed.$('.chat-review__state').textContent, 'Changed since; not undone');
  assert.ok(changed.$('[data-primary-chat-undo]'));
  assert.equal(changed.$('.chat-review__notice'), null);
  for (const [reason, text] of [
    ['session_busy', 'That chat is busy right now; try again when it is idle.'],
    ['not_found', 'That change can no longer be undone.'],
    ['unavailable', 'Could not undo that change.'],
  ]) {
    const h = await chatRows(t, [chatEntry()], { chatUndoAnswer: refuse(reason) });
    h.$('[data-primary-chat-undo]').click();
    await flush();
    await flush();
    assert.equal(h.$('.chat-review__notice').textContent, text, reason);
    assert.ok(h.$('[data-primary-chat-undo]'), reason);
  }
  const again = await chatRows(t, [chatEntry()], { chatUndoAnswer: refuse('already_undone') });
  again.$('[data-primary-chat-undo]').click();
  await flush();
  await flush();
  assert.equal(again.$('.chat-review__notice'), null);
});

test('hostile chat titles, values and project names are escaped (row 94)', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const h = await chatRows(t, [
    chatEntry({ title: evil, before: '<b>old</b>', after: evil }),
    chatEntry({ id: 'm', change_id: CID2, action: 'move_to_project', field: 'project_id', after: 'p1', project: { id: 'p1', name: evil } }),
  ]);
  assert.equal(h.$('[data-primary-pane="activity"] img'), null);
  assert.equal(h.$('[data-primary-pane="activity"] b'), null);
  assert.match(h.$('[data-activity-kind="chat_changed"] .chat-review__body').textContent, /<b>old<\/b>/u);
});

test('scheduled-check entries name the check and say why it was skipped or who changed it (row 85)', async (t) => {
  const data = fixtures();
  data.activity = { truncated: false, entries: [
    entry({ id: 's1', kind: 'schedule_fired', title: 'Scheduled check: Morning review', status: 'running' }),
    entry({ id: 's2', kind: 'schedule_skipped', title: 'Morning review', reason: 'paused' }),
    entry({ id: 's3', kind: 'schedule_missed', title: 'Morning review', reason: 'late' }),
    entry({ id: 's4', kind: 'schedule_skipped', title: 'Morning review', reason: 'runtime_submission_refused' }),
    entry({ id: 's5', kind: 'schedule_created', title: 'Morning review', by: 'jenny' }),
    entry({ id: 's6', kind: 'schedule_disabled', title: 'Morning review', by: 'user' }),
  ] };
  const h = harness(t, { data });
  h.open();
  await flush();
  const rows = h.all('[data-primary-pane="activity"] li.chat-review__item');
  assert.deepEqual(rows.map((li) => li.querySelector('.primary-activity__kind').textContent),
    ['Check ran', 'Check skipped', 'Check missed', 'Check skipped', 'Check created', 'Check turned off']);
  assert.deepEqual(rows.map((li) => li.querySelector('.chat-review__body')?.textContent ?? ''),
    ['', 'Jenny was paused.', 'Jenny was not running when it was due.', 'Jenny could not start the turn.',
      'Jenny asked and you approved.', 'You made this change.']);
  assert.equal(rows[0].querySelector('.chat-review__status').getAttribute('data-tone'), 'pending');
  assert.equal(rows[1].querySelector('.chat-review__status'), null);
});

test('digest entries: Digest with its prompt and a work tone; Digest held back says why in one line (row 86)', async (t) => {
  const data = fixtures();
  const held = (id, reason) => entry({ id, kind: 'digest_skipped', reason });
  data.activity = { truncated: false, entries: [entry({ id: 'd1', kind: 'digest', title: 'While you were away', status: 'running' }),
    entry({ id: 'd2', kind: 'digest', title: 'While you were away', status: 'completed' }),
    held('h1', 'quiet_hours'), held('h2', 'engine_cold'), held('h3', 'cap'), held('h4', 'paused'), held('h5', 'busy')] };
  const h = harness(t, { data });
  h.open();
  await flush();
  const rows = h.all('[data-primary-pane="activity"] li.chat-review__item');
  assert.deepEqual(rows.map((li) => li.querySelector('.primary-activity__kind').textContent), ['Digest', 'Digest', ...Array(5).fill('Digest held back')]);
  assert.equal(rows[0].querySelector('strong').textContent, 'While you were away');
  assert.deepEqual(rows.slice(0, 2).map((li) => li.querySelector('.chat-review__status').getAttribute('data-tone')), ['pending', 'ok']);
  assert.deepEqual(rows.slice(2).map((li) => li.querySelector('.chat-review__body').textContent), ['Quiet hours. It runs when they end if you are here.',
    'Waiting for the model to load. It runs after your next message.', 'One digest every 6 hours at most.', 'Jenny was paused.', 'It could not start.']);
  assert.deepEqual(rows.slice(2).map((li) => [li.querySelector('strong'), li.querySelector('.chat-review__status')]), Array(5).fill([null, null]));
  assert.deepEqual(statusFor(entry({ kind: 'digest', status: 'started' })), { tone: 'pending', label: 'Started' });
});
