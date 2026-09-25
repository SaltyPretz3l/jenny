'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { JSDOM } = require('jsdom');
const { createI18n } = require('../renderer/shared/i18n-utils');
const thinking = require('../renderer/chat/chat-thinking-utils');

function fixture(t, { realMarkdown = false } = {}) {
  const dom = new JSDOM('');
  t.after(() => dom.window.close());
  const i18n = createI18n();
  const context = vm.createContext({ document: dom.window.document, jennyI18n: i18n });
  function load(path) {
    const filename = require.resolve(path);
    context.module = { exports: {} };
    context.require = createRequire(filename);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context.module.exports;
  }
  const markdown = realMarkdown ? load('../renderer/shared/markdown-utils') : null;
  const { createReasoningV2Renderer } = load('../renderer/chat/renderer-transcript-reasoning-v2');
  const calls = [];
  const streamingCalls = [];
  const renderer = createReasoningV2Renderer({
    escapeHtml: (s) => String(s),
    groupReasoningByPhase: thinking.groupReasoningByPhase,
    getReasoningEntries: (message) => message.phases.flatMap((phase) => phase.entries),
    renderMarkdown: (text, options) => {
      assert.equal(options.mermaid, 'plain');
      calls.push(text);
      return markdown ? markdown.renderMarkdown(text, options) : `<p>${text}</p>`;
    },
    renderStreamingMarkdownUnits: (text) => {
      streamingCalls.push(text);
      return { html: `<p>${text}</p>`, units: [] };
    },
    shouldShowThinkingToggle: () => true,
    thinkingController: new thinking.ThinkingPanelController(),
  });
  const message = {
    id: 'memo-message', status: 'streaming',
    phases: [
      { phase_id: 'settled', phase_kind: 'reasoning', entries: [{ text: 'Settled **body**' }] },
      { phase_id: 'live', phase_kind: 'reasoning', entries: [{ text: 'Live' }] },
    ],
  };
  const render = () => renderer.renderThinkingWidget(message, message.id);
  const renderMessage = (other) => renderer.renderThinkingWidget(other, other.id);
  const body = (html, phase = 'settled') => {
    const template = dom.window.document.createElement('template');
    template.innerHTML = html;
    return template.content.querySelector(`.reasoning-row-panel[data-phase-key="${phase}"] .reasoning-row-panel-body`).innerHTML;
  };
  return { message, render, renderMessage, body, calls, streamingCalls, i18n, markdown, context };
}

test('growing live text reuses byte-identical settled markup and changed markdown renders again', (t) => {
  const f = fixture(t);
  let settled;
  for (let index = 0; index < 8; index += 1) {
    f.message.phases[1].entries[0].text += ' growing';
    const html = f.body(f.render());
    if (index === 0) settled = html;
    assert.equal(html, settled);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.streamingCalls.length, 8);
  f.message.phases[0].entries[0].text = 'Changed settled body';
  assert.equal(f.body(f.render()), '<p>Changed settled body</p>');
  f.render();
  assert.equal(f.calls.length, 2);
});

test('completion renders fresh once, including after the same phase resumes streaming', (t) => {
  const f = fixture(t);
  f.render();
  f.message.status = 'complete';
  const settled = f.body(f.render(), 'live');
  assert.equal(f.body(f.render(), 'live'), settled);
  assert.equal(f.calls.filter((text) => text === 'Live').length, 1);
  f.message.status = 'streaming';
  f.render();
  f.message.status = 'complete';
  f.render();
  f.render();
  assert.equal(f.calls.filter((text) => text === 'Live').length, 2);
});

test('message and phase keys isolate bodies, renderer instances isolate caches, and oldest entries evict', (t) => {
  const f = fixture(t);
  f.render();
  f.message.phases[0].phase_id = 'other';
  f.render();
  assert.equal(f.calls.length, 2);
  f.message.phases[0].phase_id = 'settled';
  f.render();
  assert.equal(f.calls.length, 2);
  for (let index = 0; index < 32; index += 1) {
    f.message.id = `other-${index}`;
    f.render();
  }
  f.message.id = 'memo-message';
  f.render();
  assert.equal(f.calls.length, 35);
  const other = fixture(t);
  other.render();
  assert.equal(other.calls.length, 1);
});

test('real prose, paths, lists and tables retain exact HTML and table catalog changes invalidate', (t) => {
  const f = fixture(t, { realMarkdown: true });
  const text = '**Prose** with `src/main.js:2` and $plain math$.\n\n- [x] done\n\n| A | B |\n|---|---|\n| 1 | 2 |';
  f.message.phases[0].entries[0].text = text;
  const expected = f.markdown.renderMarkdown(text, { mermaid: 'plain' });
  assert.equal(f.body(f.render()), expected);
  assert.equal(f.body(f.render()), expected);
  assert.equal(f.calls.length, 1);
  // Same locale tag, new catalog: checking only the locale would miss this.
  f.i18n.load({ tag: 'en', strings: { 'common.copy': 'Copy changed' } });
  const changed = f.body(f.render());
  assert.notEqual(changed, expected);
  assert.equal(changed, f.markdown.renderMarkdown(text, { mermaid: 'plain' }));
  f.render();
  assert.equal(f.calls.length, 2);
});

test('runtime renderer and inline-path helper replacements invalidate settled bodies', (t) => {
  const f = fixture(t);
  f.render();
  f.context.markdownUtils = { renderMarkdown() {} };
  f.render();
  f.render();
  assert.equal(f.calls.length, 2);
  f.context.markdownInlinePaths = { decorateInlinePathChips() {} };
  f.render();
  f.render();
  assert.equal(f.calls.length, 3);
});

test('code blocks bypass memo for private highlighting state and generated IDs', (t) => {
  const f = fixture(t, { realMarkdown: true });
  f.message.phases[0].entries[0].text = '```js\nconst value = 1;\n```';
  f.render();
  f.render();
  assert.equal(f.calls.length, 2);
  f.message.phases[0].entries[0].text = `\`\`\`js\n${'const value = 1;\n'.repeat(30)}\`\`\``;
  const first = f.body(f.render());
  const second = f.body(f.render());
  assert.notEqual(first, second, 'preserve the existing per-render code ID allocation');
  assert.equal(f.calls.length, 4);
});

test('a settled phase fingerprint ignores the rendering scope and tracks its own content', (t) => {
  const f = fixture(t);
  const fingerprint = (html, phase = 'settled') => {
    const template = f.context.document.createElement('template');
    template.innerHTML = html;
    return template.content.querySelector(`.reasoning-row-block[data-phase-key="${phase}"]`)
      ?.getAttribute('data-reasoning-fp');
  };
  const stacked = fingerprint(f.render());
  assert.ok(stacked, 'a settled phase carries a fingerprint');
  assert.equal(fingerprint(f.render(), 'live'), null, 'the streaming tail carries none');
  f.message.phases[1].entries[0].text += ' growing';
  assert.equal(fingerprint(f.render()), stacked, 'live growth leaves the settled fingerprint alone');

  // The row model renders each checkpoint phase in its own row ("Thought")
  // while the message-level stack names it "Step 1": same phase, same print.
  const solo = { id: f.message.id, status: 'complete', phases: [f.message.phases[0]] };
  assert.equal(fingerprint(f.renderMessage(solo)), stacked);

  f.message.phases[0].entries[0].text = 'Corrected settled body';
  assert.notEqual(fingerprint(f.render()), stacked, 'a changed settled body changes the fingerprint');
});
