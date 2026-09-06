'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDisplayMediaPicker } = require('../renderer/features/renderer-display-media-picker');
const stringUtils = require('../renderer/shared/string-utils');

const SCREEN = {
  id: 'screen:0:0',
  name: 'Entire Screen',
  displayId: '1',
  kind: 'screen',
  thumbnailDataUrl: 'data:image/png;base64,AAAA',
};
const WINDOW = {
  id: 'window:12:0',
  name: 'Notepad',
  displayId: '',
  kind: 'window',
  thumbnailDataUrl: 'data:image/png;base64,BBBB',
};

// A help-overlay stand-in that mirrors the real close()->onClose ordering:
// open is flipped to false BEFORE onClose fires (so a re-entrant close() during
// onClose is a no-op, exactly like renderer/inventory/help-overlay.js).
function createFakeOverlay() {
  let open = false;
  let lastConfig = null;
  const calls = { open: 0, close: 0, destroy: 0 };
  return {
    open(config) {
      calls.open += 1;
      lastConfig = config || {};
      open = true;
    },
    close() {
      calls.close += 1;
      if (!open) {
        return;
      }
      open = false;
      const onClose = lastConfig && lastConfig.onClose;
      if (typeof onClose === 'function') {
        onClose();
      }
    },
    isOpen() {
      return open;
    },
    destroy() {
      calls.destroy += 1;
      open = false;
    },
    calls,
    getConfig() {
      return lastConfig;
    },
  };
}

function createEnv() {
  const clickHandlers = [];
  const doc = {
    addEventListener(type, fn) {
      if (type === 'click') {
        clickHandlers.push(fn);
      }
    },
    removeEventListener(type, fn) {
      if (type !== 'click') {
        return;
      }
      const idx = clickHandlers.indexOf(fn);
      if (idx !== -1) {
        clickHandlers.splice(idx, 1);
      }
    },
  };
  const overlay = createFakeOverlay();
  const responses = [];
  const counters = { unsubRequest: 0, unsubCancel: 0 };
  let requestListener = null;
  let cancelListener = null;
  const bridge = {
    onRequest(cb) {
      requestListener = cb;
      return () => {
        counters.unsubRequest += 1;
        requestListener = null;
      };
    },
    onCancel(cb) {
      cancelListener = cb;
      return () => {
        counters.unsubCancel += 1;
        cancelListener = null;
      };
    },
    respond(requestId, sourceId) {
      responses.push({ requestId, sourceId });
    },
  };
  const state = {};
  const picker = createDisplayMediaPicker({
    document: doc,
    bridge,
    helpOverlayFactory: () => overlay,
    escapeHtml: stringUtils.escapeHtml,
    state,
  });
  picker.bind();

  function fireClick(closestMap) {
    // The module registers a single capturing click listener per open request.
    const handler = clickHandlers[clickHandlers.length - 1];
    assert.ok(typeof handler === 'function', 'a capturing click listener should be registered while open');
    handler({
      preventDefault() {},
      target: {
        closest(selector) {
          return Object.prototype.hasOwnProperty.call(closestMap, selector) ? closestMap[selector] : null;
        },
      },
    });
  }

  return {
    picker,
    overlay,
    responses,
    counters,
    state,
    clickHandlers,
    emitRequest: (payload) => requestListener && requestListener(payload),
    emitCancel: (payload) => cancelListener && cancelListener(payload),
    clickTile: (sourceId) => fireClick({ '[data-capture-source-id]': { getAttribute: () => sourceId } }),
    clickCancel: () => fireClick({ '[data-capture-source-cancel]': {} }),
  };
}

