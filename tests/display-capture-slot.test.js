'use strict';

// new-test-file: the capture gate's one-use slot and frame check are a new surface (row 197 S1).

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const {
  ARM_TTL_MS,
  createDisplayCaptureSlot,
  isMainFrameCaptureRequest,
  isWindowSourceId,
} = require('../services/main/display-capture-slot');
const { MAIN_DOCUMENT_PATH } = require('../services/main/ipc-sender-authorization');

const APP_URL = pathToFileURL(MAIN_DOCUMENT_PATH).href;

function clock(start = 1000) {
  const state = { now: start };
  return { now: () => state.now, advance: (ms) => { state.now += ms; } };
}

test('an armed slot answers once and is then empty', () => {
  const c = clock();
  const slot = createDisplayCaptureSlot({ now: c.now });
  assert.equal(slot.isArmed(), false);
  assert.equal(slot.arm('window:591824:0'), true);
  assert.equal(slot.isArmed(), true);
  assert.deepEqual(slot.take(), { sourceId: 'window:591824:0' });
  assert.equal(slot.take(), null);
  assert.equal(slot.isArmed(), false);
});

test('an armed slot expires after its few seconds', () => {
  const c = clock();
  const slot = createDisplayCaptureSlot({ now: c.now });
  assert.equal(slot.arm('window:1:0'), true);
  c.advance(ARM_TTL_MS + 1);
  assert.equal(slot.isArmed(), false);
  assert.equal(slot.take(), null);
});

test('a live slot is not re-armed; an expired or disarmed one can be', () => {
  const c = clock();
  const slot = createDisplayCaptureSlot({ now: c.now });
  assert.equal(slot.arm('window:1:0'), true);
  assert.equal(slot.arm('window:2:0'), false);
  assert.deepEqual(slot.take(), { sourceId: 'window:1:0' });
  assert.equal(slot.arm('window:3:0'), true);
  slot.disarm();
  assert.equal(slot.take(), null);
  assert.equal(slot.arm('window:4:0'), true);
  c.advance(ARM_TTL_MS + 1);
  assert.equal(slot.arm('window:5:0'), true);
  assert.deepEqual(slot.take(), { sourceId: 'window:5:0' });
});

test('only a window source id can be armed', () => {
  const slot = createDisplayCaptureSlot();
  for (const bad of ['screen:0:0', 'window:abc:0', 'window:1:1', 'window:-1:0', 'window:0:0', '', null, 42, 'window:1:0 ']) {
    assert.equal(isWindowSourceId(bad), false, String(bad));
    assert.equal(slot.arm(bad), false, String(bad));
  }
  assert.equal(isWindowSourceId('window:591824:0'), true);
});

function mainWindowWith({ url = APP_URL } = {}) {
  const mainFrame = { url };
  const webContents = { mainFrame, isDestroyed: () => false, getURL: () => url };
  return { mainFrame, mainWindow: { isDestroyed: () => false, webContents } };
}

test('a capture request from the main window main frame on the app page passes', () => {
  const { mainFrame, mainWindow } = mainWindowWith();
  assert.equal(isMainFrameCaptureRequest({ request: { frame: mainFrame }, getMainWindow: () => mainWindow }), true);
});

test('a request from a frame that is not the main window main frame is refused', () => {
  const { mainFrame, mainWindow } = mainWindowWith();
  const getMainWindow = () => mainWindow;
  assert.equal(isMainFrameCaptureRequest({ request: { frame: { url: APP_URL } }, getMainWindow }), false, 'another frame');
  assert.equal(isMainFrameCaptureRequest({ request: { frame: null }, getMainWindow }), false, 'no frame');
  assert.equal(isMainFrameCaptureRequest({ request: {}, getMainWindow }), false, 'frame missing');
  assert.equal(isMainFrameCaptureRequest({ request: null, getMainWindow }), false, 'no request');
  assert.equal(isMainFrameCaptureRequest({ request: { frame: mainFrame }, getMainWindow: null }), false, 'no window getter');
  assert.equal(isMainFrameCaptureRequest({ request: { frame: mainFrame }, getMainWindow: () => null }), false, 'no window');
  const navigated = mainWindowWith({ url: 'https://example.com/' });
  assert.equal(isMainFrameCaptureRequest({ request: { frame: navigated.mainFrame }, getMainWindow: () => navigated.mainWindow }), false, 'navigated away');
  mainWindow.isDestroyed = () => true;
  assert.equal(isMainFrameCaptureRequest({ request: { frame: mainFrame }, getMainWindow }), false, 'window gone');
  assert.equal(isMainFrameCaptureRequest({ request: { frame: mainFrame }, getMainWindow: () => { throw new Error('boom'); } }), false, 'throws');
});
