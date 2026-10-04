'use strict';

// timeline-perf (2026-10-04): a live turn article predicts its height from the
// text of its whole row list, and extractHtmlText re-parsed that list on every
// event (18 s of a 36-iteration turn's replay). The text is now assembled
// from per-row pieces, reusing an unchanged row's piece. Contract: the
// predicted height (and the text it is computed from) is identical to the
// whole-list extraction for every input, malformed rows included (they fall
// back), and a warm call parses only the changed rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const modulePath = require.resolve('../renderer/features/renderer-pretext-utils.js');
const FONT = 'normal normal 400 15px sans-serif';
const COLLAPSED = { excludeSelector: '.tool-call-row[data-expanded="false"] .tool-call-row-body, .reasoning-row-panel:not(.expanded) .reasoning-row-panel-body' };
const ANSWERS = {
  excludeSelector: `${COLLAPSED.excludeSelector}, .turn-row-list:not([data-turn-live="true"]) .chat-row[data-row-kind="reasoning"], .chat-row[data-run-member]:not([data-run-expanded="true"])`,
};

function setup(t) {
  const previousDocument = global.document;
  const previousPretextLayout = global.pretextLayout;
  const dom = new JSDOM('<!doctype html><body></body>');
  const parsed = { chars: 0 };
  const document = dom.window.document;
  const createElement = document.createElement.bind(document);
  const innerHtml = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  document.createElement = (tagName, ...rest) => {
    const element = createElement(tagName, ...rest);
    if (String(tagName).toLowerCase() === 'template') {
      Object.defineProperty(element, 'innerHTML', {
        configurable: true,
        get() { return innerHtml.get.call(this); },
        set(value) { parsed.chars += String(value).length; innerHtml.set.call(this, value); },
      });
    }
    return element;
  };
  global.document = document;
  // The height is a function of every character of the text, so any text
  // difference changes the number.
  global.pretextLayout = {
    prepare(text) { return { text }; },
    layout(prepared, maxWidth, lineHeight) {
      let hash = 7;
      for (const char of prepared.text) hash = (hash * 31 + char.codePointAt(0)) % 1000003;
      return { height: (prepared.text.length * lineHeight) / maxWidth + hash, text: prepared.text };
    },
    clearCache() {},
  };
  delete require.cache[modulePath];
  const pretextUtils = require(modulePath);
  t.after(() => {
    delete require.cache[modulePath];
    global.document = previousDocument;
    global.pretextLayout = previousPretextLayout;
    dom.window.close();
  });
  return { pretextUtils, parsed };
}

function row(id, kind, body, attrs = '') {
  return { kind: 'row', id, markup: `<div class="chat-row" data-row-id="${id}" data-row-kind="${kind}"${attrs}><span class="chat-row-node-dot" aria-hidden="true"></span>${body}</div>` };
}

function toolRow(id, expanded, summary, output) {
  return row(id, 'tool_call', `<div class="tool-call-row" data-expanded="${expanded}" data-tool-status="success"><div class="tool-call-header">${summary}</div>`
    + `<div class="tool-call-row-body"><pre><code>\n${output}</code></pre></div></div>`, ` data-chat-row-v2-summary-text="${summary}"`);
}

function reasoningRow(id, expanded, text) {
  return row(id, 'reasoning', `<div class="reasoning-row-block"><div class="reasoning-row-header">Thinking</div>`
    + `<div class="reasoning-row-panel${expanded ? ' expanded' : ''}"><div class="reasoning-row-panel-body"><p>${text}</p></div></div></div>`);
}

function buildSegments(liveText = 'And continues.', answerText = '') {
  const filler = 'a long line of reasoning text that makes every row a similar size '.repeat(6);
  return [
    reasoningRow('t:reasoning:1', false, `Plan &amp; check ${filler}`),
    toolRow('t:tool:1', 'false', 'read_file a &gt; b &amp; c &#39;q&#39;', `def f():\n    return 1 ${filler}`),
    { kind: 'divider', id: 'm2', markup: `\n<div class="chat-time-divider" data-before-message-id="m2"><span>10:00</span></div>\n` },
    toolRow('t:tool:2', 'true', 'grep &quot;x&quot;', `match&nbsp;one\nmatch two ${filler}`),
    row('t:tool:3', 'tool_call', `<div class="tool-call-row" data-expanded="false"><div class="tool-call-header">ls ${filler}</div></div>`,
      ' data-run-id="r1" data-run-member="first" data-run-expanded="false"'),
    row('t:text:1', 'assistant_text', `<div class="chat-bubble">Text with &lt;div&gt; literal,<br>a break and   spaces ${filler}${answerText}</div>`),
    reasoningRow('t:reasoning:2', true, `Live ${liveText} ${filler}`),
  ];
}

function listHtml(segments, live) {
  return `<div class="turn-row-list" data-turn-row-list="true" data-turn-phase="tool_running"${live ? ' data-turn-live="true"' : ''}>`
    + segments.map((segment) => segment.markup).join('') + '</div>';
}

