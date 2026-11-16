'use strict';

// Automatic (owner's pick 4, slice 4e): the model the most connected hardware offers;
// ties go to the larger context length (unknown counts as 0), then to the id in order.
// Paused hardware answers nothing, so it counts for nothing. One chooser for the GPU
// list (node-commands.js) and the pool's lease model (pool-composition.js); its own
// module because pool-composition -> node-commands -> engine-routes -> pool-composition
// would be an import cycle.
function automaticModel(views) {
  const counts = new Map();
  for (const view of views) {
    if (!view.online || view.paused) continue;
    for (const entry of view.models) {
      const seen = counts.get(entry.id) || { n: 0, ctx: 0 };
      counts.set(entry.id, { n: seen.n + 1, ctx: Math.max(seen.ctx, Number.isSafeInteger(entry.context_length) ? entry.context_length : 0) });
    }
  }
  let best = null;
  for (const [id, seen] of counts) {
    if (!best || seen.n > best.n || (seen.n === best.n && (seen.ctx > best.ctx || (seen.ctx === best.ctx && id < best.id)))) {
      best = { id, ...seen };
    }
  }
  return best ? best.id : null;
}

module.exports = { automaticModel };
