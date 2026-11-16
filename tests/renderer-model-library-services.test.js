'use strict';

// Settings > Models > "Engines and providers": the services registry table, its
// one shared Manage drawer, and the chat engines (llama-server, NInfer) the
// engine-blocks helper registers on it. The Ollama row is covered in
// tests/renderer-ollama-health.test.js.
// new-test-file: a new surface (the services registry); engine-blocks had no test file of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const servicesModule = require('../renderer/shell/model-library/model-library-services');
const { createModelLibraryEngineBlocks } = require('../renderer/shell/model-library/model-library-engine-blocks');

async function flush() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function makeDom() {
  return new JSDOM('<!doctype html><body><div id="modelServicesHost"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
}

function makeServices(t) {
  const dom = makeDom();
  const services = servicesModule.createModelLibraryServices({ documentRef: dom.window.document, windowRef: dom.window });
  t.after(() => services.dispose());
  return { dom, doc: dom.window.document, services };
}

function entry(id, overrides = {}) {
  return {
    id, kind: 'chat', order: 10, name: id, what: `What ${id} does`,
    getStatus: () => ({ text: 'Ready', tone: 'ready', set: true }),
    ...overrides,
  };
}

const rowIds = (doc) => [...doc.querySelectorAll('#modelServicesHost .srow[data-service-id]')].map((node) => node.dataset.serviceId);
const heads = (doc) => [...doc.querySelectorAll('#modelServicesHost .srow-head')].map((node) => [node.querySelector('span').textContent, node.querySelector('small').textContent]);
const row = (doc, id) => doc.querySelector(`#modelServicesHost .srow[data-service-id="${id}"]`);

test('rows group by kind in the order chat, image, cloud and sort by order inside a kind', async (t) => {
  const { doc, services } = makeServices(t);
  services.register(entry('c2', { kind: 'cloud', order: 20 }));
  services.register(entry('i1', { kind: 'image', order: 5 }));
  services.register(entry('h2', { kind: 'chat', order: 20 }));
  services.register(entry('c1', { kind: 'cloud', order: 10 }));
  services.register(entry('h1', { kind: 'chat', order: 10 }));
  await flush();
  assert.deepEqual(rowIds(doc), ['h1', 'h2', 'i1', 'c1', 'c2']);
  assert.deepEqual(heads(doc).map((head) => head[0]), ['Chat engines', 'Image engines', 'Cloud providers']);
  assert.ok(doc.querySelector('#modelServicesHost > .mrow-list.srow-list'));
  assert.equal(services.has('h1'), true);
  services.unregister('h1');
  await flush();
  assert.equal(services.has('h1'), false);
  assert.deepEqual(rowIds(doc), ['h2', 'i1', 'c1', 'c2']);
});

test('several registers in one turn paint once, and re-registering an id replaces the row', async (t) => {
  const { doc, services } = makeServices(t);
  const host = doc.getElementById('modelServicesHost');
  let writes = 0;
  new doc.defaultView.MutationObserver(() => { writes += 1; }).observe(host, { childList: true });
  services.register(entry('a'));
  services.register(entry('b'));
  services.register(entry('a', { name: 'Renamed' }));
  await flush();
  assert.equal(writes, 1);
  assert.deepEqual(rowIds(doc), ['a', 'b']);
  assert.equal(row(doc, 'a').querySelector('.mrow-name').textContent, 'Renamed');
});

test('section summaries read all, some or none set up, and a kind without rows draws no header', async (t) => {
  const { doc, services } = makeServices(t);
  const state = (set) => () => ({ text: set ? 'Ready' : 'Not set up', tone: set ? 'ready' : 'off', set });
  services.register(entry('h1', { kind: 'chat', getStatus: state(true) }));
  services.register(entry('h2', { kind: 'chat', order: 20, getStatus: state(true) }));
  services.register(entry('i1', { kind: 'image', getStatus: state(true) }));
  services.register(entry('i2', { kind: 'image', order: 20, getStatus: state(false) }));
  await flush();
  assert.deepEqual(heads(doc), [['Chat engines', '2 ready'], ['Image engines', '1 of 2 set up']]);
  services.unregister('i1');
  services.unregister('h1');
  services.unregister('h2');
  await flush();
  assert.deepEqual(heads(doc), [['Image engines', 'None set up']]);
  services.unregister('i2');
  await flush();
  assert.equal(doc.querySelector('#modelServicesHost .srow-head'), null);
});

test('each row has exactly one action: Manage (ghost) when set up, the action label (secondary) when not', async (t) => {
  const { doc, services } = makeServices(t);
  services.register(entry('on'));
  services.register(entry('off', { order: 20, actionLabel: 'Sign in', getStatus: () => ({ text: 'Not connected', tone: 'off', set: false }) }));
  services.register(entry('plain', { order: 30, getStatus: () => ({ text: 'Not set up', tone: 'off', set: false }) }));
  await flush();
  for (const id of ['on', 'off', 'plain']) assert.equal(row(doc, id).querySelectorAll('button').length, 1, id);
  const manage = row(doc, 'on').querySelector('button');
  assert.equal(manage.textContent, 'Manage');
  assert.ok(manage.classList.contains('btn--ghost') && manage.classList.contains('btn--sm'));
  assert.equal(manage.dataset.modelServiceAction, 'open');
  assert.equal(manage.dataset.serviceId, 'on');
  assert.equal(manage.getAttribute('aria-label'), 'Manage: on');
  assert.equal(manage.getAttribute('title'), 'Manage: on');
  const signIn = row(doc, 'off').querySelector('button');
  assert.equal(signIn.textContent, 'Sign in');
  assert.ok(!signIn.classList.contains('btn--ghost'));
  assert.equal(row(doc, 'plain').querySelector('button').textContent, 'Set up…');
  const dot = row(doc, 'off').querySelector('.srow-status .mp-dot');
  assert.equal(dot.dataset.tone, 'off');
  assert.equal(dot.getAttribute('aria-hidden'), 'true');
  assert.equal(row(doc, 'off').querySelector('.srow-status span:last-child').textContent, 'Not connected');
});

test('names, descriptions and statuses are escaped', async (t) => {
  const { doc, services } = makeServices(t);
  services.register(entry('evil', {
    name: '<img src=x onerror=alert(1)>', what: '<b>bold</b>',
    getStatus: () => ({ text: '"><script>x()</script>', tone: 'ready" onclick="x', set: true }),
  }));
  await flush();
  const host = doc.getElementById('modelServicesHost');
  assert.equal(host.querySelector('img, b, script'), null);
  assert.ok(host.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(host.textContent.includes('<script>x()</script>'));
  assert.equal(host.querySelector('.mp-dot').dataset.tone, 'off', 'an unknown tone falls back instead of reaching the attribute');
  assert.equal(host.querySelector('[onclick]'), null);
});

test('refresh(id) replaces only that row and updates its section summary', async (t) => {
  const { doc, services } = makeServices(t);
  let set = false;
  services.register(entry('a', { getStatus: () => ({ text: set ? 'Ready' : 'Not set up', tone: set ? 'ready' : 'off', set }) }));
  services.register(entry('b', { order: 20 }));
  await flush();
  assert.deepEqual(heads(doc), [['Chat engines', '1 of 2 set up']]);
  const rowA = row(doc, 'a');
  const rowB = row(doc, 'b');
  const head = doc.querySelector('.srow-head');
  set = true;
  services.refresh('a');
  assert.notEqual(row(doc, 'a'), rowA, 'the refreshed row is a new node');
  assert.equal(row(doc, 'b'), rowB, 'the other rows keep their nodes');
  assert.equal(doc.querySelector('.srow-head'), head);
  assert.deepEqual(heads(doc), [['Chat engines', '2 ready']]);
  assert.equal(row(doc, 'a').querySelector('button').textContent, 'Manage');
  const settled = row(doc, 'a');
  services.refresh('a');
  assert.equal(row(doc, 'a'), settled, 'an unchanged row is left alone');
});

test('refresh(id) of a row that is not drawn queues one full render', async (t) => {
  const { doc, services } = makeServices(t);
  services.register(entry('a'));
  await flush();
  doc.getElementById('modelServicesHost').innerHTML = '';
  services.refresh('a');
  services.refresh('a');
  await flush();
  assert.deepEqual(rowIds(doc), ['a']);
});

test('open(id) opens one shared drawer, hands renderDrawer the body and focuses its first control', async (t) => {
  const { doc, services } = makeServices(t);
  const seen = [];
  services.register(entry('a', {
    name: 'Alpha', drawerTitle: 'Alpha engine',
    renderDrawer: (body) => { seen.push(body); body.innerHTML = '<p>Facts</p><button type="button" id="firstControl">Go</button><button type="button">Two</button>'; },
  }));
  services.register(entry('b', { order: 20, name: 'Beta', renderDrawer: (body) => { body.innerHTML = '<button type="button" id="betaControl">Beta go</button>'; } }));
  await flush();
  assert.equal(services.openId(), null);
  services.open('a', row(doc, 'a').querySelector('button'));
  assert.equal(services.openId(), 'a');
  assert.equal(doc.querySelectorAll('#modelServicesDrawer').length, 1);
  assert.equal(doc.querySelector('#modelServicesDrawer .inv-drawer-header h2').textContent, 'Alpha engine');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], doc.querySelector('#modelServicesDrawer .inv-drawer-body'));
  assert.equal(services.drawerBody(), seen[0]);
  assert.equal(doc.activeElement.id, 'firstControl');
  // A repaint that drops focus puts it back on the equivalent control (the GGUF folders block after an Add).
  const repaint = () => { seen[0].innerHTML = '<button type="button" data-model-library-folder-action="add-model">Add</button>'; };
  repaint(); seen[0].querySelector('button').focus(); repaint(); await flush();
  assert.equal(doc.activeElement, seen[0].querySelector('[data-model-library-folder-action="add-model"]'));
  services.open('b', row(doc, 'b').querySelector('button'));
  assert.equal(doc.querySelectorAll('#modelServicesDrawer').length, 1, 'one drawer host serves every row');
  assert.equal(doc.querySelector('#modelServicesDrawer .inv-drawer-header h2').textContent, 'Beta', 'the title defaults to the name');
  assert.equal(doc.activeElement.id, 'betaControl');
});

