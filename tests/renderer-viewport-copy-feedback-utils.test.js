const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createViewportCopyFeedbackUtils,
} = require('../renderer/shell/renderer-viewport-copy-feedback-utils');

test('viewport copy feedback utils place and clear message chips', () => {
  const dom = new JSDOM(`
    <main id="timeline">
      <div class="chat-hover-row" data-message-id="m1" style="position: relative;">
        <button data-message-action="copy"></button>
      </div>
    </main>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const row = timeline.querySelector('.chat-hover-row');
  const button = row.querySelector('button');
  Object.defineProperties(row, {
    clientWidth: { value: 220 },
  });
  Object.defineProperties(button, {
    offsetLeft: { value: 20 },
    offsetWidth: { value: 40 },
    offsetTop: { value: 6 },
  });
  button.getBoundingClientRect = () => ({ height: 20 });
  const announcements = [];
  const copyFeedback = createViewportCopyFeedbackUtils({
    chatTimeline: timeline,
    documentRef: dom.window.document,
    escapeSelectorValue: (value) => String(value || ''),
    setTimeoutRef() { return 1; },
    clearTimeoutRef() {},
    announce(message, options) { announcements.push([message, options.key]); },
  });

  copyFeedback.showCopyFeedback('m1');
  const chip = timeline.querySelector('.chat-copy-chip[data-message-id="m1"]');

  assert.equal(chip?.textContent, 'Copied!');
  assert.equal(chip?.style.left, '66px');
  assert.deepEqual(announcements, [['Message copied.', 'message-copy:m1']]);
  copyFeedback.clearCopyFeedback('m1');
  assert.equal(timeline.querySelector('.chat-copy-chip[data-message-id="m1"]'), null);
});
