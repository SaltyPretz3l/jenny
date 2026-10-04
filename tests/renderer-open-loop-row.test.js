'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createOpenLoopRowRenderer,
  formatLoopTiming,
  loopRowSelector,
  openLoopActionLabel,
  parseIsoDate,
} = require('../renderer/features/renderer-open-loop-row.js');

function renderRow(loop, options = {}) {
  const { document } = new JSDOM('<!doctype html><body></body>').window;
  const renderer = createOpenLoopRowRenderer({ documentRef: document, ...options });
  const item = renderer.createLoopSummaryItem(loop, options.sectionKey || 'active');
  document.body.append(item);
  return item;
}

/* Dates follow the app locale, not the OS one: pin a non-English tag and a
 * 24-hour clock so a regression to toLocale*(undefined) fails. */
function withAppLocale(t, tag = 'de-DE') {
  const previous = globalThis.jennyI18n;
  globalThis.jennyI18n = { tag: () => tag, timeOptions: () => ({ hourCycle: 'h23' }) };
  t.after(() => { globalThis.jennyI18n = previous; });
  return tag;
}

const action = (id, slot, extra = {}) => ({ id: `${id}:f1`, type: id, label: id, slot, followUpId: 'f1', ...extra });

test('timing text uses the app locale and says the status even without a date', (t) => {
  const tag = withAppLocale(t);
  const day = (iso) => new Date(iso).toLocaleDateString(tag, { month: 'short', day: 'numeric' });
  assert.equal(formatLoopTiming({ status: 'active', isDue: true, timingLabel: 'ignored' }), 'Due now');
  assert.equal(formatLoopTiming({ status: 'resolved', resolvedAt: '2026-09-28T10:00:00.000Z' }), `Completed ${day('2026-09-28T10:00:00.000Z')}`);
  assert.equal(formatLoopTiming({ status: 'archived', archivedAt: '2026-09-20T10:00:00.000Z' }), `Archived ${day('2026-09-20T10:00:00.000Z')}`);
  const until = new Date('2026-09-30T15:00:00.000Z');
  assert.equal(
    formatLoopTiming({ status: 'deferred', deferredUntil: until.toISOString() }),
    `Deferred until ${day(until)}, ${until.toLocaleTimeString(tag, { hour: 'numeric', hourCycle: 'h23', minute: '2-digit' })}`
  );

  // Missing or invalid timestamps: the status in the UI language, never the service's English.
  assert.equal(formatLoopTiming({ status: 'archived', archivedAt: 'not a date', timingLabel: 'Archived' }), 'Archived');
  assert.equal(formatLoopTiming({ status: 'resolved', timingLabel: 'English' }), 'Completed');
  assert.equal(formatLoopTiming({ status: 'deferred', timingLabel: 'English' }), 'Deferred');
  assert.equal(formatLoopTiming({ status: 'active', resolvedAt: '2026-09-28T10:00:00.000Z', timingLabel: 'Fallback' }), '');
  assert.equal(parseIsoDate('garbage'), null);
});

test('action labels resolve through their key and keep the service English for unknown keys', () => {
  assert.equal(openLoopActionLabel({ labelKey: 'companion.actions.resumeThread', label: 'x' }), 'Resume thread');
  assert.equal(openLoopActionLabel({ labelKey: 'companion.actions.delete', label: 'x' }), 'Delete');
  assert.equal(openLoopActionLabel({ labelKey: 'companion.actions.unknown', label: 'Legacy label' }), 'Legacy label');
  assert.equal(openLoopActionLabel(null), '');
});