test('a click on a row action opens its drawer, and Escape closes it, runs onDrawerClose and returns focus to the row button', async (t) => {
  const { dom, doc, services } = makeServices(t);
  const closed = [];
  services.register(entry('a', { renderDrawer: (body) => { body.innerHTML = '<button type="button">In</button>'; }, onDrawerClose: () => closed.push('a') }));
  await flush();
  const button = row(doc, 'a').querySelector('button');
  button.focus();
  button.click();
  assert.equal(services.openId(), 'a');
  assert.ok(services.drawerBody());
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(services.openId(), null);
  assert.equal(services.drawerBody(), null);
  assert.deepEqual(closed, ['a']);
  assert.equal(doc.activeElement, button);
});

test('focus returns to the current row button even when the row was re-rendered while the drawer was open', async (t) => {
  const { dom, doc, services } = makeServices(t);
  services.register(entry('a', { renderDrawer: (body) => { body.innerHTML = '<button type="button">In</button>'; } }));
  await flush();
  const original = row(doc, 'a').querySelector('button');
  services.open('a', original);
  services.render();
  assert.equal(original.isConnected, false, 'the anchor went away with the re-render');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const current = row(doc, 'a').querySelector('button');
  assert.notEqual(current, original);
  assert.equal(doc.activeElement, current);
});

