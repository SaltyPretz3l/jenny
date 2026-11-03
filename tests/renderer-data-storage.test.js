'use strict';

// Settings > "Your data" (row 95): the sizes, folder links and the guarded clear flow, driven
// against a fake window.jennyShell.dataLifecycle in jsdom. The renderer must send category ids,
// the preview token and the typed count only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createDataStorageController, normalizeUsage } = require('../renderer/features/renderer-data-storage');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush() { for (let i = 0; i < 8; i += 1) await tick(); }

function usageResult(overrides = {}) {
  const categories = overrides.categories || [
    { id: 'chats', bytes: 412 * MB, files: 900, clearable: true, available: true, partial: false, locationDisplay: '%APPDATA%\\jenny\\sessions' },
    { id: 'artifacts', bytes: 0, files: 0, clearable: true, available: false, partial: false, locationDisplay: '' },
    { id: 'logs', bytes: 15 * MB, files: 40, clearable: true, available: true, partial: false, locationDisplay: '%APPDATA%\\jenny\\logs' },
    { id: 'caches', bytes: 96 * MB, files: 300, clearable: true, available: true, partial: true, locationDisplay: '%APPDATA%\\jenny\\Cache' },
    { id: 'leftovers', bytes: 8 * MB, files: 3, clearable: true, available: true, partial: false, locationDisplay: '%APPDATA%\\jenny\\exports' },
    { id: 'engines', bytes: 25 * GB, files: 30, clearable: false, available: true, partial: false, locationDisplay: '%APPDATA%\\jenny\\engines' },
    { id: 'personal', bytes: 3 * MB, files: 20, clearable: false, available: true, partial: false, locationDisplay: '%APPDATA%\\jenny' },
  ];
  return { ok: true, status: 'ok', categories, totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0) };
}

function previewResult(categoryId, overrides = {}) {
  return Object.assign({
    ok: true,
    status: 'ok',
    categoryId,
    previewToken: 'token-' + categoryId,
    items: [
      { label: 'Old app logs', bytes: 8 * MB, files: 4 },
      { label: 'Turn <b>diagnostics</b>', bytes: 3 * MB, files: 1 },
    ],
    totalBytes: 11 * MB,
    totalFiles: 5,
    kept: ['The current logs are emptied, not deleted'],
    partial: false,
  }, overrides);
}

function setup({ flag, usage = usageResult(), api = {}, openSection, refresh } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="appShell">
      <section id="settingsView" class="active-view"><nav><button class="settings-nav-item" data-settings-section="account">Profile</button></nav><section class="settings-card settings-section-active" data-settings-section="account">
        <div id="dataStorageGroup" hidden><h4>Your data</h4><div id="dataStorageMount"></div></div>
      </section></section>
    </div></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const calls = { usage: 0, usageArgs: [], reveal: [], preview: [], clear: [], sections: [], refreshes: 0 };
  const dataLifecycle = Object.assign({
    getStorageUsage: (request) => { calls.usage += 1; calls.usageArgs.push(request); return Promise.resolve(typeof usage === 'function' ? usage(calls.usage, request) : usage); },
    revealCategory: (request) => { calls.reveal.push(request); return Promise.resolve({ ok: true, status: 'ok' }); },
    previewClear: (request) => { calls.preview.push(request); return Promise.resolve(previewResult(request.categoryId)); },
    clearCategory: (request) => { calls.clear.push(request); return Promise.resolve({ ok: true, status: 'ok', freedBytes: 11 * MB, freedFiles: 5, failed: [] }); },
  }, api);
  window.jennyShell = { dataLifecycle };
  const state = { features: { featureFlags: flag === undefined ? {} : { data_usage_page: flag } } };
  const controller = createDataStorageController({
    windowRef: window,
    documentRef: window.document,
    state,
    openSettingsSection: openSection || ((id) => calls.sections.push(id)),
    refreshSessions: refresh || (() => { calls.refreshes += 1; return Promise.resolve(); }),
  });
  controller.bind();
  const doc = window.document;
  const rowTitles = () => [...doc.querySelectorAll('[data-settings-field] .settings-field-title')].map((el) => el.textContent);
  const row = (id) => doc.querySelector('[data-settings-field="data-storage-' + id + '"]');
  const status = () => doc.querySelector('[data-storage-status]');
  const modalEl = () => doc.querySelector('[data-step-modal="data-storage-clear"]');
  const modalAction = (id) => modalEl().querySelector('[data-step-modal-action="' + id + '"]');
  return { window, doc, calls, controller, rowTitles, row, status, modalEl, modalAction, dispose: () => { controller.dispose(); window.close(); } };
}

