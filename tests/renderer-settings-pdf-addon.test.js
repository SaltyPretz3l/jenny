'use strict';

// Settings > Tools > PDF reading add-on (renderer/shell/renderer-settings-pdf-addon.js)
// and the chat side of CMP-TOOL-0047: the failed tool row's "Set up PDF
// reading" link and the recovery action that opens Settings at the add-on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPdfAddonController } = require('../renderer/shell/renderer-settings-pdf-addon.js');
const { escapeHtml } = require('../renderer/shared/string-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils.js');

const LICENCE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
const NOT_INSTALLED_TEXT = 'PDF reading needs the optional PDF reading add-on, which is not installed. Tell the user they can install it in Settings › Tools › PDF reading add-on. Do not retry this PDF until they say it is installed.';

function inventoryFixture() {
  return {
    settingsField: require('../renderer/inventory/settings-field'),
    statusRow(options = {}) {
      const progress = options.progress ? ` data-progress="${options.progress.value}/${options.progress.max}"` : '';
      return `<div class="inv-status-row" data-status-tone="${options.tone || ''}"${progress} role="status">${options.label || ''} ${options.message || ''}</div>`;
    },
    actionButton(options = {}) {
      return `<button type="button" data-action="${options.id || ''}" data-variant="${options.variant || ''}"${options.disabled ? ' disabled' : ''}>${options.label || ''}</button>`;
    },
  };
}

function state(overrides = {}) {
  return {
    state: 'not_installed',
    reason: '',
    package: 'PyMuPDF',
    version: '1.27.2.2',
    license: 'AGPL-3.0',
    licenseUrl: LICENCE_URL,
    installedVersion: '',
    downloadSizeBytes: 19238032,
    installedSizeBytes: 53300000,
    downloadedBytes: 0,
    totalBytes: 0,
    applyPending: false,
    cancellable: false,
    developmentAvailable: null,
    developmentVersion: '',
    ...overrides,
  };
}