test('the close button and close() also run onDrawerClose once; opening a second id closes the first', async (t) => {
  const { doc, services } = makeServices(t);
  const closed = [];
  services.register(entry('a', { onDrawerClose: () => closed.push('a'), renderDrawer: (body) => { body.textContent = 'A'; } }));
  services.register(entry('b', { order: 20, onDrawerClose: () => closed.push('b'), renderDrawer: (body) => { body.textContent = 'B'; } }));
  await flush();
  services.open('a', row(doc, 'a').querySelector('button'));
  services.open('b', row(doc, 'b').querySelector('button'));
  assert.deepEqual(closed, ['a']);
  assert.equal(services.openId(), 'b');
  assert.equal(services.drawerBody().textContent, 'B');
  doc.querySelector('#modelServicesDrawer .inv-drawer-close').click();
  assert.deepEqual(closed, ['a', 'b']);
  assert.equal(services.openId(), null);
  services.open('a');
  services.close();
  services.close();
  assert.deepEqual(closed, ['a', 'b', 'a']);
});

test('unregistering the open id closes its drawer; open of an unknown id does nothing', async (t) => {
  const { doc, services } = makeServices(t);
  const closed = [];
  services.register(entry('a', { onDrawerClose: () => closed.push('a'), renderDrawer: (body) => { body.textContent = 'A'; } }));
  await flush();
  assert.equal(services.open('nope'), false);
  services.open('a');
  services.unregister('a');
  assert.deepEqual(closed, ['a']);
  assert.equal(doc.querySelector('#modelServicesDrawer .inv-drawer-panel'), null);
});

