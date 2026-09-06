'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createAttachmentEventBindings } = require('../renderer/features/renderer-attachment-event-utils');

test('image paste mints ownership before byte preprocessing and cancels it on dispose', async () => {
  const dom = new JSDOM(`
    <div id="tray"></div><div id="settings"></div><button id="settings-button"></button>
    <div id="command"></div><button id="terminal"></button><button id="shortcut"></button>
    <textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>
  `);
  const documentRef = dom.window.document;
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  const token = Object.freeze({ operationId: 'paste-1', sessionId: 'session-a' });
  const cancelled = [];
  let closeCalls = 0;
  let tokenBegun = false;
  let resolveBytes;

  try {
    const controller = createAttachmentEventBindings({
      state: { ui: { composerPopoverOpen: false } },
      constants: { TOAST_SOURCE: { attachments: 'attachments' } },
      dom: {
        attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'),
        composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'),
        composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'),
        chatInput: documentRef.getElementById('input'), chatView: documentRef.getElementById('chat'),
        attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture'),
      },
      callbacks: {
        resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {},
        suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {},
        getDroppedFilePaths() { return []; }, renderComposerPopover() {}, renderCommandPopover() {},
        syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() { closeCalls += 1; }, closeCommandPopover() {},
        handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage(error, fallback) { return error?.message || fallback; },
        beginAttachmentToken() { tokenBegun = true; return token; },
        cancelAttachmentToken(value) { cancelled.push(value); }, queueInlineImageAttachment: async () => {},
      },
    });
    controller.bind();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      getData: () => '',
      items: [{ type: 'image/png', getAsFile: () => ({
        name: 'slow.png', type: 'image/png',
        arrayBuffer() {
          assert.equal(tokenBegun, true, 'the receipt must exist before preprocessing starts');
          return new Promise((resolve) => { resolveBytes = resolve; });
        },
      }) }],
    } });
    documentRef.getElementById('input').dispatchEvent(event);
    controller.dispose();
    assert.deepEqual(cancelled, [token]);
    resolveBytes(Uint8Array.from([1, 2, 3]).buffer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls, 0, 'an in-flight paste must not mutate popover UI after disposal');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  }
});

test('image paste logs receipt, bytes, and save settlement in order', async () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window; global.document = dom.window.document;
  const documentRef = dom.window.document;
  const logs = [];
  let controller;
  try {
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput: documentRef.getElementById('input'), chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async () => ({ id: 'img_1', sizeBytes: 4 }), appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
    controller.bind();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { types: ['Files', 'image/png'], files: [], getData: () => '', items: [{ type: 'image/png', getAsFile: () => ({ name: 'a.png', type: 'image/png', arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer }) }] } });
    documentRef.getElementById('input').dispatchEvent(event);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(logs.map((entry) => entry.event), ['composer.paste.received', 'composer.paste.image_decoded', 'composer.paste.saved']);
    assert.equal(logs[0].fields.hasImage, true);
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  }
});

test('image paste on the document body reroutes into the composer queue', async () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousElement = global.Element;
  global.window = dom.window;
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  const documentRef = dom.window.document;
  const chatInput = documentRef.getElementById('input');
  const queuedImages = [];
  const logs = [];
  let controller;
  try {
    // jsdom does not calculate layout, so expose a rendered composer explicitly.
    chatInput.getClientRects = () => [{}];
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput, chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async (payload) => { queuedImages.push(payload); return { id: 'img_1', sizeBytes: 4 }; }, appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
    controller.bind();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '', items: [{ type: 'image/png', getAsFile: () => ({ name: 'body.png', type: 'image/png', arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer }) }] } });
    documentRef.body.dispatchEvent(event);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queuedImages.length, 1);
    assert.equal(queuedImages[0].sourceKind, 'clipboard');
    assert.equal(event.defaultPrevented, true);
    assert.ok(logs.some((entry) => entry.event === 'composer.paste.rerouted' && entry.fields.targetTag === 'body'));
    assert.equal(documentRef.activeElement, chatInput);
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    global.Element = previousElement;
    dom.window.close();
  }
});

test('image paste inside another editable control is left alone', () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousElement = global.Element;
  global.window = dom.window;
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  const documentRef = dom.window.document;
  const chatInput = documentRef.getElementById('input');
  const queuedImages = [];
  let controller;
  try {
    chatInput.getClientRects = () => [{}];
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput, chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async (payload) => { queuedImages.push(payload); } } });
    controller.bind();
    const editableInput = documentRef.createElement('input');
    documentRef.body.appendChild(editableInput);
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '', items: [{ type: 'image/png', getAsFile: () => ({ name: 'input.png', type: 'image/png', arrayBuffer: async () => Uint8Array.from([1]).buffer }) }] } });
    editableInput.dispatchEvent(event);
    assert.equal(queuedImages.length, 0);
    assert.equal(event.defaultPrevented, false);
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    global.Element = previousElement;
    dom.window.close();
  }
});

test('text-only paste on the document body is left alone', () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousElement = global.Element;
  global.window = dom.window;
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  const documentRef = dom.window.document;
  const chatInput = documentRef.getElementById('input');
  const queuedImages = [];
  const logs = [];
  let controller;
  try {
    chatInput.getClientRects = () => [{}];
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput, chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async (payload) => { queuedImages.push(payload); }, appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
    controller.bind();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'hello', items: [{ type: 'text/plain', kind: 'string' }] } });
    documentRef.body.dispatchEvent(event);
    assert.equal(queuedImages.length, 0);
    assert.equal(event.defaultPrevented, false);
    assert.equal(logs.some((entry) => entry.event.startsWith('composer.paste.')), false);
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    global.Element = previousElement;
    dom.window.close();
  }
});

