'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ConversationTransferService } = require('../services/conversation-transfer-service');
const { ConversationTransferStore } = require('../services/conversation-transfer-store');
const { JennyConversationAdapter } = require('../services/jenny-conversation-adapter');
const { codexSnapshot } = require('../services/codex-conversation-adapter');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const { safeResult } = require('../services/conversation-transfer-contract');

const CODEX_ID = '12345678-1234-1234-1234-123456789abc';
const MODULE = require.resolve('../renderer/shell/renderer-settings-conversation-transfer');
const SENTINEL = /^SENTINEL\[settings\.transfer\.[A-Za-z.]+\]$/;

// The module binds jt at load, so each test loads it fresh behind a sentinel translator.
function translatedController(t, bridge) {
  const previous = globalThis.jennyI18n;
  globalThis.jennyI18n = { t: (key) => 'SENTINEL[' + key + ']' };
  delete require.cache[MODULE];
  const { createConversationTransferController } = require(MODULE);
  const dom = new JSDOM('<div id="conversationTransferHost"></div>');
  const host = dom.window.document.getElementById('conversationTransferHost');
  const controller = createConversationTransferController({ windowRef: dom.window, host, getBridge: () => bridge,
    inventory: { actionButton: require('../renderer/inventory/action-button'),
      selectField: require('../renderer/inventory/select-field') } });
  controller.bind();
  t.after(() => {
    controller.dispose(); dom.window.close();
    globalThis.jennyI18n = previous;
    delete require.cache[MODULE];
  });
  const click = async (action) => {
    host.querySelector('[data-transfer-action="' + action + '"]').click();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const select = async (id, value) => {
    const element = host.querySelector('#' + id); element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const status = () => host.querySelector('[role="status"]').textContent;
  const disclosures = () => [...host.querySelectorAll('li')].map((row) => row.textContent);
  const destination = () => [...host.querySelectorAll('p')].find((row) => row.textContent.startsWith('SENTINEL[settings.transfer.destinationWorkspace]')).textContent;
  return { host, click, select, status, disclosures, destination };
}
function failure(task) {
  try { task(); } catch (error) { return safeResult(error); }
  throw new Error('expected a transfer failure');
}
const listing = { ok: true, conversations: [{ id: 'chat', title: 'Chat' }] };

test('a reason-bearing source_busy error renders through the translator', async (t) => {
  const busy = failure(() => codexSnapshot({ status: { type: 'active' }, turns: [] }, os.tmpdir()));
  assert.equal(busy.reason, 'source_busy');
  const h = translatedController(t, { list: async () => listing, preview: async () => busy });
  await h.click('list'); await h.select('transferConversation', 'chat'); await h.click('preview');
  assert.match(h.status(), SENTINEL);
});

test('every reason the transfer service can return renders translated; unknown reasons keep their message', async (t) => {
  const reasons = ['source_busy', 'source_missing', 'source_changed', 'empty_source', 'preview_expired', 'transfer_busy',
    'unfinished_transfer', 'snapshot_unavailable', 'snapshot_write_failed', 'snapshot_too_large', 'asset_limit',
    'invalid_asset', 'unsafe_asset_path', 'invalid_request', 'destination_missing', 'destination_persist_failed',
    'receipt_store_unavailable', 'receipt_write_failed', 'receipt_limit', 'outcome_unknown', 'codex_import_failed',
    'codex_api_incompatible', 'context_outcome_unknown', 'codex_timeout', 'codex_api_error', 'codex_unavailable',
    'codex_exited', 'codex_invalid_output', 'codex_output_limit', 'codex_write_failed', 'disposed'];
  let reason = '';
  const h = translatedController(t, { list: async () => listing,
    preview: async () => ({ ok: false, reason, message: 'English main-process message' }) });
  await h.click('list'); await h.select('transferConversation', 'chat');
  for (reason of reasons) {
    await h.click('preview');
    assert.match(h.status(), SENTINEL, reason);
  }
  // open_failed and transfer_failed are already translated by the main process t(); unknown reasons pass through too.
  for (reason of ['open_failed', 'transfer_failed', 'future_reason']) {
    await h.click('preview');
    assert.equal(h.status(), 'English main-process message', reason);
  }
});

function sessionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-transfer-i18n-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = new ElectronSessionStore(path.join(root, 'sessions.json'));
  t.after(() => sessions.dispose());
  return { root, sessions, receipts: new ConversationTransferStore(path.join(root, 'receipts')) };
}

test('Codex fidelity warnings, resume notice and Jenny destination render through the translator', async (t) => {
  const f = sessionFixture(t);
  const missing = path.join(f.root, 'missing.md');
  const snapshot = codexSnapshot({ cwd: f.root, turns: [{ status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'hello' }, { type: 'audio' },
      { type: 'localImage', path: path.join(f.root, 'missing.png') }] },
    { type: 'agentMessage', text: 'see [notes](' + missing + ')' },
    { type: 'imageGeneration', result: path.join(f.root, 'missing-generated.png') },
    { type: 'commandExecution', status: 'inProgress', command: 'never' },
    { type: 'novelItem' }] }] }, f.root);
  assert.equal(snapshot.warnings.length, 6);
  let copies = 0;
  const service = new ConversationTransferService({ receiptStore: f.receipts, adapters: {
    codex: { snapshot: async () => structuredClone(snapshot) },
    jenny: { exists: async () => true, copy: async () => { copies += 1; throw Object.assign(new Error('stop'), { reason: 'destination_persist_failed' }); } } } });
  const request = { source: 'codex', destination: 'jenny', sourceId: CODEX_ID };
  await assert.rejects(service.copy({ previewToken: (await service.preview(request)).previewToken }), { reason: 'destination_persist_failed' });
  assert.equal(copies, 1);
  const resumed = await service.preview(request);
  assert.match(resumed.warnings.join(' '), /resumes the saved snapshot/);
  const h = translatedController(t, { list: async () => listing, preview: async () => resumed });
  await h.click('list'); await h.select('transferConversation', 'chat'); await h.click('preview');
  assert.equal(h.disclosures().length, resumed.warnings.length);
  for (const row of h.disclosures()) assert.match(row, SENTINEL);
  assert.match(h.destination(), /SENTINEL\[settings\.transfer\.destinationWorkspace\] SENTINEL\[settings\.transfer\.[A-Za-z.]+\]$/);
});