test('dispose() removes the drawer host and the click listener', async (t) => {
  const { doc, services } = makeServices(t);
  let opened = 0;
  services.register(entry('a', { renderDrawer: () => { opened += 1; } }));
  await flush();
  const button = row(doc, 'a').querySelector('button');
  services.open('a', button);
  assert.ok(doc.getElementById('modelServicesDrawer'));
  services.dispose();
  assert.equal(doc.getElementById('modelServicesDrawer'), null);
  button.click();
  assert.equal(opened, 1, 'a click after dispose opens nothing');
});

test('shared() hands every owner of one document the same instance, and dispose drops it', (t) => {
  const dom = makeDom();
  const deps = { documentRef: dom.window.document, windowRef: dom.window };
  const first = servicesModule.shared(deps);
  assert.equal(servicesModule.shared(deps), first);
  assert.notEqual(servicesModule.shared({ documentRef: makeDom().window.document, windowRef: dom.window }), first);
  first.dispose();
  const second = servicesModule.shared(deps);
  assert.notEqual(second, first);
  t.after(() => second.dispose());
  assert.equal(servicesModule.HOST_ID, 'modelServicesHost');
  assert.equal(servicesModule.DRAWER_ID, 'modelServicesDrawer');
});

// ---------- chat engines registered by the engine-blocks helper ----------

const PIN = { id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B', model_id: 'qwen3.8-27b-nvfp4', size_bytes: 23719715844, supports_mtp: true };

function ninferState({ install = {}, present = false, manager = {}, eligible = true } = {}) {
  return {
    eligible, reason: '', enabled: true,
    runtime: {
      install: { status: 'not_installed', version: '0.9.1', download_size_bytes: 450215373, install: null, last_error: null, ...install },
      artifacts: { status: 'idle', phase: '', download: null, last_error: null },
      pins: [PIN],
    },
    installed: [{ id: PIN.id, present }],
    manager: { state: 'stopped', port: 0, runtimeLabel: '', lastError: '', stoppedBy: '', ...manager },
    settings: { suggestionDismissed: true, watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 } },
  };
}

