const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const Tooltip = require('../renderer/inventory/tooltip');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

test('tooltip show and hide preserve existing aria-describedby ids', () => {
  const dom = new JSDOM(
    '<span id="help">Help</span><span id="details">Details</span>'
      + '<button id="anchor" aria-describedby="help details">Go</button>',
  );
  const { document } = dom.window;
  const anchor = document.getElementById('anchor');

  Tooltip.show(anchor, 'Tip');
  const tooltip = document.querySelector('[role="tooltip"]');

  assert.equal(anchor.getAttribute('aria-describedby'), `help details ${tooltip.id}`);
  Tooltip.hide({ force: true });
  assert.equal(anchor.getAttribute('aria-describedby'), 'help details');
  dom.window.close();
});

test('tooltip migration refreshes data-tooltip when title changes', () => {
  const dom = new JSDOM('<a id="anchor" title="A">Link</a>');
  const { document, MouseEvent } = dom.window;
  const anchor = document.getElementById('anchor');
  Tooltip.initTooltipHandlers(document);

  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  assert.equal(anchor.getAttribute('data-tooltip'), 'A');

  anchor.setAttribute('title', 'B');
  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  assert.equal(anchor.getAttribute('data-tooltip'), 'B');
  assert.equal(anchor.hasAttribute('title'), false);
  Tooltip.hide({ force: true });
  dom.window.close();
});

test('tooltip migration treats an empty title as no tooltip', () => {
  const dom = new JSDOM('<a id="anchor" title="A">Link</a>');
  const { document, MouseEvent } = dom.window;
  const anchor = document.getElementById('anchor');
  Tooltip.initTooltipHandlers(document);

  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  anchor.setAttribute('title', '');
  anchor.dispatchEvent(new MouseEvent('mouseenter'));

  assert.equal(anchor.hasAttribute('title'), false);
  assert.equal(anchor.hasAttribute('data-tooltip'), false);
  Tooltip.hide({ force: true });
  dom.window.close();
});

test('clearing a visible tooltip title hides it and cancels pending display', async (t) => {
  const dom = new JSDOM('<a id="anchor" title="Old">Link</a>');
  const { document, FocusEvent, MouseEvent } = dom.window;
  const anchor = document.getElementById('anchor');
  t.after(() => {
    Tooltip.unpin();
    Tooltip.hide({ force: true });
    dom.window.close();
  });
  Tooltip.initTooltipHandlers(document);

  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  await waitForUiState(dom.window, () => document.querySelector('[role="tooltip"]')?.getAttribute('aria-hidden') === 'false', {
    timeoutMs: 5000,
    message: 'the hover tooltip did not show',
  });
  const tooltip = document.querySelector('[role="tooltip"]');
  assert.equal(tooltip.textContent, 'Old');
  assert.equal(tooltip.getAttribute('aria-hidden'), 'false');

  anchor.setAttribute('title', '');
  anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  anchor.dispatchEvent(new MouseEvent('mouseleave'));

  assert.equal(tooltip.getAttribute('aria-hidden'), 'true');
  assert.equal(tooltip.classList.contains('inv-tooltip--visible'), false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(tooltip.getAttribute('aria-hidden'), 'true', 'a stale show timer must not redisplay the tooltip');
  assert.equal(tooltip.classList.contains('inv-tooltip--visible'), false);
});

test('clearing a pinned tooltip title unpins and hides it on renewed interaction', (t) => {
  const dom = new JSDOM('<a id="anchor" title="Old">Link</a>');
  const { document, FocusEvent, MouseEvent } = dom.window;
  const anchor = document.getElementById('anchor');
  t.after(() => {
    Tooltip.unpin();
    Tooltip.hide({ force: true });
    dom.window.close();
  });
  Tooltip.initTooltipHandlers(document);

  Tooltip.pin(anchor);
  const tooltip = document.querySelector('[role="tooltip"]');
  assert.equal(Tooltip.isPinned(), true);
  assert.equal(tooltip.getAttribute('aria-hidden'), 'false');

  anchor.setAttribute('title', '');
  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

  assert.equal(Tooltip.isPinned(), false);
  assert.equal(tooltip.getAttribute('aria-hidden'), 'true');
  assert.equal(tooltip.classList.contains('inv-tooltip--visible'), false);
});

/* Gate N2 (2026-09-27): opening the collapsed composer's settings list
 * focused its first row, and the row's tooltip ("This chat is in ...")
 * covered the list's header. A suppressed container shows no delegated
 * tooltip; a show already pending when the suppression lands is dropped. */
test('an anchor inside [data-tooltip-suppressed] shows no tooltip on focus or hover; a pending show re-checks', async (t) => {
  const dom = new JSDOM('<div id="list"><button id="row" title="This chat is in jenny-ui-test">Project</button></div>'
    + '<button id="pill" title="Composer settings">Auto</button>');
  const { document, FocusEvent, MouseEvent } = dom.window;
  t.after(() => {
    Tooltip.hide({ force: true });
    dom.window.close();
  });
  Tooltip.initTooltipHandlers(document);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 450));
  const visible = () => {
    const tooltip = document.querySelector('[role="tooltip"]');
    return Boolean(tooltip && tooltip.classList.contains('inv-tooltip--visible'));
  };

  document.getElementById('list').setAttribute('data-tooltip-suppressed', '');
  document.getElementById('row').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  document.getElementById('row').dispatchEvent(new MouseEvent('mouseenter'));
  await wait();
  assert.equal(visible(), false, 'no tooltip inside the suppressed list');

  const pill = document.getElementById('pill');
  pill.dispatchEvent(new MouseEvent('mouseenter'));
  pill.setAttribute('data-tooltip-suppressed', '');
  await wait();
  assert.equal(visible(), false, 'a show pending when the suppression lands is dropped');

  pill.removeAttribute('data-tooltip-suppressed');
  pill.dispatchEvent(new MouseEvent('mouseenter'));
  await waitForUiState(dom.window, visible, {
    timeoutMs: 5000,
    message: 'unsuppressed, the tooltip did not show again',
  });
  assert.equal(visible(), true, 'unsuppressed, the tooltip shows again');
});

test('an anchor that asks for below gets it while it fits; others stay above-first', (t) => {
  const dom = new JSDOM('<button id="below" data-tooltip-placement="below">?</button><button id="plain">Go</button>', { pretendToBeVisual: true });
  const { document } = dom.window;
  t.after(() => {
    Tooltip.hide({ force: true });
    dom.window.close();
  });
  const place = (id, top) => {
    const anchor = document.getElementById(id);
    anchor.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 100, right: 120, width: 20, height: 20 });
    Tooltip.show(anchor, 'Tip');
    const below = document.querySelector('[role="tooltip"]').classList.contains('inv-tooltip--below');
    Tooltip.hide({ force: true });
    return below;
  };
  const roomBelow = dom.window.innerHeight / 2;
  assert.equal(place('below', roomBelow), true);
  assert.equal(place('plain', roomBelow), false, 'no attribute keeps the above-first default');
  assert.equal(place('below', dom.window.innerHeight - 21), false, 'no room below falls back to above');
});