test('rows come largest first with the total, the folder link and one action each', async (t) => {
  const h = setup();
  t.after(h.dispose);
  await flush();
  assert.equal(h.doc.getElementById('dataStorageGroup').hidden, false);
  assert.deepEqual(h.rowTitles(), ['Engines & models', 'Chats & attachments', 'Caches', 'Logs & diagnostics', 'Leftovers', 'Settings & personal', 'Artifacts & generated images']);
  assert.match(h.doc.querySelector('.data-storage-total').textContent, /^Jenny uses at least 26 GB on this PC\.$/, 'a partial row makes the total a lower bound');
  assert.equal(h.doc.querySelector('.data-storage-total strong').textContent, '26 GB');
  const chats = h.row('chats');
  assert.match(chats.querySelector('.data-storage-size').textContent, /^412 MB$/);
  assert.equal(chats.querySelector('.data-storage-path').textContent, '%APPDATA%\\jenny\\sessions');
  assert.equal(chats.querySelector('[data-action="storage-clear"]').textContent, 'Delete all…');
  assert.equal(chats.querySelector('[data-action="storage-clear"]').getAttribute('aria-label'), 'Delete all chats…');
  assert.equal(h.row('logs').querySelector('[data-action="storage-clear"]').getAttribute('aria-label'), 'Clear logs & diagnostics…');
  assert.equal(h.row('caches').querySelector('.data-storage-size').textContent, '≥ 96 MB', 'a partial size is marked');
  assert.equal(h.row('engines').querySelector('[data-action="storage-manage"]').textContent, 'Manage');
  assert.equal(h.row('personal').querySelector('.data-storage-kept').textContent, 'Kept');
  assert.equal(h.row('personal').querySelector('[data-action]')?.getAttribute('data-action'), 'storage-reveal', 'only the folder link, no clear action');
  assert.equal(h.row('chats').querySelector('.data-storage-meter-slot').getAttribute('aria-hidden'), 'true');
});

test('a row without a project says so and offers no action', async (t) => {
  const h = setup();
  t.after(h.dispose);
  await flush();
  const artifacts = h.row('artifacts');
  assert.equal(artifacts.querySelector('.data-storage-size').textContent, 'No project open');
  assert.equal(artifacts.querySelector('[data-action]'), null);
  assert.equal(artifacts.querySelector('.data-storage-path'), null);
});

test('sizes read Measuring until the usage arrives and the page never waits for it', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = setup({ api: { getStorageUsage: () => gate } });
  t.after(h.dispose);
  await flush();
  assert.equal(h.doc.querySelector('.data-storage-total').textContent, 'Measuring…');
  assert.equal(h.doc.querySelectorAll('[data-settings-field]').length, 7);
  assert.ok([...h.doc.querySelectorAll('.data-storage-size')].every((el) => el.textContent === 'Measuring…'));
  release(usageResult());
  await flush();
  assert.equal(h.doc.querySelector('.data-storage-total strong') !== null, true);
});

test('the flag off renders nothing and never measures', async (t) => {
  const h = setup({ flag: false });
  t.after(h.dispose);
  await flush();
  assert.equal(h.doc.getElementById('dataStorageGroup').hidden, true);
  assert.equal(h.doc.getElementById('dataStorageMount').textContent, '');
  assert.equal(h.calls.usage, 0);
});

