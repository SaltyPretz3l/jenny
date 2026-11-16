'use strict';

// The picture cleanup for project boards (row 150 slice B7, plan PROJECT_BOARD_2026-11-13 section 6.4): a stored
// picture is removed 7 days after its last reference went.
//
// A reference is any `asset` string of SHA-256 shape found by walking, without interpreting, the stored JSON of:
// every board document in <userData>/boards (a deleted board that can still be restored is still on disk), its undo
// journal (operations and inverses, so undo can bring a picture back), its proposals file, and every redo step the
// board service holds in memory. A board set aside (slice B11) keeps its pictures too: its files are no longer
// listed, so the store scans their bytes for picture names. When any of those cannot be read (a link, an unreadable or corrupt file, an
// unreadable boards folder) the pass removes nothing and stamps nothing: a picture is never removed on a partial view.
//
// The clocks live in board-assets.js's index: an unreferenced picture gets one the first pass that sees it so, a
// referenced one loses it, and a clock older than GRACE_MS removes the picture (no link followed). A corrupt index is
// rebuilt. maybeSweep() runs a pass once when first asked (the board service's first call) and then at most once
// every INTERVAL_MS, each on its own turn of the event loop (setImmediate, no timer left behind) after the call that
// asked has its answer. A failure is logged and swallowed. The pass is synchronous file IO in the main process,
// so no board write interleaves with it.

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 64;
const MAX_NODES = 2000000;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Adds every `asset` string of SHA-256 shape in `value` to `into`; false when the walk ran past its bounds. */
function collectAssetRefs(value, into) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (item === null || typeof item !== 'object') continue;
    nodes += 1;
    if (depth > MAX_DEPTH || nodes > MAX_NODES) return false;
    for (const key of Object.keys(item)) {
      const child = item[key];
      if (key === 'asset' && typeof child === 'string' && child.length === 64 && SHA256_RE.test(child)) into.add(child);
      else if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return true;
}

function createBoardAssetSweeper({
  assets, store, getRedoInverses = () => [], now = () => Date.now(), logger = () => {},
  graceMs = GRACE_MS, intervalMs = INTERVAL_MS, schedule = (fn) => { setImmediate(fn); },
} = {}) {
  if (!assets || !store) throw new Error('The board asset sweeper requires the asset store and the board store.');
  const log = (level, event, data) => { try { logger(level, event, data); } catch (_error) { /* never fails a pass */ } };
  const nowMs = () => { const value = now(); return value instanceof Date ? value.getTime() : Number(value); };
  let last = null;
  let running = false;

  // The set of referenced pictures, or null when any source could not be read.
  function references() {
    const refs = new Set();
    const index = store.readIndex();
    if (index.status === 'link' || index.status === 'unreadable') return null;
    for (const { id } of store.listDocumentIds()) {
      for (const read of [store.readDocument(id), store.readJournal(id), store.readProposals(id)]) {
        if (read.status === 'missing') continue;
        if (read.status !== 'ok' || !collectAssetRefs(read.value, refs)) return null;
      }
    }
    const aside = store.asideAssetRefs();
    if (!aside.ok) return null;
    for (const asset of aside.refs) refs.add(asset);
    const held = getRedoInverses();
    if (!Array.isArray(held) || !collectAssetRefs(held, refs)) return null;
    return refs;
  }

  /** One pass, now: { ok, removed: [asset], skipped? }. Never throws. */
  function sweepNow() {
    try {
      const refs = references();
      if (!refs) {
        log('WARN', 'boards.asset_sweep_skipped', { reason: 'unreadable_source' });
        return { ok: false, removed: [], skipped: 'unreadable_source' };
      }
      const at = nowMs();
      const index = assets.readIndex();
      const next = {};
      const removed = [];
      const seen = new Set();
      for (const { asset } of assets.list()) {
        if (seen.has(asset)) continue;
        seen.add(asset);
        if (refs.has(asset)) continue;
        const first = index.since[asset];
        if (!Number.isSafeInteger(first) || first > at) next[asset] = at;
        else if (at - first < graceMs) next[asset] = first;
        else if (assets.remove(asset)) removed.push(asset);
        else next[asset] = first;
      }
      const before = Object.keys(index.since);
      const changed = index.rebuilt || before.length !== Object.keys(next).length || before.some((asset) => index.since[asset] !== next[asset]);
      if (changed) assets.writeIndex(next);
      if (removed.length) log('INFO', 'boards.asset_sweep_removed', { count: removed.length });
      return { ok: true, removed };
    } catch (error) {
      log('WARN', 'boards.asset_sweep_failed', { code: String(error?.code || error?.name || 'failed').slice(0, 40) });
      return { ok: false, removed: [] };
    }
  }

  /** Schedules a pass when none ran in the last interval; true when one was scheduled. */
  function maybeSweep() {
    const at = nowMs();
    if (running || (last !== null && at - last < intervalMs)) return false;
    last = at;
    running = true;
    try {
      schedule(() => {
        try { sweepNow(); } finally { running = false; }
      });
    } catch (_error) {
      running = false;
      return false;
    }
    return true;
  }

  return Object.freeze({ sweepNow, maybeSweep });
}

module.exports = { GRACE_MS, INTERVAL_MS, collectAssetRefs, createBoardAssetSweeper };
