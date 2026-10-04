'use strict';

/**
 * tests/renderer-stuck-send.test.js
 *
 * HB-009 (po-review approved 2026-09-28): a send the runtime accepted but
 * cannot start says why. The runtime projects `admission_wait` on pending work;
 * the durable-send controller shows it once past its grace (2 s for another
 * chat's reply, 5 s for unconfirmed cleanup), the composer strip names the
 * reason and the one action that helps, and only the unconfirmed-cleanup case
 * reaches the Needs-you inbox. Restart engine asks first only when it would
 * stop a reply running in another chat.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { GRACE_MS, visibleWait, restartEngine } = require('../renderer/chat/renderer-stuck-send');
const { renderRuntimeQueue } = require('../renderer/chat/renderer-runtime-queue-view');
const { buildAttentionInbox } = require('../renderer/shell/renderer-attention-inbox-model');
const { createAttentionInboxController } = require('../renderer/shell/renderer-attention-inbox');
const inventoryActionButton = require('../renderer/inventory/action-button');
const { summary, queueHarness } = require('./helpers/durable-send-queue-harness');

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const wait = (reason, sinceMs, blocking = 'session-2') => ({ reason, since: ago(sinceMs), blocking_session_id: blocking });

test('a wait shows only for pending work, past its reason\'s grace', () => {
  const at = (reason, elapsed) => visibleWait({ reason, since: new Date(NOW - elapsed).toISOString(), blocking_session_id: 's2' }, 'pending', NOW);
  assert.equal(at('model_busy', GRACE_MS.model_busy - 1), null, 'a quick hand-off never flashes a row');
  assert.deepEqual({ ...at('model_busy', GRACE_MS.model_busy) }, { reason: 'model_busy', blockingSessionId: 's2' });
  assert.equal(at('cleanup_unconfirmed', 4999), null, 'unconfirmed cleanup waits out the runtime\'s own grace');
  assert.equal(at('cleanup_unconfirmed', 5000).reason, 'cleanup_unconfirmed');
  assert.equal(at('session_busy', 60000), null, 'the chat\'s own reply running is the existing queue');
  assert.equal(visibleWait({ reason: 'model_busy', since: new Date(NOW - 9000).toISOString() }, 'paused', NOW), null);
  assert.equal(visibleWait({ reason: 'model_busy', since: 'not a time' }, 'pending', NOW), null);
  assert.equal(visibleWait(null, 'pending', NOW), null);
});

function confirmStub(t, answer) {
  const asked = [];
  const previous = [globalThis.rendererIdeConfirmDialog, globalThis.inventoryHelpOverlay];
  globalThis.rendererIdeConfirmDialog = { createIdeConfirmDialog: () => ({
    confirm: (config) => { asked.push(config); return Promise.resolve(answer); }, dispose() {} }) };
  globalThis.inventoryHelpOverlay = { createHelpOverlay: () => ({}) };
  t.after(() => { [globalThis.rendererIdeConfirmDialog, globalThis.inventoryHelpOverlay] = previous; });
  return asked;
}

function restartHarness(retryStart = async () => ({ ok: true }), { lifecycle = new Map(), isClosed } = {}) {
  const calls = { restarts: 0, notices: [] };
  const shell = { backend: { retryStart: async () => { calls.restarts += 1; return retryStart(); } } };
  const notices = { set: (text, options) => calls.notices.push([text, options.tone]), clear: () => calls.notices.push(['', 'cleared']) };
  const state = { sessions: [{ id: 's1', title: 'Budget' }, { id: 's2', title: 'Travel plans' }],
    ui: { chatSendLifecycleBySession: lifecycle } };
  return { calls, run: (streaming) => restartEngine({ state, shell, sessionId: 's1', streamingSessionIds: streaming, notices, isClosed }) };
}

test('Restart engine restarts at once when nothing else is replying', async (t) => {
  const asked = confirmStub(t, false);
  const { calls, run } = restartHarness();
  assert.equal(await run(['s1']), true, 'the waiting chat\'s own stuck turn is what the restart frees');
  assert.equal(asked.length, 0);
  assert.equal(calls.restarts, 1);
  assert.deepEqual(calls.notices.map(([, tone]) => tone), ['pending', 'cleared']);
});

test('Restart engine asks first when it would stop a reply in another chat, and a Cancel restarts nothing', async (t) => {
  const asked = confirmStub(t, false);
  const { calls, run } = restartHarness();
  assert.equal(await run(['s2']), false);
  assert.equal(calls.restarts, 0);
  assert.equal(asked[0].title, 'Restart the engine?');
  assert.equal(asked[0].message, 'The reply running in "Travel plans" will stop too. Your waiting message starts after the restart.');
  assert.deepEqual([asked[0].confirmLabel, asked[0].cancelLabel, asked[0].variant], ['Restart engine', 'Cancel', 'danger']);
});

test('a confirmed restart runs, and a failed one says so in the composer', async (t) => {
  confirmStub(t, true);
  const ok = restartHarness();
  assert.equal(await ok.run(['s2']), true);
  assert.equal(ok.calls.restarts, 1);
  const failing = restartHarness(async () => { throw new Error('sidecar did not start'); });
  assert.equal(await failing.run([]), false);
  assert.deepEqual(failing.calls.notices.at(-1), ['Could not restart the engine: sidecar did not start', 'warning']);
  const notReady = restartHarness(async () => ({ phase: 'failed' }));
  assert.equal(await notReady.run([]), false, 'a start that did not come up is not a restart');
  assert.deepEqual(notReady.calls.notices.at(-1), ['Could not restart the engine: failed', 'warning']);
});

test('a reply the stream index missed but the send lifecycle calls streaming still asks first', async (t) => {
  const asked = confirmStub(t, false);
  const { calls, run } = restartHarness(undefined, { lifecycle: new Map([['s2', 'streaming'], ['s1', 'streaming']]) });
  assert.equal(await run([]), false);
  assert.equal(asked.length, 1);
  assert.equal(calls.restarts, 0);
});

test('a window closed while the dialog was open restarts nothing', async (t) => {
  confirmStub(t, true);
  let closed = false;
  const { calls, run } = restartHarness(undefined, { isClosed: () => closed });
  const running = run(['s2']);
  closed = true;
  assert.equal(await running, false);
  assert.equal(calls.restarts, 0);
  assert.deepEqual(calls.notices, []);
});

test('with no dialog to ask with, a restart that would stop another reply does not run', async (t) => {
  const previous = globalThis.rendererIdeConfirmDialog;
  globalThis.rendererIdeConfirmDialog = undefined;
  t.after(() => { globalThis.rendererIdeConfirmDialog = previous; });
  const { calls, run } = restartHarness();
  assert.equal(await run(['s2']), false);
  assert.equal(calls.restarts, 0);
});

/* ── The durable-send controller: the runtime's reason reaches the strip ── */