test('the action bar is primary, inline, then one trailing History + overflow group', () => {
  const item = renderRow({
    followUpId: 'f1',
    status: 'active',
    title: 'Ship it',
    sourceKind: 'manual',
    sessionState: 'open',
    history: [{ kind: 'created', at: '2026-09-28T10:00:00.000Z' }],
    actions: [
      action('resolve_follow_up', 'inline', { labelKey: 'companion.actions.done' }),
      action('continue_follow_up', 'primary', { labelKey: 'companion.actions.resumeThread' }),
      action('edit_follow_up', 'overflow', { labelKey: 'companion.actions.edit' }),
    ],
  });
  const bar = item.querySelector('.home-loop-actions');
  const kinds = [...bar.children].map((node) => (node.classList.contains('home-loop-actions__trailing')
    ? [...node.children].map((child) => (child.dataset.loopHistoryToggle ? 'history' : 'overflow')).join('+')
    : node.textContent.trim()));
  assert.deepEqual(kinds, ['Resume thread', 'Done', 'history+overflow']);
  assert.ok(bar.children[0].classList.contains('btn--primary'));
  assert.equal(bar.querySelectorAll('.btn--primary').length, 1);
  assert.equal(bar.textContent.includes('Edit'), false);

  const history = bar.querySelector('[data-loop-history-toggle]');
  assert.equal(history.getAttribute('aria-label'), 'History (1)');
  assert.equal(history.getAttribute('aria-expanded'), 'false');
  const historyList = item.ownerDocument.getElementById(history.getAttribute('aria-controls'));
  assert.ok(historyList?.classList.contains('home-loop-history-list'), 'aria-controls resolves to the history list');
  assert.equal(historyList.hidden, true);
  const overflow = bar.querySelector('[data-loop-overflow]');
  assert.equal(overflow.getAttribute('aria-haspopup'), 'menu');
  assert.equal(overflow.getAttribute('aria-label'), 'More actions for Ship it');

  const meta = [...item.querySelector('.home-loop-meta').children].map((node) => node.textContent);
  assert.deepEqual(meta, ['Manual', 'Open session']);
});

test('a completed row has no filled button and expanded state comes from the renderer', () => {
  const body = 'b'.repeat(240);
  const item = renderRow({
    followUpId: 'f1',
    status: 'resolved',
    title: 'Done thing',
    body,
    sessionState: 'missing',
    history: [{ kind: 'resolved', at: '2026-09-28T10:00:00.000Z', detail: 'Marked done' }],
    actions: [action('activate_follow_up', 'inline', { labelKey: 'companion.actions.reopen' })],
  }, { sectionKey: 'recentResolved', isHistoryExpanded: () => true, isBodyExpanded: () => true });

  assert.equal(item.querySelectorAll('.btn--primary').length, 0);
  assert.equal(item.dataset.loopStatus, 'resolved');
  assert.deepEqual([...item.querySelector('.home-loop-meta').children].map((node) => node.textContent), ['Completed'],
    'a missing session adds no badge; an undated completion still says Completed');
  assert.equal(item.querySelector('[data-loop-overflow]'), null, 'no overflow actions, no menu button');

  const bodyNode = item.querySelector('.home-loop-body');
  assert.equal(bodyNode.dataset.expanded, 'true');
  const bodyToggle = item.querySelector('[data-loop-body-toggle]');
  assert.equal(bodyToggle.hidden, false);
  assert.equal(bodyToggle.textContent.trim(), 'Show less');
  assert.equal(item.ownerDocument.getElementById(bodyToggle.getAttribute('aria-controls')), bodyNode);

  const historyToggle = item.querySelector('[data-loop-history-toggle]');
  const list = item.ownerDocument.getElementById(historyToggle.getAttribute('aria-controls'));
  assert.ok(list?.classList.contains('home-loop-history-list'));
  assert.equal(list.hidden, false);
  assert.match(list.textContent, /Marked done/);
});

test('dom ids stay distinct for follow-up ids that differ only in punctuation', () => {
  const { document } = new JSDOM('<!doctype html><body></body>').window;
  const renderer = createOpenLoopRowRenderer({ documentRef: document, isHistoryExpanded: () => false });
  const history = [{ kind: 'created', at: '2026-09-28T10:00:00.000Z' }];
  const ids = ['a:b', 'a-b', 'a_b'].map((followUpId) => {
    const row = renderer.createLoopSummaryItem({ followUpId, status: 'active', title: followUpId, history, actions: [] }, 'active');
    document.body.append(row);
    assert.equal(document.querySelector(loopRowSelector(followUpId)), row, 'the row selector finds the row');
    return row.querySelector('[data-loop-history-toggle]').getAttribute('aria-controls');
  });
  assert.equal(new Set(ids).size, 3, ids.join(' '));
  for (const id of ids) {
    assert.equal(document.querySelectorAll(`#${CSS_escape(id)}`).length, 1);
  }
});

