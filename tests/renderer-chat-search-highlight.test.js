const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  MAX_SEARCH_TOTAL_MATCHES,
  createSearchHighlightController,
  buildCanonicalSearchDocuments,
  findDocumentMatches,
} = require('../renderer/chat/renderer-chat-search-highlight');

/**
 * Shim CSS.highlights + Highlight on the JSDOM window. Production code
 * uses Electron 40 / Chromium 128+ which ships these natively; the shim
 * exists only so we can assert registration calls in unit tests.
 */
function shimCssHighlights(win) {
  win.CSS = win.CSS || {};
  win.CSS.highlights = new Map();
  win.Highlight = function Highlight() {
    this.ranges = Array.prototype.slice.call(arguments);
  };
}

function buildTimeline(html) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatTimeline" role="feed">' + html + '</div>'
    + '</body></html>');
  shimCssHighlights(dom.window);
  return {
    dom,
    timeline: dom.window.document.getElementById('chatTimeline'),
    controller: createSearchHighlightController({
      document: dom.window.document,
      chatTimeline: dom.window.document.getElementById('chatTimeline'),
      window: dom.window,
    }),
  };
}

const FIXTURE = ''
  + '<article class="chat-entry" data-message-id="m1"><div class="chat-bubble">Hello world. Hello again.</div></article>'
  + '<article class="chat-entry" data-message-id="m2"><div class="chat-bubble">A different MESSAGE here.</div></article>'
  + '<article class="chat-entry" data-message-id="m3"><div class="chat-bubble chat-bubble-streaming">streaming hello text</div></article>'
  + '<article class="chat-entry" data-message-id="m4"><div class="chat-bubble">word boundaries: helloween, hello, helloed.</div></article>';

test('scan finds case-insensitive substring matches across non-streaming entries (F1)', () => {
  const { controller } = buildTimeline(FIXTURE);
  const matches = controller.scan('hello');
  // Expected: m1: "Hello", "Hello" (2)  ; m4: "hello", "hello", "hello" (in helloween, hello, helloed) (3) — total 5
  assert.equal(matches.length, 5);
  assert.deepEqual(matches.map((m) => m.entryEl.getAttribute('data-message-id')), ['m1', 'm1', 'm4', 'm4', 'm4']);
});

test('scan skips hidden metadata, action chrome, and aria-hidden text inside chat entries', () => {
  const fixture = ''
    + '<article class="chat-entry" data-message-id="m1">'
    + '<div class="chat-bubble">visible needle</div>'
    + '<div data-search-skip="true">needle skip marker</div>'
    + '<div aria-hidden="true">needle aria hidden</div>'
    + '<button class="chat-hover-action">needle copy button</button>'
    + '<span class="tool-call-status-badge">needle status badge</span>'
    + '</article>';
  const { controller } = buildTimeline(fixture);

  const matches = controller.scan('needle');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].entryEl.getAttribute('data-message-id'), 'm1');
});

test('scan skips entries containing a streaming bubble (F1)', () => {
  const { controller } = buildTimeline(FIXTURE);
  const matches = controller.scan('hello');
  for (const m of matches) {
    assert.notEqual(m.entryEl.getAttribute('data-message-id'), 'm3', 'streaming entry should not contribute matches');
  }
});

test('case-sensitive flag honors casing (F1)', () => {
  const { controller } = buildTimeline(FIXTURE);
  const insensitive = controller.scan('hello').length;
  controller.clear();
  const sensitive = controller.scan('hello', { caseSensitive: true }).length;
  assert.equal(insensitive, 5);
  assert.equal(sensitive, 3, 'only lowercase "hello" hits in m4 — three of them');
});

test('whole-word flag matches only standalone tokens (F1)', () => {
  const { controller } = buildTimeline(FIXTURE);
  const matches = controller.scan('hello', { wholeWord: true });
  // Should hit "Hello" (m1, x2) and "hello" (m4, the standalone one) — 3 matches
  // (helloween / helloed have trailing word characters so they're excluded)
  assert.equal(matches.length, 3);
});

test('CSS.highlights registry receives the all-matches highlight (F1)', () => {
  const { controller, dom } = buildTimeline(FIXTURE);
  controller.scan('hello');
  const highlight = dom.window.CSS.highlights.get('chat-search-match');
  assert.ok(highlight, 'all-matches highlight should be registered');
  assert.equal(highlight.ranges.length, 5);
});

