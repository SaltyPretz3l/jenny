'use strict';

// Dogfood HB-034 F5 (Direction A): a reply that paused by itself behind another
// chat's command says so on its live activity row instead of "Still at it…".
// The line lives in renderer-stream-waiting-line.js; the row hosts it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createStreamActivityRow,
  ACTIVITY_COPY,
  ACTIVITY_COPY_LONG,
} = require('../renderer/chat/renderer-stream-activity-row');

function makeHarness(t, { overrides = {} } = {}) {
  const dom = new JSDOM('<div id="chatTimeline"><article class="chat-entry assistant pending">'
    + '<div class="chat-message-content"><div class="chat-row">hi</div></div></article></div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const flags = { live: true, visible: true, blocking: false };
  const clock = { nowMs: 0 };
  const row = createStreamActivityRow({
    getChatTimeline: () => timeline,
    isStreamLive: () => flags.live,
    isSessionVisible: () => flags.visible,
    hasBlockingToolState: () => flags.blocking,
    now: () => clock.nowMs,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    pickCopyIndex: () => 0,
    ...overrides,
  });
  t.after(() => {
    row.dispose();
    dom.window.close();
  });
  return { timeline, flags, clock, row };
}

const findRow = (timeline) => timeline.querySelector('.turn-activity-row');

function noteEvent(row, type, extra = {}) {
  row.noteStreamEvent({ type, streamId: 'stream-1', sessionId: 'session-1', ...extra });
}

function makeWaitHarness(t, overrides = {}) {
  const calls = { opened: [], restarted: [] };
  const titles = { 'session-a': 'G5 fix attempt 4' };
  const harness = makeHarness(t, { overrides: {
    getSessionTitle: (sessionId) => titles[sessionId] || '',
    onOpenChat: (sessionId) => calls.opened.push(sessionId),
    onRestartEngine: (sessionId) => calls.restarted.push(sessionId),
    ...overrides,
  } });
  return { ...harness, calls, titles };
}

function noteWaiting(row, extra = {}) {
  noteEvent(row, 'runtime_waiting', { workId: 'work-1', waitState: 'waiting', resourceClass: 'filesystem',
    blockingSessionId: 'session-a', ...extra });
}

const rowText = (timeline) => findRow(timeline).querySelector('.turn-activity-label').textContent.replace(/\\s+/g, ' ').trim();

test('a waiting reply names the chat in the way, at once, and never says still at it', (t) => {
  const { timeline, clock, row, calls } = makeWaitHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 200;
  noteWaiting(row);
  const node = findRow(timeline);
  assert.ok(node, 'no silence threshold: the wait is known, not guessed');
  assert.equal(node.getAttribute('data-turn-activity-kind'), 'waiting');
  assert.equal(rowText(timeline), 'Waiting for "G5 fix attempt 4" to finish a command in this folder. Continues on its own.');

  const link = node.querySelector('.turn-activity-wait-link');
  assert.equal(link.tagName, 'BUTTON');
  assert.equal(link.textContent, 'G5 fix attempt 4');
  link.click();
  assert.deepEqual(calls.opened, ['session-a']);

  // Long past the generic escalation: the line does not degrade, and it keeps one node.
  clock.nowMs = 200 + 5 * 60 * 1000;
  row.tick();
  assert.equal(findRow(timeline), node);
  assert.equal(node.querySelector('.turn-activity-wait-link'), link, 'an unchanged wait is not rebuilt on a tick');
  assert.ok(!rowText(timeline).includes(ACTIVITY_COPY_LONG));
  const elapsed = node.querySelector('.turn-activity-elapsed');
  assert.equal(elapsed.textContent, '5:00');
  assert.equal(elapsed.getAttribute('data-elapsed-started-at'), '200');
  assert.equal(row.isWaitingStream('stream-1'), true);
  assert.equal(row.isWaitingWork('work-1'), true);
});

test('a waiting line survives a tool row that still reads running', (t) => {
  const { timeline, flags, row } = makeWaitHarness(t);
  flags.blocking = true;
  noteWaiting(row);
  assert.ok(findRow(timeline), 'the tool that waits has not started; its row must not hide why');
});

test('a wait without a known chat falls back to plain words and no link', (t) => {
  const { timeline, row } = makeWaitHarness(t);
  noteWaiting(row, { blockingSessionId: 'session-unknown' });
  assert.equal(rowText(timeline), 'Waiting for another chat to finish a command in this folder. Continues on its own.');
  assert.equal(findRow(timeline).querySelector('.turn-activity-wait-link'), null);

  noteWaiting(row, { blockingSessionId: '', resourceClass: 'tests' });
  assert.equal(rowText(timeline), 'Waiting for other work to finish. Continues on its own.');
});

test('a wait behind a stopped command that never confirmed reads as stuck and offers the restart', (t) => {
  const { timeline, row, calls } = makeWaitHarness(t);
  noteWaiting(row);
  noteWaiting(row, { waitState: 'stuck', blockingSessionId: '' });
  const node = findRow(timeline);
  assert.equal(node.getAttribute('data-turn-activity-kind'), 'waiting-stuck');
  assert.ok(rowText(timeline).startsWith('Waiting on a stopped command that never confirmed it ended.'));
  assert.ok(!rowText(timeline).includes('Continues on its own'));
  const restart = node.querySelector('.turn-activity-wait-action');
  assert.equal(restart.textContent.trim(), 'Restart engine');
  restart.click();
  assert.deepEqual(calls.restarted, ['session-1']);
  assert.equal(row.isWaitingStream('stream-1'), true);
});

test('the resumed reply arrives on a new stream and takes the waiting line away', (t) => {
  const { timeline, row } = makeWaitHarness(t);
  noteWaiting(row);
  assert.ok(findRow(timeline));
  row.noteStreamEvent({ type: 'started', streamId: 'stream-2', sessionId: 'session-1' });
  assert.equal(findRow(timeline), null);
  assert.equal(row.isWaitingStream('stream-1'), false);
  assert.equal(row.isWaitingWork('work-1'), false);

  // Another chat's start never ends this chat's wait.
  noteWaiting(row);
  row.noteStreamEvent({ type: 'started', streamId: 'stream-9', sessionId: 'session-other' });
  assert.ok(findRow(timeline));
});

test('a wait that ended without a resume leaves no line and never falls back to the busy copy', (t) => {
  const { timeline, clock, row } = makeWaitHarness(t);
  noteEvent(row, 'delta');
  noteWaiting(row);
  noteWaiting(row, { waitState: 'ended', blockingSessionId: '' });
  assert.equal(findRow(timeline), null);
  assert.equal(row.isWaitingStream('stream-1'), false);
  assert.equal(row.isWaitingWork('work-1'), false);
  clock.nowMs = 10 * 60 * 1000;
  row.tick();
  assert.equal(findRow(timeline), null, 'a paused reply is not "Still at it…"');
});

test('stopping a waiting reply clears the line with the stream', (t) => {
  const { timeline, row } = makeWaitHarness(t);
  noteWaiting(row);
  noteEvent(row, 'error');
  assert.equal(findRow(timeline), null);
  assert.equal(row.isWaitingStream('stream-1'), false);
});

test('a generic row that takes over a waiting node carries none of its parts', (t) => {
  const { timeline, clock, row } = makeWaitHarness(t);
  noteWaiting(row);
  const node = findRow(timeline);
  // Defensive: the same node re-used for untyped silence must be plain text again.
  noteEvent(row, 'delta');
  clock.nowMs = 5000;
  row.tick();
  const again = findRow(timeline);
  assert.ok(again);
  assert.equal(again.getAttribute('data-turn-activity-kind'), 'generic');
  assert.equal(again.querySelector('.turn-activity-wait-link'), null);
  assert.equal(again.querySelector('.turn-activity-label').textContent, ACTIVITY_COPY[0]);
  assert.ok(node);
});

// Main reports a wait once and never repeats an unchanged one, so the row's
// stream cap must not be what forgets it (Astra pass on B14).
test('other streams filling the cap do not evict a waiting reply', (t) => {
  const { row } = makeWaitHarness(t, { maxTrackedStreams: 3 });
  noteWaiting(row);
  for (let index = 2; index <= 6; index += 1) {
    row.noteStreamEvent({ type: 'delta', streamId: `stream-${index}`, sessionId: `session-${index}` });
  }
  assert.equal(row.isWaitingStream('stream-1'), true);
  assert.equal(row.isWaitingWork('work-1'), true);
});

// Row 100 P2 (owner pick B): a work-lease wait says who holds it in plain words, the command and the
// process on hover, and counts the chats waiting behind one of this app's background jobs.
function noteHolder(row, holder, extra = {}) {
  noteWaiting(row, { resourceClass: 'work', blockingSessionId: '', holderWhat: 'tests', holderCount: 1,
    holderJobIds: [], ...holder, ...extra });
}
const label = (timeline) => findRow(timeline).querySelector('.turn-activity-label');

test('row 100 P2: each holder kind reads in plain words, with the command and process on hover', (t) => {
  const { timeline, row, calls } = makeWaitHarness(t);
  noteHolder(row, { holderKind: 'chat', blockingSessionId: 'session-a', holderLabel: 'npm test', holderPid: 4242 });
  assert.equal(rowText(timeline), 'Waiting for "G5 fix attempt 4" to finish its tests. Continues on its own.');
  assert.equal(label(timeline).title, 'npm test · process 4242');
  findRow(timeline).querySelector('.turn-activity-wait-link').click();
  assert.deepEqual(calls.opened, ['session-a']);

  const cases = [
    [{ holderKind: 'chat', blockingSessionId: 'session-unknown', holderWhat: 'git_change' }, 'Waiting for another chat to finish a git change.'],
    [{ holderKind: 'jenny_window', holderWhat: 'install' }, 'Waiting for another Jenny window to finish an install.'],
    [{ holderKind: 'claude_code' }, 'Waiting for a Claude Code session to finish its tests.'],
    [{ holderKind: 'test_run', holderPid: 18244 }, 'Waiting for a test run outside Jenny to finish.'],
    [{ holderKind: 'git', holderWhat: 'git_change' }, 'Waiting for another git command in this repository to finish.'],
    [{ holderKind: 'chat', blockingSessionId: 'session-a', holderCount: 2 }, 'Waiting for "G5 fix attempt 4" and 1 more to finish.'],
    [{ holderKind: 'test_run', holderCount: 3 }, 'Waiting for 3 runs to finish.'],
    [{ holderKind: 'other' }, 'Waiting for other work to finish.'],
    [{ holderKind: 'jenny_window', holderWhat: '' }, 'Waiting for other work to finish.'],
  ];
  for (const [holder, sentence] of cases) {
    noteHolder(row, holder);
    assert.equal(rowText(timeline), `${sentence} Continues on its own.`, JSON.stringify(holder));
  }
  noteHolder(row, { holderKind: 'test_run', holderPid: 18244 });
  assert.equal(label(timeline).title, 'process 18244');
  noteWaiting(row);
  assert.equal(label(timeline).hasAttribute('title'), false, 'a folder wait carries no holder hover');
});

test('row 100 P2: waitersForJob lists the chats waiting behind a job, and only while they wait', (t) => {
  const { row } = makeWaitHarness(t);
  noteHolder(row, { holderKind: 'chat', blockingSessionId: 'session-a', holderJobIds: ['job-1'] });
  row.noteStreamEvent({ type: 'runtime_waiting', streamId: 'stream-2', sessionId: 'session-2', workId: 'work-2',
    waitState: 'waiting', resourceClass: 'work', holderKind: 'chat', holderJobIds: ['job-1', 'job-2'] });
  assert.deepEqual(row.waitersForJob('job-1'), ['session-1', 'session-2']);
  assert.deepEqual(row.waitersForJob('job-2'), ['session-2']);
  assert.deepEqual(row.waitersForJob(''), []);
  noteEvent(row, 'runtime_waiting', { workId: 'work-1', waitState: 'ended' });
  assert.deepEqual(row.waitersForJob('job-1'), ['session-2']);
});
