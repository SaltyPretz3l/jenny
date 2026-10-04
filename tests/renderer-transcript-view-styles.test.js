// Transcript views: the answers stylesheet rules in styles/chat-thread-rail.css,
// matched against REAL row markup (legacy article shell, modern row list,
// reasoning renderer) with querySelectorAll. The headless harness loads no
// stylesheet, so this is where selector reach is proven; layout stays an
// owner real-app gate.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createTurnShellRenderer } = require('../renderer/chat/renderer-turn-shell');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
const {
  clearReasoningStreamStateCache,
  createReasoningV2Renderer,
} = require('../renderer/chat/renderer-transcript-reasoning-v2');
const {
  ThinkingPanelController,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');

const railCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-thread-rail.css'), 'utf8');
const railRules = [...railCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2].replace(/\s+/g, ' ').trim() }));

/** The one rail rule whose selector contains `needle` and whose body contains `declaration`. */
function railRule(needle, declaration) {
  const hits = railRules.filter((rule) => rule.selector.includes(needle) && rule.body.includes(declaration));
  assert.equal(hits.length, 1, `exactly one rule for ${needle} { ${declaration} }`);
  return hits[0].selector;
}

test.beforeEach(() => clearReasoningStreamStateCache());

function makeReasoningRenderer() {
  return createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => (message?.reasoning?.entries || []),
    renderMarkdown: (s) => `<p>${escapeHtml(s)}</p>`,
    renderStreamingMarkdownUnits: (s) => ({ html: `<p>${escapeHtml(s)}</p>` }),
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });
}

function reasoningMessage(id, live) {
  const status = live ? 'streaming' : 'complete';
  return {
    id,
    role: 'assistant',
    status,
    reasoning: { source: 'provider', status, entries: [{ id: `${id}-r1`, text: 'Weighing the options.' }] },
  };
}

function reasoningWidget(renderer, id, live, transcriptView) {
  return renderer.renderThinkingWidget(reasoningMessage(id, live), live ? id : '', { transcriptView });
}

function timelineDocument(view, innerHtml) {
  return new JSDOM(`<div class="chat-timeline" data-transcript-view="${view}">${innerHtml}</div>`).window.document;
}

const matchedArticleIds = (document, selector) => [...document.querySelectorAll(selector)]
  .map((node) => node.closest('article').id);

/* ── TV-5: the legacy article path (per-session row-model rollback) ── */

function legacyAndModernTimeline(view) {
  const renderer = makeReasoningRenderer();
  const shell = createTurnShellRenderer({ escapeHtml });
  const legacy = (id, live) => `<article class="chat-entry assistant" id="${id}">${
    shell.buildAssistantContentShell(id, reasoningWidget(renderer, id, live, view))}</article>`;
  const modern = (id, live) => {
    const rowList = createTurnRowListUtils({
      escapeHtml,
      buildRowBodyMarkup: () => reasoningWidget(renderer, id, live, view),
    });
    const rows = [{ row_id: `row:${id}`, turn_id: id, kind: 'reasoning' }];
    return `<article class="chat-entry assistant" id="${id}">${
      rowList.buildTurnRowListMarkup(rows, [], { turnPhase: live ? 'thinking' : 'done', turnLive: live })}</article>`;
  };
  return timelineDocument(view, [
    legacy('legacy-settled', false),
    legacy('legacy-live', true),
    modern('modern-settled', false),
    modern('modern-live', true),
  ].join(''));
}

test('answers: the legacy stack rule hides a settled legacy stack and never reaches modern reasoning rows', () => {
  const selector = railRule('.reasoning-row-stack:not(', 'display: none');
  const document = legacyAndModernTimeline('answers');
  assert.equal(document.querySelectorAll('.reasoning-row-stack').length, 4, 'every fixture renders a stack');
  assert.ok(document.querySelector('#legacy-live [data-reasoning-live-tail="true"]'), 'the legacy live fixture streams');
  assert.ok(!document.querySelector('#legacy-settled .chat-row[data-row-kind]'), 'the legacy shell row carries no row kind');
  assert.deepEqual(matchedArticleIds(document, selector), ['legacy-settled']);
});

