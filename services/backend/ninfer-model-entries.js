'use strict';

// Catalog rows for the managed NInfer runtime's pinned models (row 54), so the composer lists a model
// the user has downloaded while NInfer is stopped: picking it loads through the NInfer manager. A
// running server lists its own row first, and the merge keeps that one (real capabilities).
//
// A row exists only when everything a launch needs is already in place (flag on, manager wired,
// runtime installed, eligible GPU, artifact file present at its pinned size); otherwise the model
// is not offered at all rather than offered and refused.

const ENGINE_TYPE = 'openai-compatible';

async function ninferModelEntries(service) {
  try {
    const runtime = service?.ninferRuntime;
    const pins = runtime?.artifacts?.artifacts;
    if (!runtime || runtime.enabled === false || !Array.isArray(pins) || pins.length === 0) return [];
    if (!service.options?.getNinferManager?.()) return [];
    if (runtime.install?.resolveExecutable?.()?.ok !== true) return [];
    const eligibility = await runtime.eligibility?.();
    if (eligibility?.eligible !== true) return [];
    const settings = service.configService?.getLocalEngines?.()?.ninfer || null;
    const rows = [];
    for (const pin of pins) {
      const modelId = String(pin?.model_id || '').trim();
      if (!modelId) continue;
      const located = await runtime.artifacts.resolveArtifactPath(pin.id);
      if (located?.ok !== true) continue;
      rows.push({
        id: modelId,
        engine_type: ENGINE_TYPE,
        available: true,
        managed: 'ninfer',
        capabilities: { vision: settings?.vision !== false },
      });
    }
    return rows;
  } catch (_error) {
    // A catalog read never fails because the optional runtime could not be probed.
    return [];
  }
}

module.exports = { ninferModelEntries };