function engineHarness(t, options = {}) {
  const dom = makeDom();
  const doc = dom.window.document;
  const services = servicesModule.createModelLibraryServices({ documentRef: doc, windowRef: dom.window });
  const calls = [];
  let state = ninferState(options.ninferState);
  let listener = null;
  if (options.bridge !== false) {
    dom.window.jennyShell = {
      ninfer: {
        async getState() { calls.push('getState'); return state; },
        async setup() { calls.push('setup'); return { ok: true }; },
        onChanged(fn) { listener = fn; return () => { listener = null; }; },
      },
    };
  }
  let llama = options.llama || { running: false, port: 0, fileCount: 3, unavailable: false };
  const folders = { bind: () => calls.push('folders.bind'), render: () => {
    calls.push('folders.render');
    const host = doc.getElementById('modelLibraryFoldersHost');
    if (host) host.innerHTML = '<button type="button" id="foldersAdd">Add folder…</button>';
  } };
  const ninferChanges = [];
  const blocks = createModelLibraryEngineBlocks({
    windowRef: dom.window, documentRef: doc, imageEngineEnabled: () => false,
    ninferEnabled: () => options.ninferEnabled !== false,
    llamaServerEnabled: () => options.llamaServerEnabled !== false,
    llamaServer: () => llama, folders: () => folders, services: () => services,
    ninfer: { onState: () => ninferChanges.push(1), onUse: () => {} },
  });
  t.after(() => { blocks.dispose(); services.dispose(); });
  return {
    dom, doc, services, blocks, calls, folders, ninferChanges,
    setState: (next) => { state = ninferState(next); },
    setLlama: (next) => { llama = next; },
    emit: () => { if (listener) listener({}); },
    status: (id) => row(doc, id)?.querySelector('.srow-status span:last-child')?.textContent,
  };
}

test('engine blocks: llama-server and NInfer register as chat rows only behind their flags', async (t) => {
  const on = engineHarness(t);
  on.blocks.render();
  await flush();
  assert.deepEqual(rowIds(on.doc), ['llama-server', 'ninfer']);

  const off = engineHarness(t, { llamaServerEnabled: false, ninferEnabled: false });
  off.blocks.render();
  await flush();
  assert.deepEqual(rowIds(off.doc), []);

  const ineligible = engineHarness(t, { ninferState: { eligible: false } });
  ineligible.blocks.render();
  await flush();
  assert.deepEqual(rowIds(ineligible.doc), ['llama-server'], 'an ineligible card gets no NInfer row');
});

test('engine blocks: the llama-server row follows the server state and its drawer renders the folders host', async (t) => {
  const h = engineHarness(t);
  h.blocks.render();
  await flush();
  assert.equal(h.status('llama-server'), 'Idle · 3 files');
  h.setLlama({ running: false, port: 0, fileCount: 1, unavailable: false });
  h.blocks.render();
  assert.equal(h.status('llama-server'), 'Idle · 1 file');
  h.setLlama({ running: true, port: 8033, fileCount: 1, unavailable: false });
  h.blocks.render();
  assert.equal(h.status('llama-server'), 'Serving on :8033');
  h.setLlama({ running: false, port: 0, fileCount: 0, unavailable: true });
  h.blocks.render();
  assert.equal(h.status('llama-server'), 'Not available');
  assert.equal(row(h.doc, 'llama-server').querySelector('.mp-dot').dataset.tone, 'off');

  h.calls.length = 0;
  h.services.open('llama-server', row(h.doc, 'llama-server').querySelector('button'));
  const body = h.services.drawerBody();
  assert.ok(body.querySelector('.mp-quiet').textContent.includes('Runs GGUF files directly'));
  assert.ok(body.querySelector('#modelLibraryFoldersHost'));
  assert.deepEqual(h.calls.filter((call) => call.startsWith('folders.')), ['folders.bind', 'folders.render']);
  assert.ok(body.querySelector('#foldersAdd'), 'the folders controller rendered into the drawer');
});

