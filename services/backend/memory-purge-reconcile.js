'use strict';

const { requestMemoryRpc, purgeSessionMemories } = require('./backend-memory');
const { sidecarReady } = require('./memory-reflection-scheduler');

// The canonical index is the durable deletion record. Never infer deletions
// from an empty/unreadable index. The deletion registry has no public in-flight
// id lookup; chats still in that index are retained, including archived chats.
function startMemoryPurgeReconcile({ service, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let stopped = false;
  const dispose = () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = () => {
    timer = setTimer(async () => {
      timer = null;
      if (stopped) return;
      try {
        if (!sidecarReady(service)) { schedule(); return; }
        const summaries = service.sessionStore.listSessions();
        if (!Array.isArray(summaries) || !summaries.length) return;
        const present = new Set(summaries.map(summary => summary.id));
        const result = await requestMemoryRpc(service, 'memory.chat_sessions', { limit: 2000 });
        if (!Array.isArray(result?.session_ids)) throw new Error('invalid_response');
        const seen = new Set();
        let purged = 0;
        for (const id of result.session_ids.slice(0, 2000)) {
          if (stopped || purged >= 50) break;
          if (typeof id !== 'string' || !id.trim() || present.has(id) || seen.has(id)) continue;
          seen.add(id);
          // A restore may have added this id while the sidecar was answering.
          const current = service.sessionStore.listSessions();
          if (!Array.isArray(current) || !current.length) break;
          if (current.some(summary => summary.id === id)) continue;
          const result = await purgeSessionMemories(service, id);
          if (result.ok !== true) break;
          purged += 1;
        }
      } catch (_error) {
        try {
          service._emitServiceLog?.('WARN', 'memory.purge_reconcile_failed', { reason: 'reconcile_failed' });
        } catch (_logError) { /* Startup reconciliation is best effort. */ }
      } finally {
        if (timer === null) stopped = true;
      }
    }, 15_000);
    timer?.unref?.();
  };
  schedule();
  return { dispose };
}

module.exports = { startMemoryPurgeReconcile };