test('a direct Send held by unconfirmed cleanup joins the strip past its grace and lists as stuck', async (t) => {
  let admission = wait('cleanup_unconfirmed', 1000, 'session-1');
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, next_cursor: null,
    work: [summary(1, { admission_wait: admission })] }) });
  const controller = h.state.runtimeSendController;
  await h.controller.startPromptSend('reconcile March');
  await controller.refreshPending();
  let [row] = controller.listPending('session-1');
  assert.deepEqual([row.queued, row.wait], [false, null], 'inside the grace it is still a plain direct send');
  assert.deepEqual(controller.listStuckSends(), []);
  const painted = h.calls.renderSessions;
  admission = wait('cleanup_unconfirmed', 6000, 'session-1');
  await controller.refreshPending();
  [row] = controller.listPending('session-1');
  assert.equal(row.queued, true);
  assert.deepEqual({ ...row.wait }, { reason: 'cleanup_unconfirmed', blockingSessionId: 'session-1' });
  assert.ok(h.calls.renderSessions > painted, 'crossing the grace repaints the strip and the inbox');
  assert.deepEqual(controller.listStuckSends().map((entry) => [entry.sessionId, entry.workId]), [['session-1', 'work_1']]);
});

test('a wait behind another chat names that chat and is not the inbox\'s business', async (t) => {
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, next_cursor: null,
    work: [summary(1, { admission_wait: wait('model_busy', 3000, 'session-2') })] }) });
  const controller = h.state.runtimeSendController;
  await h.controller.startPromptSend('draft the memo');
  await controller.refreshPending();
  const [row] = controller.listPending('session-1');
  assert.equal(row.queued, true);
  assert.deepEqual({ ...row.wait }, { reason: 'model_busy', blockingSessionId: 'session-2' });
  assert.deepEqual(controller.listStuckSends(), []);
  controller.openChat('session-2');
  assert.deepEqual(h.calls.activations, ['session-2']);
});