test('engine blocks: the NInfer row follows summary() and its drawer holds the block, whose controls reach the bridge', async (t) => {
  const h = engineHarness(t);
  h.blocks.render();
  await flush();
  assert.equal(h.status('ninfer'), 'Not set up');
  const action = row(h.doc, 'ninfer').querySelector('button');
  assert.equal(action.textContent, 'Set up…');
  assert.ok(!action.classList.contains('btn--ghost'));

  h.setState({ install: { status: 'installed' }, present: true, manager: { state: 'ready', port: 8034 } });
  h.emit();
  await flush();
  assert.equal(h.status('ninfer'), 'Serving on :8034');
  assert.equal(row(h.doc, 'ninfer').querySelector('button').textContent, 'Manage');
  assert.ok(h.ninferChanges.length >= 1, 'the section is still told about the state change');

  h.setState({ install: { status: 'installed' }, present: true, manager: { state: 'crashed', stoppedBy: 'watchdog' } });
  h.emit();
  await flush();
  assert.equal(row(h.doc, 'ninfer').querySelector('.mp-dot').dataset.tone, 'warn');

  h.setState({});
  h.emit();
  await flush();
  assert.equal(h.status('ninfer'), 'Not set up');
  h.services.open('ninfer', row(h.doc, 'ninfer').querySelector('button'));
  const body = h.services.drawerBody();
  assert.ok(body.querySelector('#modelLibraryNinferHost .model-library-ninfer'), 'the NInfer block renders inside the drawer');
  assert.match(body.textContent, /built only for the RTX 5090/);
  h.calls.length = 0;
  body.querySelector('[data-ninfer-action="setup"]').click();
  await flush();
  assert.ok(h.calls.includes('setup'), 'Set up reaches the bridge from inside the drawer');
});

test('engine blocks: the NInfer row disappears when the kill switch goes off or the card turns ineligible, and dispose removes every row', async (t) => {
  const h = engineHarness(t);
  h.blocks.render();
  await flush();
  assert.deepEqual(rowIds(h.doc), ['llama-server', 'ninfer']);
  h.setState({ eligible: false });
  h.emit();
  await flush();
  assert.deepEqual(rowIds(h.doc), ['llama-server']);
  h.setState({});
  h.emit();
  await flush();
  assert.deepEqual(rowIds(h.doc), ['llama-server', 'ninfer']);
  h.blocks.dispose();
  await flush();
  assert.deepEqual(rowIds(h.doc), []);
  assert.equal(h.services.has('ninfer'), false);
});

test('engine blocks: rows rendered before the services module loaded register when it announces itself', async (t) => {
  const dom = makeDom();
  const doc = dom.window.document;
  dom.window.jennyShell = {};
  const blocks = createModelLibraryEngineBlocks({
    windowRef: dom.window, documentRef: doc, ninferEnabled: () => false,
    llamaServerEnabled: () => true, llamaServer: () => ({ running: false, port: 0, fileCount: 2, unavailable: false }),
  });
  t.after(() => blocks.dispose());
  blocks.render();
  await flush();
  assert.deepEqual(rowIds(doc), [], 'no services module yet, so no row');
  dom.window.modelLibraryServices = servicesModule;
  const services = servicesModule.shared({ documentRef: doc, windowRef: dom.window });
  t.after(() => services.dispose());
  doc.dispatchEvent(new dom.window.CustomEvent(servicesModule.READY_EVENT));
  await flush();
  assert.deepEqual(rowIds(doc), ['llama-server']);
});

// ---------- image engines (stable-diffusion.cpp, ComfyUI) registered by the same helper ----------

const GIB = 1073741824;
const imageFile = (name, gb) => ({ name, size_bytes: Math.round(gb * GIB) });
const imageSet = (id, backend) => ({ id, label: `${backend} set`, backend, family: 'qwen_image21', recipe: 'minimax_h3_image', root: 'G:\\m', files: { diffusion: imageFile('d.gguf', 1), text_encoder: imageFile('t.gguf', 1), vae: imageFile('v.safetensors', 0.5) }, created_at: 1 });
const comfyHealth = (extra = {}) => ({ folder: 'G:\\ComfyUI', ok: true, reason: '', version: '0.45.0', recipes: {}, ...extra });