function CSS_escape(id) {
  return id.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`);
}

test('with layout, Show more follows the measured clamp instead of the length guess', () => {
  const { document } = new JSDOM('<!doctype html><body></body>').window;
  const renderer = createOpenLoopRowRenderer({ documentRef: document });
  const list = document.createElement('div');
  document.body.append(list);
  const longButFits = renderer.createLoopSummaryItem({ followUpId: 'a', status: 'active', title: 'A', body: 'x'.repeat(400), actions: [] }, 'active');
  const shortButClipped = renderer.createLoopSummaryItem({ followUpId: 'b', status: 'active', title: 'B', body: 'Short note', actions: [] }, 'active');
  list.append(longButFits, shortButClipped);
  const measure = (row, clientHeight, scrollHeight) => {
    const body = row.querySelector('.home-loop-body');
    Object.defineProperty(body, 'clientHeight', { value: clientHeight });
    Object.defineProperty(body, 'scrollHeight', { value: scrollHeight });
  };
  measure(longButFits, 40, 40);
  measure(shortButClipped, 40, 80);
  assert.equal(longButFits.querySelector('[data-loop-body-toggle]').hidden, false, 'the length guess before layout');
  assert.equal(shortButClipped.querySelector('[data-loop-body-toggle]').hidden, true);

  renderer.syncBodyToggles(list);
  assert.equal(longButFits.querySelector('[data-loop-body-toggle]').hidden, true, 'fits: no dead toggle');
  assert.equal(shortButClipped.querySelector('[data-loop-body-toggle]').hidden, false, 'clipped: toggle reachable');
});

test('a short body hides its Show more toggle; a body equal to the title is not repeated', () => {
  const short = renderRow({ followUpId: 'f1', status: 'active', title: 'T', body: 'Short note', actions: [] });
  assert.equal(short.querySelector('[data-loop-body-toggle]').hidden, true);
  assert.equal(short.querySelector('.home-loop-actions'), null, 'no actions, no bar');
  const inlineOnly = renderRow({ followUpId: 'f1', status: 'active', title: 'T', actions: [action('resolve_follow_up', 'inline')] });
  assert.equal(inlineOnly.querySelector('.home-loop-actions__trailing'), null, 'no trailing controls, no trailing group');

  const repeated = renderRow({ followUpId: 'f1', status: 'active', title: 'Same text...', body: 'Same text', actions: [] });
  assert.equal(repeated.querySelector('.home-loop-body'), null);
});

test('history timestamps follow the app locale and its 24-hour setting', (t) => {
  const tag = withAppLocale(t);
  const at = '2026-09-28T17:05:00.000Z';
  const item = renderRow({
    followUpId: 'f1', status: 'active', title: 'T',
    history: [{ kind: 'created', at }],
    actions: [],
  }, { isHistoryExpanded: () => true });
  const expected = new Date(at).toLocaleString(tag, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', hourCycle: 'h23', minute: '2-digit' });
  assert.equal(item.querySelector('.home-loop-history-item .home-summary-label').textContent, `created / ${expected}`);
});

test('Resume names its session for keyboard and screen-reader users, escaped', () => {
  const session = 'Fix <b>"login"</b> & deploy';
  const item = renderRow({
    followUpId: 'f1',
    status: 'active',
    title: 'Ship it',
    sessionState: 'saved',
    contextLine: session,
    actions: [
      action('continue_follow_up', 'primary', { type: 'continue_session', labelKey: 'companion.actions.resumeThread', sessionId: 's1' }),
      action('resolve_follow_up', 'inline', { labelKey: 'companion.actions.done' }),
    ],
  });
  const [resume, done] = item.querySelectorAll('.home-loop-actions [data-companion-action-id]');
  assert.equal(resume.getAttribute('title'), `Resume thread: ${session}`);
  assert.equal(resume.querySelector('b'), null, 'the session title is text, never markup');
  assert.equal(done.hasAttribute('title'), false);
  assert.equal(item.querySelector('.home-loop-meta').title, session, 'the meta line keeps its hover tooltip');
});
