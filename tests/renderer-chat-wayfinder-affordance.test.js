const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { createChatWayfinderAffordance } = require('../renderer/inventory/chat-wayfinder-affordance');

function createFixture(t) {
  const dom = new JSDOM('<!doctype html><body><div id="host" hidden></div></body>');
  t.after(() => dom.window.close());
  const host = dom.window.document.getElementById('host');
  const affordance = createChatWayfinderAffordance({
    document: dom.window.document,
    hostId: 'timeline-wayfinder',
  });
  const root = affordance.mount(host);
  return { affordance, host, root };
}

test('wayfinder uses one Jenny jump-arrow SVG for prompt, unread, and latest states', (t) => {
  const { affordance, root } = createFixture(t);
  const button = root.querySelector('.chat-wayfinder-button');
  const icon = root.querySelector('.chat-wayfinder-icon');

  assert.equal(icon.tagName.toLowerCase(), 'svg');
  assert.equal(icon.getAttribute('viewBox'), '0 0 16 16');
  assert.deepEqual(
    Array.from(icon.querySelectorAll('path'), (path) => path.getAttribute('d')),
    ['M3 12.75h10', 'M8 3.25v8', 'M4.75 8 8 11.25 11.25 8']
  );
  assert.equal(icon.textContent, '', 'icon should not fall back to a Unicode arrow glyph');
  const staticIconMarkup = icon.outerHTML;

  const states = [
    { state: 'prompt', label: 'Back to prompt', detail: 'Original request' },
    { state: 'unread', label: 'Jump to unread', detail: '2 unread updates' },
    { state: 'latest', label: 'Return to latest', detail: 'Newest response' },
  ];
  for (const state of states) {
    affordance.setState({ visible: true, ...state });
    assert.equal(button.dataset.chatWayfinderState, state.state);
    assert.equal(button.getAttribute('aria-label'), state.label);
    assert.equal(button.getAttribute('title'), `${state.label}: ${state.detail}`);
    assert.equal(icon.outerHTML, staticIconMarkup, 'state should select direction through CSS without rebuilding the icon');
  }
});

test('wayfinder keeps activation and disposal behavior intact with the SVG icon', (t) => {
  const { affordance, host, root } = createFixture(t);
  let activations = 0;
  affordance.on('activate', () => { activations += 1; });
  affordance.setState({ visible: true, state: 'latest', label: 'Return to latest' });

  root.querySelector('.chat-wayfinder-icon').dispatchEvent(new root.ownerDocument.defaultView.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(activations, 1, 'clicking the SVG should activate through the existing delegated handler');

  affordance.dispose();
  assert.equal(root.isConnected, false);
  assert.equal(host.hidden, true);
});
