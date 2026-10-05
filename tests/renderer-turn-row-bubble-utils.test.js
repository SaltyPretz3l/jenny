'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnRowBubbleUtils } = require('../renderer/chat/renderer-turn-row-bubble-utils');
const { JSDOM } = require('jsdom');

test('S4: projected answer units never carry a reveal class', () => {
  const bubbles = createTurnRowBubbleUtils({
    renderStreamingMarkdownUnits: () => ({ html: '<p>answer</p>', units: [{ html: '<p>answer</p>', revealed: true }], changedStartIndex: 0 }),
  });
  for (const options of [{ streamUnits: [{ html: '<p>answer</p>', revealed: true }] }, {}]) {
    const dom = new JSDOM(bubbles.buildStreamingBubbleHtml('answer', options));
    assert.equal(dom.window.document.querySelectorAll('.chat-stream-unit.is-revealed').length, 0);
    dom.window.close();
  }
});

test('projected user bubbles render Markdown breaks while preserving failure and attachment markup', () => {
  const calls = [];
  const message = {
    id: 'user_1',
    role: 'user',
    content: 'line one\nline two',
    send_failure: { state: 'failed' },
    attachments: [{ name: 'notes.txt' }],
  };
  const bubbles = createTurnRowBubbleUtils({
    getMessageById: () => message,
    renderMarkdown(text, options) {
      calls.push({ text, options });
      return '<p>line one<br>line two</p>';
    },
    renderMessageAttachments: () => '<div data-attachment="notes.txt"></div>',
  });
  const row = {
    kind: 'user_bubble',
    primary_message_id: 'user_1',
    payload: { content: message.content },
  };

  const html = bubbles.buildUserBubbleRowMarkup(row, [message]);

  assert.deepEqual(calls, [{ text: message.content, options: { breaks: true, literalBackslashes: true } }]);
  assert.match(html, /class="chat-bubble chat-bubble-markdown"/);
  assert.match(html, /line one<br>line two/);
  assert.match(html, /Failed to send/);
  assert.match(html, /data-attachment="notes\.txt"/);
});

test('projected user editing exposes escaped raw source instead of rendered Markdown', () => {
  const bubbles = createTurnRowBubbleUtils({
    getMessageById: () => ({ id: 'user_1', content: '**raw**' }),
    renderMarkdown: () => '<strong>rendered</strong>',
  });
  const html = bubbles.buildUserBubbleRowMarkup({
    kind: 'user_bubble',
    primary_message_id: 'user_1',
    payload: { content: '**raw**' },
  }, [], {
    editingMessageId: 'user_1',
    editingDraftText: '**raw** <unsafe>',
  });

  assert.match(html, /\*\*raw\*\* &lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<strong>/);
});
