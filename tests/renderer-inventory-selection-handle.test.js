const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildSelectionHandleMarkup } = require('../renderer/inventory/selection-handle');

function parseMarkup(markup) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${markup}</body></html>`);
  return dom.window.document.body.firstElementChild;
}

test('buildSelectionHandleMarkup emits a checkbox button with the message id (F4)', () => {
  const markup = buildSelectionHandleMarkup({ messageId: 'msg-42' });
  const el = parseMarkup(markup);
  assert.ok(el, 'should produce a single element');
  assert.equal(el.tagName, 'BUTTON');
  assert.equal(el.getAttribute('role'), 'checkbox');
  assert.equal(el.classList.contains('chat-entry-select-handle'), true);
  assert.equal(el.getAttribute('data-select-message-id'), 'msg-42');
  assert.equal(el.getAttribute('aria-checked'), 'false');
  assert.equal(el.getAttribute('data-selected'), 'false');
});

test('buildSelectionHandleMarkup reflects selected=true (F4)', () => {
  const markup = buildSelectionHandleMarkup({ messageId: 'm-1', selected: true });
  const el = parseMarkup(markup);
  assert.equal(el.getAttribute('aria-checked'), 'true');
  assert.equal(el.getAttribute('data-selected'), 'true');
});

test('buildSelectionHandleMarkup uses the supplied aria-label (F4)', () => {
  const markup = buildSelectionHandleMarkup({
    messageId: 'm-1',
    ariaLabel: 'Select message from Jenny at 10:30',
  });
  const el = parseMarkup(markup);
  assert.equal(el.getAttribute('aria-label'), 'Select message from Jenny at 10:30');
  assert.equal(el.getAttribute('title'), 'Select message from Jenny at 10:30');
});

test('buildSelectionHandleMarkup defaults the aria-label when missing (F4)', () => {
  const markup = buildSelectionHandleMarkup({ messageId: 'm-1' });
  const el = parseMarkup(markup);
  assert.equal(el.getAttribute('aria-label'), 'Select this message');
});

test('buildSelectionHandleMarkup escapes the message id (F4 / no raw HTML)', () => {
  const markup = buildSelectionHandleMarkup({ messageId: '"><script>alert(1)</script>' });
  // The escape should produce &quot; / &lt; / &gt; in the source.
  assert.ok(markup.includes('&quot;'));
  assert.ok(markup.includes('&lt;script&gt;'));
  // And the DOM parse should not produce any script element.
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${markup}</body></html>`);
  assert.equal(dom.window.document.querySelectorAll('script').length, 0);
});