test('image paste on the body with no rendered composer logs and does nothing', () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousElement = global.Element;
  global.window = dom.window;
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  const documentRef = dom.window.document;
  const chatInput = documentRef.getElementById('input');
  const queuedImages = [];
  const logs = [];
  let controller;
  try {
    chatInput.getClientRects = () => [];
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput, chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async (payload) => { queuedImages.push(payload); }, appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
    controller.bind();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '', items: [{ type: 'image/png', getAsFile: () => ({ name: 'hidden.png', type: 'image/png', arrayBuffer: async () => Uint8Array.from([1]).buffer }) }] } });
    documentRef.body.dispatchEvent(event);
    assert.equal(queuedImages.length, 0);
    assert.equal(event.defaultPrevented, false);
    assert.ok(logs.some((entry) => entry.event === 'composer.paste.no_composer' && entry.fields.targetTag === 'body' && entry.fields.reason === 'not_rendered'));
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    global.Element = previousElement;
    dom.window.close();
  }
});

test('image paste on the body with a disabled composer logs and does nothing', () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  const documentRef = dom.window.document;
  const chatInput = documentRef.getElementById('input');
  const queuedImages = [];
  const logs = [];
  let controller;
  try {
    chatInput.disabled = true;
    chatInput.getClientRects = () => [{}];
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput, chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async (payload) => { queuedImages.push(payload); }, appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
    controller.bind();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '', items: [{ type: 'image/png', getAsFile: () => ({ name: 'disabled.png', type: 'image/png', arrayBuffer: async () => Uint8Array.from([1]).buffer }) }] } });
    documentRef.body.dispatchEvent(event);
    assert.equal(queuedImages.length, 0);
    assert.equal(event.defaultPrevented, false);
    assert.ok(logs.some((entry) => entry.event === 'composer.paste.no_composer' && entry.fields.reason === 'disabled'));
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  }
});

test('image paste on a focused checkbox reroutes into the composer queue', async () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><input id="checkbox" type="checkbox"><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  const documentRef = dom.window.document;
  const chatInput = documentRef.getElementById('input');
  const checkbox = documentRef.getElementById('checkbox');
  const queuedImages = [];
  let controller;
  try {
    chatInput.getClientRects = () => [{}];
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput, chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async (payload) => { queuedImages.push(payload); return { id: 'img_1', sizeBytes: 1 }; } } });
    controller.bind();
    checkbox.focus();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '', items: [{ type: 'image/png', getAsFile: () => ({ name: 'checkbox.png', type: 'image/png', arrayBuffer: async () => Uint8Array.from([1]).buffer }) }] } });
    checkbox.dispatchEvent(event);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queuedImages.length, 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(documentRef.activeElement, chatInput);
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  }
});

test('image paste on the body skips reroute when the clipboard image has no file', () => {
  const dom = new JSDOM('<div id="tray"></div><div id="settings"></div><button id="settings-button"></button><div id="command"></div><button id="terminal"></button><button id="shortcut"></button><textarea id="input"></textarea><main id="chat"></main><button id="attach"></button><button id="capture"></button>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  const documentRef = dom.window.document;
  const chatInput = documentRef.getElementById('input');
  const queuedImages = [];
  const logs = [];
  let controller;
  try {
    chatInput.getClientRects = () => [{}];
    controller = createAttachmentEventBindings({ state: { ui: { composerPopoverOpen: false } }, constants: { TOAST_SOURCE: { attachments: 'attachments' } }, dom: { attachmentTray: documentRef.getElementById('tray'), composerSettingsPopover: documentRef.getElementById('settings'), composerSettingsButton: documentRef.getElementById('settings-button'), composerCommandPopover: documentRef.getElementById('command'), composerTerminalShortcut: documentRef.getElementById('terminal'), composerAttachShortcut: documentRef.getElementById('shortcut'), chatInput, chatView: documentRef.getElementById('chat'), attachFilesButton: documentRef.getElementById('attach'), captureScreenButton: documentRef.getElementById('capture') }, callbacks: { resetAttachmentQueue() {}, removeQueuedAttachment() {}, renderAttachmentTray() {}, suppressFileDropNavigation() {}, setDropActive() {}, prepareDroppedAttachments: async () => {}, getDroppedFilePaths: () => [], renderComposerPopover() {}, renderCommandPopover() {}, syncComposerModelSelectWidth() {}, updateComposerSafeOffset() {}, closeComposerPopover() {}, closeCommandPopover() {}, handleAttachmentPicker: async () => {}, showToastMessage() {}, toErrorMessage: (error, fallback) => error?.message || fallback, beginAttachmentToken: () => ({ operationId: 'paste-1' }), cancelAttachmentToken() {}, queueInlineImageAttachment: async (payload) => { queuedImages.push(payload); }, appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
    controller.bind();
    documentRef.body.focus();
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '', items: [{ type: 'image/png', getAsFile: () => null }] } });
    documentRef.body.dispatchEvent(event);
    assert.equal(queuedImages.length, 0);
    assert.equal(event.defaultPrevented, false);
    assert.ok(logs.some((entry) => entry.event === 'composer.paste.reroute_skipped' && entry.fields.targetTag === 'body'));
    assert.notEqual(documentRef.activeElement, chatInput);
  } finally {
    controller?.dispose();
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  }
});
