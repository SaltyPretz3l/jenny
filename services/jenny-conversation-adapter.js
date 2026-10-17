'use strict';

const { exportSession, importSession } = require('./backend/session-export-import');
const { redactExportSecretsInValue } = require('./backend/transcript-export-redaction');
const { fail } = require('./conversation-transfer-contract');
const { imageMime, writeAssets } = require('./conversation-transfer-assets');

class JennyConversationAdapter {
  constructor({ sessionStore, shadowStore, attachmentAssetStore, transferAssetRoot, isBusy = () => false } = {}) {
    Object.assign(this, { sessionStore, shadowStore, attachmentAssetStore, transferAssetRoot, isBusy });
  }
  async list() {
    return this.sessionStore.listSessions().slice(0, 500).map((row) => ({
      id: row.id, title: row.title, archived: Boolean(row.archived_at), busy: this.isBusy(row.id),
    }));
  }
  async snapshot(id) {
    if (this.isBusy(id)) fail('source_busy', 'Wait for this conversation to settle before copying.');
    const source = this.sessionStore.getSession(id);
    if (!source) fail('source_missing', 'This conversation no longer exists.');
    const exported = JSON.parse(exportSession(this.sessionStore, id, this.attachmentAssetStore));
    const warnings = [];
    const messages = [];
    for (const row of exported.session.messages) {
      if (!['user', 'assistant', 'tool'].includes(row.role)) continue;
      const attachments = (row.attachments || []).map((asset) => {
        if (asset.kind === 'audio') warnings.push('Audio attachment copied as a file; playback and transcription are not replayed: ' + String(asset.displayName || 'Audio').slice(0, 160));
        if (asset._exportedData) {
          const kind = asset.kind === 'image' ? 'image' : 'file';
          return { kind, name: String(asset.displayName || 'Attachment').slice(0, 160),
            mime: asset._exportedMime, data: asset._exportedData };
        }
        warnings.push(`Original attachment unavailable: ${asset.displayName || 'Attachment'}. Only retained conversation text will be copied.`);
        return { kind: 'missing', name: String(asset.displayName || 'Attachment').slice(0, 160) };
      });
      if (row.role === 'tool' && row.tool_result?.status && !['completed', 'success', 'failed', 'error'].includes(row.tool_result.status)) {
        warnings.push('Unfinished tool activity was omitted.');
        continue;
      }
      for (const artifact of row.tool_result?.generated_artifacts || []) {
        warnings.push('Original generated artifact not retained by session export: ' + String(artifact.title || artifact.name || artifact.id || 'Artifact').slice(0, 160));
      }
      messages.push({ role: row.role === 'user' ? 'user' : 'assistant',
        content: row.role === 'tool' ? '[Completed tool activity; copied text only]\n'
          + [row.tool_result?.tool_name, row.tool_result?.output_text || row.content].filter(Boolean).join('\n') : row.content,
        attachments });
    }
    if (source.pending_question_batch || source.pending_plan_proposal || source.active_turn) {
      warnings.push('Pending work, questions and approvals are omitted.');
    }
    return redactExportSecretsInValue({ title: source.title, sourceWorkspace: source.project_id || 'General',
      messages, warnings: [...new Set(warnings)] });
  }
  async copy(snapshot, record, update) {
    const destinationId = record.destinationId || `sess_transfer_${record.id.replaceAll('-', '')}`;
    if (this.sessionStore.getSession(destinationId)) {
      if (this.sessionStore.flushSession(destinationId) !== true) fail('destination_persist_failed', 'The copied conversation is not durable yet. Retry the saved transfer.');
      return destinationId;
    }
    update({ destinationId, state: 'importing' });
    const files = this.transferAssetRoot ? writeAssets(this.transferAssetRoot, record.id, snapshot) : [];
    let assetIndex = 0;
    const messages = snapshot.messages.map((message) => {
      const attachments = (message.attachments || []).filter((asset) => asset.data && asset.kind === 'image').map((asset) => ({
        kind: 'image', displayName: asset.name, _exportedMime: imageMime(Buffer.from(asset.data, 'base64')),
        _exportedData: asset.data, sourceKind: 'import',
      }));
      const links = [];
      const retained = [];
      let content = message.content;
      for (const asset of message.attachments || []) {
        if (!asset.data) continue;
        const saved = files[assetIndex++];
        if (asset.sourceLink && saved) content = content.replaceAll(asset.sourceLink, saved.path.replaceAll('\\', '/'));
        if (asset.kind !== 'image' && /^(text\/|application\/json)/.test(asset.mime || '')
          && !/\.(pdf|docx|xlsx|pptx|zip|webm|wav|mp3)$/i.test(asset.name || '')) {
          retained.push('[Retained file text: ' + asset.name + ']\n' + Buffer.from(asset.data, 'base64').toString('utf8').slice(0, 12000));
        }
        if (asset.kind !== 'image' && saved) links.push('[' + String(asset.name).replace(/[[\]\\\r\n]/g, '') + '](<' + saved.path.replaceAll('\\', '/') + '>)');
      }
      return { role: message.role, content: redactExportSecretsInValue(content + (links.length ? '\n[Copied files; originals available from Settings > Conversation transfer > Open copied attachments]\n' + links.join('\n') : '') + (retained.length ? '\n' + retained.join('\n\n') : '')), attachments };
    });
    const payload = { format: 'jenny-session-export', format_version: 1,
      session: { title: snapshot.title + ' (from Codex)', created_at: record.createdAt,
        updated_at: record.createdAt, conversation_mode: 'chat', messages } };
    importSession(this.sessionStore, JSON.stringify(payload), this.attachmentAssetStore,
      { trustedArchive: true, restoredSessionId: destinationId, shadowStore: this.shadowStore });
    if (this.sessionStore.flushSession(destinationId) !== true) fail('destination_persist_failed', 'The copied conversation is not durable yet. Retry the saved transfer.');
    return destinationId;
  }
  async exists(id) { return Boolean(this.sessionStore.getSession(id)); }
}
module.exports = { JennyConversationAdapter };
