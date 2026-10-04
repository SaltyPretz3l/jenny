const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const markdownUtils = require('../renderer/shared/markdown-utils');
const { createChatSearchOverlay } = require('../renderer/chat/renderer-chat-search-overlay');
const {
  buildCanonicalSearchDocuments,
  createSearchHighlightController,
  createVisibleTextProvider,
  findDocumentMatches,
} = require('../renderer/chat/renderer-chat-search-highlight');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

// CTR-003 / CTR-004 / CTR-009: canonical search documents carry what the user
// can see (rendered Markdown, not source), nothing is silently cut at 10,000
// characters, and a canonical match binds inside the row of its own message.

function installMarkdown(t) {
  const previous = globalThis.markdownUtils;
  globalThis.markdownUtils = markdownUtils;
  t.after(() => {
    if (previous === undefined) delete globalThis.markdownUtils;
    else globalThis.markdownUtils = previous;
  });
}

function shimCssHighlights(win) {
  win.CSS = win.CSS || {};
  win.CSS.highlights = new Map();
  win.Highlight = function Highlight() {
    this.ranges = Array.prototype.slice.call(arguments);
  };
}

function proseRow(sourceId, content, options) {
  const opts = options || {};
  const kind = opts.kind || 'assistant_text';
  const html = markdownUtils.renderMarkdown(content, opts.breaks ? { breaks: true } : undefined);
  return '<div class="chat-row" data-row-id="row-' + sourceId + '" data-row-kind="' + kind + '"'
    + ' data-source-message-id="' + sourceId + '" data-source-message-ids="' + sourceId + '">'
    + '<div class="chat-bubble chat-bubble-markdown" dir="auto">' + html + '</div></div>';
}

function article(ownerId, role, rowsHtml) {
  return '<article class="chat-entry" data-message-id="' + ownerId + '" data-message-role="' + role + '" tabindex="-1">'
    + rowsHtml + '</article>';
}

function buildEnv(t, timelineHtml, extraOptions) {
  installMarkdown(t);
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<div id="chatView"><div id="chatTimeline" role="feed">' + (timelineHtml || '') + '</div></div>'
    + '</body></html>');
  shimCssHighlights(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const reveals = [];
  const overlay = createChatSearchOverlay({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    chatView: dom.window.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    viewportReveal: { revealElement(el) { reveals.push(el); } },
    getSessionTurnEventState: () => ({ turnEvents: [] }),
    ...(extraOptions || {}),
  });
  t.after(() => overlay.dispose());
  overlay.attach();
  overlay.open();
  const win = dom.window;
  const input = win.document.querySelector('.chat-search-bar-input');
  const count = win.document.querySelector('.chat-search-bar-count');
  return {
    dom, overlay, reveals, count,
    current: () => win.CSS.highlights.get('chat-search-current'),
    async search(query, expectedCount) {
      input.value = query;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      await waitForUiState(win, () => count.textContent === expectedCount, {
        message: 'search count never reached "' + expectedCount + '" (was "' + count.textContent + '")',
      });
    },
    next() {
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    },
  };
}

test('CTR-009: a phrase matches across inline nodes and binds a range spanning them', async (t) => {
  const env = buildEnv(t, article('a1', 'assistant', proseRow('a1', 'Hello **world**')), {
    getCurrentSessionMessages: () => [
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a1', role: 'assistant', content: 'Hello **world**' },
    ],
  });
  await env.search('Hello world', '1 of 1');
  const range = env.current().ranges[0];
  assert.equal(range.toString(), 'Hello world');
  assert.notEqual(range.startContainer, range.endContainer, 'the range spans the text node and the strong node');
});

test('CTR-009: text that exists only in a link destination is not a match', async (t) => {
  const env = buildEnv(t, article('a1', 'assistant', proseRow('a1', '[Docs](https://x/secret-path)')), {
    getCurrentSessionMessages: () => [{ id: 'a1', role: 'assistant', content: '[Docs](https://x/secret-path)' }],
  });
  await env.search('secret-path', 'No matches');
  await env.search('Docs', '1 of 1');
});