test('setCurrentIndex registers the current highlight separately (F1)', () => {
  const { controller, dom } = buildTimeline(FIXTURE);
  controller.scan('hello');
  controller.setCurrentIndex(0);
  let current = dom.window.CSS.highlights.get('chat-search-current');
  assert.ok(current, 'current-match highlight should be registered');
  assert.equal(current.ranges.length, 1);
  controller.setCurrentIndex(2);
  current = dom.window.CSS.highlights.get('chat-search-current');
  assert.equal(current.ranges.length, 1);
  assert.equal(controller.getCurrentIndex(), 2);
});

test('clear empties the registry and the matches list (F1)', () => {
  const { controller, dom } = buildTimeline(FIXTURE);
  controller.scan('hello');
  controller.setCurrentIndex(0);
  controller.clear();
  assert.equal(controller.getMatches().length, 0);
  assert.equal(dom.window.CSS.highlights.has('chat-search-match'), false);
  assert.equal(dom.window.CSS.highlights.has('chat-search-current'), false);
});

test('empty query produces no matches (F1)', () => {
  const { controller } = buildTimeline(FIXTURE);
  const matches = controller.scan('');
  assert.equal(matches.length, 0);
});

test('scan re-runs cleanly after a prior scan (F1)', () => {
  const { controller, dom } = buildTimeline(FIXTURE);
  controller.scan('hello');
  controller.scan('MESSAGE', { caseSensitive: true });
  assert.equal(controller.getMatches().length, 1);
  assert.equal(dom.window.CSS.highlights.get('chat-search-match').ranges.length, 1);
});

test('matches inside the search bar itself are excluded (F1)', () => {
  // Add a search bar with the data-search-skip marker and "hello" inside it.
  const fixture = FIXTURE
    + '<div class="chat-search-bar"><input data-search-skip="true" value="hello" /></div>';
  // Note: input.value is not in the DOM tree as text, but include the
  // skip marker on a wrapping element with text content too.
  const fixtureWithSkip = fixture + '<div class="chat-search-bar"><span data-search-skip="true">hello inside skip</span></div>';
  const { controller } = buildTimeline(fixtureWithSkip);
  const matches = controller.scan('hello');
  // Same 5 matches as before — the skip region should not contribute.
  assert.equal(matches.length, 5);
});

test('canonical search documents include bounded virtualized tool details', () => {
  const documents = buildCanonicalSearchDocuments([
    {
      id: 'tool-message', role: 'assistant', kind: 'tool_use',
      tool_call: { call_id: 'call-1', summary: 'Write report', input_json: 'x'.repeat(20_000) },
    },
  ], { turnEvents: [] });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].field, 'tool_detail');
  assert.equal(documents[0].toolCallId, 'call-1');
  assert.equal(documents[0].text.length, 10_000);
  const matches = findDocumentMatches(documents, 'Write report');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].messageId, 'tool-message');
  assert.equal(matches[0].start, 0);
});

