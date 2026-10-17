'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { CodexAppServerClient } = require('./codex-app-server-client');
const { readSourceFile, ownedDirectory, writeAssets, attachmentBudget, reserveAsset } = require('./conversation-transfer-assets');
const { redactExportSecretsInValue } = require('./backend/transcript-export-redaction');
const { fail } = require('./conversation-transfer-contract');

const SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'exec', 'unknown'];
function migratedTarget(results, source) {
  const matches = (results || []).filter((row) => row.itemType === 'SESSIONS')
    .flatMap((row) => row.successes || []).filter((row) => {
      const normalized = String(row.source || '').replace(/^\\\\\?\\/, '');
      return path.resolve(normalized) === path.resolve(source);
    });
  return matches[0]?.target || null;
}
function markdownFiles(text, roots, warnings, budget) {
  const assets = [];
  const pattern = /(!?)\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const file = match[2].replace(/^<|>$/g, '');
    if (!path.isAbsolute(file)) continue;
    try { assets.push({ ...readSourceFile(file, roots, match[1] ? 'image' : 'file', budget), sourceLink: file }); }
    catch (error) {
      if (error.reason) throw error;
      warnings.push('Linked attachment unavailable or unsupported: ' + path.basename(file).slice(0, 160));
    }
    if (assets.length > 256) fail('asset_limit', 'Too many linked attachments.');
  }
  return assets;
}
function codexSnapshot(thread, codexHome) {
  if (thread.status?.type === 'active' || thread.turns?.some((turn) => ['inProgress', 'pending'].includes(turn.status))) {
    fail('source_busy', 'Wait for this Codex conversation to settle before copying.');
  }
  if (!Array.isArray(thread.turns)) fail('codex_api_incompatible', 'Codex did not return readable completed history.');
  const messages = [];
  const warnings = [];
  const roots = [thread.cwd, path.join(codexHome, 'jenny-transfer-assets'), path.join(codexHome, 'jenny-transfer')];
  // Shared across every message so repeated links cannot materialize bytes past the aggregate limit.
  const budget = attachmentBudget();
  for (const turn of thread.turns) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const attachments = [];
        const text = [];
        for (const input of item.content || []) {
          if (input.type === 'text') text.push(String(input.text || ''));
          else if (input.type === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(input.url || '')) {
            const [prefix, data] = input.url.split(',');
            reserveAsset(budget, Buffer.byteLength(data, 'base64'));
            attachments.push({ kind: 'image', name: 'Imported image', mime: prefix.slice(5).split(';')[0], data });
          } else if (input.type === 'localImage') {
            try { attachments.push(readSourceFile(input.path, [path.dirname(input.path)], 'image', budget)); }
            catch (error) {
              if (error.reason) throw error;
              warnings.push('Original user image is unavailable or outside source storage.');
            }
          } else warnings.push('Unsupported user attachment: ' + String(input.type || 'unknown').slice(0, 80));
        }
        messages.push({ role: 'user', content: text.join('\n'), attachments });
      } else if (item.type === 'agentMessage') {
        const content = String(item.text || '');
        if (content === '<EXTERNAL SESSION IMPORTED>') continue;
        messages.push({ role: 'assistant', content, attachments: markdownFiles(content, roots, warnings, budget) });
      } else if (item.type === 'imageGeneration') {
        try {
          const file = item.result || item.path;
          const attachment = readSourceFile(file, [path.dirname(file)], 'image', budget);
          messages.push({ role: 'assistant', content: '[Completed image generation]', attachments: [attachment] });
        } catch (error) {
          if (error.reason) throw error;
          warnings.push('Generated image is unavailable or unsupported.');
        }
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'functionCallOutput', 'webSearch', 'collabAgentToolCall'].includes(item.type)) {
        if (item.status && !['completed', 'failed', 'interrupted'].includes(item.status)) {
          warnings.push('Unfinished tool activity was omitted.');
          continue;
        }
        const details = item.type === 'commandExecution'
          ? { command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode }
          : item.type === 'functionCallOutput' ? { name: item.name, output: item.output }
            : { ...item, id: undefined };
        messages.push({ role: 'assistant', content: '[Completed tool activity; copied text only]\n' + JSON.stringify(details),
          attachments: [] });
      } else if (item.type !== 'reasoning') {
        warnings.push('Unsupported history item omitted: ' + String(item.type || 'unknown').slice(0, 80));
      }
    }
  }
  return redactExportSecretsInValue({ title: thread.name || thread.preview || 'Codex chat',
    sourceWorkspace: thread.cwd || 'No workspace', messages, warnings: [...new Set(warnings)] });
}

