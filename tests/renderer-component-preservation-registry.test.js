'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createComponentPreservationRegistry,
} = require('../renderer/chat/renderer-component-preservation-registry');
const {
  setChildrenHtmlPreservingKeyedNodes,
} = require('../renderer/chat/renderer-stream-dom-patch-utils');
const { renderUserQuestionsBlock } = require('../renderer/chat/renderer-user-questions-block');

function renderQuestions(questionRef = 'question-ref') {
  return renderUserQuestionsBlock({
    toolCallId: 'call-1',
    questionRef,
    questions: [
      { id: 'single', prompt: 'Pick one', options: ['Alpha', 'Beta'], multi_select: false, allow_other: false },
      { id: 'multi', prompt: 'Pick many', options: ['One', 'Two'], multi_select: true, allow_other: true },
      { id: 'free', prompt: 'Notes', options: [], multi_select: false, allow_other: false },
    ],
  });
}

test('structural morph retains media, code, and Mermaid component identity by source', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">
    <article data-message-id="m1">
      <div class="markdown-code-block collapsed"><code>const value = 1;</code></div>
      <div class="markdown-mermaid-block" data-mermaid-source="graph TD;A--&gt;B" data-mermaid-rendered="true">
        <div class="markdown-mermaid-preview"><div class="mermaid-viewport"><svg style="transform:scale(1.6) translate(4px, 8px)"></svg></div></div>
      </div>
      <audio data-attachment-id="audio-1" src="asset://reply.wav"></audio>
      <p>old</p>
    </article>
  </div></body>`);
  const root = dom.window.document.getElementById('root');
  const code = root.querySelector('.markdown-code-block');
  const mermaid = root.querySelector('.markdown-mermaid-block');
  const media = root.querySelector('audio');
  media.currentTime = 19;
  let plays = 0;
  media.addEventListener('play', () => { plays += 1; });

  const patched = setChildrenHtmlPreservingKeyedNodes(root, `
    <article data-message-id="m1">
      <div class="markdown-code-block"><code>const value = 1;</code></div>
      <div class="markdown-mermaid-block" data-mermaid-source="graph TD;A--&gt;B"><div class="markdown-mermaid-preview"></div></div>
      <audio data-attachment-id="audio-1" src="asset://reply.wav"></audio>
      <p>new</p>
    </article>`);

  assert.equal(patched, true);
  assert.strictEqual(root.querySelector('.markdown-code-block'), code);
  assert.strictEqual(root.querySelector('.markdown-mermaid-block'), mermaid);
  assert.strictEqual(root.querySelector('audio'), media);
  assert.equal(media.currentTime, 19);
  assert.equal(root.querySelector('svg').style.transform, 'scale(1.6) translate(4px, 8px)');
  media.dispatchEvent(new dom.window.Event('play'));
  assert.equal(plays, 1, 'direct listeners survive because the media node identity survives');
  assert.equal(root.querySelector('p').textContent, 'new', 'generated non-component markup remains authoritative');
});

test('changed component source resets safely instead of retaining stale runtime state', () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"><audio src="asset://old.wav"></audio></div></body>');
  const root = dom.window.document.getElementById('root');
  const oldMedia = root.querySelector('audio');
  oldMedia.currentTime = 11;

  setChildrenHtmlPreservingKeyedNodes(root, '<audio src="asset://new.wav"></audio>');

  assert.notStrictEqual(root.querySelector('audio'), oldMedia);
  assert.match(root.querySelector('audio').getAttribute('src'), /new\.wav$/);
});

test('loaded media keeps identity when Chromium populates runtime currentSrc', () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"><audio src="file:///C:/Jenny/audio.wav"></audio></div></body>');
  const root = dom.window.document.getElementById('root');
  const media = root.querySelector('audio');
  Object.defineProperty(media, 'currentSrc', {
    configurable: true,
    value: 'file:///C:/Jenny/audio.wav',
  });
  media.currentTime = 13;

  setChildrenHtmlPreservingKeyedNodes(
    root,
    '<audio src="file:///C:/Jenny/audio.wav"></audio>'
  );

  assert.strictEqual(root.querySelector('audio'), media);
  assert.equal(media.currentTime, 13);
});

test('user-questions definition keys identity by question reference', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${renderQuestions()}</div></body>`);
  const registry = createComponentPreservationRegistry();
  const current = dom.window.document.querySelector('.user-questions-block');
  const sameDom = new JSDOM(`<body>${renderQuestions()}</body>`);
  const changedDom = new JSDOM(`<body>${renderQuestions('question-other')}</body>`);

  assert.ok(registry.getNodeKey(current));
  assert.equal(registry.getNodeKey(current), registry.getNodeKey(sameDom.window.document.querySelector('.user-questions-block')));
  assert.notEqual(registry.getNodeKey(current), registry.getNodeKey(changedDom.window.document.querySelector('.user-questions-block')));
  assert.equal(registry.shouldRetainNode(current, sameDom.window.document.querySelector('.user-questions-block')), true);
  sameDom.window.close(); changedDom.window.close(); dom.window.close();
});