test('answers: the disabled header drops panel and caret on the legacy path, which has no data-turn-live', () => {
  const panelSelector = railRule('.reasoning-row-header:disabled ~ .reasoning-row-panel', 'display: none');
  const document = legacyAndModernTimeline('answers');
  assert.ok(!document.querySelector('#legacy-live [data-turn-live]'), 'the legacy list has no live-turn marker');
  const header = document.querySelector('#legacy-live .reasoning-row-header');
  assert.equal(header.disabled, true, 'the answers header renders disabled');
  const matched = [...document.querySelectorAll(panelSelector)];
  const legacyLive = matched.filter((node) => node.closest('article').id === 'legacy-live');
  assert.deepEqual(
    legacyLive.map((node) => node.className.split(' ')[0]).sort(),
    ['reasoning-row-caret', 'reasoning-row-panel'],
    'the live legacy line keeps only its header text'
  );
  assert.ok(matched.every((node) => /^reasoning-row-(panel|caret)\b/.test(node.className)), 'nothing else hides');

  // Thinking renders an enabled toggle: neither rule reaches it.
  const thinking = legacyAndModernTimeline('thinking');
  assert.equal(thinking.querySelectorAll(panelSelector).length, 0);
  assert.equal(thinking.querySelectorAll(railRule('.reasoning-row-stack:not(', 'display: none')).length, 0);
});

/* ── TV-16 / TV-7e: hidden-row sibling spacing and the first-child dot ── */

function answersThreadDocument({ view = 'answers', live = false, doubleReasoning = false } = {}) {
  const rowList = createTurnRowListUtils({
    escapeHtml,
    buildRowBodyMarkup: (row) => `<div>${escapeHtml(row.kind)}</div>`,
  });
  const kinds = [
    ...(doubleReasoning ? [['r0', 'reasoning']] : []),
    ['r1', 'reasoning'], ['t1', 'assistant_text'], ['r2', 'reasoning'], ['t2', 'assistant_text'],
    ['r3', 'reasoning'], ['s1', 'tool_step'], ['r4', 'reasoning'], ['s2', 'tool_step'],
  ];
  if (doubleReasoning) {
    kinds.splice(kinds.findIndex(([id]) => id === 't2'), 0, ['r2b', 'reasoning']);
    kinds.splice(kinds.findIndex(([id]) => id === 's1'), 0, ['r3b', 'reasoning']);
  }
  const rows = kinds.map(([id, kind]) => ({ row_id: id, turn_id: 'turn-1', kind }));
  return timelineDocument(view, `
    <div class="chat-thread-node chat-thread-node-nested">
      <div class="chat-thread-node-row">
        <button class="chat-thread-toggle" type="button"></button>
        <div class="chat-thread-node-article">
          <article class="chat-entry assistant">${rowList.buildTurnRowListMarkup(rows, [], { turnPhase: live ? 'thinking' : 'done', turnLive: live })}</article>
        </div>
      </div>
    </div>`);
}

const matchedRowIds = (document, selector) => [...document.querySelectorAll(selector)]
  .map((node) => node.closest('.chat-row').getAttribute('data-row-id').split(':').pop());

