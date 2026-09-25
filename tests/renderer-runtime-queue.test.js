'use strict';

/**
 * tests/renderer-runtime-queue.test.js
 *
 * Runtime UX A1 (JEN-043) gate — the composer queue strip. The strip is the
 * only place the durable pending list becomes visible, so it owns the honesty
 * rules: a paused row shows Resume and never a position number, and a row
 * being withdrawn says so instead of claiming it is already gone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  disposeRuntimeQueueRender,
  renderRuntimeQueue,
} = require('../renderer/chat/renderer-runtime-queue-view');

function mount() {
  return new JSDOM('<div class="runtime-queue" id="runtimeQueue" hidden></div>');
}

function host(dom) {
  return dom.window.document.getElementById('runtimeQueue');
}

const state = () => ({ currentSessionId: 's1', sessions: [{ id: 's1', title: 'Destination' }] });

const row = (overrides = {}) => ({
  key: 'durable_1', workId: 'work_1', turnId: 'turn_1', prompt: 'First prompt',
  position: 1, status: 'pending', admitted: false, ...overrides,
});

test('the strip names each waiting message and its place in line', () => {
  const dom = mount();
  const node = host(dom);
  const rows = [row(), row({ key: 'durable_2', workId: 'work_2', prompt: 'Second prompt', position: 2 })];
  const count = renderRuntimeQueue({ state: state(), host: node, rows, actions: { withdraw() {}, resume() {} } });

  assert.equal(count, 2);
  assert.equal(node.hidden, false);
  assert.deepEqual([...node.querySelectorAll('.runtime-queue__position')].map((el) => el.textContent),
    ['Runs next', '#2 in line']);
  assert.deepEqual([...node.querySelectorAll('.runtime-queue__preview')].map((el) => el.textContent),
    ['First prompt', 'Second prompt']);
  assert.equal(node.querySelector('.runtime-queue__preview').getAttribute('title'), 'First prompt');
  assert.equal(node.querySelector('.runtime-queue__summary').getAttribute('role'), 'status');
  assert.match(node.querySelector('.runtime-queue__summary').textContent, /2 queued/);
  assert.match(node.querySelector('.runtime-queue__list').getAttribute('aria-label'), /Destination/);
  assert.equal(node.querySelector('.runtime-queue__list').getAttribute('role'), 'group');
  const ids = [...node.querySelectorAll('[id]')].map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length, 'every row control id is unique');
  assert.ok([...node.querySelectorAll('.runtime-queue__action--withdraw')]
    .every((button) => String(button.getAttribute('title') || '').trim().length > 0), 'withdraw carries a tooltip');
  dom.window.close();
});

test('withdraw hands the exact row back and locks while the withdrawal is in flight', () => {
  const dom = mount();
  const node = host(dom);
  const calls = [];
  const rows = [row(), row({ key: 'durable_2', workId: 'work_2', prompt: 'Second prompt', position: 2 })];
  const actions = { withdraw: (entry) => calls.push(entry), resume() {} };
  renderRuntimeQueue({ state: state(), host: node, rows, actions });
  node.querySelector('[data-runtime-work-key="durable_2"] .runtime-queue__action--withdraw').click();
  assert.deepEqual(calls, [rows[1]]);

  const withdrawing = [rows[0], { ...rows[1], status: 'withdrawing' }];
  renderRuntimeQueue({ state: state(), host: node, rows: withdrawing, actions });
  const second = node.querySelector('[data-runtime-work-key="durable_2"]');
  assert.equal(second.querySelector('.runtime-queue__action--withdraw').disabled, true);
  assert.match(second.querySelector('.runtime-queue__status').textContent, /Withdrawing/);

  const running = [{ ...rows[0], status: 'running', position: null }, rows[1]];
  renderRuntimeQueue({ state: state(), host: node, rows: running, actions });
  const first = node.querySelector('[data-runtime-work-key="durable_1"]');
  assert.equal(first.querySelector('.runtime-queue__action--withdraw').disabled, true);
  assert.match(first.querySelector('.runtime-queue__status').textContent, /Running/);
  dom.window.close();
});

test('a paused reply the composer never queued offers Discard and Resume with reply copy, and Discard reaches withdraw', () => {
  const dom = mount();
  const node = host(dom);
  const withdrawn = [];
  const detached = row({ key: 'work:work_7', workId: 'work_7', prompt: 'Paused reply', status: 'paused', position: null, admitted: true, detached: true });
  renderRuntimeQueue({ state: state(), host: node, rows: [detached], actions: { withdraw: (r) => withdrawn.push(r), resume() {} } });
  const discard = node.querySelector('.runtime-queue__action--withdraw');
  assert.equal(discard.textContent, 'Discard');
  assert.equal(discard.title, 'Discard this paused reply');
  assert.equal(discard.getAttribute('aria-label'), 'Discard this paused reply');
  assert.equal(discard.disabled, false);
  assert.equal(node.querySelector('.runtime-queue__action--resume').title, 'Resume this paused reply');
  discard.click();
  assert.deepEqual(withdrawn, [detached], 'Discard is the withdraw action on a detached row, never a silent no-op');
  renderRuntimeQueue({ state: state(), host: node, rows: [{ ...detached, status: 'withdrawing' }],
    actions: { withdraw: (r) => withdrawn.push(r), resume() {} } });
  assert.equal(node.querySelector('.runtime-queue__action--withdraw').disabled, true);
  assert.equal(node.querySelector('.runtime-queue__status').textContent, 'Withdrawing\u2026');
  dom.window.close();
});

test('a paused row offers Resume and never claims a position number', () => {
  const dom = mount();
  const node = host(dom);
  const resumed = [];
  const paused = row({ status: 'paused', position: null });
  renderRuntimeQueue({ state: state(), host: node, rows: [paused],
    actions: { withdraw() {}, resume: (entry) => resumed.push(entry) } });

  const marker = node.querySelector('.runtime-queue__position');
  assert.equal(/#\d|Runs next/.test(marker.textContent), false, 'no position number for paused work');
  assert.equal(marker.getAttribute('aria-hidden'), null, 'the place in line is read by assistive tech');
  // The snapshot row cannot say why work is paused, so the label claims no cause.
  assert.equal(node.querySelector('.runtime-queue__status').textContent, 'Paused');
  const resume = node.querySelector('.runtime-queue__action--resume');
  assert.ok(resume, 'paused work offers Resume');
  assert.equal(resume.disabled, false);
  resume.click();
  assert.deepEqual(resumed, [paused]);
  assert.equal(node.querySelector('.runtime-queue__action--withdraw').disabled, false);
  dom.window.close();
});

test('a send the runtime has not acknowledged yet cannot be withdrawn', () => {
  const dom = mount();
  const node = host(dom);
  const withdrawn = [];
  renderRuntimeQueue({ state: state(), host: node, rows: [row({ workId: '', position: null })],
    actions: { withdraw: (entry) => withdrawn.push(entry), resume() {} } });
  const withdraw = node.querySelector('.runtime-queue__action--withdraw');
  assert.equal(withdraw.disabled, true, 'no work_id means nothing exists to cancel yet');
  withdraw.click();
  assert.deepEqual(withdrawn, []);
  assert.equal(node.querySelector('.runtime-queue__position').textContent, 'Queued');
  dom.window.close();
});

test('a send the runtime never acknowledged reads as confirming and cannot be withdrawn', () => {
  const dom = mount();
  const node = host(dom);
  renderRuntimeQueue({ state: state(), host: node, rows: [row({ workId: '', status: 'unconfirmed', position: null })],
    actions: { withdraw() {}, resume() {} } });
  assert.equal(node.querySelector('.runtime-queue__status').textContent, 'Confirming\u2026');
  assert.equal(node.querySelector('.runtime-queue__action--withdraw').disabled, true);
  assert.equal(node.querySelector('.runtime-queue__position').textContent, 'Queued');
  dom.window.close();
});

test('an unnumbered queued row still reads as queued', () => {
  const dom = mount();
  const node = host(dom);
  renderRuntimeQueue({ state: state(), host: node, rows: [row({ position: null })],
    actions: { withdraw() {}, resume() {} } });
  assert.equal(node.querySelector('.runtime-queue__position').textContent, 'Queued');
  assert.equal(node.querySelector('.runtime-queue__status'), null, 'a plain pending row needs no status line');
  dom.window.close();
});

test('an empty queue hides the strip entirely', () => {
  const dom = mount();
  const node = host(dom);
  renderRuntimeQueue({ state: state(), host: node, rows: [row()], actions: { withdraw() {}, resume() {} } });
  assert.equal(node.hidden, false);
  assert.equal(renderRuntimeQueue({ state: state(), host: node, rows: [], actions: { withdraw() {}, resume() {} } }), 0);
  assert.equal(node.hidden, true);
  assert.equal(node.querySelector('.runtime-queue__row'), null);
  dom.window.close();
});

test('an unchanged queue does not rebuild the strip, and a rebuild detaches old listeners', () => {
  const dom = mount();
  const node = host(dom);
  const calls = [];
  const actions = { withdraw: (entry) => calls.push(entry.key), resume() {} };
  renderRuntimeQueue({ state: state(), host: node, rows: [row()], actions });
  const firstRow = node.querySelector('.runtime-queue__row');
  const firstWithdraw = node.querySelector('.runtime-queue__action--withdraw');

  renderRuntimeQueue({ state: state(), host: node, rows: [row()], actions });
  assert.equal(node.querySelector('.runtime-queue__row'), firstRow, 'unchanged rows keep their DOM');

  const nextActions = { withdraw: (entry) => calls.push('next:' + entry.key), resume() {} };
  renderRuntimeQueue({ state: state(), host: node, rows: [row({ position: 2 })], actions: nextActions });
  assert.notEqual(node.querySelector('.runtime-queue__action--withdraw'), firstWithdraw);
  firstWithdraw.click();
  assert.deepEqual(calls, [], 'the detached control is inert');
  node.querySelector('.runtime-queue__action--withdraw').click();
  assert.deepEqual(calls, ['next:durable_1']);
  dom.window.close();
});

test('disposing the strip detaches every listener it owns', () => {
  const dom = mount();
  const node = host(dom);
  const calls = [];
  renderRuntimeQueue({ state: state(), host: node, rows: [row()],
    actions: { withdraw: () => calls.push('withdraw'), resume() {} } });
  const withdraw = node.querySelector('.runtime-queue__action--withdraw');
  const toggle = node.querySelector('.runtime-queue__toggle');
  disposeRuntimeQueueRender(node);
  assert.equal(node.hidden, true, 'dead controls do not linger on screen');
  assert.equal(node.childElementCount, 0);
  withdraw.click();
  toggle.click();
  assert.deepEqual(calls, []);
  disposeRuntimeQueueRender(node);
  disposeRuntimeQueueRender(null);
  dom.window.close();
});

test('a long prompt is clipped for display but kept whole in its tooltip', () => {
  const dom = mount();
  const node = host(dom);
  const prompt = 'a'.repeat(200) + ' tail';
  renderRuntimeQueue({ state: state(), host: node, rows: [row({ prompt })],
    actions: { withdraw() {}, resume() {} } });
  const preview = node.querySelector('.runtime-queue__preview');
  assert.equal(preview.textContent.length <= 161, true, 'preview is clipped');
  assert.equal(preview.getAttribute('title'), prompt);
  assert.equal(node.querySelector('b'), null);
  dom.window.close();
});

test('while the runtime is closing, Resume says why it cannot run yet', () => {
  const dom = mount();
  const node = host(dom);
  const actions = { withdraw() {}, resume() {} };
  const rows = [row({ status: 'paused', position: null })];
  renderRuntimeQueue({ state: state(), host: node, rows, actions, closing: true });
  const closed = node.querySelector('.runtime-queue__action--resume');
  assert.equal(closed.disabled, true);
  assert.equal(closed.getAttribute('title'), 'Jenny is shutting down');
  // Nothing on the strip may claim the pause will lift on its own.
  assert.equal(/resumes|automatically/i.test(node.textContent), false);

  renderRuntimeQueue({ state: state(), host: node, rows, actions, closing: false });
  const open = node.querySelector('.runtime-queue__action--resume');
  assert.equal(open.disabled, false, 'the closing state is part of the render signature');
  assert.equal(open.getAttribute('title'), 'Resume this queued message');
  dom.window.close();
});

test('a missing host or missing handlers never throws and disables what it cannot do', () => {
  const dom = mount();
  const node = host(dom);
  assert.equal(renderRuntimeQueue({ state: state(), host: null, rows: [row()] }), 0);
  renderRuntimeQueue({ state: state(), host: node, rows: [row({ status: 'paused', position: null })] });
  assert.equal(node.querySelector('.runtime-queue__action--withdraw').disabled, true);
  assert.equal(node.querySelector('.runtime-queue__action--resume').disabled, true);
  dom.window.close();
});