test('user-question selections and drafts restore across a rebuilt matching block', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${renderQuestions()}</div></body>`);
  const root = dom.window.document.getElementById('root');
  const registry = createComponentPreservationRegistry();
  root.querySelector('[data-user-question-id="single"] [value="Beta"]').checked = true;
  root.querySelector('[data-user-question-id="multi"] [value="One"]').checked = true;
  root.querySelector('[data-user-question-id="multi"] [value="Two"]').checked = true;
  const otherToggle = root.querySelector('[data-user-question-id="multi"] [data-user-question-other-toggle]');
  const otherInput = root.querySelector('[data-user-question-id="multi"] [data-user-question-other-input]');
  otherToggle.checked = true; otherInput.disabled = false; otherInput.value = 'Three';
  root.querySelector('[data-user-question-free-text]').value = 'Keep this draft';
  const snapshot = registry.capture(root);

  root.innerHTML = renderQuestions();
  registry.restore(root, snapshot);

  assert.equal(root.querySelector('[data-user-question-id="single"] [value="Beta"]').checked, true);
  assert.deepEqual(
    Array.from(root.querySelectorAll('[data-user-question-id="multi"] [data-user-question-option]:checked')).map((input) => input.value),
    ['One', 'Two']
  );
  assert.equal(root.querySelector('[data-user-question-other-toggle]').checked, true);
  assert.equal(root.querySelector('[data-user-question-other-input]').value, 'Three');
  assert.equal(root.querySelector('[data-user-question-other-input]').disabled, false);
  assert.equal(root.querySelector('[data-user-question-free-text]').value, 'Keep this draft');
  dom.window.close();
});

test('user-question restore skips missing and mismatched controls', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${renderQuestions()}</div></body>`);
  const root = dom.window.document.getElementById('root');
  const registry = createComponentPreservationRegistry();
  root.querySelector('[data-user-question-free-text]').value = 'Draft';
  const snapshot = registry.capture(root);
  root.innerHTML = '<div class="user-questions-block" data-question-ref="question-ref"><fieldset data-user-question-id="free"></fieldset><fieldset data-user-question-id="unknown"><input></fieldset></div>';

  assert.doesNotThrow(() => registry.restore(root, snapshot));
  assert.equal(root.querySelector('[data-user-question-id="unknown"] input').value, '');
  dom.window.close();
});