test('measuring waits for Settings to open on the account section, then runs once per visit', async () => {
  const hidden = new JSDOM(`<!doctype html><body><div id="appShell"><section id="settingsView"><nav><button class="settings-nav-item" data-settings-section="account">Profile</button></nav><section class="settings-card" data-settings-section="account"><div id="dataStorageGroup" hidden><div id="dataStorageMount"></div></div></section></section></div></body>`, { pretendToBeVisual: true });
  let measured = 0;
  hidden.window.jennyShell = { dataLifecycle: { getStorageUsage: () => { measured += 1; return Promise.resolve(usageResult()); } } };
  const controller = createDataStorageController({ windowRef: hidden.window, documentRef: hidden.window.document, state: { features: { featureFlags: {} } } });
  controller.bind();
  await flush();
  assert.equal(measured, 0, 'a closed Settings page measures nothing');
  const view = hidden.window.document.getElementById('settingsView');
  const card = hidden.window.document.querySelector('.settings-card[data-settings-section="account"]');
  view.classList.add('active-view');
  card.classList.add('settings-section-active');
  await flush();
  assert.equal(measured, 1);
  card.classList.remove('settings-section-active');
  await flush();
  card.classList.add('settings-section-active');
  await flush();
  assert.equal(measured, 2, 'coming back measures again');
  controller.dispose();
  hidden.window.close();
});

test('the folder link reveals by category id only and Manage opens the models section', async (t) => {
  const h = setup();
  t.after(h.dispose);
  await flush();
  h.row('logs').querySelector('.data-storage-path').click();
  await flush();
  assert.deepEqual(h.calls.reveal, [{ categoryId: 'logs' }]);
  h.row('engines').querySelector('[data-action="storage-manage"]').click();
  assert.deepEqual(h.calls.sections, ['models']);
  assert.equal(h.calls.preview.length, 0);
});

test('Clear lists exactly what goes and what is kept, escaped, and Cancel changes nothing', async (t) => {
  const h = setup();
  t.after(h.dispose);
  await flush();
  h.row('logs').querySelector('[data-action="storage-clear"]').click();
  await flush();
  assert.deepEqual(h.calls.preview, [{ categoryId: 'logs' }]);
  assert.ok(h.modalEl());
  assert.equal(h.modalEl().querySelector('.inv-step-modal-title').textContent, 'Clear logs & diagnostics?');
  assert.equal(h.modalEl().querySelector('.inv-step-modal--danger') !== null, true);
  const items = [...h.modalEl().querySelectorAll('.data-clear-list li')].map((li) => li.textContent);
  assert.deepEqual(items, ['Old app logs8.0 MB · 4 files', 'Turn <b>diagnostics</b>3.0 MB · 1 file']);
  assert.equal(h.modalEl().querySelector('.data-clear-list b'), null, 'labels are text, not markup');
  assert.match(h.modalEl().querySelector('.data-clear-keep').textContent, /^Kept: The current logs are emptied, not deleted\.$/);
  assert.equal(h.modalAction('confirm').textContent, 'Clear 11 MB');
  h.modalAction('cancel').click();
  await flush();
  assert.equal(h.modalEl(), null);
  assert.equal(h.calls.clear.length, 0);
  assert.equal(h.doc.activeElement, h.row('logs').querySelector('.data-storage-action'), 'focus returns to the row action');
});

test('Escape closes the confirm without clearing', async (t) => {
  const h = setup();
  t.after(h.dispose);
  await flush();
  h.row('caches').querySelector('[data-action="storage-clear"]').click();
  await flush();
  assert.ok(h.modalEl());
  h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flush();
  assert.equal(h.modalEl(), null);
  assert.equal(h.calls.clear.length, 0);
});

test('confirming sends the preview token, shows the freed size and measures that row again', async (t) => {
  const h = setup();
  t.after(h.dispose);
  await flush();
  h.row('logs').querySelector('[data-action="storage-clear"]').click();
  await flush();
  h.modalAction('confirm').click();
  await flush();
  assert.deepEqual(h.calls.clear, [{ categoryId: 'logs', previewToken: 'token-logs' }]);
  assert.equal(h.modalEl(), null);
  assert.equal(h.status().hidden, false);
  assert.equal(h.status().dataset.tone, 'ok');
  assert.equal(h.status().textContent, 'Cleared logs & diagnostics, freed 11 MB.');
  assert.equal(h.status().getAttribute('role'), 'status');
  assert.equal(h.calls.usage, 2, 'sizes are measured again after a clear');
  assert.equal(h.calls.refreshes, 0, 'only Delete all chats reloads the sidebar');
});

