'use strict';

// new-test-file: Settings > Team, Leave's offer to export first (row 123, slice 2a-6c), moved out of
// renderer-settings-team-actions.test.js at its 600-line cap. Leave is never done for the person and never blocked by
// an export that failed, was cancelled or cannot run offline; an export still gathering stops with the confirmation.
// Real Settings and team modules over the harness bridge, with a stubbed save dialog.

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('./helpers/team-settings-harness');

const { OTHER, DOT, flush, pushed, snapshot, NONE } = shared;
const lab = (over = {}) => snapshot({ team_id: OTHER, team_name: 'Lab', role: 'member', member_id: DOT, display_name: 'Dot', ...over });
const harness = (options = {}) => shared.harness({ host: NONE, teams: [lab()], ...options });
const OVERVIEW = { ok: true, channels: [{ channel_id: 'chan_team', kind: 'team' }], members: [{ member_id: DOT, display_name: 'Dot' }] };

test('2a-6c: the Leave confirm offers an export first; Leave waits while it runs; offline says why; done says where', async (t) => {
  const saves = [];
  let release;
  const h = harness({ host: NONE, teams: [snapshot({ team_id: OTHER, team_name: 'Lab', role: 'member', member_id: DOT, display_name: 'Dot' })], answers: {
    chatOverview: { ok: true, channels: [{ channel_id: 'chan_team', kind: 'team' }], members: [{ member_id: DOT, display_name: 'Dot' }] },
    chatHistory: () => new Promise((resolve) => { release = () => resolve({ ok: true, messages: [{ id: 'msg_1', seq: 1, channel_id: 'chan_team', author: { kind: 'member', member_id: DOT },
      created_at: new Date().toISOString(), text: 'hello', thread_root_id: null, reply_count: 0, deleted: null }], has_more: false }); }),
  } });
  t.after(h.restore);
  h.window.jennyShell.dialog = { saveFile: async (payload) => { saves.push(payload); return { canceled: false, path: 'D:\\Lab.md' }; } };
  await flush();
  h.click('[data-team-action="leave"]');
  assert.match(h.text(), /To keep a copy of the messages you can read, export them first\./);
  h.click('[data-team-action="leave-export"]');
  await flush();
  assert.equal(h.q('[data-team-action="confirm-leave"]').disabled, true, 'Leave waits while the export runs');
  assert.ok(h.q('[data-team-action="leave-export-cancel"]'), 'the export can be cancelled from here');
  release();
  await flush();
  assert.equal(saves.length, 1);
  assert.match(h.text(), /Exported 1 messages from 1 conversations to D:\\Lab\.md\./);
  assert.equal(h.q('[data-team-action="confirm-leave"]').disabled, false);
  assert.equal(h.sent('leave').length, 0, 'exporting never leaves');
  h.listeners.state({ teams: [snapshot({ team_id: OTHER, team_name: 'Lab', role: 'member', state: 'offline' })] });
  await pushed();
  assert.match(h.text(), /Lab is offline, so its messages cannot be exported now\./);
  assert.equal(h.q('[data-team-action="leave-export"]').disabled, true);
  assert.equal(h.logged.some((line) => line.includes('hello')), false, 'no message text in a log');
});