function imageState(overrides = {}) {
  return {
    engine_tag: 'master-929-3f8527a', status: 'not_installed', install: null, last_error: null, custom_executable: null, download_size_bytes: 337915440,
    handoff: { active: false, retained: false, closing: false }, model_sets: { sets: [], default_id: null }, families: { qwen_image21: { label: 'Qwen-Image 2.1' } },
    comfyui: { enabled: true, health: null }, recipes: {}, ...overrides,
  };
}

function imageHarness(t, options = {}) {
  const dom = makeDom();
  const doc = dom.window.document;
  const services = servicesModule.createModelLibraryServices({ documentRef: doc, windowRef: dom.window });
  const calls = [];
  let state = imageState(options.state);
  let listener = null;
  dom.window.jennyShell = { imageEngine: {
    async getState() { calls.push('getState'); return state; },
    async chooseModelFolder() { calls.push('chooseModelFolder'); return { ok: false, reason: 'cancelled' }; },
    async chooseComfyFolder() { calls.push('chooseComfyFolder'); return { ok: false, reason: 'cancelled' }; },
    onChanged(fn) { listener = fn; return () => { listener = null; }; },
  } };
  let enabled = options.enabled !== false;
  const blocks = createModelLibraryEngineBlocks({
    windowRef: dom.window, documentRef: doc, imageEngineEnabled: () => enabled, ninferEnabled: () => false, llamaServerEnabled: () => false, services: () => services,
  });
  t.after(() => { blocks.dispose(); services.dispose(); });
  return {
    doc, services, blocks, calls,
    setEnabled: (value) => { enabled = value; },
    async setState(next) { state = imageState(next); if (listener) listener({}); await flush(); },
    status: (id) => row(doc, id)?.querySelector('.srow-status span:last-child')?.textContent,
    tone: (id) => row(doc, id)?.querySelector('.mp-dot')?.dataset.tone,
    action: (id) => row(doc, id)?.querySelector('button')?.textContent,
    open(id) { services.open(id, row(doc, id).querySelector('button')); return services.drawerBody(); },
  };
}

test('image engines: both rows register behind the flag and ComfyUI follows its own kill switch', async (t) => {
  const on = imageHarness(t);
  on.blocks.render();
  await flush();
  assert.deepEqual(rowIds(on.doc), ['sdcpp', 'comfyui']);
  assert.deepEqual(heads(on.doc), [['Image engines', 'None set up']]);
  const noComfy = imageHarness(t, { state: { comfyui: { enabled: false, health: null } } });
  noComfy.blocks.render();
  await flush();
  assert.deepEqual(rowIds(noComfy.doc), ['sdcpp']);
  const off = imageHarness(t, { enabled: false });
  off.blocks.render();
  await flush();
  assert.deepEqual(rowIds(off.doc), []);
  on.setEnabled(false);
  on.blocks.render();
  await flush();
  assert.deepEqual(rowIds(on.doc), [], 'the flag going off removes both rows');
});

test('image engines: the stable-diffusion.cpp row follows the engine state', async (t) => {
  const h = imageHarness(t);
  h.blocks.render();
  await flush();
  assert.equal(h.status('sdcpp'), 'Not installed');
  assert.equal(h.action('sdcpp'), 'Install…');
  const install = { phase: 'downloading', downloaded_bytes: 118 * 1048576, total_bytes: 322 * 1048576 };
  await h.setState({ status: 'installing', install });
  assert.equal(h.tone('sdcpp'), 'busy');
  assert.equal(h.status('sdcpp'), 'Downloading · 118 of 322 MB');
  const sets = [imageSet('0123456789ab', 'sdcpp'), imageSet('abcdef012345', 'comfyui')];
  await h.setState({ status: 'installed', model_sets: { sets, default_id: null } });
  assert.equal(h.status('sdcpp'), 'Installed · 1 model set', 'only stable-diffusion.cpp sets count');
  assert.equal(h.tone('sdcpp'), 'ready');
  assert.equal(h.action('sdcpp'), 'Manage');
  await h.setState({ status: 'installed', model_sets: { sets: [sets[0], { ...sets[0], id: '111111111111' }], default_id: null } });
  assert.equal(h.status('sdcpp'), 'Installed · 2 model sets');
  await h.setState({ status: 'error', last_error: 'download_failed' });
  assert.equal(h.tone('sdcpp'), 'warn');
  await h.setState({ status: 'installed', handoff: { active: false, retained: true, closing: false, cleanup: { attempts: 1, record: null } } });
  assert.equal(h.tone('sdcpp'), 'warn');
});