test('a partial clear names what stayed', async (t) => {
  const h = setup({ api: { clearCategory: () => Promise.resolve({ ok: true, status: 'partial', freedBytes: 11 * MB, freedFiles: 4, failed: [{ label: 'engine logs', reason: 'in_use', count: 9 }] }) } });
  t.after(h.dispose);
  await flush();
  h.row('logs').querySelector('[data-action="storage-clear"]').click();
  await flush();
  h.modalAction('confirm').click();
  await flush();
  assert.equal(h.status().dataset.tone, 'warn');
  assert.equal(h.status().textContent, 'Freed 11 MB. 9 items could not be removed: engine logs.');
});

test('a stale preview says so and reopens the review; a busy clear says so', async (t) => {
  let outcome = { ok: false, status: 'stale' };
  const h = setup({ api: { clearCategory: () => Promise.resolve(outcome) } });
  t.after(h.dispose);
  await flush();
  h.row('logs').querySelector('[data-action="storage-clear"]').click();
  await flush();
  h.modalAction('confirm').click();
  await flush();
  assert.equal(h.status().textContent, "Jenny's data changed while this was open. Review it again.");
  assert.equal(h.calls.preview.length, 2, 'the preview is requested again');
  assert.ok(h.modalEl(), 'and the review is open again');
  outcome = { ok: false, status: 'busy' };
  h.modalAction('confirm').click();
  await flush();
  assert.equal(h.status().textContent, 'Another clear is still running.');
  assert.equal(h.modalEl(), null);
});

test('a failed clear or preview says nothing was removed and leaves the page usable', async (t) => {
  const h = setup({ api: { clearCategory: () => Promise.reject(new Error('bridge')) } });
  t.after(h.dispose);
  await flush();
  h.row('leftovers').querySelector('[data-action="storage-clear"]').click();
  await flush();
  h.modalAction('confirm').click();
  await flush();
  assert.equal(h.status().textContent, 'Could not clear leftovers. Nothing was removed.');
  assert.equal(h.modalEl(), null);
});

test('an empty preview says there is nothing to clear instead of opening a confirm', async (t) => {
  const h = setup({ api: { previewClear: () => Promise.resolve(previewResult('caches', { items: [], totalBytes: 0, totalFiles: 0 })) } });
  t.after(h.dispose);
  await flush();
  h.row('caches').querySelector('[data-action="storage-clear"]').click();
  await flush();
  assert.equal(h.modalEl(), null);
  assert.equal(h.status().textContent, 'There is nothing to clear in caches.');
});

test('Delete all chats needs the typed count, sends it, and reloads the sidebar', async (t) => {
  const h = setup({ api: { previewClear: (request) => Promise.resolve(previewResult(request.categoryId, { confirmCount: 85, kept: ['The Jenny chat'], items: [{ label: '85 chats with their history', bytes: 164 * MB, files: 85 }], totalBytes: 164 * MB })) } });
  t.after(h.dispose);
  await flush();
  h.row('chats').querySelector('[data-action="storage-clear"]').click();
  await flush();
  assert.equal(h.modalEl().querySelector('.inv-step-modal-title').textContent, 'Delete all 85 chats?');
  assert.match(h.modalEl().querySelector('.inv-step-modal-summary').textContent, /attachments, artifacts and chat memories/);
  assert.match(h.modalEl().querySelector('.inv-step-modal-summary').textContent, /This cannot be undone\. Chats that are working are stopped\.$/);
  assert.match(h.modalEl().querySelector('.data-clear-keep').textContent, /Kept: The Jenny chat\. Make an archive first/);
  const confirm = h.modalAction('confirm');
  assert.equal(confirm.textContent, 'Delete 85 chats');
  assert.equal(confirm.disabled, true);
  const input = h.modalEl().querySelector('.data-storage-typed .inv-text-field-control');
  assert.equal(h.modalEl().querySelector('.data-storage-typed .inv-text-field-label').textContent, 'Type 85 to confirm');
  input.value = '84';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(confirm.disabled, true);
  confirm.click();
  await flush();
  assert.equal(h.calls.clear.length, 0, 'a disabled confirm sends nothing');
  input.value = ' 85 ';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(confirm.disabled, false);
  confirm.click();
  await flush();
  assert.deepEqual(h.calls.clear, [{ categoryId: 'chats', previewToken: 'token-chats', confirmCount: 85 }]);
  assert.equal(h.calls.refreshes, 1);
  assert.equal(h.status().textContent, 'Deleted 85 chats, freed 11 MB.');
});

