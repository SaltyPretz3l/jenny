const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSearchBar } = require('../renderer/inventory/search-bar');

function buildBar() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="host"></div></body></html>');
  const host = dom.window.document.getElementById('host');
  const bar = createSearchBar({ document: dom.window.document, hostId: 'test-search' });
  return { dom, host, bar };
}

test('mounts the expected scaffolding (input + 5 buttons + output) (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);

  const root = host.querySelector('.chat-search-bar');
  assert.ok(root, 'search bar root should mount');
  assert.equal(root.getAttribute('role'), 'search');

  const input = host.querySelector('.chat-search-bar-input');
  assert.ok(input);
  assert.equal(input.getAttribute('aria-label'), 'Search messages in this conversation');
  assert.equal(input.getAttribute('aria-keyshortcuts'), 'Enter Shift+Enter Escape');
  assert.equal(input.getAttribute('data-search-skip'), 'true');

  const buttons = host.querySelectorAll('button');
  assert.equal(buttons.length, 5, 'prev, next, close, case toggle, word toggle');

  const count = host.querySelector('.chat-search-bar-count');
  assert.ok(count);
  assert.equal(count.tagName, 'OUTPUT');
  assert.equal(count.getAttribute('aria-live'), 'polite');
  assert.equal(count.textContent, 'No matches');
});

test('emits input event on every keystroke (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const captured = [];
  bar.on('input', (q) => { captured.push(q); });
  const input = host.querySelector('.chat-search-bar-input');
  input.value = 'foo';
  input.dispatchEvent(new (input.ownerDocument.defaultView).Event('input', { bubbles: true }));
  assert.deepEqual(captured, ['foo']);
});

test('Enter and Shift+Enter on input emit next/prev (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const events = [];
  bar.on('next', () => { events.push('next'); });
  bar.on('prev', () => { events.push('prev'); });
  const input = host.querySelector('.chat-search-bar-input');

  const win = input.ownerDocument.defaultView;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(events, ['next', 'prev']);
});

test('Esc on input emits close (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  let closed = 0;
  bar.on('close', () => { closed += 1; });
  const input = host.querySelector('.chat-search-bar-input');
  const win = input.ownerDocument.defaultView;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(closed, 1);
});

test('toggle buttons flip aria-pressed and emit toggle events (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const caseEvents = [];
  const wordEvents = [];
  bar.on('toggle-case', (v) => { caseEvents.push(v); });
  bar.on('toggle-word', (v) => { wordEvents.push(v); });

  const caseBtn = host.querySelector('.chat-search-bar-toggle-case');
  const wordBtn = host.querySelector('.chat-search-bar-toggle-word');
  assert.equal(caseBtn.getAttribute('aria-pressed'), 'false');
  caseBtn.click();
  assert.equal(caseBtn.getAttribute('aria-pressed'), 'true');
  caseBtn.click();
  assert.equal(caseBtn.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(caseEvents, [true, false]);

  wordBtn.click();
  assert.equal(wordBtn.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(wordEvents, [true]);
});

test('nav and close buttons emit their events (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const events = [];
  bar.on('prev', () => { events.push('prev'); });
  bar.on('next', () => { events.push('next'); });
  bar.on('close', () => { events.push('close'); });
  host.querySelector('.chat-search-bar-prev').click();
  host.querySelector('.chat-search-bar-next').click();
  host.querySelector('.chat-search-bar-close').click();
  assert.deepEqual(events, ['prev', 'next', 'close']);
});

test('setMatchInfo writes "n of m" or "No matches" (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const count = host.querySelector('.chat-search-bar-count');
  bar.setMatchInfo(0, 0);
  assert.equal(count.textContent, 'No matches');
  bar.setMatchInfo(2, 7);
  assert.equal(count.textContent, '2 of 7');
  // current clamps to [1, total]
  bar.setMatchInfo(0, 7);
  assert.equal(count.textContent, '1 of 7');
  bar.setMatchInfo(99, 7);
  assert.equal(count.textContent, '7 of 7');
});

test('setQuery / getQuery sync the input value (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  bar.setQuery('hello');
  assert.equal(host.querySelector('.chat-search-bar-input').value, 'hello');
  assert.equal(bar.getQuery(), 'hello');
});

test('setCaseSensitive / setWholeWord update aria-pressed without emitting (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const events = [];
  bar.on('toggle-case', (v) => { events.push(v); });
  bar.setCaseSensitive(true);
  assert.equal(host.querySelector('.chat-search-bar-toggle-case').getAttribute('aria-pressed'), 'true');
  assert.equal(bar.getCaseSensitive(), true);
  assert.equal(events.length, 0, 'programmatic set should not emit');
});

test('focusInput moves focus to the input (F1)', () => {
  const { host, bar, dom } = buildBar();
  bar.mount(host);
  bar.focusInput(true);
  assert.equal(dom.window.document.activeElement, host.querySelector('.chat-search-bar-input'));
});

test('unmount detaches without disposing; remount restores (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  bar.unmount();
  assert.equal(host.querySelector('.chat-search-bar'), null);
  bar.mount(host);
  assert.ok(host.querySelector('.chat-search-bar'));
});

test('dispose removes listeners and the root element (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  bar.dispose();
  assert.equal(host.querySelector('.chat-search-bar'), null);
});

// Scroll-program W2b: the global match cap needs an explicit surfaced state —
// a capped scan renders "N of 500+" so the reader knows additional matches
// were omitted rather than believing the total.
test('setMatchInfo renders the omitted-matches state when the scan was truncated', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const count = host.querySelector('.chat-search-bar-count');

  bar.setMatchInfo(3, 500, { truncated: true });
  assert.equal(count.textContent, '3 of 500+', 'a capped total is presented as a floor, not a count');

  bar.setMatchInfo(2, 5);
  assert.equal(count.textContent, '2 of 5', 'the untruncated form is unchanged');
});
