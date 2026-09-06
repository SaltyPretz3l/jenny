'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranscriptAttachmentsRenderer } = require('../renderer/chat/renderer-transcript-attachments');

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
  assert.match(valid, /<figure class="message-attachment-card message-attachment-image">/);
  assert.match(valid, /<figcaption class="message-attachment-caption">Chart<\/figcaption>/);
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
