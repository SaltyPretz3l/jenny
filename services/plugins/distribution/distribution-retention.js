'use strict';

const { joinPath } = require('../store/fs-facade');
const { GENERATIONS_DIR, listGenerationIds, readGeneration } = require('../store/generation-store');
const { readActivePointer } = require('../store/active-pointer');
const { LIMITS } = require('./distribution-limits');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
async function enforceGenerationRetention(facade, baseDir, { protectedGenerationIds = new Set(), keep = LIMITS.retainedGenerations } = {}) {
  const pointer = await readActivePointer(facade, baseDir);
  const protectedIds = new Set(protectedGenerationIds);
  const activeId = pointer.status === 'ok' ? pointer.pointer.generation_id : null;
  if (activeId) protectedIds.add(activeId);
  const rows = [];
  for (const id of (await listGenerationIds(facade, baseDir)).filter((item) => ID_RE.test(item))) {
    const generation = await readGeneration(facade, baseDir, id); if (!generation.ok) continue;
    rows.push({ id, at: Date.parse(generation.record.created_at) });
  }
  rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const remainingSlots = Math.max(0, keep - (activeId ? 1 : 0));
  const retained = new Set(rows.filter((row) => row.id !== activeId).slice(0, remainingSlots).map((row) => row.id));
  for (const id of protectedIds) retained.add(id);
  const removed = [];
  for (const row of rows) {
    if (retained.has(row.id)) continue;
    await facade.removeTree(joinPath(baseDir, GENERATIONS_DIR, row.id)); removed.push(row.id);
  }
  return { ok: true, retained: [...retained].sort(), removed };
}
module.exports = { enforceGenerationRetention };