test('CTR-009: entities, escapes and inline code match their visible text', (t) => {
  installMarkdown(t);
  const provider = createVisibleTextProvider({ document: new JSDOM('').window.document });
  const messages = [
    { id: 'm1', role: 'assistant', content: 'a &amp; b' },
    { id: 'm2', role: 'assistant', content: '1 \\* 2' },
    { id: 'm3', role: 'assistant', content: 'run `npm test` now' },
  ];
  const documents = buildCanonicalSearchDocuments(messages, { turnEvents: [] }, { toVisibleText: provider.toVisibleText });
  assert.equal(findDocumentMatches(documents, 'a & b').length, 1);
  assert.equal(findDocumentMatches(documents, 'amp;').length, 0);
  assert.equal(findDocumentMatches(documents, '1 * 2').length, 1);
  assert.equal(findDocumentMatches(documents, '\\*').length, 0);
  assert.equal(findDocumentMatches(documents, 'run npm test now').length, 1);
  assert.equal(findDocumentMatches(documents, '`').length, 0);
});

test('CTR-009: a phrase does not match across block boundaries', (t) => {
  installMarkdown(t);
  const provider = createVisibleTextProvider({ document: new JSDOM('').window.document });
  const documents = buildCanonicalSearchDocuments(
    [{ id: 'm1', role: 'assistant', content: 'first paragraph\n\nsecond paragraph\n\n- item one\n- item two' }],
    { turnEvents: [] },
    { toVisibleText: provider.toVisibleText }
  );
  assert.equal(findDocumentMatches(documents, 'paragraph second').length, 0);
  assert.equal(findDocumentMatches(documents, 'paragraphsecond').length, 0);
  assert.equal(findDocumentMatches(documents, 'item one').length, 1);
  assert.equal(findDocumentMatches(documents, 'one item').length, 0);
});

test('CTR-009: visible text is cached per message and re-rendered only when its source changes', (t) => {
  installMarkdown(t);
  let renders = 0;
  const provider = createVisibleTextProvider({
    document: new JSDOM('').window.document,
    renderMarkdown: (source, options) => { renders += 1; return markdownUtils.renderMarkdown(source, options); },
  });
  const message = { id: 'm1', role: 'assistant', content: 'cached **text**' };
  assert.equal(provider.toVisibleText(message), 'cached text');
  assert.equal(provider.toVisibleText({ ...message }), 'cached text');
  assert.equal(renders, 1, 'an unchanged message is not re-rendered');
  assert.equal(provider.toVisibleText({ ...message, content: 'changed' }), 'changed');
  assert.equal(renders, 2, 'a changed source string re-renders');
  provider.clear();
  provider.toVisibleText({ ...message, content: 'changed' });
  assert.equal(renders, 3, 'clear() drops the cache');
});

test('CTR-009: the visible-text cache is bounded', (t) => {
  installMarkdown(t);
  let renders = 0;
  const provider = createVisibleTextProvider({
    document: new JSDOM('').window.document,
    renderMarkdown: (source, options) => { renders += 1; return markdownUtils.renderMarkdown(source, options); },
  });
  for (let index = 0; index < 700; index += 1) {
    provider.toVisibleText({ id: 'bounded-' + index, role: 'assistant', content: 'text ' + index });
  }
  assert.equal(renders, 700);
  provider.toVisibleText({ id: 'bounded-0', role: 'assistant', content: 'text 0' });
  assert.equal(renders, 701, 'the oldest entry was evicted past the bound');
  provider.toVisibleText({ id: 'bounded-699', role: 'assistant', content: 'text 699' });
  assert.equal(renders, 701, 'a recent entry is still cached');
});

test('CTR-004: a coalesced second assistant message binds inside its own row', async (t) => {
  const rows = proseRow('a1', 'needle in the first message') + proseRow('a2', 'needle in the second message');
  const env = buildEnv(t, article('a1', 'assistant', rows), {
    getCurrentSessionMessages: () => [
      { id: 'u1', role: 'user', content: 'go' },
      { id: 'a1', role: 'assistant', content: 'needle in the first message' },
      { id: 'a2', role: 'assistant', content: 'needle in the second message' },
    ],
  });
  await env.search('needle', '1 of 2');
  const first = env.current().ranges[0];
  assert.equal(first.startContainer.parentElement.closest('.chat-row').getAttribute('data-source-message-id'), 'a1');

  env.next();
  const second = env.current().ranges[0];
  assert.equal(env.count.textContent, '2 of 2');
  assert.equal(second.startContainer.parentElement.closest('.chat-row').getAttribute('data-source-message-id'), 'a2');
  assert.equal(second.toString(), 'needle');
});

