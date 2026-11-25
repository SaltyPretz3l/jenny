'use strict';

// Load-path helpers for the managed Strata runtime (row 200 S2 step 6), kept
// out of backend-model-load.js (loadModel), backend-runtime.js (unloadModel)
// and backend-model-list.js so those grow by branches, not bodies.
//
// The model is offered only when a launch could start: flag on, manager wired,
// the owner's install and Setup's config found, and the native pack not known
// bad. Otherwise it is not listed at all rather than listed and refused (the
// NInfer rule). The ids come from the runtime's state (the pinned pack
// manifest), never from a path.

const ENGINE_TYPE = 'openai-compatible';
const UNLISTED_PACK_STATES = Object.freeze(['failed', 'missing']);

function strataModelOf(service) {
  try {
    const runtime = service?.strataRuntime;
    if (!runtime || runtime.enabled !== true) return null;
    const state = runtime.getState?.() || null;
    const id = String(state?.model?.id || '').trim();
    // The manager lookup reads the feature flags: only once an install is known.
    return id && service.options?.getStrataManager?.() ? { state, id, aliases: Array.isArray(state.model.aliases) ? state.model.aliases : [] } : null;
  } catch (_error) {
    return null;
  }
}

// True when `modelName` names the Strata model (its served id or an alias the
// config registers, G6).
function isStrataModel(service, modelName) {
  const token = String(modelName || '').trim();
  const model = token ? strataModelOf(service) : null;
  return Boolean(model) && (model.id === token || model.aliases.includes(token));
}

// The catalog row for the Strata model while its server is stopped (a running
// server lists its own row first and the merge keeps that one).
function strataModelEntries(service) {
  const model = strataModelOf(service);
  if (!model) return [];
  const { install, setup, packs } = model.state;
  if (install?.found !== true || setup?.found !== true || UNLISTED_PACK_STATES.includes(packs?.native)) return [];
  const settings = service.configService?.getLocalEngines?.()?.strata || null;
  const paramsB = Number(model.state.model.paramsB);
  return [{
    id: model.id,
    engine_type: ENGINE_TYPE,
    available: true,
    managed: 'strata',
    // So model-size-class does not read "inkling-2-mini" as unknown (plan step 3).
    ...(Number.isFinite(paramsB) && paramsB > 0 ? { parameter_size: `${paramsB}B` } : {}),
    capabilities: { vision: settings?.vision !== false && !UNLISTED_PACK_STATES.includes(packs?.vision) },
  }];
}

// The boot target follows the last load that took: a Strata load marks Strata
// last-used (and the caller clears the other two targets); any other non-team
// load clears it so the next boot cannot reverse the switch.
function persistStrataBootTarget(service, { strataLoad, teamSelection }) {
  const config = service.configService;
  if (strataLoad) {
    config?.updatePreferredEngineType?.(ENGINE_TYPE);
    config?.updateStrataSettings?.({ lastUsed: true });
    if (config?.getLocalEngines?.()?.openaiCompatible?.managed?.lastUsedTag) config?.updateManagedLlamaServer?.({ lastUsedTag: '' });
    return;
  }
  if (!teamSelection && config?.getLocalEngines?.()?.strata?.lastUsed === true) config?.updateStrataSettings?.({ lastUsed: false });
}

module.exports = {
  isStrataModel,
  persistStrataBootTarget,
  strataModelEntries,
};
