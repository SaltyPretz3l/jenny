'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSidebarController } = require('../renderer/shell/renderer-sidebar-utils');

test('W4-57-F12: pending audio attachments render neutral filename and duration metadata', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<main id="chatView"></main>'
    + '<div id="attachmentTray"></div>'
    + '<div id="attachmentNotice"></div>'
    + '</body></html>');
  const documentRef = dom.window.document;
  const attachmentTray = documentRef.getElementById('attachmentTray');
  const controller = createSidebarController({
    state: {
      attachments: {
        queued: [{
          id: 'audio-1',
          kind: 'audio',
          displayName: 'meeting-note.wav',
          durationMs: 12000,
          sourceKind: 'microphone',
          transcriptStatus: 'pending',
        }],
        dragDepth: 0,
      },
    },
    dom: {
      chatView: documentRef.getElementById('chatView'),
      attachmentTray,
      attachmentNotice: documentRef.getElementById('attachmentNotice'),
    },
    callbacks: {
      escapeHtml: (value) => String(value == null ? '' : value),
    },
  });

  controller.renderAttachmentTray();

  assert.equal(attachmentTray.querySelector('.attachment-chip-name').textContent, 'meeting-note.wav');
  assert.equal(attachmentTray.querySelector('.attachment-chip-meta').textContent, '0:12');
  assert.equal(attachmentTray.querySelector('.attachment-chip-remove').getAttribute('title'), 'Remove attachment');
  assert.doesNotMatch(attachmentTray.textContent, /transcrib|transcript|voice/i);
});