test('CTR-004: with no matching row the current highlight is cleared and the article is still revealed', async (t) => {
  const rows = proseRow('a1', 'needle in the first message') + proseRow('a2', 'nothing relevant here');
  const env = buildEnv(t, article('a1', 'assistant', rows), {
    getCurrentSessionMessages: () => [
      { id: 'a1', role: 'assistant', content: 'needle in the first message' },
      { id: 'a2', role: 'assistant', content: 'needle in the second message' },
    ],
  });
  await env.search('needle', '1 of 2');
  assert.ok(env.current(), 'the first match binds');
  env.reveals.length = 0;

  env.next();
  assert.equal(env.count.textContent, '2 of 2');
  assert.equal(env.current(), undefined, 'a second row with fewer matches must not borrow another passage');
  assert.equal(env.reveals.length > 0, true, 'the article is still revealed');
});

test('CTR-004: a source id missing from the mounted article clears the highlight instead of borrowing', async (t) => {
  const env = buildEnv(t, article('a1', 'assistant', proseRow('a1', 'needle in the first message')), {
    getCurrentSessionMessages: () => [
      { id: 'a1', role: 'assistant', content: 'needle in the first message' },
      { id: 'a2', role: 'assistant', content: 'needle in the second message' },
    ],
  });
  await env.search('needle', '1 of 2');
  env.next();
  assert.equal(env.current(), undefined);
});

test('CTR-004: a match in a not-yet-mounted entry binds once the virtualizer mounts it', async (t) => {
  const placeholder = '<article class="chat-entry" data-message-id="a1" data-virtualized="true"><div class="chat-entry-virtualized"></div></article>';
  const mounted = [];
  let timeline = null;
  const env = buildEnv(t, placeholder, {
    virtualizer: {
      ensureMountedForMessageId(messageId) {
        mounted.push(messageId);
        const entry = timeline.querySelector('[data-message-id="' + messageId + '"]');
        entry.removeAttribute('data-virtualized');
        entry.setAttribute('data-message-role', 'assistant');
        entry.innerHTML = proseRow('a1', 'virtual **needle** text');
        return true;
      },
    },
    getCurrentSessionMessages: () => [{ id: 'a1', role: 'assistant', content: 'virtual **needle** text' }],
  });
  timeline = env.dom.window.document.getElementById('chatTimeline');
  await env.search('virtual needle', '1 of 1');
  assert.deepEqual(mounted, ['a1']);
  assert.equal(env.current().ranges[0].toString(), 'virtual needle');
});

test('CTR-004: user bubbles are indexed as rendered text with their own breaks setting', async (t) => {
  const env = buildEnv(t, article('u1', 'user', proseRow('u1', 'alpha\nbeta *gamma*', { kind: 'user_bubble', breaks: true })), {
    getCurrentSessionMessages: () => [{ id: 'u1', role: 'user', content: 'alpha\nbeta *gamma*' }],
  });
  await env.search('alpha', '1 of 1');
  await env.search('alpha beta', 'No matches');
  await env.search('beta gamma', '1 of 1');
  assert.equal(env.current().ranges[0].toString(), 'beta gamma');
});