function harness(initial, bridgeOverrides = {}) {
  const dom = new JSDOM('<!doctype html><div id="toolsConfigFieldList"></div><div id="toolsPdfAddonHost"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const calls = [];
  const opened = [];
  let listener = null;
  dom.window.open = (url, target) => { opened.push([url, target]); return null; };
  const bridge = {
    async getState() { return initial; },
    onChanged(callback) { listener = callback; return () => { listener = null; }; },
    async install(payload) { calls.push(['install', payload]); return { ...state({ state: 'downloading' }), ok: true }; },
    async installFromFile(payload) { calls.push(['installFromFile', payload]); return { ...initial, ok: true }; },
    async cancel(...args) { calls.push(['cancel', ...args]); return { ...state(), ok: true }; },
    async remove(...args) { calls.push(['remove', ...args]); return { ...state(), ok: true }; },
    ...bridgeOverrides,
  };
  const doc = dom.window.document;
  const controller = createPdfAddonController({
    windowRef: dom.window,
    documentRef: doc,
    host: doc.getElementById('toolsPdfAddonHost'),
    fieldList: doc.getElementById('toolsConfigFieldList'),
    inventory: inventoryFixture(),
    getBridge: () => bridge,
  });
  return {
    dom,
    doc,
    host: doc.getElementById('toolsPdfAddonHost'),
    fieldList: doc.getElementById('toolsConfigFieldList'),
    controller,
    calls,
    opened,
    emit: (next) => listener?.(next),
    close: () => { controller.dispose(); dom.window.close(); },
    click: (action) => doc.querySelector(`[data-action="${action}"]`).click(),
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('not installed: Set up… opens the inline licence disclosure; Accept installs with explicit acceptance', async () => {
  const h = harness(state());
  h.controller.bind();
  await settle();
  assert.equal(h.host.dataset.pdfAddonState, 'not_installed');
  assert.match(h.host.textContent, /Not installed/);
  assert.equal(h.fieldList.dataset.pdfAddonNeeded, 'true');
  assert.equal(h.host.querySelector('.pdf-addon-disclosure'), null);

  h.click('pdfAddonSetUp');
  const disclosure = h.host.querySelector('.pdf-addon-disclosure');
  assert.ok(disclosure);
  assert.match(disclosure.textContent, /GNU Affero General Public License v3 \(AGPL-3\.0\)/);
  assert.match(disclosure.textContent, /PyMuPDF is not included with Jenny/);
  assert.match(disclosure.textContent, /PyMuPDF 1\.27\.2\.2/);
  assert.match(disclosure.textContent, /about 53 MB on disk/);
  assert.equal(h.doc.querySelector('[data-action="pdfAddonAccept"]').dataset.variant, 'primary');

  h.click('pdfAddonLicence');
  assert.deepEqual(h.opened, [[LICENCE_URL, '_blank']]);

  h.click('pdfAddonAccept');
  await settle();
  assert.deepEqual(h.calls, [['install', { licenseAccepted: true }]]);
  assert.equal(h.host.dataset.pdfAddonState, 'downloading');
  assert.equal(h.host.querySelector('.pdf-addon-disclosure'), null);
  h.close();
});

test('downloading shows bytes, a progress bar and Cancel; a pushed state replaces it', async () => {
  const h = harness(state({ state: 'downloading', downloadedBytes: 11_400_000, totalBytes: 19_238_032, cancellable: true }));
  h.controller.bind();
  await settle();
  assert.match(h.host.textContent, /Downloading · 11\.4 of 19\.2 MB/);
  assert.equal(h.host.querySelector('[data-progress]').dataset.progress, '11400000/19238032');
  const progressText = h.host.querySelector('[data-progress]').textContent.trim();
  assert.ok(progressText && !h.host.querySelector('.settings-field-help').textContent.includes(progressText), 'the progress message is said once, in the progress line');
  assert.match(h.host.textContent, /Chats keep working meanwhile/);
  h.click('pdfAddonCancel');
  await settle();
  assert.deepEqual(h.calls, [['cancel']]);

  h.emit(state({ state: 'installing', applyPending: true }));
  assert.match(h.host.textContent, /Jenny starts using it once the current chat finishes/);
  assert.equal(h.host.querySelector('[data-action="pdfAddonCancel"]'), null);

  h.emit(state({ state: 'ready', installedVersion: '1.27.2.2' }));
  assert.match(h.host.querySelector('.settings-field-detail').dataset.tooltip, /Ready · PyMuPDF 1\.27\.2\.2 · AGPL-3\.0/);
  assert.equal(h.fieldList.dataset.pdfAddonNeeded, 'false');
  h.close();
});

test('ready: Remove asks once inline before removing', async () => {
  const h = harness(state({ state: 'ready', installedVersion: '1.27.2.2' }));
  h.controller.bind();
  await settle();
  h.click('pdfAddonRemove');
  assert.match(h.host.textContent, /Remove the PDF reading add-on\? Jenny will stop reading PDFs until you install it again\./);
  assert.deepEqual(h.calls, []);
  h.click('pdfAddonKeep');
  assert.doesNotMatch(h.host.textContent, /Remove the PDF reading add-on\?/);
  h.click('pdfAddonRemove');
  h.click('pdfAddonConfirmRemove');
  await settle();
  assert.deepEqual(h.calls, [['remove']]);
  assert.equal(h.host.dataset.pdfAddonState, 'not_installed');
  h.close();
});

test('failure, load failure, development and unsupported states show their copy and actions', async () => {
  const cases = [
    [state({ state: 'failed', reason: 'network' }), /pypi\.org could not be reached\. Nothing was changed\./, ['pdfAddonRetry', 'pdfAddonFromFile']],
    [state({ state: 'failed', reason: 'fingerprint' }), /did not match the expected fingerprint and was deleted/, ['pdfAddonRetry', 'pdfAddonFromFile']],
    [state({ state: 'failed', reason: 'wrong_file' }), /That file is not the PyMuPDF 1\.27\.2\.2 wheel for this computer/, ['pdfAddonRetry', 'pdfAddonFromFile']],
    [state({ state: 'load_failed', installedVersion: '1.27.2.2' }), /Installed, but Jenny could not load it\. Remove it and install again\./, ['pdfAddonRemove']],
    [state({ state: 'development', developmentAvailable: true, developmentVersion: '1.27.2.2' }), /Ready · provided by the development environment \(PyMuPDF 1\.27\.2\.2\)/, []],
    [state({ state: 'development', developmentAvailable: false }), /Not available in this development environment\. Install the media extra\./, []],
    [state({ state: 'unsupported' }), /Not available for this platform yet\./, []],
  ];
  for (const [initial, copy, actions] of cases) {
    const h = harness(initial);
    h.controller.bind();
    await settle();
    assert.match(h.host.textContent + (h.host.querySelector('.settings-field-detail')?.dataset.tooltip || ''), copy);
    assert.deepEqual([...h.host.querySelectorAll('[data-action]')].map((node) => node.dataset.action), actions);
    h.close();
  }

  for (const [action, method] of [['pdfAddonRetry', 'install'], ['pdfAddonFromFile', 'installFromFile']]) {
    const failed = harness(state({ state: 'failed', reason: 'network' }));
    failed.controller.bind();
    await settle();
    failed.click(action);
    await settle();
    assert.deepEqual(failed.calls, [[method, { licenseAccepted: true }]]);
    failed.close();
  }
});

test('a failed tool row with CMP-TOOL-0047 offers Set up PDF reading outside the header toggle', () => {
  const renderer = createTurnRowToolRenderUtils({ escapeHtml, toolCallUtils });
  const rowFor = (errorCode, outputText) => renderer.buildToolCallRowMarkup({
    row_id: 'row-1',
    turn_id: 'turn-1',
    tool_call_id: 'call-1',
    payload: { tool_call_id: 'call-1', tool_name: 'read_file', state: 'completed', input: { path: 'statement.pdf' } },
  }, [], {
    pairedToolResultRow: {
      primary_message_id: 'result-1',
      payload: {
        tool_call_id: 'call-1',
        tool_name: 'read_file',
        output_text: outputText,
        result_is_error: true,
        is_error: true,
        error_code: errorCode,
      },
    },
  });
  const dom = new JSDOM(`<!doctype html><body>${rowFor('CMP-TOOL-0047', NOT_INSTALLED_TEXT)}</body>`);
  const link = dom.window.document.querySelector('[data-inv-error-action="open_pdf_addon_settings"]');
  assert.ok(link);
  assert.equal(link.textContent, 'Set up PDF reading');
  assert.equal(link.getAttribute('role'), 'link');
  assert.equal(link.closest('.tool-call-row-toggle'), null);
  assert.match(dom.window.document.querySelector('.tool-call-row-toggle').textContent, /PDF reading add-on not installed/);
  dom.window.close();

  const other = new JSDOM(`<!doctype html><body>${rowFor('CMP-TOOL-0008', 'read failed')}</body>`);
  assert.equal(other.window.document.querySelector('[data-inv-error-action="open_pdf_addon_settings"]'), null);
  other.window.close();
});

test('the failure summary distinguishes a missing add-on from one that could not load', () => {
  const summary = (outputText) => toolCallUtils.summarizeToolFailure({
    isError: true, status: 'errored', errorCode: 'CMP-TOOL-0047', outputText,
  });
  assert.equal(summary(NOT_INSTALLED_TEXT), 'PDF reading add-on not installed');
  assert.equal(summary('The PDF reading add-on is installed but could not be loaded. Tell the user...'), 'PDF reading add-on could not be loaded');
});

test('the open_pdf_addon_settings recovery action opens Settings > Tools at the add-on', async () => {
  const opened = [];
  const dom = new JSDOM('<!doctype html>');
  const controller = createShellRuntimeController({
    state: { ui: {}, sessions: [] },
    windowRef: dom.window,
    callbacks: { openSettingsSection: (...args) => opened.push(args) },
  });
  await controller.handleErrorRecoveryAction({ action: 'open_pdf_addon_settings' });
  assert.deepEqual(opened, [['tools', { source: 'pdf_addon_tool_row', focusId: 'toolsPdfAddonHost' }]]);
  dom.window.close();
});


test('PDF states keep status and actions in one row and expand only the required block', async () => {
  const cases = [
    ['not_installed', 'Not installed', null, ['pdfAddonSetUp'], false],
    ['downloading', 'Working\u2026', null, ['pdfAddonCancel'], true],
    ['ready', 'Ready', 'ready', ['pdfAddonRemove', 'pdfAddonLicence'], false],
    ['failed', 'Failed', 'blocked', ['pdfAddonRetry', 'pdfAddonFromFile'], false],
  ];
  for (const [kind, label, tone, actions, block] of cases) {
    const h = harness(state({ state: kind, totalBytes: kind === 'downloading' ? 100 : 0, downloadedBytes: 10, cancellable: kind === 'downloading' }));
    h.controller.bind();
    await settle();
    const row = h.host.querySelector('[data-settings-field="toolsPdfAddonRow"]');
    assert.ok(row.classList.contains('settings-field--row'));
    const status = row.querySelector('.settings-page-status[role="status"]');
    assert.equal(status.textContent, label);
    assert.equal(status.getAttribute('data-state'), tone);
    assert.deepEqual(Array.from(row.querySelectorAll('[data-action]'), (node) => node.dataset.action), actions);
    assert.equal(Boolean(h.host.querySelector('[data-pdf-addon-block]')), block);
    if (kind === 'not_installed') {
      h.click('pdfAddonSetUp');
      const expanded = h.host.querySelector('[data-pdf-addon-block]');
      assert.equal(h.host.querySelector('[data-settings-field] [data-action]'), null);
      assert.ok(expanded.querySelector('[data-action="pdfAddonAccept"]'));
      h.click('pdfAddonCloseDisclosure');
      assert.equal(h.host.querySelector('[data-pdf-addon-block]'), null);
    }
    if (kind === 'failed') {
      h.host.querySelector('[data-action="pdfAddonRetry"]').focus();
      h.emit(state({ state: 'failed', reason: 'disk' }));
      assert.equal(h.doc.activeElement.dataset.action, 'pdfAddonRetry');
    }
    h.close();
  }
});

test('PDF state changes patch both tool help paragraphs without reloading the hosts', async () => {
  const h = harness(state());
  const support = require('../renderer/shell/renderer-settings-support');
  h.fieldList.innerHTML = support.buildToolConfigFieldListMarkup({ fields: support.DEFAULT_TOOL_CONFIG_FIELDS });
  const help = (key) => h.fieldList.querySelector(`[data-settings-field="settings-tool-config-${key}"] .settings-field-help`);
  const original = help('richFiles');
  h.controller.bind();
  await settle();
  for (const key of ['richFiles', 'imageRead']) assert.ok(help(key).textContent.endsWith('Needs the PDF reading add-on.'));
  h.emit(state({ state: 'ready' }));
  for (const key of ['richFiles', 'imageRead']) assert.equal(help(key).textContent.includes('Needs the PDF reading add-on.'), false);
  assert.equal(help('richFiles'), original);
  h.emit(state({ state: 'development', developmentAvailable: false }));
  assert.equal(h.fieldList.dataset.pdfAddonNeeded, 'true');
  h.emit(state({ state: 'development', developmentAvailable: true }));
  assert.equal(h.fieldList.dataset.pdfAddonNeeded, 'false');
  h.close();
});

test('the add-on writes each PDF tool help line as the shared composition, also when repainted and when blocked', async () => {
  const h = harness(state());
  const support = require('../renderer/shell/renderer-settings-support');
  // As the Tools page draws them: Image reads blocked by the runtime, Rich file reading free.
  h.fieldList.innerHTML = support.buildToolConfigFieldListMarkup({ fields: support.DEFAULT_TOOL_CONFIG_FIELDS, tools: { fileTools: true }, availability: { imageRead: { enabled: false } }, pdfAddonNeeded: true });
  const help = (key) => h.fieldList.querySelector(`[data-settings-field="settings-tool-config-${key}"] .settings-field-help`).textContent;
  const expected = (key, pdfAddonNeeded) => support.composeToolHelp(support.DEFAULT_TOOL_CONFIG_FIELDS.find((field) => field.key === key), { pdfAddonNeeded, blocked: key === 'imageRead' });
  h.controller.bind();
  await settle();
  h.controller.render();
  for (const key of ['richFiles', 'imageRead']) assert.equal(help(key), expected(key, true), key);
  h.emit(state({ state: 'ready' }));
  h.controller.render();
  for (const key of ['richFiles', 'imageRead']) assert.equal(help(key), expected(key, false), key);
  h.emit(state({ state: 'failed', reason: 'network' }));
  for (const key of ['richFiles', 'imageRead']) assert.equal(help(key), expected(key, true), key);
  h.close();
});

test('a remove that waits for the running chat says so on the row', async () => {
  const h = harness(state({ state: 'not_installed', applyPending: true }));
  h.controller.bind();
  await settle();
  assert.match(h.host.querySelector('.settings-field-help').textContent, /stops using it once the current chat finishes/);
  assert.equal(h.host.querySelector('[data-action]'), null);
  h.close();
});