// The whole-list extraction the prediction used before (extractHtmlText):
// parse, drop the excluded nodes, serialize, strip.
function wholeListText(html, options) {
  const stripTags = (value) => String(value).replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!options?.excludeSelector) return stripTags(html);
  const template = global.document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll(options.excludeSelector).forEach((node) => node.parentNode?.removeChild(node));
  return stripTags(template.innerHTML);
}

function predictBoth(pretextUtils, key, html, options) {
  const whole = pretextUtils.predictTextHeight(`whole:${key}`, wholeListText(html, options), FONT, 600, 24);
  const perRow = pretextUtils.predictHtmlContentHeight(`turn:${key}`, html, FONT, 600, 24, options);
  return { whole, perRow };
}

test('turn height prediction: per-row text is identical to the whole-list extraction', (t) => {
  const { pretextUtils } = setup(t);
  for (const [name, options] of [['collapsed', COLLAPSED], ['answers', ANSWERS], ['none', undefined]]) {
    for (const live of [false, true]) {
      const segments = buildSegments();
      const html = listHtml(segments, live);
      const first = predictBoth(pretextUtils, `${name}:${live}`, html, options);
      assert.ok(first.whole && first.whole.height > 0, `${name}/${live}: a prediction exists`);
      assert.deepEqual(first.perRow, first.whole, `${name}/${live}: cold`);
      const grown = buildSegments('And continues. More text arrives &amp; grows.', ' and the answer grows');
      const next = predictBoth(pretextUtils, `${name}:${live}`, listHtml(grown, live), options);
      assert.deepEqual(next.perRow, next.whole, `${name}/${live}: warm with a changed row`);
      assert.notDeepEqual(next.whole, first.whole, `${name}/${live}: the changed row changes the prediction`);
    }
  }
});

test('turn height prediction: rows that do not close themselves fall back to the whole list', (t) => {
  const { pretextUtils } = setup(t);
  const malformed = [
    ['unclosed div', row('t:bad', 'assistant_text', '<div class="chat-bubble">open')],
    ['stray close', { kind: 'row', id: 't:bad', markup: '<div class="chat-row" data-row-id="t:bad">x</div></div><p>after</p>' }],
    ['unclosed formatting', row('t:bad', 'assistant_text', '<b>bold')],
    ['form', row('t:bad', 'assistant_text', '<form><input name="q"></form>')],
    ['unclosed textarea', row('t:bad', 'assistant_text', '<textarea>raw')],
    ['unclosed comment', row('t:bad', 'assistant_text', '<!-- note')],
  ];
  for (const [name, bad] of malformed) {
    const segments = buildSegments();
    segments.splice(2, 0, bad);
    const html = listHtml(segments, false);
    const result = predictBoth(pretextUtils, name, html, ANSWERS);
    assert.deepEqual(result.perRow, result.whole, name);
  }
  const nested = buildSegments();
  nested.splice(1, 0, row('t:nest', 'assistant_text', '<div class="x"><div class="chat-row" data-row-id="inner">inner</div></div>'));
  const result = predictBoth(pretextUtils, 'nested', listHtml(nested, false), ANSWERS);
  assert.deepEqual(result.perRow, result.whole, 'a row wrapper opening inside a row is not a cut point');
});

test('turn height prediction: a warm call parses only the rows that changed', (t) => {
  const { pretextUtils, parsed } = setup(t);
  const segments = buildSegments();
  pretextUtils.predictHtmlContentHeight('turn:warm', listHtml(segments, true), FONT, 600, 24, COLLAPSED);
  const grown = buildSegments('And continues. More.');
  const html = listHtml(grown, true);
  parsed.chars = 0;
  const prediction = pretextUtils.predictHtmlContentHeight('turn:warm', html, FONT, 600, 24, COLLAPSED);
  assert.ok(prediction && prediction.height > 0);
  const changedRow = grown[grown.length - 1].markup.length;
  assert.ok(parsed.chars < changedRow + 400, `parsed ${parsed.chars} chars for one changed row of ${changedRow} (list ${html.length})`);
});

test('turn height prediction: a turn alternating between wrapper phases stays warm for each', (t) => {
  const { pretextUtils, parsed } = setup(t);
  const segments = buildSegments();
  const thinking = listHtml(segments, true);
  const done = thinking.replace('data-turn-phase="tool_running"', 'data-turn-phase="done"');
  pretextUtils.predictHtmlContentHeight('turn:alt', thinking, FONT, 600, 24, COLLAPSED);
  pretextUtils.predictHtmlContentHeight('turn:alt', done, FONT, 600, 24, COLLAPSED);
  parsed.chars = 0;
  pretextUtils.predictHtmlContentHeight('turn:alt', thinking, FONT, 600, 24, COLLAPSED);
  pretextUtils.predictHtmlContentHeight('turn:alt', done, FONT, 600, 24, COLLAPSED);
  assert.equal(parsed.chars, 0, 'both wrapper variants reuse their rows');
});
