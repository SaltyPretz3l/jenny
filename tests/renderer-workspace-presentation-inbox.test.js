'use strict';

/* Gate finding 2026-10-05: a workspace_present request that arrives before the
 * Workspace IDE was ever opened must not be lost. The presentation controller
 * ships in the lazy IDE bundle, so the always-loaded IDE root service relays
 * the one-shot workspacePresentation.onRequest push: it holds the newest
 * request, loads + builds the IDE in the background without switching the
 * view, and hands the request to the controller (attached by the real QoL
 * wiring at construction, before any IDE activation) so the normal
 * chip/outcome policy runs. A request that still cannot be delivered gets an
 * honest terminal outcome (`rejected`). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeRootService } = require('../renderer/shell/renderer-shell-ide-root-service');
const ideScripts = require('../renderer/shell/renderer-ide-script-manifest');
const { createIdeQolWiring } = require('../renderer/features/renderer-ide-qol-wiring');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeHarness(t, { loadSucceeds = true, buildPresentation = true } = {}) {
  const dom = new JSDOM('<div id="ideView"><div id="ideMain"></div></div>');
  const ideMain = dom.window.document.getElementById('ideMain');
  const reports = [];
  const cleanups = [];
  const timers = [];
  const viewChanges = [];
  let pushRequest = null;
  let unsubscribed = 0;
  let controllersBuilt = 0;
  const names = new Map(ideScripts.map(([src, name]) => [src, name]));
  const windowRef = {
    document: dom.window.document,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn) => { timers.push(fn); return fn; },
    clearTimeout: (fn) => { const index = timers.indexOf(fn); if (index >= 0) timers[index] = null; },
    jennyShell: {
      workspacePresentation: {
        onRequest(listener) {
          pushRequest = listener;
          return () => { unsubscribed += 1; pushRequest = null; };
        },
        reportOutcome(payload) {
          reports.push(payload);
          return Promise.resolve({ ok: true });
        },
      },
    },
    // The lazy IDE bundle "loads" asynchronously, one global per manifest entry.
    scriptLoaderUtils: {
      ensureScript: ({ src }) => new Promise((resolve) => setImmediate(() => {
        if (loadSucceeds) windowRef[names.get(src)] = {};
        resolve(loadSucceeds);
      })),
    },
  };
  const state = {
    ui: { activeView: 'chat', ide: { openTabs: [] } },
    features: { featureFlags: {} },
  };
  createIdeRootService({
    state,
    windowRef,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    callbacks: { setActiveView: (view) => viewChanges.push(view) },
    // Stand-in IDE controller: builds the REAL QoL collector exactly as the
    // production controller does at construction, and never activates.
    getIdeControllerUtils: () => ({
      createIdeController: () => {
        controllersBuilt += 1;
        const qol = buildPresentation ? createIdeQolWiring({
          getDom: () => ({ ideMain }),
          windowRef,
          getActiveView: () => state.ui.activeView,
          getFeatureFlags: () => state.features.featureFlags,
          getActiveSessionId: () => 'session-1',
        }) : null;
        return { qol };
      },
    }),
  });
  t.after(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
  return {
    reports, timers, viewChanges, ideMain, cleanups,
    push: (payload) => pushRequest?.(payload),
    subscribed: () => typeof pushRequest === 'function',
    unsubscribed: () => unsubscribed,
    controllersBuilt: () => controllersBuilt,
    fireTimers() { timers.splice(0).forEach((fn) => typeof fn === 'function' && fn()); },
    chip: () => ideMain.querySelector('.ide-presentation-chip'),
  };
}

async function settleLoad() {
  for (let i = 0; i < 6; i += 1) await flush();
}

test('a request pushed before the IDE ever loaded is delivered to the controller and reported', async (t) => {
  const h = makeHarness(t);
  assert.equal(h.subscribed(), true, 'the boot-level relay subscribes before the IDE view is opened');

  h.push({ view: 'preview', path: 'docs/a.html', request_id: 'wsp-1', source: 'tool' });
  await settleLoad();
  assert.equal(h.controllersBuilt(), 1, 'the IDE was built in the background to receive it');
  h.fireTimers();

  assert.ok(h.chip(), 'the non-stealing chip is raised in the (hidden) IDE');
  assert.match(h.chip().textContent, /Jenny wants to show a preview of docs\/a\.html/);
  assert.deepEqual(h.reports, [{ request_id: 'wsp-1', decision: 'prompted' }]);
  assert.deepEqual(h.viewChanges, [], 'the user is never switched away from chat');
});

test('requests held during the background load coalesce to the newest; the older is reported superseded', async (t) => {
  const h = makeHarness(t);
  h.push({ view: 'preview', path: 'docs/a.html', request_id: 'wsp-1' });
  h.push({ view: 'file_map', path: '', request_id: 'wsp-2' });
  await settleLoad();
  h.fireTimers();

  assert.deepEqual(h.reports, [
    { request_id: 'wsp-1', decision: 'superseded' },
    { request_id: 'wsp-2', decision: 'prompted' },
  ]);
  assert.equal(h.controllersBuilt(), 1);
});

test('once the controller is attached, later pushes go straight to it', async (t) => {
  const h = makeHarness(t);
  h.push({ view: 'preview', path: 'docs/a.html', request_id: 'wsp-1' });
  await settleLoad();
  h.fireTimers();
  h.push({ view: 'preview', path: 'docs/b.html', request_id: 'wsp-2' });
  h.fireTimers();

  assert.deepEqual(h.reports, [
    { request_id: 'wsp-1', decision: 'prompted' },
    { request_id: 'wsp-1', decision: 'superseded' },
    { request_id: 'wsp-2', decision: 'prompted' },
  ]);
  assert.equal(h.controllersBuilt(), 1);
});

test('a failed IDE load reports the held request rejected instead of losing it', async (t) => {
  const h = makeHarness(t, { loadSucceeds: false });
  h.push({ view: 'preview', path: 'docs/a.html', request_id: 'wsp-1' });
  await settleLoad();

  assert.deepEqual(h.reports, [{ request_id: 'wsp-1', decision: 'rejected' }]);
  assert.equal(h.controllersBuilt(), 0);
});

test('an IDE without a presentation controller reports the held request rejected', async (t) => {
  const h = makeHarness(t, { buildPresentation: false });
  h.push({ view: 'preview', path: 'docs/a.html', request_id: 'wsp-1' });
  await settleLoad();

  assert.deepEqual(h.reports, [{ request_id: 'wsp-1', decision: 'rejected' }]);
});

test('window cleanup unsubscribes the relay and drops a request still held', async (t) => {
  const h = makeHarness(t);
  h.push({ view: 'preview', path: 'docs/a.html', request_id: 'wsp-1' });
  h.cleanups.splice(0).forEach((cleanup) => cleanup());
  await settleLoad();

  assert.equal(h.unsubscribed(), 1);
  assert.deepEqual(h.reports, [{ request_id: 'wsp-1', decision: 'dropped' }]);
});
