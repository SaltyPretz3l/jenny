'use strict';

const { collectAssetPaths } = require('../attachment-service');
const { hasDurableProof } = require('./conversation-store-port');

// Both stores hold the session, and a mirror truncate can fail without failing
// the edit, so the referenced set spans both — a file the mirror still points at
// must not be deleted. Unlike session delete (backend-sessions.js:396) this does
// not scan *other* sessions: no path shares an assetPath across sessions today
// (import strips assetPath and writes fresh copies). Anything that changes that
// must widen this set, or truncate starts deleting live files.
function collectSessionAssetPaths(ports, sessionId) {
  const paths = [];
  for (const port of ports) {
    if (!port) continue;
    for (const message of port.getSessionMessages(sessionId)) {
      paths.push(...collectAssetPaths(message?.attachments));
    }
  }
  return [...new Set(paths)];
}

function restoreTruncateSnapshot(service, port, sessionId, snapshot, reason, scope) {
  const rollback = port.restoreSnapshot(sessionId, snapshot);
  service._emitServiceLog?.(rollback.ok ? 'WARN' : 'ERROR', 'session.truncate_rolled_back', {
    sessionId,
    scope,
    ok: rollback.ok,
    reason: rollback.reason || reason || null,
  });
  return rollback;
}

async function editUserMessageAndTruncate(service, sessionId, messageId, payload = {}) {
  const sid = String(sessionId || '').trim();
  const mid = String(messageId || '').trim();
  if (!sid || !mid) return null;
  const rawContent = Object.hasOwn(payload || {}, 'content') ? payload.content : null;
  const normalizedContent = typeof rawContent === 'string' ? rawContent : null;
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : null;
  const options = {
    ...(normalizedContent !== null ? { replaceMessageContent: normalizedContent } : {}),
    ...(attachments ? { replaceMessageAttachments: attachments } : {}),
  };
  const canonicalStore = service.sessionStore;
  const mirrorStore = service.shadowStore;
  const canonicalPort = canonicalStore?.conversationStore;
  const mirrorPort = mirrorStore?.conversationStore;
  if (!canonicalPort) return null;
  const canonicalSnapshot = canonicalPort.getRollbackSnapshot(sid);
  const mirrorSnapshot = mirrorPort?.getRollbackSnapshot?.(sid) || null;
  if (!canonicalSnapshot) return null;

  let beforePaths = [];
  if (service.attachmentAssetStore) {
    try {
      beforePaths = collectSessionAssetPaths([canonicalPort, mirrorPort], sid);
    } catch (error) {
      service._emitServiceLog?.('WARN', 'session.truncate_asset_prune_failed', {
        sessionId: sid,
        reason: String(error?.message || error),
      });
    }
  }

  const commit = canonicalPort.truncateAfterMessage(sid, mid, options, { durable: true });
  if (!hasDurableProof(commit) || !Array.isArray(commit.value?.survivingTurnIds)) {
    if (commit?.applied) {
      restoreTruncateSnapshot(
        service, canonicalPort, sid, canonicalSnapshot, commit.reason, 'canonical'
      );
    }
    return null;
  }

  let mirrorCommit = null;
  let replication = { ok: true, reason: null };
  if (mirrorPort) {
    try {
      mirrorCommit = mirrorPort.truncateAfterMessage(sid, mid, options);
      if (!mirrorCommit.ok) replication = {
        ok: false,
        reason: mirrorCommit.reason || 'mirror_refused',
      };
    } catch (error) {
      replication = { ok: false, reason: String(error?.message || error) };
    }
    if (!replication.ok) {
      service._emitServiceLog?.('WARN', 'session.truncate_replication_lag', {
        sessionId: sid,
        reason: replication.reason,
      });
    }
  }

  let journal = { ok: true, reason: null };
  if (service.turnEventJournal?.purgeTurnsAfter) {
    journal = service.turnEventJournal.purgeTurnsAfter(
      sid,
      new Set(commit.value.survivingTurnIds),
      { commitResult: commit, durable: true }
    );
    if (!journal.ok) {
      service._emitServiceLog?.('WARN', 'session.truncate_journal_purge_failed', {
        sessionId: sid,
        reason: journal.reason || 'unknown',
      });
      restoreTruncateSnapshot(
        service, canonicalPort, sid, canonicalSnapshot, journal.reason, 'canonical'
      );
      if (mirrorCommit?.applied && mirrorSnapshot) {
        restoreTruncateSnapshot(
          service, mirrorPort, sid, mirrorSnapshot, journal.reason, 'mirror'
        );
      }
      return null;
    }
  }
  if (service.attachmentAssetStore && beforePaths.length) {
    try {
      const afterPaths = collectSessionAssetPaths([canonicalPort, mirrorPort], sid);
      await service.attachmentAssetStore.pruneAssetPaths(beforePaths, afterPaths);
    } catch (error) {
      service._emitServiceLog?.('WARN', 'session.truncate_asset_prune_failed', {
        sessionId: sid,
        reason: String(error?.message || error),
      });
    }
  }
  return { ...commit.value.session, replication, journal };
}

module.exports = { editUserMessageAndTruncate };