test('a different chat taking over the model repaints the strip that names it', async (t) => {
  let blocking = 'session-2';
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, next_cursor: null,
    work: [summary(1, { admission_wait: { reason: 'model_busy', since: ago(3000), blocking_session_id: blocking } })] }) });
  await h.controller.startPromptSend('draft the memo');
  await h.state.runtimeSendController.refreshPending();
  const painted = h.calls.renderSessions;
  blocking = 'session-3';
  await h.state.runtimeSendController.refreshPending();
  assert.ok(h.calls.renderSessions > painted, 'same reason, new blocker: the title and Open that chat must follow');
  assert.equal(h.state.runtimeSendController.listPending('session-1')[0].wait.blockingSessionId, 'session-3');
});

test('a send parked in another conversation learns its wait from the per-work read', async (t) => {
  const { h } = queueHarness(t, { getWork: (payload) => ({ ok: true, work: { work_id: payload.work_id, session_id: 'session-1',
    turn_id: payload.work_id.replace('work_', 'turn_'), status: 'pending', revision: 2,
    admission_wait: wait('cleanup_unconfirmed', 8000, 'session-1') } }) });
  await h.controller.startPromptSend('elsewhere');
  h.state.currentSessionId = 'another-session';
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listStuckSends().map((entry) => entry.sessionId), ['session-1']);
});

test('the strip\'s Restart engine goes through the shell\'s sidecar restart', async (t) => {
  let restarts = 0;
  const { h } = queueHarness(t, { backend: { retryStart: async () => { restarts += 1; } },
    snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { admission_wait: wait('cleanup_unconfirmed', 6000, 'session-1') })] }) });
  await h.controller.startPromptSend('stuck');
  await h.state.runtimeSendController.refreshPending();
  const [row] = h.state.runtimeSendController.listPending('session-1');
  assert.equal(await h.state.runtimeSendController.restartEngine(row.key), true);
  assert.equal(restarts, 1);
  assert.deepEqual(h.calls.composerNotices.filter((notice) => notice.options.owner === 'runtime:restart-engine')
    .map((notice) => notice.options.cleared === true), [false, true], 'a pending notice, then cleared');
});

/* ── The strip ── */

const stripState = () => ({ currentSessionId: 's1', sessions: [{ id: 's1', title: 'Budget' }, { id: 's2', title: 'Travel plans' }] });
const stripRow = (overrides = {}) => ({ key: 'durable_1', workId: 'work_1', turnId: 'turn_1', prompt: 'Reconcile March',
  position: 1, status: 'pending', admitted: false, queued: true, ...overrides });

function strip(rows) {
  const dom = new JSDOM('<div id="runtimeQueue" hidden></div>');
  const host = dom.window.document.getElementById('runtimeQueue');
  const acted = [];
  const actions = { withdraw: (row) => acted.push(['withdraw', row.key]), resume() {},
    restartEngine: (row) => acted.push(['restart', row.key]), openChat: (row) => acted.push(['open', row.wait.blockingSessionId]) };
  renderRuntimeQueue({ state: stripState(), host, rows, actions });
  const texts = (selector) => [...host.querySelectorAll(selector)].map((node) => node.textContent);
  return { dom, host, acted, texts };
}

test('the strip says a stuck send is waiting, why, and offers Restart engine and Withdraw', () => {
  const { dom, host, acted, texts } = strip([stripRow({ wait: { reason: 'cleanup_unconfirmed', blockingSessionId: 's1' } })]);
  assert.deepEqual(texts('.runtime-queue__summary'), ['Not started']);
  assert.deepEqual(texts('.runtime-queue__position'), ['Waiting']);
  assert.deepEqual(texts('.runtime-queue__status'),
    ["The last reply's cleanup hasn't been confirmed, so nothing new can start on this model."]);
  assert.ok(host.querySelector('.runtime-queue__row--stuck'), 'the warning tone hangs off the stuck row');
  assert.deepEqual(texts('.runtime-queue__action').slice(1), ['Restart engine', 'Withdraw']);
  host.querySelector('.runtime-queue__action--restart').click();
  host.querySelector('.runtime-queue__action--withdraw').click();
  assert.deepEqual(acted, [['restart', 'durable_1'], ['withdraw', 'durable_1']]);
  dom.window.close();
});

