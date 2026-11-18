'use strict';

// new-test-file: the send queue of a shared conversation (row 171), a new surface

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const queueModule = require('../renderer/team/renderer-team-project-queue');

const { createQueue, footHtml, CAP, _reset } = queueModule;

const HOSTILE = '<img src=x onerror=alert(1)>"\'&';
const parse = (html) => {
  const dom = new JSDOM('<!doctype html><body></body>');
  dom.window.document.body.innerHTML = html;
  return dom.window.document.body;
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A fake `send`: records each prompt and answers when the test says so.
function fakeSend() {
  const calls = [];
  const send = (prompt) => new Promise((resolve) => { calls.push({ prompt, resolve }); });
  return { calls, send, prompts: () => calls.map((c) => c.prompt) };
}
function make(key = 'team\u0000s1', extra = {}) {
  const fake = fakeSend();
  const q = createQueue({ key, send: fake.send, errorText: (e) => 'Refused: ' + String(e), ...extra });
  return { q, fake };
}
const states = (q) => q.entries().map((e) => e.state);
const texts = (q) => q.entries().map((e) => e.text);

test.beforeEach(() => _reset());

test('(a) add holds up to three messages; the fourth is full and blank text is empty', () => {
  const { q } = make();
  assert.equal(CAP, 3);
  for (const t of ['one', 'two', 'three']) {
    const r = q.add(t);
    assert.equal(r.ok, true);
    assert.equal(typeof r.id, 'string');
  }
  assert.deepEqual(q.add('four'), { ok: false, reason: 'full' });
  assert.deepEqual(q.add('   \n '), { ok: false, reason: 'empty' });
  assert.deepEqual(q.add(null), { ok: false, reason: 'empty' });
  assert.deepEqual(texts(q), ['one', 'two', 'three']);
  assert.deepEqual(states(q), ['waiting', 'waiting', 'waiting']);
  assert.deepEqual(q.counts(), { entries: 3, armed: false });
});

test('entries() is a copy: changing it leaves the store alone', () => {
  const { q } = make();
  q.add('one');
  const list = q.entries();
  list[0].state = 'failed';
  list.push({ id: 'x' });
  assert.deepEqual(states(q), ['waiting']);
});

test('(b) a clean end alone sends nothing; the idle snapshot after it sends exactly the first; a second idle sends nothing', async () => {
  const { q, fake } = make();
  q.add('one');
  q.add('two');
  q.turnEnded('complete');
  await flush();
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(q.counts(), { entries: 2, armed: true });
  q.idle({ maySend: true });
  await flush();
  assert.deepEqual(fake.prompts(), ['one']);
  assert.deepEqual(states(q), ['sending', 'waiting']);
  assert.equal(q.counts().armed, false);
  q.idle({ maySend: true });
  await flush();
  assert.equal(fake.calls.length, 1);
});

test('an idle snapshot without a clean end before it sends nothing', async () => {
  const { q, fake } = make();
  q.add('one');
  q.idle({ maySend: true });
  await flush();
  assert.equal(fake.calls.length, 0);
});

test('(c) an accepted send removes the entry; the next clean end and idle send the next, in order', async () => {
  const { q, fake } = make();
  q.add('one');
  q.add('two');
  q.add('three');
  q.turnEnded('complete');
  q.idle({ maySend: true });
  await flush();
  fake.calls[0].resolve({ ok: true });
  await flush();
  assert.deepEqual(texts(q), ['two', 'three']);
  q.idle({ maySend: true });
  await flush();
  assert.equal(fake.calls.length, 1, 'nothing more until the next clean end');
  q.turnEnded('complete');
  q.idle({ maySend: true });
  await flush();
  fake.calls[1].resolve({ ok: true });
  await flush();
  q.turnEnded('complete');
  q.idle({ maySend: true });
  await flush();
  fake.calls[2].resolve({ ok: true });
  await flush();
  assert.deepEqual(fake.prompts(), ['one', 'two', 'three']);
  assert.deepEqual(q.entries(), []);
});

test('(d) a stopped or failed turn pauses every waiting entry with "Not sent", and a later idle sends nothing', async () => {
  for (const type of ['cancelled', 'canceled', 'error', 'failed']) {
    _reset();
    const { q, fake } = make();
    q.add('one');
    q.add('two');
    q.turnEnded('complete');
    q.turnEnded(type);
    assert.deepEqual(states(q), ['paused', 'paused'], type);
    assert.deepEqual(q.entries().map((e) => e.note), ['Not sent', 'Not sent']);
    assert.equal(q.counts().armed, false);
    q.idle({ maySend: true });
    await flush();
    assert.equal(fake.calls.length, 0, type);
  }
});

test('(e) a refused send marks that entry failed with the errorText sentence and pauses the rest', async () => {
  const { q, fake } = make();
  q.add('one');
  q.add('two');
  q.add('three');
  q.turnEnded('complete');
  const pending = q.idle({ maySend: true });
  await flush();
  fake.calls[0].resolve({ ok: false, error: 'revision_conflict' });
  await pending;
  const list = q.entries();
  assert.deepEqual(list.map((e) => e.state), ['failed', 'paused', 'paused']);
  assert.equal(list[0].note, 'Refused: revision_conflict');
  assert.equal(list[1].note, 'Not sent');
});

test('a send that throws or answers null is not lost', async () => {
  const thrown = createQueue({ key: 'k-throw', send: () => { throw new Error('boom'); }, errorText: () => 'It failed.' });
  thrown.add('one');
  await thrown.sendNow(thrown.entries()[0].id, { running: false });
  assert.deepEqual(thrown.entries().map((e) => [e.state, e.note]), [['failed', 'It failed.']]);

  const { q, fake } = make('k-null');
  q.add('one');
  const pending = q.sendNow(q.entries()[0].id, { running: false });
  await flush();
  fake.calls[0].resolve(null);
  await pending;
  assert.deepEqual(q.entries().map((e) => [e.state, e.note]), [['paused', 'Not sent']]);
});

test('(f) an idle snapshot that may not send while armed pauses all and disarms', async () => {
  const { q, fake } = make();
  q.add('one');
  q.add('two');
  q.turnEnded('complete');
  q.idle({ maySend: false });
  await flush();
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(states(q), ['paused', 'paused']);
  assert.equal(q.counts().armed, false);
  q.idle({ maySend: true });
  await flush();
  assert.equal(fake.calls.length, 0);
});

test('(g) lost() pauses waiting and sending entries and disarms', async () => {
  const { q, fake } = make();
  q.add('one');
  q.add('two');
  q.turnEnded('complete');
  q.idle({ maySend: true });
  await flush();
  assert.deepEqual(states(q), ['sending', 'waiting']);
  q.turnEnded('complete');
  q.lost();
  assert.deepEqual(states(q), ['paused', 'paused']);
  assert.deepEqual(q.entries().map((e) => e.note), ['Not sent', 'Not sent']);
  assert.equal(q.counts().armed, false);
  // The host accepted the send after all: the message is posted, so it leaves the queue.
  fake.calls[0].resolve({ ok: true });
  await flush();
  assert.deepEqual(texts(q), ['two']);
});

test('(h) sendNow sends a paused entry when nothing runs; it refuses while running or while another sends', async () => {
  const { q, fake } = make();
  q.add('one');
  q.add('two');
  q.turnEnded('cancelled');
  const [first, second] = q.entries();
  assert.equal(q.sendNow(first.id, { running: true }), false);
  assert.equal(q.sendNow('unknown', { running: false }), false);
  q.turnEnded('complete');
  assert.equal(q.sendNow(first.id, { running: false }), false, 'a turn just ended: wait for its idle snapshot');
  q.idle({ maySend: true }); // the first entry is paused, so this only disarms
  await flush();
  assert.equal(fake.calls.length, 0);
  const pending = q.sendNow(first.id, { running: false });
  assert.ok(pending && typeof pending.then === 'function');
  await flush();
  assert.deepEqual(fake.prompts(), ['one']);
  assert.deepEqual(states(q), ['sending', 'paused']);
  assert.equal(q.sendNow(second.id, { running: false }), false, 'another is sending');
  fake.calls[0].resolve({ ok: true });
  await pending;
  assert.deepEqual(texts(q), ['two']);
  const again = q.sendNow(second.id, { running: false });
  await flush();
  fake.calls[1].resolve({ ok: false, error: 'busy' });
  await again;
  assert.deepEqual(q.entries().map((e) => [e.state, e.note]), [['failed', 'Refused: busy']]);
});

test('(i) edit returns the text and removes the entry; discard removes it', () => {
  const { q } = make();
  q.add('one');
  q.add('two');
  q.add('three');
  const [first, second] = q.entries();
  assert.equal(q.edit(first.id), 'one');
  assert.equal(q.edit(first.id), '');
  assert.equal(q.discard(second.id), true);
  assert.equal(q.discard(second.id), false);
  assert.deepEqual(texts(q), ['three']);
});

test('a sending entry cannot be edited or discarded: the host may already hold it', async () => {
  const { q } = make();
  q.add('one');
  q.turnEnded('complete');
  q.idle({ maySend: true });
  await flush();
  const [entry] = q.entries();
  assert.equal(q.edit(entry.id), '');
  assert.equal(q.discard(entry.id), false);
  assert.deepEqual(states(q), ['sending']);
});

test('(j) after detach a new queue with the same key sees the entries, and a late answer still updates the store', async () => {
  const { q, fake } = make('team\u0000s9');
  q.add('one');
  q.add('two');
  q.turnEnded('complete');
  q.idle({ maySend: true });
  await flush();
  q.detach();
  assert.equal(q.add('three').ok, false, 'a detached view adds nothing');
  const { q: rebuilt } = make('team\u0000s9');
  assert.deepEqual(texts(rebuilt), ['one', 'two']);
  assert.deepEqual(states(rebuilt), ['sending', 'waiting']);
  fake.calls[0].resolve({ ok: false, error: 'gone' });
  await flush();
  assert.deepEqual(states(rebuilt), ['failed', 'paused']);
  assert.equal(rebuilt.entries()[0].note, 'Refused: gone');
});

test('clear() drops the conversation; a late answer after it changes nothing', async () => {
  const { q, fake } = make();
  q.add('one');
  q.turnEnded('complete');
  q.idle({ maySend: true });
  await flush();
  q.clear();
  assert.deepEqual(q.counts(), { entries: 0, armed: false });
  fake.calls[0].resolve({ ok: false, error: 'x' });
  await flush();
  assert.deepEqual(make().q.entries(), []);
});

test('(k) the store keeps the sixteen most recently used conversations', () => {
  for (let i = 0; i < 16; i += 1) make('k' + i).q.add('m' + i);
  make('k0').q.add('again'); // k0 is now the most recently used; k1 the least.
  make('k16').q.add('m16');
  assert.deepEqual(make('k1').q.entries(), [], 'the least recently used went');
  assert.deepEqual(texts(make('k0').q), ['m0', 'again']);
  assert.deepEqual(texts(make('k16').q), ['m16']);
  assert.deepEqual(texts(make('k15').q), ['m15']);
});

test('newId is injectable', () => {
  let n = 0;
  const { q } = make('k-id', { newId: () => 'mine-' + (n += 1) });
  assert.equal(q.add('one').id, 'mine-1');
  assert.equal(q.entries()[0].id, 'mine-1');
});

test('(l) footHtml: the words and the three buttons with their datasets', () => {
  const buttons = (html) => Array.from(parse(html).querySelectorAll('button.team-foot-btn'));
  const actions = (html) => buttons(html).map((b) => [b.dataset.projectAction, b.dataset.queueId, b.disabled]);

  const waiting = footHtml({ id: 'q1', text: 'x', state: 'waiting', note: '' }, { running: true });
  assert.equal(parse(waiting).querySelector('.team-queued').textContent, 'Waits for Jenny’s turn to end');
  assert.deepEqual(actions(waiting), [['queue-edit', 'q1', false], ['queue-discard', 'q1', false]], 'no Send now while waiting');

  const sending = footHtml({ id: 'q1', state: 'sending' }, { running: false });
  assert.equal(parse(sending).querySelector('.team-queued').textContent, 'Sending…');
  assert.deepEqual(actions(sending), [['queue-edit', 'q1', true], ['queue-discard', 'q1', true]], 'the host may already hold it');

  const paused = footHtml({ id: 'q2', state: 'paused', note: 'Not sent' }, { running: false });
  assert.equal(parse(paused).querySelector('.team-queued').textContent, 'Not sent');
  assert.deepEqual(actions(paused), [['queue-send', 'q2', false], ['queue-edit', 'q2', false], ['queue-discard', 'q2', false]]);
  assert.deepEqual(buttons(paused).map((b) => b.textContent), ['Send now', 'Edit', 'Discard']);

  const running = footHtml({ id: 'q2', state: 'failed', note: 'Refused.' }, { running: true });
  assert.deepEqual(actions(running)[0], ['queue-send', 'q2', true], 'Send now is disabled while a turn runs');

  const hostile = footHtml({ id: HOSTILE, state: 'failed', note: HOSTILE }, { running: false });
  const body = parse(hostile);
  assert.equal(body.querySelector('img'), null);
  assert.equal(body.querySelector('.team-queued').textContent, HOSTILE);
  assert.equal(buttons(hostile)[0].dataset.queueId, HOSTILE);

  assert.equal(footHtml(null), '');
});

// In the app `require` is the editor's AMD loader and throws for a module it does not know.
test('the script loads in the app, where require throws, and builds buttons with the app inventory', () => {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(require.resolve('../renderer/team/renderer-team-project-queue'), 'utf8');
  const made = [];
  const app = { stringUtils: require('../renderer/shared/string-utils'),
    inventory: { actionButton: (options) => { made.push(options); return '<button></button>'; } },
    require: (name) => { throw new Error('Check dependency list! ' + name); } };
  app.globalThis = app;
  vm.runInNewContext(source, app);
  assert.equal(typeof app.rendererTeamProjectQueue.createQueue, 'function');
  assert.match(app.rendererTeamProjectQueue.footHtml({ id: 'q1', state: 'paused', note: 'n' }, {}), /button/);
  assert.equal(made.length, 3);
});
