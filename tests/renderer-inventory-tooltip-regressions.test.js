const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const Tooltip = require('../renderer/inventory/tooltip');

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
  await new Promise((resolve) => setTimeout(resolve, 450));
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