test('a send behind another chat keeps its place label, names that chat calmly and offers to open it', () => {
  const { dom, host, acted, texts } = strip([stripRow({ wait: { reason: 'model_busy', blockingSessionId: 's2' } })]);
  assert.deepEqual(texts('.runtime-queue__position'), ['Runs next']);
  assert.deepEqual(texts('.runtime-queue__status'), ['Starts when "Travel plans" finishes its reply on this model.']);
  assert.equal(host.querySelector('.runtime-queue__row--stuck'), null);
  host.querySelector('.runtime-queue__action--open').click();
  assert.deepEqual(acted, [['open', 's2']]);
  dom.window.close();
});

test('a waiting send among queued messages keeps the queued count', () => {
  const { dom, texts } = strip([stripRow({ wait: { reason: 'model_busy', blockingSessionId: 's2' } }),
    stripRow({ key: 'durable_2', workId: 'work_2', position: 2, prompt: 'Then this' })]);
  assert.deepEqual(texts('.runtime-queue__summary'), ['2 queued']);
  dom.window.close();
});

/* ── Needs you ── */

test('the inbox lists a stuck send only for a listed conversation, after every other kind', () => {
  const inbox = buildAttentionInbox({
    sessions: [{ id: 's1', title: 'Budget', pending_question_batch: { batch_id: 'b1', questions: [{ id: 'q' }] } }, { id: 's2', title: '' }],
    stuckSends: [{ key: 'durable_2', sessionId: 's2' }, { key: 'durable_1', sessionId: 's1' }, { key: 'durable_9', sessionId: 'gone' }],
  });
  assert.deepEqual(inbox.rows.map((row) => [row.kind, row.sessionTitle]),
    [['question', 'Budget'], ['stuck_send', 'Untitled chat'], ['stuck_send', 'Budget']]);
  assert.deepEqual({ ...inbox.counts }, { approvals: 0, planReviews: 0, questions: 1, stuckSends: 2, answerable: 3 });
});

test('the inbox row opens the conversation or restarts the engine for it', async () => {
  const dom = new JSDOM('<div id="slot"></div><div id="attentionInbox" hidden></div>', { url: 'https://jenny.local/' });
  const opened = [];
  const restarted = [];
  let finishRestart;
  const state = { currentSessionId: '', sessions: [{ id: 's1', title: 'Budget' }], pendingToolApprovals: new Map(),
    runtimeSendController: { listStuckSends: () => [{ key: 'durable_1', workId: 'work_1', sessionId: 's1' }],
      restartEngine: (sessionId) => { restarted.push(sessionId); return new Promise((resolve) => { finishRestart = resolve; }); } } };
  const controller = createAttentionInboxController({ windowRef: dom.window, documentRef: dom.window.document, state,
    host: dom.window.document.getElementById('attentionInbox'), badgeAnchor: dom.window.document.getElementById('slot'),
    actionButton: inventoryActionButton, callbacks: { openSession: (id) => opened.push(id) } });
  controller.render();
  const row = dom.window.document.querySelector('.attention-inbox__row--stuck_send');
  assert.equal(row.querySelector('.attention-inbox__note').textContent, "Message waiting to start · last reply's cleanup unconfirmed");
  assert.equal(row.querySelector('.attention-inbox__session').textContent, 'Budget');
  row.querySelector('[data-attention-action="open"]').click();
  row.querySelector('[data-attention-action="restart"]').click();
  assert.deepEqual([opened, restarted], [['s1'], ['s1']]);
  const restart = () => dom.window.document.querySelector('[data-attention-action="restart"]');
  assert.equal(restart().disabled, true, 'a restart in flight cannot be pressed twice');
  finishRestart(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restart().disabled, false, 'the row stays until the message starts; only the runtime retires it');
  controller.dispose();
  dom.window.close();
});
