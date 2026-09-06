'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  FALLBACK_TEXT,
  SEMANTIC_PREVIEW_CAP,
  createTimelineVirtualizerEntryStore,
} = require('../renderer/chat/renderer-chat-timeline-virtualizer-entry-store');

function createFixture(count = 1) {
  const dom = new JSDOM('<!doctype html><body><div id="timeline"></div></body>');
  const timeline = dom.window.document.getElementById('timeline');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const article = dom.window.document.createElement('article');
    article.className = 'chat-entry';
    article.dataset.messageId = `message-${index}`;
    article.dataset.messageRole = index % 2 ? 'assistant' : 'user';
    article.tabIndex = -1;
    article.setAttribute('aria-label', index % 2 ? 'Message from Jenny' : 'Your message');
    article.innerHTML = `<div data-row-id="row-${index}" data-tool-call-id="tool-${index}">payload-${index}</div>`;
    timeline.appendChild(article);
    entries.push(article);
  }
  return { dom, document: dom.window.document, timeline, entries };
}

test('offscreen placeholders expose a bounded text-only semantic summary and restore original markup', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  entry.textContent = `<unsafe & summary> ${'word '.repeat(180)}`;
  const originalHtml = entry.innerHTML;
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  const unmount = store.applyUnmount(entry, 240, { epoch: 2, width: 640 });
  assert.equal(unmount.ok, true);
  assert.equal(entry.getAttribute('data-virtualized'), 'true');
  assert.equal(entry.getAttribute('aria-hidden'), null);
  assert.equal(entry.querySelector('[data-virtualized-summary="true"]').textContent.length <= SEMANTIC_PREVIEW_CAP, true);
  assert.equal(entry.innerHTML.includes('<unsafe'), false, 'preview is HTML-escaped');
  assert.equal(entry.style.minHeight, '240px');

  const mount = store.mount(entry, { epoch: 2, width: 640 });
  assert.equal(mount.ok, true);
  assert.equal(mount.layoutInvalidated, false);
  assert.equal(entry.innerHTML, originalHtml);
  assert.equal(entry.getAttribute('aria-label'), 'Your message');
  assert.deepEqual(store._internals.getIndexSizes(), { rows: 0, tools: 0, messages: 0 });
});

test('prediction-owned min-height is not restored after a virtualize-cleanup-remount race', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  entry.dataset.predictedHeight = '900';
  entry.style.minHeight = '900px';
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  assert.equal(store.applyUnmount(entry, 900, { epoch: 1, width: 760 }).ok, true);
  assert.equal(entry.style.minHeight, '900px', 'placeholder retains measured scroll geometry');

  // Reproduce prediction cleanup landing while the article is detached.
  entry.style.minHeight = '';
  assert.equal(store.mount(entry, { epoch: 1, width: 760 }).ok, true);
  assert.equal(entry.style.minHeight, '', 'temporary prediction must not survive remount');
});

test('inflated unmount measurement is not baked into a prediction-owned remount', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  entry.dataset.predictedHeight = '900';
  entry.style.minHeight = '900px';
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  const unmount = store.applyUnmount(entry, 4200, { epoch: 1, width: 760 });
  assert.equal(unmount.stash.height, 4200, 'unmount captures the inflated live measurement');
  assert.equal(unmount.stash.previousMinHeight, '', 'prediction-owned style is excluded from restoration');
  assert.equal(unmount.stash.hadInlineMinHeight, false);
  assert.equal(entry.style.minHeight, '4200px', 'placeholder temporarily retains measured geometry');

  assert.equal(store.mount(entry, { epoch: 1, width: 760 }).ok, true);
  assert.equal(entry.style.minHeight, '', 'inflated measurement cannot survive remount');
});

test('unrelated inline min-height remains restorable across virtualization', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  entry.dataset.predictedHeight = '900';
  entry.style.minHeight = '120px';
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  assert.equal(store.applyUnmount(entry, 240, { epoch: 1, width: 760 }).ok, true);
  assert.equal(store.mount(entry, { epoch: 1, width: 760 }).ok, true);
  assert.equal(entry.style.minHeight, '120px');
});

test('placeholder integrity uses node identity without serializing intact DOM', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });
  assert.equal(store.applyUnmount(entry, 100, { epoch: 0, width: 500 }).ok, true);

  const elementPrototype = fixture.dom.window.Element.prototype;
  const innerHtmlDescriptor = Object.getOwnPropertyDescriptor(elementPrototype, 'innerHTML');
  let htmlReads = 0;
  Object.defineProperty(entry, 'innerHTML', {
    configurable: true,
    get() { htmlReads += 1; return innerHtmlDescriptor.get.call(this); },
    set(value) { innerHtmlDescriptor.set.call(this, value); },
  });
  assert.equal(store.dropIfMorphed(entry), false);
  assert.equal(htmlReads, 0, 'the intact-placeholder check does not serialize its subtree');

  const replacement = fixture.document.createElement('div');
  replacement.textContent = 'fresh renderer content';
  entry.replaceChildren(replacement);
  assert.equal(store.dropIfMorphed(entry), true, 'replacing the owned placeholder invalidates the stash');
});

test('offscreen placeholders exclude inert, hidden, and aria-hidden detail text', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  entry.innerHTML = [
    '<span>Read README.md Success</span>',
    '<div inert>secret inert input</div>',
    '<div hidden>secret hidden output</div>',
    '<div aria-hidden="true">secret aria output</div>',
  ].join('');
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  assert.equal(store.applyUnmount(entry, 100, { epoch: 0, width: 500 }).ok, true);
  const preview = entry.querySelector('[data-virtualized-summary="true"]').textContent;
  assert.equal(preview, 'User message: Read README.md Success');
  assert.doesNotMatch(preview, /secret/);
});

