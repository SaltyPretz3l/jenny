'use strict';

/* Suggested changes review UI (row 35 Plan Plus W2; UI spec §3.3-3.4): the
 * pure model, the shared client over a fake bridge, the editor's suggested
 * text and the decision bar. The Changes view, dock and editor tab suites are
 * in renderer-suggested-changes-view.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../renderer/features/renderer-suggested-changes-model');
const { acceptFailureText } = require('../renderer/features/renderer-suggested-changes-client');
const { createSuggestionBarController, HIDE_EXPLANATIONS_KEY } = require('../renderer/features/renderer-suggestion-bar-controller');
const { applySuggestion } = require('../renderer/features/renderer-ide-suggestion-diff');
const { click, entry, listOf, makeClient, press, settle, withRunMode } = require('./helpers/suggested-changes-fixtures');

/* ── Model ── */

test('model: a batch keeps its decided changes; rows, header and footer', () => {
  const entries = [
    entry('old', { status: 'applied', updated_at: '2026-10-05T00:00:59Z' }),
    entry('a', { status: 'applied', updated_at: '2026-10-05T00:02:00Z' }),
    entry('b', { comments: [{ id: 'c1', text: 'Use   two\ndecimals', sent_at: null }] }),
    entry('c', { status: 'revising' }),
    entry('d', { status: 'rejected' }),
  ];
  entries[1].created_at = '2026-10-05T00:01:00Z';
  entries[2].created_at = '2026-10-05T00:01:01Z';
  entries[3].created_at = '2026-10-05T00:01:02Z';
  entries[4].created_at = '2026-10-05T00:01:03Z';
  const view = model.buildSuggestedView(listOf(entries));
  assert.deepEqual(view.rows.map((row) => row.id), ['a', 'b', 'c', 'd'], 'a change decided before the next batch began is History');
  assert.equal(view.currentId, 'b');
  assert.deepEqual(view.rows.map((row) => row.state), ['done', 'current', 'working', 'rejected']);
  assert.equal(view.rows[1].secondLine.text, 'Your comment: “Use two decimals”');
  assert.equal(view.rows[2].secondLine.tone, 'active');
  assert.equal(view.header.progressText, '2 of 4 done');
  assert.deepEqual(view.footer, { activity: null, comments: 1, historyLink: false });
  const generating = model.buildSuggestedView(listOf(entries), { activity: { generating: true, startedAt: 1000, now: 22_000 } });
  assert.equal(generating.footer.activity.label, 'Revising 1 change');
  assert.equal(generating.footer.activity.elapsedMs, 21_000);
  assert.equal(model.buildSuggestedView(listOf([entry('x', { status: 'applied' })])), null, 'no live change, no batch');
});

test('model: the bar disables Accept while Jenny generates and explains why', () => {
  const entries = [entry('a'), entry('b'), entry('c', { status: 'out_of_date', what: '', why: '' })];
  const bar = model.buildBarModel(listOf(entries), 'b', { generating: true });
  assert.equal(bar.caption, 'Change 2 of 3 · b.py');
  assert.equal(bar.canAccept, false);
  assert.match(bar.acceptReason, /still suggesting changes/);
  assert.equal(bar.canReject, true);
  assert.equal(bar.canComment, true);
  assert.deepEqual(bar.explanation.map((item) => item.kind), ['what', 'why']);
  const stale = model.buildBarModel(listOf(entries), 'c');
  assert.equal(stale.canAccept, false);
  assert.match(stale.statusNote, /no longer matches/);
  assert.equal(stale.noExplanation, 'Jenny didn’t explain this change.');
  assert.equal(model.buildBarModel(listOf(entries), 'a', { busy: true }).canAccept, false);
});

test('model: next-to-review wraps, step stops at the ends, finish totals', () => {
  const batch = [entry('a', { status: 'applied' }), entry('b'), entry('c', { status: 'rejected' }), entry('d')];
  assert.equal(model.nextToReview(batch, 'd'), 'b');
  assert.equal(model.nextToReview(batch, 'b'), 'd');
  assert.equal(model.stepFrom(batch, 'a', -1), '');
  assert.equal(model.stepFrom(batch, 'a', 1), 'b');
  assert.deepEqual(
    model.buildFinishSummary([entry('a', { status: 'applied' }), entry('b', { status: 'applied', path: 'src/a.py' }), entry('c', { status: 'rejected' }), entry('d', { status: 'later' })]),
    { applied: 2, rejected: 1, later: 1, files: 1 }
  );
});

/* ── Client ── */

