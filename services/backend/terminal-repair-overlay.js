'use strict';

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildTerminalRepairOverlayMessage(repair) {
  if (!repair || typeof repair !== 'object') return null;
  if (repair.message && typeof repair.message === 'object') {
    return { ...repair.message };
  }
  const streamId = normalizeId(repair.stream_id);
  const artifactId = normalizeId(repair.artifact_id);
  const messageId = streamId
    ? `assistant_${streamId}`
    : (artifactId ? `assistant_repair_${artifactId}` : '');
  if (!messageId) return null;
  const snapshot = repair.terminal_snapshot && typeof repair.terminal_snapshot === 'object'
    ? repair.terminal_snapshot
    : {};
  const terminal = snapshot.terminal && typeof snapshot.terminal === 'object'
    ? snapshot.terminal
    : {};
  const rendererPayload = terminal.rendererPayload && typeof terminal.rendererPayload === 'object'
    ? terminal.rendererPayload
    : {};
  const kind = normalizeId(snapshot.kind || terminal.kind) || 'error';
  const content = String(rendererPayload.content || rendererPayload.message || '').trim()
    || 'This turn could not be saved. Retry the save or discard this recovery record.';
  return {
    id: messageId,
    client_message_id: messageId,
    role: 'assistant',
    content,
    status: kind,
    terminal_status: kind,
    stream_error: kind === 'complete' ? '' : content,
    parent_stream_id: streamId,
    timestamp: repair.updated_at || repair.created_at || new Date(0).toISOString(),
  };
}

function overlayPendingTerminalRepairs(messages, repairs) {
  const canonical = Array.isArray(messages)
    ? messages.filter((message) => message && typeof message === 'object').map((message) => ({ ...message }))
    : [];
  const canonicalIds = new Set();
  for (const message of canonical) {
    const id = normalizeId(message.id);
    const clientMessageId = normalizeId(message.client_message_id);
    if (id) canonicalIds.add(id);
    if (clientMessageId) canonicalIds.add(clientMessageId);
  }
  const pending = Array.isArray(repairs) ? repairs : [];
  for (const repair of pending) {
    if (!repair || repair.state !== 'pending') continue;
    const overlayMessage = buildTerminalRepairOverlayMessage(repair);
    if (!overlayMessage) continue;
    const messageId = normalizeId(overlayMessage.id);
    const clientMessageId = normalizeId(overlayMessage.client_message_id);
    if (!messageId || canonicalIds.has(messageId) || (clientMessageId && canonicalIds.has(clientMessageId))) {
      continue;
    }
    const artifactId = normalizeId(repair.artifact_id);
    canonical.push({
      ...overlayMessage,
      durability: {
        state: 'unsaved',
        reason: normalizeId(repair.reason) || 'write_failed',
        scope: normalizeId(repair.scope) || 'assistant',
        artifact_id: artifactId,
      },
    });
    canonicalIds.add(messageId);
    if (clientMessageId) canonicalIds.add(clientMessageId);
  }
  // Flat message order is canonical. A pending repair still owns the active
  // turn, so no later valid turn can follow it; append without re-sorting or
  // rewriting imported/equal/non-monotonic timestamps.
  return canonical;
}

module.exports = {
  buildTerminalRepairOverlayMessage,
  overlayPendingTerminalRepairs,
};