test('offscreen placeholders exclude expanded tool detail containers', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  entry.innerHTML = [
    '<span>Read README.md Success</span>',
    '<div class="tool-call-row-body">expanded secret output</div>',
    '<div class="tool-call-details">expanded secret input</div>',
  ].join('');
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  assert.equal(store.applyUnmount(entry, 100, { epoch: 0, width: 500 }).ok, true);
  assert.equal(
    entry.querySelector('[data-virtualized-summary="true"]').textContent,
    'User message: Read README.md Success'
  );
});

test('message, row, and tool indexes resolve only while an entry is virtualized', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  store.applyUnmount(entry, 100, { epoch: 0, width: 500 });
  assert.strictEqual(store.resolveMessageId('message-0'), entry);
  assert.strictEqual(store.resolveRowId('row-0'), entry);
  assert.strictEqual(store.resolveToolCallId('tool-0'), entry);
  assert.equal(store.mount(entry, { epoch: 1, width: 420 }).layoutInvalidated, true);
  assert.equal(store.resolveMessageId('message-0'), null);
  assert.equal(store.resolveRowId('row-0'), null);
  assert.equal(store.resolveToolCallId('tool-0'), null);
});

test('restored historical alert and status roles do not re-announce on remount', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const entry = fixture.entries[0];
  entry.innerHTML = '<div role="alert">Old failure</div><div role="status" aria-live="polite">Old status</div>';
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
  });

  store.applyUnmount(entry, 100, { epoch: 0, width: 500 });
  assert.equal(store.mount(entry, { epoch: 0, width: 500 }).ok, true);
  assert.deepEqual(
    [...entry.querySelectorAll('[role]')].map((node) => node.getAttribute('aria-live')),
    ['off', 'off']
  );
});

test('serialized markup retention is bounded and reconstructs evicted rows from canonical markup', (t) => {
  const fixture = createFixture(3);
  t.after(() => fixture.dom.window.close());
  const rebuilt = [];
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
    budgets: { virtualizedMarkupEntries: 2 },
    requestEntryMarkup(entry) {
      rebuilt.push(entry.dataset.messageId);
      return `<div class="rebuilt">canonical-${entry.dataset.messageId}</div>`;
    },
  });

  fixture.entries.forEach((entry) => store.applyUnmount(entry, 100, { epoch: 0, width: 500 }));
  assert.equal(store.getStats().serializedMarkupEntries, 2);
  assert.equal(store.getRetentionMode(fixture.entries[0]), 'rebuild');
  assert.equal(store.mount(fixture.entries[0], { epoch: 0, width: 500 }).ok, true);
  assert.deepEqual(rebuilt, ['message-0']);
  assert.match(fixture.entries[0].textContent, /canonical-message-0/);
});

test('reconstruction failures leave readable fallbacks, redact diagnostics, and request bounded repeat recovery', (t) => {
  const fixture = createFixture(4);
  t.after(() => fixture.dom.window.close());
  const logs = [];
  let rerenders = 0;
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
    budgets: { virtualizedMarkupEntries: 1 },
    requestEntryMarkup() { throw new Error('G:\\private\\prompt.txt secret payload'); },
    requestCanonicalRerender() { rerenders += 1; },
    appendClientLog(level, event, details) { logs.push({ level, event, details }); },
  });
  fixture.entries.forEach((entry) => store.applyUnmount(entry, 100, { epoch: 0, width: 500 }));

  const first = store.mount(fixture.entries[0], { epoch: 0, width: 500 });
  const second = store.mount(fixture.entries[1], { epoch: 0, width: 500 });
  assert.equal(first.degraded, true);
  assert.equal(second.degraded, true);
  assert.equal(fixture.entries[0].getAttribute('data-virtualizer-fallback'), 'true');
  assert.equal(fixture.entries[0].querySelector('[role="note"]').textContent, FALLBACK_TEXT);
  assert.equal(rerenders, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    level: 'WARN',
    event: 'chat.timeline_virtualizer_rebuild_failed',
    details: { reason: 'threw', failureCount: 1 },
  });
  assert.equal(JSON.stringify(logs).includes('private'), false);
  assert.equal(store.getStats().rebuildFailureCount, 2);

  store.acknowledgeCanonicalRerender();
  const later = store.mount(fixture.entries[2], { epoch: 0, width: 500 });
  assert.equal(later.degraded, true);
  assert.equal(rerenders, 2, 'a completed recovery permits a later bounded repair request');
});

test('pruning and disposal release retained strong references and reset bounded stats', (t) => {
  const fixture = createFixture(2);
  t.after(() => fixture.dom.window.close());
  const input = fixture.document.createElement('input');
  fixture.entries[0].appendChild(input);
  const store = createTimelineVirtualizerEntryStore({
    chatTimeline: fixture.timeline,
    document: fixture.document,
    budgets: { virtualizedMarkupEntries: 2 },
  });
  store.applyUnmount(fixture.entries[0], 100, { epoch: 0, width: 500 });
  fixture.entries[0].remove();
  store.pruneIndexes();
  assert.equal(store.getStats().virtualizedEntries, 0);

  store.applyUnmount(fixture.entries[1], 100, { epoch: 0, width: 500 });
  store.dispose();
  assert.equal(store.getStats().virtualizedEntries, 0);
  assert.equal(store.getStats().serializedMarkupEntries, 0);
  assert.equal(store.has(fixture.entries[1]), false);
  assert.equal(store.mount(fixture.entries[1], { epoch: 0, width: 500 }).reason, 'unavailable');
});
