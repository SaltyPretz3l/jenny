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
  assert.equal(input.getAttribute('aria-keyshortcuts'), 'Enter Shift+Enter Escape Alt+C Alt+W');
  assert.equal(input.getAttribute('placeholder'), 'Find in this chat');
  assert.equal(input.getAttribute('data-search-skip'), 'true');

  const buttons = host.querySelectorAll('button');
  assert.equal(buttons.length, 5, 'prev, next, close, case toggle, word toggle');

  const count = host.querySelector('.chat-search-bar-count');
  assert.ok(count);
  assert.equal(count.tagName, 'OUTPUT');
  assert.equal(count.getAttribute('aria-live'), 'polite');
  assert.equal(count.textContent, '', 'row 156: no count before a query');
  assert.equal(host.querySelector('.chat-search-bar-prev').disabled, true);
  assert.equal(host.querySelector('.chat-search-bar-next').disabled, true);
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
  bar.setQuery('x');
  bar.setMatchInfo(1, 3);
  host.querySelector('.chat-search-bar-prev').click();
  host.querySelector('.chat-search-bar-next').click();
  host.querySelector('.chat-search-bar-close').click();
  assert.deepEqual(events, ['prev', 'next', 'close']);
});

test('setMatchInfo writes "n of m" or "No matches" (F1)', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const count = host.querySelector('.chat-search-bar-count');
  bar.setQuery('needle');
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
// a capped scan reads "N of 500+" (with a tooltip that says why) so the
// reader knows additional matches were omitted rather than believing the total.
test('setMatchInfo renders the omitted-matches state when the scan was truncated', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const count = host.querySelector('.chat-search-bar-count');
  bar.setQuery('needle');

  bar.setMatchInfo(3, 500, { truncated: true });
  assert.equal(count.textContent, '3 of 500+', 'a capped total is presented as a floor, not a count');
  assert.equal(count.getAttribute('title'), 'Only the first 500 matches are listed. Narrow the search to reach the rest.');

  bar.setMatchInfo(2, 5);
  assert.equal(count.textContent, '2 of 5', 'the untruncated form is unchanged');
  assert.equal(count.hasAttribute('title'), false, 'the cap explanation leaves with the cap');
  bar.setMatchInfo(1, 500, { truncated: true });
  bar.setMatchInfo(0, 0);
  assert.equal(count.hasAttribute('title'), false, 'no matches: no cap explanation');
});

// Row 156: the count says nothing until there is a query, and previous/next
// stay disabled without matches.
test('an empty field hides the count and disables previous/next', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const count = host.querySelector('.chat-search-bar-count');
  const next = host.querySelector('.chat-search-bar-next');
  bar.setQuery('hello');
  bar.setMatchInfo(1, 2);
  assert.equal(next.disabled, false);
  bar.setQuery('');
  bar.setMatchInfo(0, 0);
  assert.equal(count.textContent, '', 'not "No matches" for an empty field');
  assert.equal(count.textContent, '');
  assert.equal(next.disabled, true);
  bar.setQuery('zzz');
  bar.setMatchInfo(0, 0);
  assert.equal(count.textContent, 'No matches');
  assert.equal(next.disabled, true);
  const events = [];
  bar.on('next', () => { events.push('next'); });
  next.click();
  assert.deepEqual(events, [], 'a disabled button emits nothing');
});

test('Alt+C and Alt+W toggle the options from the field', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const events = [];
  bar.on('toggle-case', (v) => { events.push(['case', v]); });
  bar.on('toggle-word', (v) => { events.push(['word', v]); });
  const input = host.querySelector('.chat-search-bar-input');
  const win = input.ownerDocument.defaultView;
  const altC = new win.KeyboardEvent('keydown', { key: 'c', code: 'KeyC', altKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(altC);
  assert.equal(altC.defaultPrevented, true);
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(events, [['case', true], ['word', true]]);
  assert.equal(host.querySelector('.chat-search-bar-toggle-case').getAttribute('aria-pressed'), 'true');
  assert.equal(host.querySelector('.chat-search-bar-toggle-word').getAttribute('aria-pressed'), 'true');
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
  assert.equal(events.length, 2, 'Ctrl+Alt+C is not the toggle');
});

test('createFindToggle builds the session-bar magnifier button', () => {
  const { dom } = buildBar();
  const { createFindToggle } = require('../renderer/inventory/search-bar');
  const toggle = createFindToggle(dom.window.document, 'Find in this chat', 'Find in this chat (Ctrl+F)');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.className, 'chat-timeline-utility-button chat-find-toggle');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.getAttribute('aria-keyshortcuts'), 'Control+F');
  assert.ok(toggle.querySelector('svg[aria-hidden="true"]'));
});

test('Esc from a bar button closes; Enter on a button is only its click', () => {
  const { host, bar } = buildBar();
  bar.mount(host);
  const events = [];
  bar.on('close', () => { events.push('close'); });
  bar.on('next', () => { events.push('next'); });
  const close = host.querySelector('.chat-search-bar-close');
  const win = close.ownerDocument.defaultView;
  close.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  close.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.deepEqual(events, ['close']);
});