test('Jenny fidelity warnings and the Codex destination render through the translator', async (t) => {
  const f = sessionFixture(t);
  const chat = f.sessions.createSession({ title: 'Source' });
  // Lossy history the canonical store would normalize away is injected at the read seam.
  const messages = [{ role: 'user', content: 'voice note', attachments: [{ kind: 'audio', displayName: 'memo.webm' }] },
    { role: 'tool', content: 'made a chart', tool_result: { tool_name: 'chart', status: 'completed', generated_artifacts: [{ title: 'Chart' }] } },
    { role: 'tool', content: 'still running', tool_result: { status: 'running' } }];
  const sessionStore = Object.assign(Object.create(f.sessions), {
    getSession: (id) => { const row = f.sessions.getSession(id); return row && { ...row, messages, active_turn: { id: 'turn' } }; } });
  const jenny = new JennyConversationAdapter({ sessionStore,
    attachmentAssetStore: new AttachmentAssetStore({ rootDir: path.join(f.root, 'media') }) });
  const service = new ConversationTransferService({ receiptStore: f.receipts, adapters: { jenny, codex: {} } });
  const preview = await service.preview({ source: 'jenny', destination: 'codex', sourceId: chat.id });
  assert.ok(preview.warnings.length >= 8, 'fixture produces every Jenny-side warning');
  const h = translatedController(t, { list: async () => listing, preview: async () => preview });
  await h.click('list'); await h.select('transferConversation', 'chat'); await h.click('preview');
  assert.equal(h.disclosures().length, preview.warnings.length);
  for (const row of h.disclosures()) assert.match(row, SENTINEL);
  assert.match(h.destination(), /SENTINEL\[settings\.transfer\.destinationWorkspace\] SENTINEL\[settings\.transfer\.[A-Za-z.]+\]$/);
});