test('a single-category clear re-measures only that category and merges it into the last result', async (t) => {
  const partial = (calls, request) => {
    if (!request) return usageResult();
    return { ok: true, status: 'ok', totalBytes: null, categories: [{ id: 'logs', bytes: 1 * MB, files: 2, clearable: true, available: true, partial: false, locationDisplay: '%APPDATA%\\jenny\\logs' }] };
  };
  const h = setup({ usage: partial });
  t.after(h.dispose);
  await flush();
  h.row('logs').querySelector('[data-action="storage-clear"]').click();
  await flush();
  h.modalAction('confirm').click();
  await flush();
  assert.deepEqual(h.calls.usageArgs, [undefined, { categoryIds: ['logs'] }], 'the first measure sends no payload, the re-measure names the category');
  assert.equal(h.controller.getUsage().categories.length, 7, 'the other rows stay');
  assert.equal(h.controller.getUsage().categories.find((row) => row.id === 'logs').bytes, 1 * MB);
  assert.equal(h.controller.getUsage().categories.find((row) => row.id === 'caches').bytes, 96 * MB);
  const expected = usageResult().categories.reduce((sum, c) => sum + c.bytes, 0) - 14 * MB;
  assert.equal(h.controller.getUsage().totalBytes, expected, 'the total is recomputed in the renderer');
  assert.ok(h.row('caches').querySelector('.data-storage-size'), 'untouched rows keep their size');
});

test('a main that ignores the category payload and returns everything is used as is', async (t) => {
  const h = setup({ usage: (n) => (n === 1 ? usageResult() : usageResult({ categories: usageResult().categories.map((c) => (c.id === 'logs' ? Object.assign({}, c, { bytes: 0 }) : c)) })) });
  t.after(h.dispose);
  await flush();
  h.row('logs').querySelector('[data-action="storage-clear"]').click();
  await flush();
  h.modalAction('confirm').click();
  await flush();
  assert.equal(h.controller.getUsage().categories.length, 7);
  assert.equal(h.controller.getUsage().categories.find((row) => row.id === 'logs').bytes, 0);
});

test('Delete all chats re-measures everything with no payload', async (t) => {
  const h = setup({ api: { previewClear: (request) => Promise.resolve(previewResult(request.categoryId, { confirmCount: 3, items: [{ label: '3 chats', bytes: MB, files: 3 }], totalBytes: MB })) } });
  t.after(h.dispose);
  await flush();
  h.row('chats').querySelector('[data-action="storage-clear"]').click();
  await flush();
  const input = h.modalEl().querySelector('.data-storage-typed .inv-text-field-control');
  input.value = '3';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.modalAction('confirm').click();
  await flush();
  assert.deepEqual(h.calls.usageArgs, [undefined, undefined]);
});

test('normalizeUsage drops unknown ids and keeps a stable order for equal sizes', () => {
  const rows = normalizeUsage({ ok: true, categories: [
    { id: 'mystery', bytes: 9 },
    { id: 'logs', bytes: 5 },
    { id: 'chats', bytes: 5 },
    { id: 'engines', bytes: 'x' },
  ] }).categories.map((row) => row.id);
  assert.deepEqual(rows, ['chats', 'logs', 'engines']);
  assert.equal(normalizeUsage({ ok: false }), null);
});
