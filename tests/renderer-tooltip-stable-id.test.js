'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const tooltip = require('../renderer/inventory/tooltip');
const actionButton = require('../renderer/inventory/action-button');
const { createAwayDigestWidget } = require('../renderer/features/renderer-dashboard-widget-away-digest');

function harness(t, markup) {
  const dom = new JSDOM(markup);
  t.after(() => { tooltip.hide({ force: true }); dom.window.close(); });
  return dom;
}

test('three show -> show -> hide cycles retain one stable tooltip id and preserve help', (t) => {
  const dom = harness(t, '<button aria-describedby="help">Anchor</button>');
  const anchor = dom.window.document.querySelector('button');
  let stableId;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    tooltip.show(anchor, 'Started');
    const tip = dom.window.document.querySelector('[role="tooltip"]');
    stableId ||= tip.id;
    tooltip.show(anchor, 'Started, with token details');
    assert.equal(anchor.getAttribute('aria-describedby'), `help ${stableId}`, 'repeated show keeps exactly one tooltip id');
    assert.equal(tip.id, stableId, 'singleton id stays stable');
    tooltip.hide();
    assert.equal(anchor.getAttribute('aria-describedby'), 'help', 'hide removes only the tooltip id');
  }
});

test('show on another anchor removes the previous association while preserving other ids', (t) => {
  const dom = harness(t, '<button id="a" aria-describedby="help details">A</button>'
    + '<button id="b" aria-describedby="other-help">B</button>');
  const a = dom.window.document.getElementById('a');
  const b = dom.window.document.getElementById('b');
  tooltip.show(a, 'A');
  const id = dom.window.document.querySelector('[role="tooltip"]').id;
  tooltip.show(b, 'B');
  assert.equal(a.getAttribute('aria-describedby'), 'help details', 'anchor switch removes old tooltip association');
  assert.equal(b.getAttribute('aria-describedby'), `other-help ${id}`);
  tooltip.hide();
  assert.equal(b.getAttribute('aria-describedby'), 'other-help');
});

test('Away Digest token details update a delegated tooltip without leaving stale ids', async (t) => {
  const dom = harness(t, '<div id="body"></div>');
  const body = dom.window.document.getElementById('body');
  const timers = [];
  t.mock.method(global, 'setTimeout', (fn) => { timers.push(fn); return timers.length; });
  t.mock.method(global, 'clearTimeout', () => {});
  let resolveTokens;
  const row = { key: 'work', sessionTitle: 'Work', startedAt: Date.now(), outcome: 'completed' };
  const widget = createAwayDigestWidget({
    documentRef: dom.window.document, actionButton, tooltip,
    reader: {
      getSnapshot: () => ({ hasRead: true, digest: { rows: [row], unseenCount: 1, runningCount: 0 } }),
      readTokens: () => new Promise((resolve) => { resolveTokens = resolve; }),
    },
  });
  t.after(() => widget.dispose());
  widget.render(body);
  tooltip.initTooltipHandlers(body);
  const anchor = body.querySelector('[data-digest-action="open"]');
  anchor.setAttribute('aria-describedby', 'help');
  anchor.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
  anchor.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  timers.splice(0).forEach((fn) => fn());
  const id = dom.window.document.querySelector('[role="tooltip"]').id;
  resolveTokens({ input: 12, output: 34 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(dom.window.document.querySelector('[role="tooltip"]').textContent, /12 in.*34 out/);
  assert.equal(anchor.getAttribute('aria-describedby'), `help ${id}`, 'token update retains the delegated tooltip id');
  anchor.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
  assert.equal(anchor.getAttribute('aria-describedby'), 'help');
});