test('fix item 1: closing the Leave confirmation or leaving the page cancels an export still gathering; at the dialog it finishes', async (t) => {
  const releases = [];
  let saveRelease;
  const h = harness({ host: NONE, teams: [snapshot({ team_id: OTHER, team_name: 'Lab', role: 'member', member_id: DOT, display_name: 'Dot' })], answers: {
    chatOverview: { ok: true, channels: [{ channel_id: 'chan_team', kind: 'team' }], members: [{ member_id: DOT, display_name: 'Dot' }] },
    chatHistory: () => new Promise((resolve) => { releases.push(() => resolve({ ok: true, messages: [], has_more: false })); }),
  } });
  t.after(h.restore);
  h.window.jennyShell.dialog = { saveFile: () => new Promise((resolve) => { saveRelease = () => resolve({ canceled: false, path: 'D:\\Lab.md' }); }) };
  const exporter = globalThis.rendererTeamExport.getExporter();
  await flush();
  h.click('[data-team-action="leave"]');
  h.click('[data-team-action="leave-export"]');
  await flush();
  assert.equal(exporter.state().phase, 'gathering');
  h.click('[data-team-action="confirm-cancel"]');
  assert.equal(exporter.state().phase, 'idle', 'Cancel on the confirmation stops the export');
  releases.splice(0).forEach((fn) => fn());
  await flush();
  assert.equal(exporter.state().phase, 'idle', 'a late answer opens no dialog');
  h.click('[data-team-action="leave"]');
  h.click('[data-team-action="leave-export"]');
  await flush();
  h.section.leaveTeamSection();
  assert.equal(exporter.state().phase, 'idle', 'leaving the page stops it too');
  h.section.showTeamSection({ container: h.container });
  await flush();
  h.click('[data-team-action="leave"]');
  h.click('[data-team-action="leave-export"]');
  await flush();
  releases.splice(0).forEach((fn) => fn());
  await flush();
  assert.equal(exporter.state().phase, 'saving');
  h.click('[data-team-action="confirm-cancel"]');
  assert.equal(exporter.state().phase, 'saving', 'at the dialog it is left to finish');
  saveRelease();
  await flush();
  assert.equal(exporter.state().phase, 'done');
});

// Fix list item 21.
test('item 21: offline, Leave is enabled and sends; the export button is greyed out with the reason', async (t) => {
  const h = harness({ teams: [lab({ state: 'offline' })], answers: { leave: { ok: true } } });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="leave"]');
  assert.match(h.text(), /Lab is offline, so its messages cannot be exported now\./);
  assert.deepEqual([h.q('[data-team-action="leave-export"]').disabled, h.q('[data-team-action="confirm-leave"]').disabled], [true, false]);
  h.click('[data-team-action="confirm-leave"]');
  await flush();
  assert.deepEqual(h.sent('leave').map((c) => c.payload), [{ team_id: OTHER }]);
});

test('item 21: "Cancel the export" stops it, saves nothing and gives Leave back; Leave after a cancelled and after a failed export sends', async (t) => {
  const releases = [];
  const saves = [];
  let history = () => new Promise((resolve) => { releases.push(() => resolve({ ok: true, messages: [], has_more: false })); });
  const h = harness({ answers: { chatOverview: OVERVIEW, chatHistory: () => history(), leave: { ok: true } } });
  t.after(h.restore);
  h.window.jennyShell.dialog = { saveFile: async (payload) => { saves.push(payload); return { canceled: false, path: 'D:\\Lab.md' }; } };
  const exporter = globalThis.rendererTeamExport.getExporter();
  await flush();
  h.click('[data-team-action="leave"]');
  h.click('[data-team-action="leave-export"]');
  await flush();
  assert.equal(h.q('[data-team-action="confirm-leave"]').disabled, true);
  h.click('[data-team-action="leave-export-cancel"]');
  await flush();
  releases.splice(0).forEach((fn) => fn());
  await flush();
  assert.deepEqual([exporter.state().phase, saves.length, h.q('[data-team-action="confirm-leave"]').disabled], ['idle', 0, false], 'cancelled: nothing saved, Leave back');
  assert.equal(h.q('[data-team-action="leave-export"]').disabled, false, 'the export can be asked again');
  history = () => ({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_chat_not_found' } });
  h.click('[data-team-action="leave-export"]');
  await flush();
  assert.equal(exporter.state().phase, 'failed');
  assert.match(h.text(), /Export failed\. Try again\./);
  assert.equal(h.q('[data-team-action="confirm-leave"]').disabled, false, 'a failed export never blocks Leave');
  h.click('[data-team-action="confirm-leave"]');
  await flush();
  assert.deepEqual([h.sent('leave').map((c) => c.payload), saves.length], [[{ team_id: OTHER }], 0]);
  exporter.dismiss();
});