test('a stale user-question receipt keeps its node identity across the same question morph', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${renderQuestions()}</div></body>`);
  const root = dom.window.document.getElementById('root');
  const block = root.querySelector('.user-questions-block');
  block.dataset.userQuestionsStale = 'true';
  block.innerHTML = '<div class="user-questions-receipt">Questions no longer active</div>';

  setChildrenHtmlPreservingKeyedNodes(root, renderQuestions());

  assert.strictEqual(root.querySelector('.user-questions-block'), block);
  assert.match(root.querySelector('.user-questions-receipt').textContent, /Questions no longer active/);
  assert.equal(root.querySelector('.user-questions-submit-btn'), null);
  dom.window.close();
});

test('a status-expanded row does not force open a lazy collapsed replacement', () => {
  // The awaiting-approval row renders expanded; once the call settles the
  // replacement renders collapsed with its details unmaterialized. Restoring
  // the old expansion would leave an open header over an empty body.
  const dom = new JSDOM(`<!doctype html><body><div id="root">
    <article data-message-id="m1">
      <div class="tool-call-row" data-tool-call-id="call-1" data-expanded="true" data-tool-details-materialized="true">
        <button data-action="toggle" aria-expanded="true">Old</button>
        <div class="tool-call-row-body">approval body</div>
      </div>
    </article>
  </div></body>`);
  const root = dom.window.document.getElementById('root');
  setChildrenHtmlPreservingKeyedNodes(root, `
      <article data-message-id="m1">
        <div class="tool-call-row" data-tool-call-id="call-1" data-expanded="false" data-tool-details-materialized="false">
          <button data-action="toggle" aria-expanded="false">New</button>
          <div class="tool-call-row-body" inert></div>
        </div>
      </article>
  `, { documentRef: dom.window.document });
  const row = root.querySelector('.tool-call-row');
  assert.equal(row.getAttribute('data-expanded'), 'false');
  assert.equal(row.querySelector('button').getAttribute('aria-expanded'), 'false');
  assert.equal(row.querySelector('.tool-call-row-body').hasAttribute('inert'), true);
});

test('expanded row state and focused action restore across structural replacement', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">
    <article data-message-id="m1">
      <div class="tool-call-row" data-tool-call-id="call-1" data-expanded="true">
        <button data-action="toggle" aria-expanded="true">Old</button>
        <div class="tool-call-row-body">old result</div>
      </div>
    </article>
  </div></body>`);
  const root = dom.window.document.getElementById('root');
  root.querySelector('button').focus();

  setChildrenHtmlPreservingKeyedNodes(root, `
    <article data-message-id="m1">
      <section class="replacement-shell">
        <div class="tool-call-row" data-tool-call-id="call-1" data-expanded="false">
          <button data-action="toggle" aria-expanded="false">New</button>
          <div class="tool-call-row-body" inert>new result</div>
        </div>
      </section>
    </article>`);

  const row = root.querySelector('.tool-call-row');
  assert.equal(row.getAttribute('data-expanded'), 'true');
  assert.equal(row.querySelector('button').getAttribute('aria-expanded'), 'true');
  assert.equal(row.querySelector('.tool-call-row-body').hasAttribute('inert'), false);
  assert.strictEqual(dom.window.document.activeElement, row.querySelector('button'));
  assert.equal(row.querySelector('button').hasAttribute('tabindex'), false, 'temporary focus promotion does not alter tab order');
});

test('actionless reasoning header focus restores from the containing chat entry', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">
    <article class="chat-entry" data-message-id="m1">
      <button class="reasoning-row-header" data-message-id="m1">Old</button>
    </article>
  </div></body>`);
  const root = dom.window.document.getElementById('root');
  root.querySelector('button').focus();
  const registry = createComponentPreservationRegistry();
  const snapshot = registry.capture(root);

  root.innerHTML = `<article class="chat-entry" data-message-id="m1">
    <button class="reasoning-row-header" data-message-id="m1">New</button>
  </article>`;
  registry.restore(root, snapshot);

  assert.strictEqual(dom.window.document.activeElement, root.querySelector('.reasoning-row-header'));
});

test('restore errors isolate one registered component and dispose drops registry state', () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"><i data-test="bad"></i><i data-test="good"></i></div></body>');
  const root = dom.window.document.getElementById('root');
  const registry = createComponentPreservationRegistry({ captureCap: 4 });
  const restored = [];
  registry.register({
    name: 'test-state',
    selector: '[data-test]',
    preserveIdentity: false,
    source(node) { return node.getAttribute('data-test'); },
    capture(node) { return node.getAttribute('data-test'); },
    restore(_node, value) {
      if (value === 'bad') throw new Error('bad restore');
      restored.push(value);
    },
  });
  const snapshot = registry.capture(root);
  const errors = [];

  registry.restore(root, snapshot, { onError: (_error, component) => errors.push(component) });

  assert.deepEqual(errors, ['test-state']);
  assert.deepEqual(restored, ['good']);
  registry.dispose();
  assert.equal(registry.capture(root), null);
});