test('CTR-003: no field is silently cut at 10,000 characters', () => {
  const longReply = 'filler '.repeat(3000) + 'late-reply-phrase';
  const longOutput = 'out '.repeat(6000) + 'late-output-phrase';
  const documents = buildCanonicalSearchDocuments([
    { id: 'u1', role: 'user', content: 'go' },
    { id: 'a1', role: 'assistant', content: longReply },
    { id: 'a2', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c1', summary: 'run', input_json: '{}' } },
    { id: 'a3', role: 'assistant', kind: 'tool_result', tool_result: { call_id: 'c1', output_text: longOutput } },
  ], { turnEvents: [] });

  assert.equal(documents.find((document) => document.field === 'message' && document.text.length > 10000).text.length, longReply.length);
  assert.equal(findDocumentMatches(documents, 'late-reply-phrase').length, 1);
  assert.equal(findDocumentMatches(documents, 'late-output-phrase').length, 1);
});

test('CTR-003: only the 500-match cap sets the truncated state', () => {
  const controller = createSearchHighlightController({});
  const huge = 'a '.repeat(20000) + 'tail-needle';
  controller.scanDocuments([{ messageId: 'm1', text: huge, field: 'message' }], 'tail-needle');
  assert.equal(controller.getMatches().length, 1);
  assert.equal(controller.wasTruncated(), false);
  controller.scanDocuments([{ messageId: 'm1', text: 'needle '.repeat(600), field: 'message' }], 'needle');
  assert.equal(controller.wasTruncated(), true);
});

test('CTR-003: identical documents still de-duplicate and distinct texts for the same ids are kept', () => {
  const events = (text) => ({ turnEvents: [{ kind: 'tool_result', primary_message_id: 'a2', tool_call_id: 'c1', payload: { output_text: text } }] });
  const messages = [
    { id: 'a2', role: 'assistant', kind: 'tool_result', tool_result: { call_id: 'c1', output_text: 'same output' } },
  ];
  assert.equal(buildCanonicalSearchDocuments(messages, events('same output')).length, 1, 'event copy of the message text collapses');
  assert.equal(buildCanonicalSearchDocuments(messages, events('different output')).length, 2);
});

test('CTR-009: documents default to raw content when no visible-text function is given and record the source message id', () => {
  const documents = buildCanonicalSearchDocuments([
    { id: 'u1', role: 'user', content: 'go' },
    { id: 'a1', role: 'assistant', content: 'one **two**' },
    { id: 'a2', role: 'assistant', content: 'second' },
  ], { turnEvents: [] });
  assert.deepEqual(documents.map((document) => [document.messageId, document.sourceMessageId, document.text]), [
    ['u1', 'u1', 'go'],
    ['a1', 'a1', 'one **two**'],
    ['a1', 'a2', 'second'],
  ]);
});

// Review follow-ups: binding outside prose rows, per-row-group ordinals, and a
// cache that holds the searched session.

function plainRow(sourceId, kind, text) {
  return '<div class="chat-row" data-row-kind="' + kind + '" data-source-message-id="' + sourceId + '"'
    + ' data-source-message-ids="' + sourceId + '"><div class="row-body">' + text + '</div></div>';
}

test('CTR-004: a message shown only in a non-prose row (a plan document) still binds its match', async (t) => {
  const env = buildEnv(t, article('p1', 'assistant', plainRow('p1', 'plan_document', 'the needle plan')), {
    getCurrentSessionMessages: () => [
      { id: 'u1', role: 'user', content: 'plan it' },
      { id: 'p1', role: 'assistant', content: 'the needle plan' },
    ],
  });
  await env.search('needle', '1 of 1');
  const range = env.current().ranges[0];
  assert.equal(range.toString(), 'needle');
  assert.equal(range.startContainer.parentElement.closest('.chat-row').getAttribute('data-row-kind'), 'plan_document');
});

test('CTR-005: two events of one message bind to their own passages, in order', async (t) => {
  const rows = plainRow('a1', 'reasoning', 'needle in the first phase')
    + plainRow('a1', 'reasoning', 'needle in the second phase')
    + proseRow('a1', 'the answer');
  const env = buildEnv(t, article('a1', 'assistant', rows), {
    getCurrentSessionMessages: () => [
      { id: 'u1', role: 'user', content: 'go' },
      { id: 'a1', role: 'assistant', content: 'the answer' },
    ],
    getSessionTurnEventState: () => ({
      turnEvents: [
        { kind: 'reasoning_phase', turn_id: 't1', primary_message_id: 'a1', payload: { summary: 'needle in the first phase' } },
        { kind: 'reasoning_phase', turn_id: 't1', primary_message_id: 'a1', payload: { summary: 'needle in the second phase' } },
      ],
    }),
  });
  await env.search('needle', '1 of 2');
  assert.equal(env.current().ranges[0].startContainer.textContent, 'needle in the first phase');
  env.next();
  assert.equal(env.count.textContent, '2 of 2');
  assert.equal(env.current().ranges[0].startContainer.textContent, 'needle in the second phase', 'the second event is not bound to the first passage');
});

test('CTR-005: an event whose text another event contains is still its own document; an exact repeat is not', () => {
  const messages = [{ id: 'u1', role: 'user', content: 'go' }, { id: 'a1', role: 'assistant', content: 'done' }];
  const event = (summary) => ({ kind: 'notice', turn_id: 't1', primary_message_id: 'a1', payload: { summary } });
  const documents = buildCanonicalSearchDocuments(messages, {
    turnEvents: [event('Checked files again'), event('Checked files'), event('Checked files')],
  });
  const matches = findDocumentMatches(documents, 'Checked files');
  assert.deepEqual(matches.map((match) => match.occurrenceInDocument), [0, 1], 'two passages, numbered across the documents of one row group');
  assert.equal(matches[0].bindGroup, matches[1].bindGroup);
});

test('CTR-009: the cache holds a session larger than its default bound once reserved', (t) => {
  installMarkdown(t);
  let renders = 0;
  const provider = createVisibleTextProvider({
    document: new JSDOM('').window.document,
    renderMarkdown: (source, options) => { renders += 1; return markdownUtils.renderMarkdown(source, options); },
  });
  const messages = [];
  for (let index = 0; index < 600; index += 1) messages.push({ id: 'long-' + index, role: 'assistant', content: 'text ' + index });
  provider.reserve(messages.length);
  messages.forEach((message) => provider.toVisibleText(message));
  messages.forEach((message) => provider.toVisibleText(message));
  assert.equal(renders, 600, 'a second pass over the session renders nothing');
});

test('CTR-009: a second search over a 600-message session re-renders no message', async (t) => {
  const messages = [];
  for (let index = 0; index < 600; index += 1) messages.push({ id: 'm' + index, role: index % 2 ? 'assistant' : 'user', content: 'entry ' + index });
  const env = buildEnv(t, '', { getCurrentSessionMessages: () => messages });
  let renders = 0;
  globalThis.markdownUtils = { ...markdownUtils, renderMarkdown: (source, options) => { renders += 1; return markdownUtils.renderMarkdown(source, options); } };
  await env.search('entry 599', '1 of 1');
  assert.equal(renders, 600);
  await env.search('entry 598', '1 of 1');
  assert.equal(renders, 600, 'the overlay reserved the cache for the whole session');
});

// Search polish: a closed disclosure around the match opens for it and closes
// again when the search moves on or closes, unless the reader took it over.

function disclosureRow(sourceId, text) {
  return '<div class="chat-row" data-row-kind="assistant_text" data-source-message-id="' + sourceId + '"'
    + ' data-source-message-ids="' + sourceId + '"><details><summary>More</summary><p>' + text + '</p></details></div>';
}

function disclosureEnv(t) {
  const rows = disclosureRow('a1', 'needle inside the first disclosure') + disclosureRow('a2', 'needle inside the second disclosure');
  const env = buildEnv(t, article('a1', 'assistant', rows), {
    // "More" is the summary, part of the visible text of each message.
    getCurrentSessionMessages: () => [
      { id: 'u1', role: 'user', content: 'go' },
      { id: 'a1', role: 'assistant', content: 'More\n\nneedle inside the first disclosure' },
      { id: 'a2', role: 'assistant', content: 'More\n\nneedle inside the second disclosure' },
    ],
  });
  const [first, second] = env.dom.window.document.querySelectorAll('details');
  return { env, first, second };
}

test('search opens a closed disclosure around the current match and closes it when the match moves on', async (t) => {
  const { env, first, second } = disclosureEnv(t);
  await env.search('needle', '1 of 2');
  assert.deepEqual([first.open, second.open], [true, false], 'the first match is revealed');
  env.next();
  assert.deepEqual([first.open, second.open], [false, true], 'the disclosure search opened closes when the match leaves it');
  env.overlay.close();
  assert.deepEqual([first.open, second.open], [false, false], 'closing the search restores what it opened');
});

test('a disclosure the reader toggles during search is left as the reader set it', async (t) => {
  const { env, first } = disclosureEnv(t);
  const win = env.dom.window;
  await env.search('needle', '1 of 2');
  assert.equal(first.open, true);
  first.querySelector('summary').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  first.open = true; // the reader closed and reopened it: theirs now
  env.overlay.close();
  assert.equal(first.open, true, 'search does not close a disclosure the reader took over');
});

test('a disclosure that was already open stays open after the search closes', async (t) => {
  const { env, first } = disclosureEnv(t);
  first.open = true;
  await env.search('needle', '1 of 2');
  env.overlay.close();
  assert.equal(first.open, true);
});