class CodexConversationAdapter {
  constructor({ env = process.env, codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    clientFactory = (options) => new CodexAppServerClient(options), receiptStore } = {}) {
    Object.assign(this, { env, codexHome, clientFactory, receiptStore });
    this.clients = new Set();
    this.disposed = false;
  }
  async withClient(task, discoveryHome) {
    if (this.disposed) fail('disposed', 'Conversation transfer is closed.');
    const env = { ...this.env, CODEX_HOME: this.codexHome };
    if (discoveryHome) Object.assign(env, { HOME: discoveryHome, USERPROFILE: discoveryHome,
      CLAUDE_CONFIG_DIR: path.join(discoveryHome, '.claude') });
    const client = this.clientFactory({ env });
    this.clients.add(client);
    try { await client.initialize(); return await task(client); }
    finally { await client.dispose(); this.clients.delete(client); }
  }
  async list() {
    return this.withClient(async (client) => {
      const rows = [];
      for (const archived of [false, true]) {
        let cursor;
        do {
          const result = await client.request('thread/list', { sourceKinds: SOURCE_KINDS, archived, limit: 100, ...(cursor ? { cursor } : {}) });
          for (const thread of result.data || []) {
            rows.push({ id: thread.id, title: thread.name || thread.preview || 'Codex chat',
              archived, busy: thread.status?.type === 'active' });
          }
          cursor = result.nextCursor;
        } while (cursor && rows.length < 500);
      }
      return rows.slice(0, 500);
    });
  }
  async snapshot(id) {
    return this.withClient(async (client) => {
      const result = await client.request('thread/read', { threadId: id, includeTurns: true });
      return codexSnapshot(result.thread, this.codexHome);
    });
  }
  async exists(id) {
    return this.withClient(async (client) => {
      try { return Boolean((await client.request('thread/read', { threadId: id })).thread?.id); }
      catch (error) { if (error.reason === 'codex_api_error') return false; throw error; }
    });
  }
  async reconcile(client, record, sourceFile, update) {
    if (record.destinationId) return record.destinationId;
    const history = await client.request('externalAgentConfig/import/readHistories');
    const entry = (history.data || []).find((row) => row.importId === record.importId
      || migratedTarget([{ itemType: 'SESSIONS', successes: row.successes }], sourceFile));
    const target = entry && migratedTarget([{ itemType: 'SESSIONS', successes: entry.successes }], sourceFile);
    if (target) { update({ destinationId: target, state: 'imported' }); return target; }
    if (entry?.failures?.length) {
      update({ state: 'prepared', importId: null });
      fail('codex_import_failed', 'Codex confirmed this import failed. Retry the saved copy.');
    }
    fail('outcome_unknown', 'Codex has not confirmed this import. Retry later; no second chat was created.');
  }
  async copy(snapshot, record, update) {
    const directory = ownedDirectory(this.receiptStore.root, 'scratch/' + record.id);
    const discovery = ownedDirectory(directory, 'discovery');
    const compatibility = ownedDirectory(discovery, '.claude/projects/jenny-transfer');
    const sourceFile = path.join(compatibility, record.id + '.jsonl');
    const cwd = ownedDirectory(this.codexHome, 'jenny-transfer-workspaces/' + record.id);
    const files = writeAssets(ownedDirectory(this.codexHome, 'jenny-transfer-assets'), record.id, snapshot);
    if (record.state === 'prepared') this.writeCompatibility(sourceFile, cwd, snapshot, record, files);
    return this.withClient(async (client) => {
      let threadId = record.destinationId;
      if (record.state === 'importing') threadId = await this.reconcile(client, record, sourceFile, update);
      if (!threadId) {
        const detected = await client.request('externalAgentConfig/detect', { includeHome: true, cwds: [cwd] });
        if (!(detected.items || []).some((row) => (row.details?.sessions || []).some((entry) => path.resolve(entry.path) === path.resolve(sourceFile)))) {
          fail('codex_api_incompatible', 'This Codex version cannot discover the transfer transcript.');
        }
        update({ state: 'importing' });
        let imported;
        try {
          imported = await client.request('externalAgentConfig/import', { source: 'jenny', providerId: 'jenny',
            migrationItems: [{ itemType: 'SESSIONS', description: 'Copy Jenny conversation', cwd,
              details: { sessions: [{ path: sourceFile, cwd, title: snapshot.title }] } }] });
        } catch (error) {
          // An explicit RPC refusal never admitted the import; transport loss remains ambiguous.
          if (error.reason === 'codex_api_error') update({ state: 'prepared', importId: null });
          throw error;
        }
        update({ importId: imported.importId });
        const completed = await client.importCompleted(imported.importId);
        threadId = migratedTarget(completed.itemTypeResults, sourceFile);
        if (!threadId) fail('codex_import_failed', 'Codex could not import this conversation. Retry to reconcile the operation.');
        update({ destinationId: threadId, state: 'imported' });
      }
      await client.request('thread/resume', { threadId, cwd, approvalPolicy: 'on-request', sandbox: 'read-only' });
      await client.request('thread/name/set', { threadId, name: snapshot.title.slice(0, 160) + ' (from Jenny)' });
      const images = files.filter((asset) => asset.kind === 'image');
      if (images.length && !record.contextInjected) {
        // contextSent without contextInjected: Codex may have appended the images, and no API confirms it.
        if (record.contextSent) {
          fail('context_outcome_unknown', 'The copied images may already have been added. Check the Codex thread before copying again.');
        }
        if ((record.contextAttempts || 0) >= 3) fail('context_outcome_unknown', 'Image context needs reconciliation before another retry.');
        update({ contextAttempts: (record.contextAttempts || 0) + 1, contextSent: true });
        try {
          await client.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user',
            content: [{ type: 'input_text', text: '[Copied image attachments from the preceding conversation; historical context only.]' },
              ...images.map((asset) => ({ type: 'input_image', image_url: 'data:' + asset.mime + ';base64,' + asset.data }))] }] });
        } catch (error) {
          // Only an answered RPC refusal proves nothing was appended; transport loss stays ambiguous.
          if (error.reason === 'codex_api_error') update({ contextSent: false });
          throw error;
        }
        update({ contextInjected: true });
      }
      return threadId;
    }, discovery);
  }
  writeCompatibility(file, cwd, snapshot, record, assets) {
    const rows = [];
    let previous = null;
    let assetIndex = 0;
    const add = (role, content) => {
      const uuid = crypto.randomUUID();
      rows.push({ type: role, uuid, parentUuid: previous, sessionId: record.id, cwd,
        timestamp: record.createdAt, message: { role, content: [{ type: 'text', text: content }],
          ...(role === 'assistant' ? { id: uuid, type: 'message', model: 'imported',
            stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } : {}) } });
      previous = uuid;
    };
    for (const message of snapshot.messages) {
      let content = message.content || '[Attachment]';
      const links = [];
      for (const asset of message.attachments || []) {
        if (!asset.data) continue;
        const saved = assets[assetIndex++];
        if (asset.sourceLink) content = content.replaceAll(asset.sourceLink, saved.path.replaceAll('\\', '/'));
        const name = String(asset.name || 'Attachment').replace(/[[\]\\\r\n]/g, '').slice(0, 160);
        links.push((asset.kind === 'image' ? '!' : '') + '[' + name + '](<' + saved.path.replaceAll('\\', '/') + '>)');
      }
      add(message.role, content);
      if (links.length) add('assistant', '[Copied attachments for the preceding message]\n\n' + links.join('\n\n'));
    }
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail('unsafe_asset_path', 'The transfer transcript was redirected.');
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'), { mode: 0o600 });
  }
  async dispose() {
    this.disposed = true;
    await Promise.all([...this.clients].map((client) => client.dispose()));
  }
}
module.exports = { CodexConversationAdapter, codexSnapshot, migratedTarget };