test('image engines: the ComfyUI row follows the folder check', async (t) => {
  const h = imageHarness(t);
  h.blocks.render();
  await flush();
  assert.equal(h.status('comfyui'), 'Not set up');
  assert.equal(h.tone('comfyui'), 'off');
  assert.equal(h.action('comfyui'), 'Set up…');
  await h.setState({ comfyui: { enabled: true, health: comfyHealth({ ok: false, reason: 'comfyui_folder_invalid', recipes: {} }) } });
  assert.equal(h.status('comfyui'), 'Folder not usable');
  assert.equal(h.tone('comfyui'), 'warn');
  await h.setState({ comfyui: { enabled: true, health: comfyHealth() } });
  assert.equal(h.status('comfyui'), 'Ready · 0.45.0');
  assert.equal(h.tone('comfyui'), 'ready');
  assert.equal(h.action('comfyui'), 'Manage');
  await h.setState({ comfyui: { enabled: true, health: comfyHealth({ version: '' }) } });
  assert.equal(h.status('comfyui'), 'Ready');
});

test('image engines: each drawer renders only its own part and its controls reach the bridge', async (t) => {
  const sets = [imageSet('0123456789ab', 'sdcpp'), imageSet('abcdef012345', 'comfyui')];
  const h = imageHarness(t, { state: { status: 'installed', model_sets: { sets, default_id: '0123456789ab' }, comfyui: { enabled: true, health: comfyHealth() } } });
  h.blocks.render();
  await flush();
  const sd = h.open('sdcpp');
  assert.match(sd.querySelector('.mp-quiet').textContent, /Lets Jenny draw images in chat from models you already have/);
  const sdHost = sd.querySelector('#modelLibraryImageEngineHost');
  assert.equal(sdHost.dataset.imageEnginePart, 'sdcpp');
  assert.ok(sdHost.querySelector('[data-image-engine-action="choose-folder"]'));
  assert.equal(sdHost.querySelector('[data-image-engine-action="choose-comfy-folder"]'), null);
  assert.equal(sdHost.querySelector('.model-library-image-engine-title'), null, 'the drawer title names the engine');
  assert.deepEqual([...sdHost.querySelectorAll('.model-library-image-engine-set-name')].map((n) => n.textContent), ['sdcpp set']);
  sdHost.querySelector('[data-image-engine-action="choose-folder"]').click();
  await flush();
  assert.ok(h.calls.includes('chooseModelFolder'));
  const comfy = h.open('comfyui');
  assert.match(comfy.querySelector('.mp-quiet').textContent, /Choose the ComfyUI_windows_portable folder you already use/);
  const comfyHost = comfy.querySelector('#modelLibraryImageEngineHost');
  assert.equal(comfyHost.dataset.imageEnginePart, 'comfyui');
  assert.equal(comfy.querySelectorAll('#modelLibraryImageEngineHost').length, 1);
  assert.equal(comfyHost.querySelector('[data-image-engine-action="choose-folder"]'), null);
  assert.deepEqual([...comfyHost.querySelectorAll('.model-library-image-engine-set-name')].map((n) => n.textContent), ['comfyui set']);
  comfyHost.querySelector('[data-image-engine-action="choose-comfy-folder"]').click();
  await flush();
  assert.ok(h.calls.includes('chooseComfyFolder'));
});

test('image engines: dispose removes both rows', async (t) => {
  const h = imageHarness(t);
  h.blocks.render();
  await flush();
  h.blocks.dispose();
  await flush();
  assert.equal(h.services.has('sdcpp') || h.services.has('comfyui'), false);
});
