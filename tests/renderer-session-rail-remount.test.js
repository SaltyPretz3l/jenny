'use strict';

/* A pane re-bound without an abort signal must not keep its previous session rail (and its
   5 s context-preview poll of the old session) alive. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountSessionRail } = require('../renderer/chat/renderer-session-rail.js');
const { createFixture, flush } = require('./helpers/session-rail-fixture.js');

test('mounting a rail on a pane that already has one disposes the previous controller', async () => {
  const fixture = createFixture({ sessionId: 'sess_old' });
  await flush();
  const { window } = fixture;
  const timers = { set: [], cleared: [] };
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = (...args) => { const id = nativeSetInterval(...args); timers.set.push(id); return id; };
  window.clearInterval = (id) => { timers.cleared.push(id); return nativeClearInterval(id); };
  const mount = () => mountSessionRail({
    pane: fixture.pane,
    cluster: fixture.doc.getElementById('cluster'),
    chatTimeline: fixture.doc.getElementById('timeline'),
    getSessionId: () => fixture.state.sessionId,
    getPaneWidth: () => fixture.state.width,
    bridge: fixture.bridge,
    detail: fixture.detail,
    windowRef: window,
    refreshIntervalMs: 5000,
  });

  const first = mount(); // retires the fixture's own rail
  await flush();
  const second = (fixture.state.sessionId = 'sess_new', mount());
  await flush();
  try {
    assert.notEqual(second, null);
    assert.notEqual(second, first);
    assert.equal(fixture.doc.querySelectorAll('[data-session-rail-root]').length, 1, 'one rail in the pane');
    assert.equal(first.elements.rail.isConnected, false, 'the old rail left the document');
    assert.equal(fixture.api.elements.rail.isConnected, false, 'the fixture rail left the document too');
    assert.equal(timers.set.length, 2, 'each polling rail set one interval');
    assert.ok(timers.cleared.includes(timers.set[0]), 'the retired rail cleared its poll timer');
    assert.ok(!timers.cleared.includes(timers.set[1]), 'the live rail keeps its timer');

    const before = fixture.bridge.summaryCalls.length;
    window.dispatchEvent(new window.CustomEvent('jenny:focused-chat-changed'));
    await flush();
    const after = fixture.bridge.summaryCalls.slice(before);
    assert.ok(after.every((call) => call.session_id === 'sess_new'), 'only the live rail answers session events');
  } finally {
    second.dispose();
    fixture.controller.abort();
  }
  assert.ok(timers.cleared.includes(timers.set[1]), 'dispose clears the live timer');
});
