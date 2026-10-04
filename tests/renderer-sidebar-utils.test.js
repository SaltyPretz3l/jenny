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

// W3 review P3: with one pane, pane 0's tray reads the skill as its own session's, so a session
// switch drops a skill attached in another chat (the pre-split behaviour), instead of keeping it.
test('one pane: a pending skill from another session is dropped when the tray renders', () => {
  const previous = { visibility: globalThis.rendererPaneVisibilityUtils, skills: globalThis.rendererComposerV2State };
  globalThis.rendererPaneVisibilityUtils = require('../renderer/chat/renderer-pane-visibility-utils');
  globalThis.rendererComposerV2State = require('../renderer/chat/renderer-composer-v2-state');
  try {
    const dom = new JSDOM('<!DOCTYPE html><html><body><main id="chatView"></main><div id="attachmentTray"></div><div id="attachmentNotice"></div></body></html>');
    const documentRef = dom.window.document;
    const state = { ui: {}, currentSessionId: 'session-a', attachments: { queued: [], dragDepth: 0 } };
    const skills = globalThis.rendererComposerV2State;
    skills.setPendingSkillInvocation(state, { id: 'skill-1', name: 'Research', command: 'research' });
    const controller = createSidebarController({
      state,
      dom: { chatView: documentRef.getElementById('chatView'), attachmentTray: documentRef.getElementById('attachmentTray'), attachmentNotice: documentRef.getElementById('attachmentNotice') },
      callbacks: { escapeHtml: (value) => String(value == null ? '' : value) },
    });
    state.currentSessionId = 'session-b';
    controller.renderAttachmentTray();
    assert.equal(skills.peekPendingSkillInvocation(state, 'session-a'), null, 'the switch dropped the skill');
    state.currentSessionId = 'session-a';
    controller.renderAttachmentTray();
    assert.equal(documentRef.getElementById('attachmentTray').querySelector('[data-inv-chip="attached-skill"]'), null, 'no chip on return');
  } finally {
    globalThis.rendererPaneVisibilityUtils = previous.visibility;
    globalThis.rendererComposerV2State = previous.skills;
  }
});