test('client: accept carries the revision and moves to the next change to review', async () => {
  const { bridge, client } = makeClient([entry('a'), entry('b'), entry('c')]);
  await client.refresh('s1');
  client.setCurrent('s1', 'a');
  const result = await client.accept('s1', 'a', 1);
  assert.deepEqual(result, { ok: true, applied: true });
  assert.deepEqual(bridge.calls[0], ['accept', 's1', 'a', 1]);
  assert.equal(client.getCurrent('s1'), 'b');
  const stale = await client.accept('s1', 'b', 7);
  assert.equal(stale.ok, false);
  assert.match(stale.message, /Jenny updated this change/);
  assert.equal(client.getCurrent('s1'), 'b', 'a failure stays on the change');
});

test('client: accept refuses over unsaved edits in an open editor tab', async () => {
  const { bridge, client } = makeClient([entry('a')]);
  await client.refresh('s1');
  client.setDirtyCheck((path) => path === 'src/a.py');
  const result = await client.accept('s1', 'a', 1);
  assert.equal(result.ok, false);
  assert.equal(result.message, 'Save or discard your unsaved edits to a.py before accepting this change.');
  assert.equal(bridge.calls.length, 0, 'nothing reached Electron');
  client.setDirtyCheck(null);
  assert.equal((await client.accept('s1', 'a', 1)).ok, true);
});

test('client: the last accept of a group checks every member’s file for unsaved edits', async () => {
  const { bridge, client } = makeClient([
    entry('a', { group_id: 'grp:t:g', status: 'accepted' }),
    entry('b', { group_id: 'grp:t:g' }),
    entry('c', { group_id: 'grp:t:g', status: 'rejected' }),
  ]);
  await client.refresh('s1');
  client.setDirtyCheck((path) => path === 'src/a.py' || path === 'src/c.py');
  const result = await client.accept('s1', 'b', 1);
  assert.equal(result.message, 'Save or discard your unsaved edits to a.py before accepting this change.');
  assert.equal(bridge.calls.length, 0);
});

test('model: Accept waits on a stale revision, a running reply, unsaved edits or a missing preview', () => {
  const list = listOf([entry('a', { revision: 2 })]);
  const reasons = [
    [{ revision: 1 }, /new version is loading/],
    [{ replying: true }, /finishes replying/],
    [{ unsaved: true }, /unsaved edits to a\.py/],
    [{ previewMissing: true }, /can’t be accepted/],
  ];
  for (const [options, reason] of reasons) {
    const bar = model.buildBarModel(list, 'a', options);
    assert.equal(bar.canAccept, false, JSON.stringify(options));
    assert.match(bar.acceptReason, reason);
  }
  const shown = model.buildBarModel(list, 'a', { revision: 1 });
  assert.equal(shown.revision, 1, 'the bar names the revision its host shows');
  assert.equal(model.buildBarModel(list, 'a', { revision: 2 }).canAccept, true);
});

test('client: choosing the same change again does not notify', async () => {
  const { client } = makeClient([entry('a')]);
  let notified = 0;
  client.subscribe(() => { notified += 1; });
  client.setCurrent('s1', 'a');
  client.setCurrent('s1', 'a');
  assert.equal(notified, 1);
});

test('client: accept failures read in plain words', () => {
  assert.match(acceptFailureText({ outcome: 'moved' }), /file changed since/);
  assert.match(acceptFailureText({ outcome: 'out_of_date', reason: 'target_exists' }), /already exists/);
  assert.match(acceptFailureText({ reason: 'path_link_refused' }), /can’t write/);
  assert.match(acceptFailureText({ error: 'no_workspace' }), /Open the project folder/);
});

test('client: Send turns the queued comments into one Propose message', async () => {
  await withRunMode('ask', async (switches) => {
    const { bridge, client, sent } = makeClient([entry('a')]);
    const result = await client.sendComments('s1');
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(switches, [['propose', 's1']], 'the revision turn runs in Propose');
    assert.deepEqual(bridge.calls[0], ['sendComments', 's1']);
    assert.equal(sent[0][0], 'DIGEST');
    assert.deepEqual(sent[0][1], { sessionIdOverride: 's1', visiblePrompt: 'Please revise the changes I commented on.', preserveComposerDraft: true });
  });
  await withRunMode('propose', async () => {
    const blocked = makeClient([entry('a')], { startPromptSend: async () => ({ rejected: true, reason: 'busy' }) });
    const failed = await blocked.client.sendComments('s1');
    assert.equal(failed.ok, false);
    assert.match(failed.message, /comments are saved/);
    assert.deepEqual(blocked.bridge.calls[1], ['undoSend', 's1', { ids: ['b'], sent_at: '2026-10-05T01:00:00.000Z' }],
      'a digest that was not sent goes back in the queue');
  });
  await withRunMode('ask', async () => {
    const stuck = makeClient([entry('a')]);
    const refused = await stuck.client.sendComments('s1');
    assert.match(refused.message, /Switch this chat to Propose/);
    assert.equal(stuck.bridge.calls.length, 0, 'nothing is marked sent');
  }, { canSwitch: false });
});

