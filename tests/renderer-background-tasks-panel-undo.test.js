'use strict';
// new-test-file: renderer-background-tasks-panel.test.js is at the 600-line ceiling

/* Row 195 (change C10): Clear in the Background tasks panel says what it does and can be undone. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const rr = require('../renderer/features/renderer-background-tasks-panel-render.js');
const owner = require('../renderer/features/renderer-background-tasks-panel.js');

const NOW = 1_800_000_000_000;
const flush = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const job = (jobId, state, extra = {}) => ({ jobId, sessionId: 's1', command: `cmd ${jobId}`, state, exitCode: 0, stopRequested: false,
  startedAtMs: NOW - 72_000, endedAtMs: NOW - 60_000, progress: null, ...extra });
const JOBS = [
  job('aaaaaaaaaaaa', 'running', { exitCode: null, endedAtMs: 0 }),
  job('dddddddddddd', 'completed'),
  job('eeeeeeeeeeee', 'failed', { exitCode: 1 }),
];

function harness({ clear = true, restore = true, cleared = ['dddddddddddd', 'eeeeeeeeeeee'], restoreResult = { ok: true, restored: 2 } } = {}) {
  const dom = new JSDOM('<body><div id="artifactReviewPanel" class="artifact-review-panel"><div id="host"></div></div></body>', { pretendToBeVisual: true });
  const win = dom.window;
  const panelEl = win.document.getElementById('artifactReviewPanel');
  const state = { currentSessionId: 's1', ui: { artifactReview: { mode: 'artifact', enabled: false } } };
  const calls = { clear: [], restore: [] };
  let hidden = [];
  win.jennyShell = {
    backgroundJobs: {
      getState: async () => ({ jobs: JOBS.filter((entry) => !hidden.includes(entry.jobId)) }),
      onChanged: () => () => {},
      ...(clear ? { clearFinished: async (sessionId) => { calls.clear.push(sessionId); hidden = cleared.slice(); return { ok: true, cleared: cleared.length, jobIds: cleared }; } } : {}),
      ...(restore ? { restoreFinished: async (sessionId, ids) => {
        calls.restore.push([sessionId, ids]);
        if (restoreResult instanceof Error) throw restoreResult;
        if (restoreResult.ok) hidden = [];
        return restoreResult;
      } } : {}),
    },
    chatWorkspace: { getSummary: async (request) => ({ ok: true, summary: { session_id: request.session_id, background_tasks: { state: 'available', data: { items: [] } } } }) },
  };
  const surface = { previewContent: win.document.getElementById('host') };
  let panel = null;
  panel = owner.createBackgroundTasksPanel({
    state, windowRef: win, dom: { artifactReviewPanel: panelEl },
    openArtifactRail: (mode) => Object.assign(state.ui.artifactReview, { mode, enabled: true }),
    renderArtifactReviewPanel: () => { if (state.ui.artifactReview.enabled) panel.renderRailContent(surface); },
    toggleArtifactReview: () => { state.ui.artifactReview.enabled = false; },
    claimOwner: () => {}, getPanelSessionId: () => state.currentSessionId, openSession: () => {},
    setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {}, now: () => NOW,
  });
  panel.bind();
  return { win, doc: win.document, panelEl, state, calls, panel, surface, unhide: () => { hidden = []; }, $: (selector) => panelEl.querySelector(selector), close: () => { panel.dispose(); win.close(); } };
}

test('render: Clear carries its title and the undo line shows the count, one or many, only when asked', () => {
  const tasks = rr.buildTasks({ jobs: JOBS, sessionId: 's1' });
  const doc = (undoCount) => new JSDOM(`<body>${rr.listHtml({ tasks, filter: 'all', foldOpen: true, clearable: true, undoCount })}</body>`).window.document;
  assert.equal(doc(0).querySelector('[data-bgt-clear]').getAttribute('title'), 'Clear finished runs from this list. You can undo it.');
  assert.equal(doc(0).querySelector('[data-bgt-clear]').getAttribute('aria-label'), 'Clear finished commands');
  assert.equal(doc(0).querySelector('.background-tasks-undo'), null);
  const many = doc(3).querySelector('.background-tasks-undo');
  assert.equal(many.getAttribute('role'), 'status');
  assert.equal(many.querySelector('span').textContent, '3 finished runs cleared from this list.');
  assert.equal(many.querySelector('[data-bgt-undo]').textContent, 'Undo');
  assert.match(many.querySelector('[data-bgt-undo]').className, /btn--ghost btn--sm/);
  assert.equal(many.previousElementSibling.className, 'background-tasks-list', 'directly under the list');
  assert.equal(doc(1).querySelector('.background-tasks-undo span').textContent, '1 finished run cleared from this list.');
  const empty = new JSDOM(`<body>${rr.listHtml({ tasks: [], filter: 'all', foldOpen: true, clearable: true, undoCount: 2 })}</body>`).window.document;
  assert.ok(empty.querySelector('.background-tasks-undo'), 'the line survives an emptied list');
});

test('owner: Clear shows the line, Undo restores the rows, removes the line and focuses the fold', async () => {
  const h = harness();
  await h.panel.open({ sessionId: 's1' });
  assert.equal(h.$('.background-tasks-undo'), null, 'no line before a Clear');
  h.$('[data-bgt-clear]').click();
  await flush();
  assert.equal(h.$('[data-bgt-open="job:dddddddddddd"]'), null);
  assert.equal(h.$('.background-tasks-undo span').textContent, '2 finished runs cleared from this list.');
  h.$('[data-bgt-undo]').click();
  await flush();
  assert.deepEqual(h.calls.restore, [['s1', ['dddddddddddd', 'eeeeeeeeeeee']]]);
  assert.ok(h.$('[data-bgt-open="job:dddddddddddd"]') && h.$('[data-bgt-open="job:eeeeeeeeeeee"]'), 'the rows are back');
  assert.equal(h.$('.background-tasks-undo'), null);
  assert.equal(h.doc.activeElement, h.$('[data-bgt-fold]'));
  h.close();
});

test('owner: a failed or throwing Undo leaves the line and throws nothing', async () => {
  for (const restoreResult of [{ ok: false, reason: 'unavailable' }, new Error('boom')]) {
    const h = harness({ restoreResult });
    await h.panel.open({ sessionId: 's1' });
    h.$('[data-bgt-clear]').click();
    await flush();
    h.$('[data-bgt-undo]').click();
    await flush();
    assert.equal(h.calls.restore.length, 1);
    assert.ok(h.$('.background-tasks-undo'), 'the line stays');
    assert.equal(h.$('[data-bgt-open="job:dddddddddddd"]'), null);
    h.close();
  }
});

test('owner: no line when nothing was cleared or the method is missing; a close or another chat removes it', async () => {
  const none = harness({ cleared: [] });
  await none.panel.open({ sessionId: 's1' });
  none.$('[data-bgt-clear]').click();
  await flush();
  assert.equal(none.$('.background-tasks-undo'), null, 'nothing cleared: no line');
  none.close();

  const old = harness({ restore: false });
  await old.panel.open({ sessionId: 's1' });
  old.$('[data-bgt-clear]').click();
  await flush();
  assert.equal(old.$('.background-tasks-undo'), null, 'no restoreFinished: no line');
  assert.equal(old.$('[data-bgt-open="job:dddddddddddd"]'), null, 'Clear itself still works');
  old.close();

  const h = harness();
  await h.panel.open({ sessionId: 's1' });
  h.$('[data-bgt-clear]').click();
  await flush();
  assert.ok(h.$('.background-tasks-undo'));
  assert.equal(h.panel.close(), true);
  await h.panel.open({ sessionId: 's1' });
  assert.equal(h.$('.background-tasks-undo'), null, 'a closed panel forgets the line');

  h.unhide();
  await h.panel.open({ sessionId: 's1' });
  h.$('[data-bgt-clear]').click();
  await flush();
  assert.ok(h.$('.background-tasks-undo'));
  h.state.currentSessionId = 's2';
  h.panel.renderRailContent(h.surface);
  assert.equal(h.$('.background-tasks-undo'), null, 'rebound to another chat');
  h.close();
});