test('onRequest opens the modal with escaped source names and pickable tiles', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 1, sources: [SCREEN, WINDOW] });

  assert.equal(env.overlay.calls.open, 1);
  assert.equal(env.overlay.isOpen(), true);
  const body = env.overlay.getConfig().bodyHtml;
  assert.match(body, /data-capture-source-id="screen:0:0"/);
  assert.match(body, /data-capture-source-id="window:12:0"/);
  assert.match(body, /Entire Screen/);
  assert.match(body, /Notepad/);
  assert.match(body, /class="capture-source-tile"[^>]*title="Notepad"[^>]*data-capture-source-id="window:12:0"/);
  // Both a Screens and a Windows section render.
  assert.match(body, /Screens/);
  assert.match(body, /Windows/);
  assert.match(body, /data-capture-source-cancel/);
  // Pending default: until the user picks, the shared outcome reads 'cancelled'
  // so a backstop-timeout rejection stays quiet regardless of IPC ordering.
  assert.equal(env.state.displayMediaCapture.lastOutcome, 'cancelled');
});

test('picking a tile responds with the source id and records a picked outcome', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 7, sources: [SCREEN, WINDOW] });
  env.clickTile('window:12:0');

  assert.deepEqual(env.responses, [{ requestId: 7, sourceId: 'window:12:0' }]);
  assert.equal(env.state.displayMediaCapture.lastOutcome, 'picked');
  assert.equal(env.overlay.isOpen(), false);
});

test('the Cancel button responds null and records a cancelled outcome', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 3, sources: [SCREEN] });
  env.clickCancel();

  assert.deepEqual(env.responses, [{ requestId: 3, sourceId: null }]);
  assert.equal(env.state.displayMediaCapture.lastOutcome, 'cancelled');
  assert.equal(env.overlay.isOpen(), false);
});

test('Esc / scrim / close (overlay onClose) responds null and records cancelled', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 5, sources: [SCREEN] });
  // Simulate the help-overlay's own dismissal (Esc/scrim/close button).
  env.overlay.close();

  assert.deepEqual(env.responses, [{ requestId: 5, sourceId: null }]);
  assert.equal(env.state.displayMediaCapture.lastOutcome, 'cancelled');
});

test('resolving is idempotent — a pick then an onClose does not double-respond', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 9, sources: [SCREEN] });
  env.clickTile('screen:0:0');
  // A stray extra close must not produce a second respond.
  env.overlay.close();

  assert.equal(env.responses.length, 1);
  assert.deepEqual(env.responses[0], { requestId: 9, sourceId: 'screen:0:0' });
});

test('onCancel from main dismisses the stale modal without responding again', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 11, sources: [SCREEN] });
  env.emitCancel({ requestId: 11 });

  assert.equal(env.overlay.isOpen(), false);
  assert.equal(env.responses.length, 0, 'onCancel must not echo a response back to main');
  assert.equal(env.state.displayMediaCapture.lastOutcome, 'cancelled');
});

test('onCancel for a non-active request is ignored', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 20, sources: [SCREEN] });
  env.emitCancel({ requestId: 999 });

  assert.equal(env.overlay.isOpen(), true, 'a mismatched cancel must not close the active modal');
  assert.equal(env.responses.length, 0);
});

test('a second onRequest supersedes the first (cancels it, opens the new one)', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 1, sources: [SCREEN] });
  env.emitRequest({ requestId: 2, sources: [WINDOW] });

  // The prior request is cancelled...
  assert.deepEqual(env.responses, [{ requestId: 1, sourceId: null }]);
  // ...and the new modal is open.
  assert.equal(env.overlay.calls.open, 2);
  assert.equal(env.overlay.isOpen(), true);
  // Picking now resolves the newer request.
  env.clickTile('window:12:0');
  assert.deepEqual(env.responses[1], { requestId: 2, sourceId: 'window:12:0' });
});

test('a foreign window title is escaped, never injected as live markup', () => {
  const env = createEnv();
  const evil = {
    id: 'window:1:0',
    name: '"><img src=x onerror=alert(1)>',
    displayId: '',
    kind: 'window',
    thumbnailDataUrl: 'data:image/png;base64,AAAA',
  };
  env.emitRequest({ requestId: 1, sources: [evil] });
  const body = env.overlay.getConfig().bodyHtml;

  assert.ok(!body.includes('onerror=alert(1)>'), 'the raw onerror payload must not survive');
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the title must appear escaped');
});

