'use strict';

// Row 62: the bootstrap now loads sessions and opens the last chat before the
// backend is ready, so the restored chat's first render must already see real
// feature flags (math rendering, pretext layout, palette/top-nav binds) rather
// than the placeholders that used to land only after bootstrap() returned.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function recordBootOrder(window, events) {
  const shell = window.jennyShell;
  const getFeatureState = shell.features.getState.bind(shell.features);
  shell.features.getState = async (...args) => {
    events.push('features.getState:called');
    const payload = await getFeatureState(...args);
    events.push('features.getState:resolved');
    return payload;
  };
  const listSessions = shell.sessions.list.bind(shell.sessions);
  shell.sessions.list = async (...args) => {
    // Other modules also pull feature state at bind time; what matters is that
    // the renderer has merged a real payload before the chat history loads.
    const resolved = window.__rendererState?.features?.availabilityResolved === true;
    events.push(`sessions.list:flags-${resolved ? 'applied' : 'placeholder'}`);
    return listSessions(...args);
  };
}

test('feature flags resolve before the bootstrap lists sessions and restores the last chat (row 62)', async (t) => {
  const events = [];
  const app = await loadRendererApp({
    persistedActiveView: 'chat',
    beforeRendererBoot: (window) => recordBootOrder(window, events),
  });
  t.after(() => app.dispose());
  await waitForUi(app.window, 80);

  const firstList = events.find((event) => event.startsWith('sessions.list'));
  assert.ok(events.includes('features.getState:resolved'), `feature state was fetched: ${events.join(', ')}`);
  assert.equal(firstList, 'sessions.list:flags-applied', `flags applied before sessions.list: ${events.join(', ')}`);
});
