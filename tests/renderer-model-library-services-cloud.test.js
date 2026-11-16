'use strict';

// Settings > Models > "Engines and providers": the Cloud providers rows (ChatGPT, Codex CLI) and the
// summary rule for a row that is drawn but not counted ("Add provider…").
// new-test-file: services test at its 600-line cap

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const servicesModule = require('../renderer/shell/model-library/model-library-services');
const { createCloudModelsController } = require('../renderer/shell/renderer-settings-cloud-models');

async function flush() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function makeServices(t) {
  const dom = new JSDOM('<!doctype html><body><div id="modelServicesHost"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const services = servicesModule.createModelLibraryServices({ documentRef: dom.window.document, windowRef: dom.window });
  t.after(() => services.dispose());
  return { dom, doc: dom.window.document, services };
}

const heads = (doc) => [...doc.querySelectorAll('#modelServicesHost .srow-head')].map((node) => [node.querySelector('span').textContent, node.querySelector('small').textContent]);
const rowIds = (doc) => [...doc.querySelectorAll('#modelServicesHost .srow[data-service-id]')].map((node) => node.dataset.serviceId);
const row = (doc, id) => doc.querySelector(`#modelServicesHost .srow[data-service-id="${id}"]`);
const status = (doc, id) => row(doc, id).querySelector('.srow-status span:last-child').textContent;
const tone = (doc, id) => row(doc, id).querySelector('.mp-dot').dataset.tone;
const action = (doc, id) => row(doc, id).querySelector('button').textContent;

function entry(id, set, overrides = {}) {
  return {
    id, kind: 'cloud', order: 10, name: id, what: `What ${id} does`,
    getStatus: () => ({ text: set ? 'Ready' : 'None added', tone: set ? 'ready' : 'off', set }),
    ...overrides,
  };
}

test('an entry with inSummary:false is drawn but left out of its section summary', async (t) => {
  const { doc, services } = makeServices(t);
  let secondSet = false;
  services.register(entry('one', true));
  services.register(entry('two', false, { order: 20, getStatus: () => ({ text: secondSet ? 'Ready' : 'Off', tone: secondSet ? 'ready' : 'off', set: secondSet }) }));
  services.register(entry('add', false, { order: 999, inSummary: false }));
  await flush();
  assert.deepEqual(rowIds(doc), ['one', 'two', 'add']);
  assert.deepEqual(heads(doc), [['Cloud providers', '1 of 2 set up']]);
  secondSet = true;
  services.refresh('two');
  assert.deepEqual(heads(doc), [['Cloud providers', '2 ready']], 'an uncounted row never makes the section partial');
  services.unregister('one');
  services.unregister('two');
  await flush();
  assert.deepEqual(heads(doc), [['Cloud providers', 'None set up']], 'a section of only uncounted rows reads as none set up');
});

function inventoryFixture() {
  return {
    settingsField: require('../renderer/inventory/settings-field'),
    toggleSwitch: require('../renderer/inventory/toggle-switch').toggleSwitch,
    badge: (o = {}) => `<span class="inv-badge" data-tone="${o.tone || ''}">${o.text || ''}</span>`,
    actionButton: (o = {}) => `<button type="button" data-action="${o.id || ''}">${o.label || ''}</button>`,
  };
}

function cloudState({ auth = 'signed_out', plan = '', error = null } = {}) {
  return { chatgpt: { enabled: true, auth: { state: auth, email: 'sam@example.com', planType: plan, error } }, localOnly: false };
}

function cloudHarness(t, { chatgpt = cloudState(), codex = { status: 'unavailable', code: 'codex_cli_unavailable', message: 'not found' } } = {}) {
  const h = makeServices(t);
  let push = null;
  let codexState = codex;
  const bridge = { async getState() { return chatgpt; }, onChanged(fn) { push = fn; return () => { push = null; }; } };
  const codexBridge = { async getState() { return codexState; }, async refresh() { return codexState; } };
  const controller = createCloudModelsController({
    windowRef: h.dom.window, documentRef: h.doc, inventory: inventoryFixture(), services: () => h.services,
    getBridge: () => bridge, getCodexBridge: () => codexBridge,
  });
  t.after(() => controller.dispose());
  return { ...h, controller, push: (next) => push(next), setCodex: (next) => { codexState = next; } };
}

test('cloud providers: ChatGPT and Codex CLI register as the first two rows, signed out and not found', async (t) => {
  const h = cloudHarness(t);
  h.controller.bind();
  await flush();
  assert.deepEqual(rowIds(h.doc), ['chatgpt', 'codex']);
  assert.deepEqual(heads(h.doc), [['Cloud providers', 'None set up']]);
  assert.equal(row(h.doc, 'chatgpt').querySelector('.mrow-name').textContent, 'ChatGPT');
  assert.equal(row(h.doc, 'chatgpt').querySelector('.mrow-meta').textContent, 'Your ChatGPT subscription');
  assert.equal(row(h.doc, 'codex').querySelector('.mrow-name').textContent, 'Codex CLI');
  assert.equal(row(h.doc, 'codex').querySelector('.mrow-meta').textContent, 'The codex command and its own login');
  assert.equal(status(h.doc, 'chatgpt'), 'Not connected');
  assert.equal(tone(h.doc, 'chatgpt'), 'off');
  assert.equal(action(h.doc, 'chatgpt'), 'Sign in');
  assert.equal(status(h.doc, 'codex'), 'Not found');
  assert.equal(action(h.doc, 'codex'), 'Check again');
});

test('cloud providers: signed in shows the plan, a ready CLI reads Ready, and both become Manage', async (t) => {
  const h = cloudHarness(t, { chatgpt: cloudState({ auth: 'signed_in', plan: 'plus' }), codex: { status: 'ready', code: 'ready' } });
  h.controller.bind();
  await flush();
  assert.equal(status(h.doc, 'chatgpt'), 'Connected · Plus');
  assert.equal(tone(h.doc, 'chatgpt'), 'ready');
  assert.equal(status(h.doc, 'codex'), 'Ready');
  assert.equal(action(h.doc, 'chatgpt'), 'Manage');
  assert.equal(action(h.doc, 'codex'), 'Manage');
  assert.deepEqual(heads(h.doc), [['Cloud providers', '2 ready']]);
  h.push(cloudState({ auth: 'signed_in', plan: '' }));
  assert.equal(status(h.doc, 'chatgpt'), 'Connected', 'no plan label, no separator');
});

test('cloud providers: connecting is busy, an error is a short warning, a missing login is Not signed in', async (t) => {
  const h = cloudHarness(t, { codex: { status: 'unavailable', code: 'chatgpt_auth_required' } });
  h.controller.bind();
  await flush();
  assert.equal(status(h.doc, 'codex'), 'Not signed in');
  h.push(cloudState({ auth: 'connecting' }));
  assert.equal(status(h.doc, 'chatgpt'), 'Waiting for browser');
  assert.equal(tone(h.doc, 'chatgpt'), 'busy');
  h.push(cloudState({ error: { code: 'auth_cancelled', message: 'Sign-in was cancelled.' } }));
  assert.equal(status(h.doc, 'chatgpt'), 'Sign-in was cancelled.');
  assert.equal(tone(h.doc, 'chatgpt'), 'warn');
  assert.equal(action(h.doc, 'chatgpt'), 'Sign in');
  h.push(cloudState({ error: { code: 'x', message: 'A very long failure message that would never fit in a status column beside the row name' } }));
  assert.equal(status(h.doc, 'chatgpt'), 'Sign-in failed', 'a long reason stays in the drawer');
});

test('cloud providers: a Codex check in flight reads Checking and dispose removes both rows', async (t) => {
  const h = cloudHarness(t, { codex: { status: 'unavailable', code: 'auth_unchecked' } });
  h.dom.window.setTimeout = () => 1;
  h.controller.bind();
  await flush();
  assert.equal(status(h.doc, 'codex'), 'Checking…');
  assert.equal(tone(h.doc, 'codex'), 'busy');
  h.controller.dispose();
  await flush();
  assert.deepEqual(rowIds(h.doc), []);
  assert.equal(h.services.has('chatgpt'), false);
});

test('cloud providers: rows announced before the services module loaded register when it announces itself', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="modelServicesHost"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const doc = dom.window.document;
  const controller = createCloudModelsController({
    windowRef: dom.window, documentRef: doc, inventory: inventoryFixture(),
    getBridge: () => ({ async getState() { return cloudState(); } }), getCodexBridge: () => ({ async getState() { return { status: 'ready', code: 'ready' }; } }),
  });
  t.after(() => controller.dispose());
  controller.bind();
  await flush();
  assert.deepEqual(rowIds(doc), [], 'no services module yet, so no row');
  dom.window.modelLibraryServices = servicesModule;
  const services = servicesModule.shared({ documentRef: doc, windowRef: dom.window });
  t.after(() => services.dispose());
  doc.dispatchEvent(new dom.window.CustomEvent(servicesModule.READY_EVENT));
  await flush();
  assert.deepEqual(rowIds(doc), ['chatgpt', 'codex']);
});

test('a drawer repaint that drops focus puts it back on the equivalent control, until the drawer closes', async (t) => {
  const { doc, services } = makeServices(t);
  const markup = '<p>Facts</p><button type="button" data-owner-action="first">One</button><button type="button" data-owner-action="check" data-owner-id="a&quot;b">Check</button>';
  let body = null;
  services.register(entry('a', true, { renderDrawer: (node) => { body = node; node.innerHTML = markup; } }));
  await flush();
  services.open('a');
  body.querySelector('[data-owner-action="check"]').focus();
  body.innerHTML = markup; // the owner repaints after an action
  await flush();
  assert.equal(doc.activeElement, body.querySelector('[data-owner-action="check"]'));
  services.close();
  body.innerHTML = markup;
  await flush();
  assert.notEqual(doc.activeElement, body.querySelector('[data-owner-action="check"]'), 'a closed drawer keeps nothing');
});
