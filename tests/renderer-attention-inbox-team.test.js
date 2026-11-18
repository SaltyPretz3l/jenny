'use strict';

// new-test-file: Team rows in the Needs-you section are a new surface (row 175 F10, D16): the rows come from the
// Team notifier's accessor (renderer-team-notify.js), not from the chat sessions or the approval map the sibling
// view tests build, so they need their own stub of that accessor and a global that must be restored.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createAttentionInboxController } = require('../renderer/shell/renderer-attention-inbox');
const inventoryActionButton = require('../renderer/inventory/action-button');

const MARKUP = '<div class="workbench-health-pill-slot" id="workbenchHealthPillSlot"></div>'
  + '<div class="attention-inbox" id="attentionInbox" hidden></div>';
const S1 = 'sess_' + 'a'.repeat(32);
const S2 = 'sess_' + 'b'.repeat(32);
const waitingItem = (over = {}) => ({ kind: 'approval', unattended: false, teamId: 'team_one', projectId: 'project_p1', sessionId: S1,
  title: 'Palette loader cleanup', where: 'Palette', count: 1, onScreen: false, ...over });

// The Team notifier's accessor, as the notifier exposes it: `attention()` and `request()`.
function teamHarness({ waiting = [], sessions = [], onInboxRows } = {}) {
  const dom = new JSDOM(MARKUP, { url: 'https://jenny.local/' });
  const { window } = dom;
  const requests = [];
  const source = { waiting, notices: [] };
  const previous = globalThis.rendererTeamNotify;
  globalThis.rendererTeamNotify = {
    attention: () => ({ key: JSON.stringify(source.waiting), waiting: source.waiting, notices: source.notices }),
    request: (intent) => { requests.push(intent); return true; },
  };
  const openCalls = [];
  const rows = [];
  const state = { currentSessionId: '', sessions, pendingToolApprovals: new Map(), ui: { activeView: 'chat' } };
  const controller = createAttentionInboxController({
    windowRef: window, documentRef: window.document, state, host: window.document.getElementById('attentionInbox'),
    badgeAnchor: window.document.getElementById('workbenchHealthPillSlot'), actionButton: inventoryActionButton,
    callbacks: { openSession: (id) => openCalls.push(id) },
    onInboxRows: (list) => { rows.push(...list); if (onInboxRows) onInboxRows(list); },
  });
  const restore = () => {
    controller.dispose();
    if (previous === undefined) delete globalThis.rendererTeamNotify; else globalThis.rendererTeamNotify = previous;
  };
  const rowEls = () => [...window.document.querySelectorAll('.attention-inbox__row')];
  return { window, controller, requests, openCalls, rows, source, state, restore, rowEls,
    badge: () => window.document.querySelector('.attention-inbox-badge__count') };
}

test('Team approval row in Needs you: the Team line, Open alone, and the row opens the conversation', (t) => {
  const h = teamHarness({ waiting: [waitingItem()] });
  t.after(h.restore);
  h.controller.render();
  const [row] = h.rowEls();
  assert.ok(row, 'the Team approval is a row');
  assert.equal(row.querySelector('.attention-inbox__open').textContent, 'Palette loader cleanup');
  assert.equal(row.querySelector('.attention-inbox__note').textContent, 'Team · Palette · Your turn');
  const labels = [...row.querySelectorAll('.attention-inbox__action')].map((node) => node.textContent.trim());
  assert.deepEqual(labels, ['Open'], 'no Allow, Always allow or Deny on a Team row');
  row.querySelector('.attention-inbox__action').click();
  assert.deepEqual(h.requests, [{ kind: 'conversation', teamId: 'team_one', projectId: 'project_p1', sessionId: S1 }]);
  assert.deepEqual(h.openCalls, [], 'the local open callback never sees a Team conversation');
  h.requests.length = 0;
  row.querySelector('.attention-inbox__open').click();
  assert.equal(h.requests.length, 1, 'the title opens it too');
});

test('a Team question row says how many questions wait and offers Answer; an unattended one names nobody viewing', (t) => {
  const h = teamHarness({ waiting: [
    waitingItem({ kind: 'question', sessionId: S1, title: 'Plan the move' }),
    waitingItem({ kind: 'question', sessionId: S2, title: 'Many', count: 3 }),
    waitingItem({ kind: 'approval', unattended: true, sessionId: 'sess_' + 'c'.repeat(32), title: 'Files', where: 'Docs' }),
  ] });
  t.after(h.restore);
  h.controller.render();
  const lines = h.rowEls().map((row) => [row.querySelector('.attention-inbox__open').textContent, row.querySelector('.attention-inbox__note').textContent,
    [...row.querySelectorAll('.attention-inbox__action')].map((node) => node.textContent.trim()).join('+')]);
  assert.deepEqual(lines, [
    ['Files', 'Team · Docs · Nobody is viewing', 'Open'],
    ['Plan the move', 'Team · Palette · 1 question waiting', 'Answer'],
    ['Many', 'Team · Palette · 3 questions waiting', 'Answer'],
  ]);
});

test('a Team row for the conversation on screen drops its action and says so', (t) => {
  const h = teamHarness({ waiting: [waitingItem({ onScreen: true })] });
  t.after(h.restore);
  h.controller.render();
  const [row] = h.rowEls();
  assert.equal(row.querySelector('.attention-inbox__note').textContent, 'Waiting in the chat on screen');
  assert.equal(row.querySelectorAll('.attention-inbox__action').length, 0);
});

test('the badge counts Team rows with the local ones, and desktop notifications never see a Team row', (t) => {
  const h = teamHarness({
    waiting: [waitingItem(), waitingItem({ kind: 'question', sessionId: S2 })],
    sessions: [{ id: 'local1', title: 'Local chat', pending_question_batch: { batch_id: 'b1', questions: [{}] } }],
  });
  t.after(h.restore);
  h.controller.render();
  assert.equal(h.controller.getSnapshot().answerable, 3);
  assert.equal(h.badge().textContent, '3');
  assert.deepEqual(h.rows.map((row) => row.source || 'local'), ['local'], 'only the local row reaches the desktop notifier');
});

test('a Team row leaves when the accessor stops listing it (count to 0, team gone, Project activity off)', (t) => {
  const h = teamHarness({ waiting: [waitingItem()] });
  t.after(h.restore);
  h.controller.render();
  assert.equal(h.rowEls().length, 1);
  h.source.waiting = [];
  h.controller.render();
  assert.equal(h.rowEls().length, 0);
  assert.equal(h.controller.getSnapshot().answerable, 0);
});

test('a Team title and project name are text, never markup, and read in their own direction', (t) => {
  const h = teamHarness({ waiting: [waitingItem({ title: '<img src=x onerror=alert(1)>', where: '<b>Proj</b>' })] });
  t.after(h.restore);
  h.controller.render();
  const [row] = h.rowEls();
  assert.equal(row.querySelector('img, b'), null);
  assert.equal(row.querySelector('.attention-inbox__open').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(row.querySelector('.attention-inbox__note').textContent, 'Team · <b>Proj</b> · Your turn');
  assert.equal(row.getAttribute('dir'), 'auto');
});

test('a change the Team notifier announces redraws the section without a chrome pass', (t) => {
  const h = teamHarness();
  t.after(h.restore);
  h.controller.render();
  assert.equal(h.rowEls().length, 0);
  h.source.waiting = [waitingItem()];
  h.window.dispatchEvent(new h.window.Event('jenny:team-attention'));
  assert.equal(h.rowEls().length, 1);
});