test('paired tool-result documents target the rendered tool-use article', () => {
  const documents = buildCanonicalSearchDocuments([
    { id: 'user-1', role: 'user', content: 'run it' },
    { id: 'tool-use-1', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call-1', input_json: '{}' } },
    { id: 'tool-result-1', role: 'assistant', kind: 'tool_result', tool_result: { call_id: 'call-1', output_text: 'result-only needle' } },
  ], { turnEvents: [] });
  const match = findDocumentMatches(documents, 'result-only needle')[0];
  assert.equal(match.messageId, 'tool-use-1');
  assert.equal(match.toolCallId, 'call-1');
});

test('whole-word document search handles punctuation and alphanumeric query edges', () => {
  const documents = [{
    messageId: 'm1',
    text: 'Use C++ locally, follow #tag, but skip C++17, x#tag, and helloworld.',
  }];

  assert.deepEqual(
    findDocumentMatches(documents, 'C++', { wholeWord: true }).map((match) => match.start),
    [4]
  );
  assert.deepEqual(
    findDocumentMatches(documents, '#tag', { wholeWord: true }).map((match) => match.start),
    [24]
  );
  assert.equal(findDocumentMatches(documents, 'hello', { wholeWord: true }).length, 0);
  assert.equal(findDocumentMatches([{ messageId: 'm2', text: 'say hello now' }], 'hello', { wholeWord: true }).length, 1);
});

test('canonical binding selects the recorded occurrence instead of the first DOM match', () => {
  const { controller, dom } = buildTimeline(
    '<article class="chat-entry" data-message-id="m1"><span>needle needle</span></article>'
  );
  controller.scanDocuments([{ messageId: 'm1', text: 'needle needle', field: 'message' }], 'needle');
  controller.setCurrentIndex(1);

  const bound = controller.bindCurrentToEntry(
    dom.window.document.querySelector('.chat-entry'),
    'needle'
  );

  assert.equal(bound.occurrenceInDocument, 1);
  assert.equal(bound.range.startOffset, 7);
});

test('tool-detail binding scopes the selected occurrence to the matching tool row', () => {
  const { controller, dom } = buildTimeline(
    '<article class="chat-entry" data-message-id="m1">'
      + '<span>needle outside</span>'
      + '<div class="tool-call-row tool-call-row--minimal" data-tool-call-id="call-1">'
      + '<div class="tool-call-row-body"><span>needle inside</span></div></div>'
      + '</article>'
  );
  controller.scanDocuments([{
    messageId: 'm1', text: 'needle inside', field: 'tool_detail', toolCallId: 'call-1',
  }], 'needle');
  controller.setCurrentIndex(0);
  const entry = dom.window.document.querySelector('.chat-entry');
  const scopeEl = entry.querySelector('.tool-call-row--minimal');

  const bound = controller.bindCurrentToEntry(
    entry,
    'needle',
    {},
    { scopeEl }
  );

  assert.equal(bound.range.startContainer.parentElement.textContent, 'needle inside');
});

// ---- Scroll-program W2b: global match cap ----------------------------------
// Only MAX_SEARCH_FIELD_CHARS (per field) bounds search today. A hostile or
// merely huge conversation can yield tens of thousands of matches; the legacy
// DOM path allocates a live Range per match (the review's probe measured
// ~78 MiB). W2b adds a global cap (500), stops SCANNING at the cap on both
// the canonical and legacy paths, and surfaces an explicit omitted state.

test('findDocumentMatches stops scanning documents at the global match cap', () => {
  assert.equal(MAX_SEARCH_TOTAL_MATCHES, 500, 'the cap is a fixed exported constant');
  const scanned = new Set();
  const documents = [];
  for (let i = 0; i < 600; i += 1) {
    documents.push({
      messageId: `m${i}`,
      toolCallId: '',
      turnId: '',
      field: 'message',
      get text() { scanned.add(i); return 'needle'; },
    });
  }

  const matches = findDocumentMatches(documents, 'needle', {});

  assert.equal(matches.length, MAX_SEARCH_TOTAL_MATCHES, 'matches beyond the cap are not collected');
  assert.ok(
    scanned.size < 600,
    `documents past the cap must not even be read (scanned ${scanned.size} of 600)`
  );
});

test('legacy DOM scan stops allocating ranges at the global match cap', () => {
  const bubble = Array(200).fill('needle').join(' ');
  const fixture = [1, 2, 3].map((n) => (
    `<article class="chat-entry" data-message-id="mm${n}"><div class="chat-bubble">${bubble}</div></article>`
  )).join('');
  const { dom, controller } = buildTimeline(fixture);
  const doc = dom.window.document;
  let ranges = 0;
  const realCreateRange = doc.createRange.bind(doc);
  doc.createRange = () => { ranges += 1; return realCreateRange(); };

  const matches = controller.scan('needle');

  assert.equal(matches.length, MAX_SEARCH_TOTAL_MATCHES, '600 occurrences must clamp to the cap');
  // 400 matches come from the first two entries; without a mid-entry stop the
  // third entry would allocate 200 more Ranges. (TreeWalker counts are NOT
  // asserted — jsdom's selector engine creates walkers internally.)
  assert.ok(ranges <= MAX_SEARCH_TOTAL_MATCHES, `live Ranges are the memory cost (allocated ${ranges})`);
});

test('the controller reports whether the last scan was truncated', () => {
  assert.equal(typeof createSearchHighlightController({}).wasTruncated, 'function');
  const { controller } = buildTimeline(FIXTURE);
  controller.scan('hello');
  assert.equal(controller.wasTruncated(), false, 'five matches is nowhere near the cap');

  const documents = [];
  for (let i = 0; i < 600; i += 1) {
    documents.push({ messageId: `m${i}`, toolCallId: '', turnId: '', field: 'message', text: 'needle' });
  }
  controller.scanDocuments(documents, 'needle', {});
  assert.equal(controller.wasTruncated(), true, 'an at-cap result reports the omitted state');
});
