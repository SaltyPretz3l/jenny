// new-test-file: the article-markup test file is at the 600-line cap; this covers a new surface (row 192 outcomes line).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createArticleMarkupPipeline } = require('../renderer/chat/renderer-render-pipeline-article-markup');
const stringUtils = require('../renderer/shared/string-utils');

// Row 192 C8/C9: the outcomes line under a settled answer, from the turn's own view model (the ledger the Changes
// tab reads) and the change pictures already held in memory; and the details line on a failed-before-text turn.
const editCall = (id, path, state = 'completed') => ({ toolCallId: id, toolName: 'Edit', state, resultMetadata: { diff: { path } } });

function buildOutcomesArticle({ toolCalls = [], liveTurnId = '', rows = null, features = {} } = {}) {
  const pipeline = createArticleMarkupPipeline({
    state: { currentSessionId: 'session-42', ui: {}, features: { featureFlags: features } },
    callbacks: {
      escapeHtml: stringUtils.escapeHtml,
      buildTurnRowListMarkup: () => '<div class="turn-row-list" data-turn-row-list="true"></div>',
      buildMessageShellArticle: ({ innerHtml }) => innerHtml,
      renderMessageHoverRow: (message) => `<div class="chat-hover-row" data-hover-row="true" data-message-id="${message.id}"></div>`,
    },
  });
  const html = pipeline.buildTurnArticleMarkup(
    { turn_id: 'turn-1', source_message_ids: ['assistant-1'] },
    rows || [{ row_id: 'row-t', turn_id: 'turn-1', kind: 'assistant_text', primary_message_id: 'assistant-1' }],
    [],
    { projectionContext: { liveTurnId, viewModelByTurnId: new Map([['turn-1', { turnId: 'turn-1', toolCalls }]]) } }
  );
  return new JSDOM(`<div id="chatTimeline">${html}</div>`).window.document;
}

function installPictures(t, pages) {
  const previous = { pictures: global.rendererChangePictures, model: global.rendererChangePicturesModel };
  t.after(() => {
    if (previous.pictures === undefined) delete global.rendererChangePictures; else global.rendererChangePictures = previous.pictures;
    if (previous.model === undefined) delete global.rendererChangePicturesModel; else global.rendererChangePicturesModel = previous.model;
  });
  const asked = [];
  global.rendererChangePicturesModel = require('../renderer/features/renderer-change-pictures-model');
  global.rendererChangePictures = { getShared: () => ({ cache: {
    isDisabled: () => false,
    peek: (sessionId, turnId, viewport) => { asked.push([sessionId, turnId, viewport]); return { record: pages ? { pages } : null }; },
  } }) };
  return asked;
}

test('a settled turn with text only renders no outcomes line and keeps its details line', () => {
  const doc = buildOutcomesArticle();
  assert.equal(doc.querySelector('.turn-outcomes'), null);
  assert.ok(doc.querySelector('.chat-hover-row'));
});

test('the outcomes line counts the files the turn changed and sits above the details line', () => {
  const doc = buildOutcomesArticle({ toolCalls: [editCall('c1', 'src/a.js'), editCall('c2', 'src/b.js'), editCall('c3', 'src/a.js'), editCall('c4', 'src/c.js', 'errored')] });
  const line = doc.querySelector('.turn-outcomes');
  assert.ok(line, 'a turn that changed files renders the line');
  assert.equal(line.getAttribute('role'), 'group');
  assert.equal(line.getAttribute('aria-label'), 'What this turn left behind');
  const links = [...line.querySelectorAll('button.turn-outcome-link')];
  assert.deepEqual(links.map((link) => link.textContent), ['2 files changed'], 'a file edited twice counts once; a failed edit not at all');
  assert.equal(links[0].dataset.turnOutcome, 'changes');
  assert.equal(links[0].dataset.turnId, 'turn-1');
  assert.equal(line.querySelector('.turn-outcome-sep'), null, 'one link, no separator');
  assert.ok(line.compareDocumentPosition(doc.querySelector('.chat-hover-row')) & 4, 'the details line follows the outcomes line');
  assert.equal(buildOutcomesArticle({ toolCalls: [editCall('c1', 'index.html')] }).querySelector('.turn-outcome-link').textContent, '1 file changed');
});

test('the outcomes line names the change pictures already in memory, and none when the feature is off', (t) => {
  const asked = installPictures(t, [{ path: 'index.html', state: 'ready' }]);
  const toolCalls = [editCall('c1', 'index.html'), editCall('c2', 'styles.css')];
  const line = buildOutcomesArticle({ toolCalls }).querySelector('.turn-outcomes');
  const links = [...line.querySelectorAll('button.turn-outcome-link')];
  assert.deepEqual(links.map((link) => link.textContent), ['2 files changed', '1 picture of the changed page']);
  assert.equal(links[1].dataset.turnOutcome, 'pictures');
  assert.equal(line.querySelectorAll('.turn-outcome-sep').length, 1);
  assert.equal(line.querySelector('.turn-outcome-sep').getAttribute('aria-hidden'), 'true');
  assert.deepEqual(asked[0], ['session-42', 'turn-1', 'desktop']);
  const off = buildOutcomesArticle({ toolCalls, features: { change_pictures: false } });
  assert.deepEqual([...off.querySelectorAll('.turn-outcome-link')].map((link) => link.textContent), ['2 files changed']);
});

test('a running turn renders neither the outcomes line nor the details line', () => {
  const doc = buildOutcomesArticle({ toolCalls: [editCall('c1', 'src/a.js')], liveTurnId: 'turn-1' });
  assert.equal(doc.querySelector('.turn-outcomes'), null);
  assert.equal(doc.querySelector('.chat-hover-row'), null);
});

test('a turn whose only row is its error card renders the details line', () => {
  const doc = buildOutcomesArticle({ rows: [{ row_id: 'row-e', turn_id: 'turn-1', kind: 'system_notice', primary_message_id: 'assistant-1', payload: { subkind: 'assistant_error' } }] });
  assert.ok(doc.querySelector('.chat-hover-row'));
  assert.equal(doc.querySelector('.turn-outcomes'), null);
});

test('an outcome link opens the Changes tab on its turn through the existing review action', async (t) => {
  installPictures(t, [{ path: 'index.html', state: 'new' }]);
  const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
  const doc = buildOutcomesArticle({ toolCalls: [editCall('c1', 'index.html')] });
  const chatTimeline = doc.getElementById('chatTimeline');
  const calls = [];
  const bindings = createTranscriptEventBindings({
    chatTimeline, state: {}, handleCodeReviewAction: async (payload) => calls.push(payload),
    appendClientLog: () => {}, showComposerActionError: () => {}, resolveToolCallId: () => '', thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  for (const link of chatTimeline.querySelectorAll('.turn-outcome-link')) {
    const event = new doc.defaultView.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  await Promise.resolve();
  assert.deepEqual(calls.map(({ scope, turnId }) => ({ scope, turnId })), [{ scope: 'turn', turnId: 'turn-1' }, { scope: 'turn', turnId: 'turn-1' }]);
});
