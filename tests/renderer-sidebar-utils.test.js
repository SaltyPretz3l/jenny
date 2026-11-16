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

  assert.equal(attachmentTray.querySelector('.composer-attachment--audio .composer-attachment-name').textContent, 'meeting-note.wav');
  assert.equal(attachmentTray.querySelector('.composer-attachment-meta').textContent, 'Audio · 0:12');
  assert.equal(attachmentTray.querySelector('.composer-attachment-remove').getAttribute('title'), 'Remove attachment');
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

// Row 153: the composer's attachment items inside the composer.
function trayRig(stateOverrides = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="chatView"></main><div id="attachmentTray" class="attachment-tray hidden"></div><div id="attachmentNotice"></div></body></html>');
  const documentRef = dom.window.document;
  const state = { ui: {}, currentSessionId: 'session-a', attachments: { queued: [], dragDepth: 0 }, ...stateOverrides };
  const tray = documentRef.getElementById('attachmentTray');
  const controller = createSidebarController({
    state,
    dom: { chatView: documentRef.getElementById('chatView'), attachmentTray: tray, attachmentNotice: documentRef.getElementById('attachmentNotice') },
    callbacks: { escapeHtml: (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') },
  });
  return { state, tray, controller };
}

const image = (index, extra = {}) => ({ id: `img-${index}`, kind: 'image', displayName: `shot-${index}.png`, assetPath: `C:/a/shot-${index}.png`, sourceKind: 'capture', width: 800, height: 600, ...extra });
const file = (index, extra = {}) => ({ id: `file-${index}`, kind: 'file', displayName: `notes-${index}.markdown`, sizeBytes: 3 * 1024 * 1024 + 1, ...extra });

test('row 153: images past the per-message image limit are marked; the reason stays in the status line', () => {
  const { state, tray, controller } = trayRig();
  state.attachments.queued = [image(1), file(1), image(2), image(3), image(4), image(5)];
  controller.renderAttachmentTray();
  const over = [...tray.querySelectorAll('.composer-attachment--over')].map((node) => node.dataset.attachmentId);
  assert.deepEqual(over, ['img-5'], 'the fifth image in queue order, not the file');
  assert.match(tray.querySelector('[data-attachment-id="img-5"] .composer-attachment-thumb').title, /over the 4-image limit$/);
  assert.equal(tray.querySelector('[data-attachment-id="img-4"] .composer-attachment-thumb').title, 'shot-4.png · Screen capture · 800 × 600');
});

test('row 153: file meta names the type and size; a long extension falls back to File; truncated says so', () => {
  const { state, tray, controller } = trayRig();
  state.attachments.queued = [file(1), file(2, { displayName: 'build.log', sizeBytes: 200, truncated: true }), file(3, { displayName: 'README' })];
  controller.renderAttachmentTray();
  const metas = [...tray.querySelectorAll('.composer-attachment-meta')].map((node) => node.textContent);
  assert.deepEqual(metas, ['File · 3.0 MB', 'LOG · 1 KB · first part only', 'File · 3.0 MB']);
});

test('row 153: Clear all appears from three items; at the cap it follows "{count} of {max}"', () => {
  const { state, tray, controller } = trayRig();
  state.attachments.queued = [file(1), file(2)];
  controller.renderAttachmentTray();
  assert.equal(tray.querySelector('[data-attachment-clear]'), null);
  state.attachments.queued = [file(1), file(2), file(3)];
  controller.renderAttachmentTray();
  assert.equal(tray.querySelector('.composer-attachment-tail [data-attachment-clear]').textContent, 'Clear all');
  assert.equal(tray.querySelector('.composer-attachment-count'), null);
  state.attachments.queued = Array.from({ length: 8 }, (_, index) => file(index));
  controller.renderAttachmentTray();
  assert.equal(tray.querySelector('.composer-attachment-count').textContent, '8 of 8');
});

test('row 153: placeholders render for the live session only, after the items; a drag keeps an empty tray hidden', () => {
  const { state, tray, controller } = trayRig();
  state.attachments.dragDepth = 1;
  controller.renderAttachmentTray();
  assert.equal(tray.classList.contains('hidden'), true, 'the drop hint is CSS on the pane; the tray takes no space');
  state.attachments.dragDepth = 0;
  state.attachments.queued = [image(1)];
  state.attachmentPending = [
    { operationId: 'op-1', sessionId: 'session-a', kind: 'image', name: 'Pasted Image.png' },
    { operationId: 'op-2', sessionId: 'session-a', kind: 'file', name: 'notes.md' },
    { operationId: 'op-3', sessionId: 'session-other', kind: 'file', name: 'elsewhere.md' },
  ];
  controller.renderAttachmentTray();
  const items = [...tray.children].map((node) => node.dataset.attachmentId || node.getAttribute('aria-label') || node.querySelector('.sr-only')?.textContent);
  assert.deepEqual(items, ['img-1', 'Preparing Pasted Image.png', 'Preparing notes.md']);
  assert.equal(tray.querySelector('.composer-attachment--pending .composer-attachment-meta').textContent, 'Preparing…');
  assert.equal(tray.querySelector('[data-attachment-clear]'), null, 'placeholders do not count towards Clear all');
});

test('row 153: pane 0 never rewrites unchanged markup, and a drag never rewrites it at all', () => {
  const { state, tray, controller } = trayRig();
  state.attachments.queued = [image(1)];
  let writes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(tray)), 'innerHTML')
    || Object.getOwnPropertyDescriptor(tray.ownerDocument.defaultView.Element.prototype, 'innerHTML');
  Object.defineProperty(tray, 'innerHTML', { get() { return descriptor.get.call(this); }, set(value) { writes += 1; descriptor.set.call(this, value); } });
  controller.renderAttachmentTray();
  assert.equal(writes, 1);
  for (let index = 0; index < 20; index += 1) {
    state.attachments.dragDepth = index % 2;
    controller.renderAttachmentTray();
  }
  assert.equal(writes, 1, 'drag enter and leave only toggle chat-drop-active');
  assert.equal(tray.ownerDocument.getElementById('chatView').classList.contains('chat-drop-active'), true);
});

test('row 153: a session switch with an identical tray still re-renders it (its chip listeners name the session)', () => {
  const { state, tray, controller } = trayRig();
  state.attachments.queued = [file(1)];
  controller.renderAttachmentTray();
  const first = tray.firstElementChild;
  controller.renderAttachmentTray();
  assert.equal(tray.firstElementChild, first, 'same session, same markup: kept');
  state.currentSessionId = 'session-b';
  controller.renderAttachmentTray();
  assert.notEqual(tray.firstElementChild, first, 'another session: rebuilt');
});

test('row 153: audio without a duration reads "Audio"', () => {
  const { state, tray, controller } = trayRig();
  state.attachments.queued = [{ id: 'a1', kind: 'audio', displayName: 'memo.wav' }];
  controller.renderAttachmentTray();
  assert.equal(tray.querySelector('.composer-attachment-meta').textContent, 'Audio');
});
