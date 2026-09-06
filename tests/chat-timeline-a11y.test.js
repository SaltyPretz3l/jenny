const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

/* Ht-B Step B3 — chat timeline a11y live region.
 * Static contract over index.html: the timeline container is a politely
 * announced log so newly appended turns reach screen readers. */
test('#chatTimeline is a non-live log backed by the shared announcer regions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const timeline = dom.window.document.getElementById('chatTimeline');

  assert.ok(timeline, 'index.html must carry #chatTimeline');
  assert.equal(timeline.getAttribute('role'), 'log');
  assert.equal(timeline.getAttribute('aria-live'), 'off');
  assert.equal(timeline.hasAttribute('aria-relevant'), false);
  assert.equal(timeline.getAttribute('aria-atomic'), 'false');
  assert.equal(timeline.getAttribute('aria-busy'), 'false', 'the E4 aria-busy contract stays');
  assert.ok(timeline.getAttribute('aria-label'), 'the timeline keeps its accessible name');
  assert.equal(
    dom.window.document.getElementById('chatSurface').hasAttribute('aria-live'),
    false,
    'the transcript shell must not wrap the live log in another live region'
  );
  const polite = dom.window.document.getElementById('srAnnouncePolite');
  const assertive = dom.window.document.getElementById('srAnnounceAssertive');
  assert.equal(polite.getAttribute('role'), 'status');
  assert.equal(polite.getAttribute('aria-live'), 'polite');
  assert.equal(assertive.getAttribute('role'), 'alert');
  assert.equal(assertive.getAttribute('aria-live'), 'assertive');

  dom.window.close();
});
