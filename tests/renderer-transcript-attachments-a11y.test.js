'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranscriptAttachmentsRenderer } = require('../renderer/chat/renderer-transcript-attachments');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { JSDOM } = require('jsdom');

const escapeHtml = (value) => String(value == null ? '' : value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

test('image attachments use figure/caption semantics and reject unusable media sources', () => {
  const renderer = createTranscriptAttachmentsRenderer({ escapeHtml });
  const valid = renderer.renderMessageAttachments({
    id: 'm1',
    attachments: [{ kind: 'image', assetPath: 'C:\\managed\\image.png', displayName: 'Chart' }],
  });
  const figure = new JSDOM(valid).window.document.querySelector('figure.inv-artifact-figure--attachment');
  assert.equal(figure.querySelector('figcaption').textContent, 'Chart');
  assert.equal(figure.closest('.message-attachment-card'), null, 'an image has no card wrapper');
  assert.doesNotMatch(valid, /src=""/);

  const rejected = renderer.renderMessageAttachments({
    id: 'm2',
    attachments: [{ kind: 'image', assetPath: 'https://example.invalid/private.png', displayName: 'Private chart' }],
  });
  assert.match(rejected, /role="status"/);
  assert.match(rejected, /Image unavailable/);
  assert.doesNotMatch(rejected, /<img\b/);
  assert.doesNotMatch(rejected, /example\.invalid|private\.png/);
});

test('image attachments with an id are keyboard-operable image viewer buttons', () => {
  const renderer = createTranscriptAttachmentsRenderer({ escapeHtml });
  const html = renderer.renderMessageAttachments({
    id: 'm1',
    attachments: [
      { id: 'att-1', kind: 'image', assetPath: '/managed/cat.png', displayName: 'Cat "1"' },
      { kind: 'image', assetPath: '/managed/legacy.png', displayName: 'Legacy' },
    ],
  });
  const [cat, legacy] = new JSDOM(html).window.document.querySelectorAll('figure.inv-artifact-figure');
  const frame = cat.querySelector('button.inv-artifact-figure-frame');
  assert.deepEqual([frame.getAttribute('aria-label'), frame.dataset.imageViewerOpen, frame.dataset.imageId, frame.dataset.sessionId],
    ['View Cat "1"', 'attachment', 'att-1', '']);
  assert.equal(frame.querySelector('img').getAttribute('src'), 'file:///managed/cat.png');
  assert.deepEqual([...cat.querySelectorAll('[data-image-action]')].map((tool) => [tool.dataset.imageAction, tool.dataset.imageKind, tool.getAttribute('aria-label')]),
    [['copy', 'attachment', 'Copy image'], ['save-as', 'attachment', 'Save as…']]);
  assert.equal(cat.querySelector('figcaption').textContent, 'Cat "1"');
  assert.equal(legacy.querySelector('button'), null, 'an attachment without an id stays a plain framed image');
  assert.equal(legacy.querySelector('img').getAttribute('src'), 'file:///managed/legacy.png');
});

test('audio attachments with rejected paths render a bounded placeholder', () => {
  const renderer = createTranscriptAttachmentsRenderer({ escapeHtml });
  const html = renderer.renderMessageAttachments({
    id: 'm3',
    attachments: [{ kind: 'audio', assetPath: '', displayName: 'Voice memo', sourceKind: 'assistant_tts' }],
  });
  assert.match(html, /Audio unavailable/);
  assert.doesNotMatch(html, /<audio\b/);
});

test('historical assistant audio renders as a standard audio attachment', () => {
  const renderer = createTranscriptAttachmentsRenderer({ escapeHtml });
  const html = renderer.renderMessageAttachments({
    id: 'm4',
    attachments: [{
      id: 'audio-1',
      kind: 'audio',
      assetPath: 'C:\\managed\\assistant-reply.wav',
      displayName: 'Assistant reply',
      sourceKind: 'assistant_tts',
      durationMs: 12000,
    }],
  });

  assert.match(html, /class="message-attachment-card message-attachment-audio"/);
  assert.match(html, /<audio[\s\S]*\bcontrols\b/);
  assert.match(html, /class="message-attachment-label">Assistant reply<\/div>/);
  assert.doesNotMatch(html, /data-assistant-tts|assistant-reply-audio/);
});

test('skill invocation metadata renders as a compact user-row pill without an attachment card', () => {
  const renderer = createTranscriptAttachmentsRenderer({ escapeHtml });
  const html = renderer.renderMessageAttachments({
    id: 'm5',
    role: 'user',
    skill_invocation: { id: 'bundled/verify', name: 'Verifier <safe>', scope: 'bundled', command: 'verify' },
    attachments: [],
  });
  assert.match(html, /class="message-skill-pill">Verifier &lt;safe&gt;<\/span>/);
  assert.doesNotMatch(html, /message-attachment-card/);
});

test('attached and tool-output image buttons open the chat gallery at that image; a failed open is reported', async () => {
  const attachmentMarkup = createTranscriptAttachmentsRenderer({ escapeHtml }).renderMessageAttachments({
    attachments: [{ id: 'att-1', kind: 'image', assetPath: 'C:\\managed\\cat.png', displayName: 'Cat' }],
  });
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatTimeline">' + attachmentMarkup
    + '<button type="button" data-image-viewer-open="tool" data-image-id="chart-1" data-session-id="sess_other"><img></button>'
    + '</div></body></html>');
  const window = dom.window;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const opens = [];
  const errors = [];
  let result = true;
  window.rendererImageViewerController = { open: async (target) => { opens.push(target); return result; } };
  const bindings = createTranscriptEventBindings({
    chatTimeline, state: {}, thinkingController: {},
    getSessionId: () => 'sess_pane',
    showComposerActionError: (error, title) => errors.push([error.message, title]),
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  const attachmentButton = chatTimeline.querySelector('[data-image-viewer-open="attachment"]');
  assert.equal(attachmentButton.getAttribute('aria-label'), 'View Cat');
  assert.ok(attachmentButton.querySelector('img.inv-artifact-figure-image'));
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  attachmentButton.querySelector('img').click();
  chatTimeline.querySelector('[data-image-viewer-open="tool"]').click();
  await settle();
  assert.deepEqual(opens, [
    { sessionId: 'sess_pane', select: { kind: 'attachment', id: 'att-1' }, contextNode: attachmentButton },
    { sessionId: 'sess_other', select: { kind: 'tool', id: 'chart-1' }, contextNode: chatTimeline.querySelector('[data-image-viewer-open="tool"]') },
  ]);
  assert.deepEqual(errors, []);

  result = false;
  attachmentButton.click();
  delete window.rendererImageViewerController;
  attachmentButton.click();
  await settle();
  assert.deepEqual(errors, [['Image unavailable', 'Artifact Action Failed'], ['Image unavailable', 'Artifact Action Failed']]);
});