test('answers: the rows after hidden reasoning rows get the gap and dot their visible neighbours call for', () => {
  const leadingGap = railRule('[data-row-kind="reasoning"]:first-child + .chat-row', 'margin-block-start: 0');
  const leadingDot = railRule('[data-row-kind="reasoning"]:first-child + .chat-row .chat-row-node-dot', 'display: none');
  const proseGap = railRule(
    '[data-row-kind="reasoning"] + .chat-row[data-row-kind="assistant_text"]',
    'margin-block-start: var(--space-4)'
  );
  const clusterGap = railRule(
    '[data-row-kind="reasoning"] + .chat-row:not([data-row-kind="assistant_text"])',
    'margin-block-start: var(--tl-cluster-gap)'
  );
  const settled = answersThreadDocument();
  assert.equal(settled.querySelectorAll('.chat-row-node-dot').length, 8, 'every row renders its node dot');
  assert.deepEqual(matchedRowIds(settled, leadingGap), ['t1'], 'the first visible row keeps the list top edge');
  assert.deepEqual(matchedRowIds(settled, leadingDot), ['t1'], 'the thread toggle stays the only first dot');
  assert.deepEqual(matchedRowIds(settled, proseGap), ['t2'], 'prose after hidden reasoning after prose keeps the paragraph gap');
  assert.deepEqual(matchedRowIds(settled, clusterGap), ['s1'], 'machinery after hidden reasoning after prose keeps the cluster break');

  // The live turn shows its reasoning lines, and the other views hide nothing.
  const live = answersThreadDocument({ live: true });
  assert.ok(live.querySelector('.turn-row-list[data-turn-live="true"]'), 'the live fixture carries the live-turn marker');
  for (const document of [live, answersThreadDocument({ view: 'thinking' })]) {
    for (const selector of [leadingGap, leadingDot, proseGap, clusterGap]) {
      assert.equal(document.querySelectorAll(selector).length, 0, selector);
    }
  }
});

for (const [label, id, property, value, needle] of [
  ['leading gap', 't1', 'margin-block-start', '0',
    '[data-row-kind="reasoning"]:first-child + [data-row-kind="reasoning"].chat-row + .chat-row'],
  ['prose gap', 't2', 'margin-block-start', 'var(--space-4)',
    '[data-row-kind="assistant_text"] + .chat-row[data-row-kind="reasoning"] + [data-row-kind="reasoning"].chat-row + .chat-row[data-row-kind="assistant_text"]'],
  ['cluster gap', 's1', 'margin-block-start', 'var(--tl-cluster-gap)',
    '[data-row-kind="assistant_text"] + .chat-row[data-row-kind="reasoning"] + [data-row-kind="reasoning"].chat-row + .chat-row:not([data-row-kind="assistant_text"])'],
  ['leading dot', 't1', 'display', 'none',
    '[data-row-kind="reasoning"]:first-child + [data-row-kind="reasoning"].chat-row + .chat-row .chat-row-node-dot'],
]) {
  test(`answers: two hidden reasoning rows preserve the ${label}`, () => {
    const settled = answersThreadDocument({ doubleReasoning: true });
    // Cascade stand-in: highest specificity wins, then source order (stable sort).
    const specificity = (selector) => Math.max(...selector.split(',').map((compound) => (
      compound.replace(/::[\w-]+/g, '').match(/\.[\w-]+|\[[^\]]*\]|:(?!not\()[\w-]+/g) || []).length));
    const resolvedValue = (document) => {
      const row = [...document.querySelectorAll('.chat-row')]
        .find((node) => node.getAttribute('data-row-id').split(':').pop() === id);
      const node = property === 'display' ? row.querySelector('.chat-row-node-dot') : row;
      const rule = railRules.filter((candidate) => candidate.body.includes(`${property}:`)
        && node.matches(candidate.selector))
        .sort((a, b) => specificity(a.selector) - specificity(b.selector)).at(-1);
      return rule?.body.match(new RegExp(`${property}:\\s*([^;]+)`))?.[1];
    };
    assert.equal(resolvedValue(settled), value, `${label} after two hidden reasoning rows`);
    assert.equal(resolvedValue(settled), resolvedValue(answersThreadDocument()), 'same as one hidden row');
    const selector = railRule(needle, `${property}: ${value}`);
    assert.deepEqual(matchedRowIds(settled, selector), [id]);
    for (const document of [
      answersThreadDocument({ doubleReasoning: true, live: true }),
      answersThreadDocument({ doubleReasoning: true, view: 'thinking' }),
      answersThreadDocument({ doubleReasoning: true, view: 'everything' }),
    ]) {
      assert.equal(document.querySelectorAll(selector).length, 0, selector);
    }
  });
}