test('an invalid thumbnail data URL falls back to a placeholder tile', () => {
  const env = createEnv();
  const bad = {
    id: 'screen:0:0',
    name: 'Screen',
    displayId: '1',
    kind: 'screen',
    thumbnailDataUrl: 'javascript:alert(1)',
  };
  env.emitRequest({ requestId: 1, sources: [bad] });
  const body = env.overlay.getConfig().bodyHtml;

  assert.ok(!body.includes('javascript:alert(1)'), 'a non-image URL must never reach the DOM');
  assert.match(body, /capture-source-thumb--empty/, 'the tile falls back to the empty placeholder');
});

test('an empty source list still opens a modal with an explicit empty state', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 1, sources: [] });
  const body = env.overlay.getConfig().bodyHtml;

  assert.equal(env.overlay.isOpen(), true);
  assert.match(body, /No screens or windows are available/);
  // Cancel still works from the empty state.
  env.clickCancel();
  assert.deepEqual(env.responses, [{ requestId: 1, sourceId: null }]);
});

test('dispose unsubscribes, closes an open modal, and releases an in-flight request', () => {
  const env = createEnv();
  env.emitRequest({ requestId: 42, sources: [SCREEN] });
  env.picker.dispose();

  assert.equal(env.counters.unsubRequest, 1, 'onRequest subscription is torn down');
  assert.equal(env.counters.unsubCancel, 1, 'onCancel subscription is torn down');
  assert.deepEqual(env.responses, [{ requestId: 42, sourceId: null }], 'in-flight request is released so getDisplayMedia does not hang');
  assert.equal(env.state.displayMediaCapture.lastOutcome, 'cancelled', 'a disposed in-flight capture stays quiet, not a danger toast');
  assert.equal(env.overlay.calls.destroy, 1);
  // Idempotent: a second dispose is a no-op.
  env.picker.dispose();
  assert.equal(env.responses.length, 1);
});

test('a rejecting respond invoke is caught (no unhandled rejection)', () => {
  let catchAttached = false;
  const responses = [];
  let requestListener = null;
  const thenable = { then() { return thenable; }, catch() { catchAttached = true; return thenable; } };
  const bridge = {
    onRequest(cb) { requestListener = cb; return () => {}; },
    onCancel() { return () => {}; },
    respond(requestId, sourceId) { responses.push({ requestId, sourceId }); return thenable; },
  };
  const overlay = createFakeOverlay();
  const picker = createDisplayMediaPicker({
    document: { addEventListener() {}, removeEventListener() {} },
    bridge,
    helpOverlayFactory: () => overlay,
    escapeHtml: stringUtils.escapeHtml,
    state: {},
  });
  picker.bind();
  requestListener({ requestId: 1, sources: [SCREEN] });
  overlay.close(); // Esc/scrim path -> finishPick(null) -> respond()

  assert.equal(catchAttached, true, 'the invoke promise must have .catch attached');
  assert.deepEqual(responses, [{ requestId: 1, sourceId: null }]);
});

test('with no overlay chrome available, a request is cancelled cleanly', () => {
  const responses = [];
  let requestListener = null;
  const bridge = {
    onRequest(cb) { requestListener = cb; return () => {}; },
    onCancel() { return () => {}; },
    respond(requestId, sourceId) { responses.push({ requestId, sourceId }); },
  };
  const picker = createDisplayMediaPicker({
    document: { addEventListener() {}, removeEventListener() {} },
    bridge,
    helpOverlayFactory: null, // no a11y chrome
    escapeHtml: stringUtils.escapeHtml,
    state: {},
  });
  picker.bind();
  requestListener({ requestId: 1, sources: [SCREEN] });

  assert.deepEqual(responses, [{ requestId: 1, sourceId: null }]);
});