test('client: generating means streaming in Propose; a change event refreshes loaded chats', async () => {
  let streaming = true;
  const made = makeClient([entry('a')], { isSessionStreaming: () => streaming });
  const { bridge, client } = made;
  const previous = globalThis.rendererRunModeControl;
  try {
    globalThis.rendererRunModeControl = { currentRunMode: () => 'build' };
    assert.equal(client.isGenerating('s1'), false);
    globalThis.rendererRunModeControl = { currentRunMode: () => 'propose' };
    assert.equal(client.isGenerating('s1'), true);
    streaming = false;
    assert.equal(client.isGenerating('s1'), false);
    assert.equal(made.timers.length, 1, 'the end of a Propose run re-reads the list after the grace');
  } finally {
    globalThis.rendererRunModeControl = previous;
  }
  const seen = [];
  client.subscribe((sessionId) => seen.push(sessionId));
  await client.refresh('s1');
  bridge.entries.push(entry('b'));
  bridge.emit();
  await settle();
  assert.equal(client.get('s1').entries.length, 2);
  assert.ok(seen.length >= 2);
});

/* ── Editor text ── */

test('editor: the suggested text applies once; a moved or ambiguous match shows no diff', () => {
  assert.equal(applySuggestion('x = 1\ny = 2\n', { kind: 'replace', old_string: 'y = 2', new_string: 'y = 3' }), 'x = 1\ny = 3\n');
  assert.equal(applySuggestion('x\ny\nz\n', { kind: 'replace', old_string: 'y', new_string: '' }), 'x\nz\n', 'a whole-line delete takes its newline');
  assert.equal(applySuggestion('a a', { kind: 'replace', old_string: 'a', new_string: 'b' }), null);
  assert.equal(applySuggestion('q', { kind: 'replace', old_string: 'a', new_string: 'b' }), null);
  assert.equal(applySuggestion('aaa', { kind: 'replace', old_string: 'aa', new_string: 'b' }), 'ba', 'matches count without overlap, like the sidecar');
  assert.equal(applySuggestion('', { kind: 'create', new_string: 'new\r\nfile' }), 'new\nfile');
});

/* ── Decision bar ── */

function barSetup(entries, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="bar"></div><input id="other"></body>');
  const el = dom.window.document.getElementById('bar');
  const made = makeClient(entries, options.host);
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const navigated = [];
  const bar = createSuggestionBarController({ client: made.client, storage, onNavigate: (s, id) => navigated.push([s, id]) });
  el.addEventListener('click', (event) => bar.handleClick(event, el));
  el.addEventListener('keydown', (event) => bar.handleKeydown(event, el));
  el.addEventListener('input', (event) => bar.handleInput(event, el));
  return { dom, el, bar, store, navigated, ...made };
}


test('bar: Comment opens a note; Enter saves and moves on, Esc cancels', async () => {
  const f = barSetup([entry('a'), entry('b')]);
  await f.client.refresh('s1');
  f.bar.render(f.el, { sessionId: 's1', id: 'a', revision: 1 });
  assert.deepEqual(Array.from(f.el.querySelectorAll('[data-suggestion-action]')).map((b) => b.textContent.trim()), ['Comment', 'Reject', 'Accept']);
  assert.match(f.el.querySelector('.suggestion-bar-caption').textContent, /Change 1 of 2 · a\.py/);
  click(f.dom, f.el.querySelector('[data-suggestion-action="comment"]'));
  const field = f.el.querySelector('[data-suggestion-note="comment"]');
  assert.ok(field);
  assert.equal(f.dom.window.document.activeElement, field);
  press(f.dom, field, 'Escape');
  assert.equal(f.el.querySelector('[data-suggestion-note]'), null);
  click(f.dom, f.el.querySelector('[data-suggestion-action="comment"]'));
  const again = f.el.querySelector('[data-suggestion-note]');
  again.value = 'Round down instead';
  again.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  press(f.dom, again, 'n');
  press(f.dom, again, 'Enter');
  await settle();
  await settle();
  assert.deepEqual(f.bridge.calls.filter((c) => c[0] === 'comment'), [['comment', 'a', 'Round down instead']]);
  assert.deepEqual(f.navigated, [['s1', 'b']]);
});

test('bar: Alt+Enter accepts the rendered revision; Accept waits while Jenny generates', async () => {
  const f = barSetup([entry('a', { revision: 3 }), entry('b')]);
  await f.client.refresh('s1');
  f.bar.render(f.el, { sessionId: 's1', id: 'a', revision: 3 });
  press(f.dom, f.el.querySelector('.suggestion-bar'), 'Enter', { altKey: true });
  await settle();
  await settle();
  assert.deepEqual(f.bridge.calls[0], ['accept', 's1', 'a', 3]);

  const g = barSetup([entry('a')], { host: { isSessionStreaming: () => true } });
  const previous = globalThis.rendererRunModeControl;
  globalThis.rendererRunModeControl = { currentRunMode: () => 'propose' };
  try {
    await g.client.refresh('s1');
    g.bar.render(g.el, { sessionId: 's1', id: 'a', revision: 1 });
    const accept = g.el.querySelector('[data-suggestion-action="accept"]');
    assert.equal(accept.disabled, true);
    assert.match(accept.getAttribute('title'), /still suggesting changes/);
    press(g.dom, g.el.querySelector('.suggestion-bar'), 'Enter', { altKey: true });
    await settle();
    assert.equal(g.bridge.calls.length, 0);
  } finally {
    globalThis.rendererRunModeControl = previous;
  }
});

test('bar: a focused Accept hands focus to the next change’s Accept, never to the page', async () => {
  const f = barSetup([entry('a'), entry('b')]);
  await f.client.refresh('s1');
  f.bar.render(f.el, { sessionId: 's1', id: 'a', revision: 1 });
  const doc = f.dom.window.document;
  f.el.querySelector('[data-suggestion-action="accept"]').focus();
  click(f.dom, f.el.querySelector('[data-suggestion-action="accept"]'));
  await settle();
  await settle();
  assert.deepEqual(f.navigated, [['s1', 'b']]);
  f.bar.render(f.el, { sessionId: 's1', id: 'b', revision: 1 });
  assert.equal(doc.activeElement, f.el.querySelector('[data-suggestion-action="accept"]'));
  assert.match(f.el.querySelector('.suggestion-bar-caption').textContent, /Change 2 of 2/);

  const g = barSetup([entry('a'), entry('b')]);
  await g.client.refresh('s1');
  g.bar.render(g.el, { sessionId: 's1', id: 'a', revision: 1 });
  g.el.querySelector('[data-suggestion-action="accept"]').focus();
  click(g.dom, g.el.querySelector('[data-suggestion-action="accept"]'));
  g.dom.window.document.getElementById('other').focus();
  await settle();
  await settle();
  g.bar.render(g.el, { sessionId: 's1', id: 'b', revision: 1 });
  assert.equal(g.dom.window.document.activeElement.id, 'other', 'focus the user moved elsewhere stays there');

  const h = barSetup([entry('a')]);
  await h.client.refresh('s1');
  h.bar.render(h.el, { sessionId: 's1', id: 'a', revision: 1 });
  h.el.querySelector('[data-suggestion-action="accept"]').focus();
  click(h.dom, h.el.querySelector('[data-suggestion-action="accept"]'));
  await settle();
  await settle();
  assert.equal(h.dom.window.document.activeElement, h.el.querySelector('.suggestion-bar'), 'the last decided change keeps focus on its bar');
});

test('bar: Reject takes an optional reason; ? hides explanations and remembers it', async () => {
  const f = barSetup([entry('a'), entry('b')]);
  await f.client.refresh('s1');
  f.bar.render(f.el, { sessionId: 's1', id: 'a', revision: 1 });
  assert.ok(f.el.querySelector('.suggestion-bar-explain'));
  press(f.dom, f.el.querySelector('.suggestion-bar'), '?');
  assert.equal(f.el.querySelector('.suggestion-bar-explain'), null);
  assert.equal(f.store.get(HIDE_EXPLANATIONS_KEY), '1');
  const other = f.dom.window.document.getElementById('other');
  f.el.appendChild(other);
  press(f.dom, other, '?');
  assert.equal(f.store.get(HIDE_EXPLANATIONS_KEY), '1', 'typing never fires a shortcut');
  click(f.dom, f.el.querySelector('[data-suggestion-action="reject"]'));
  click(f.dom, f.el.querySelector('[data-suggestion-note-save]'));
  await settle();
  await settle();
  assert.deepEqual(f.bridge.calls[0], ['decide', 'a', 'reject', '']);
});
