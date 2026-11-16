'use strict';

// Team models in the member's own model list (row 123, slice 4b member wiring;
// TEAM_NODE_PROTOCOL_SPEC "4b member wiring as built"). A team model is listed
// as `team/<teamId>/<modelId>` on engine `openai-compatible`; that id is what the
// hint map and a conversation's `preferred_model` hold. The real model id reaches
// the wire only through resolveManagedConfiguredModel, and the team's engine
// port only through resolveOpenAICompatibleApiUrl, both while a selection made by
// loadModel is live. The team side is reached through `service.options.getTeamEngine`,
// which the Team feature's registration sets; without it no team model exists.
// Nothing here reads a key, a token or a prompt.

const { TEAM_DIR_NAME } = require('../main/team-data-probe');
const { t } = require('../i18n-main');
const { TEAM_ERROR_CODES } = require('./error-codes');

const TEAM_MODEL_PREFIX = 'team/';
const ENGINE_TYPE = 'openai-compatible';
// The host scheduler's own model-name rule (server/team/scheduler/limits.js `maxModelIdLength`, state.js
// `isPrintable`), restated: with Team off desktop main loads no server/team module (tests/team-off.test.js).
const MAX_MODEL_NAME = 128;
const PRINTABLE = /^[\x21-\x7e][\x20-\x7e]*$/u;

function isTeamModelId(value) {
  return typeof value === 'string' && value.startsWith(TEAM_MODEL_PREFIX);
}

// E71 (owner, 2026-11-14): the `team/` prefix is reserved only while the Team feature is on, read the way
// the backend reads every flag (`service.featureFlags`, exactly true). With it off (or absent) a `team/...`
// id is an ordinary model. Every backend check that refuses or reroutes a team id asks this, not the bare prefix.
function isReservedTeamModelId(service, value) {
  return service?.featureFlags?.team === true && isTeamModelId(value);
}

// The one model-name rule, the host scheduler's own (printable ASCII, at most 128 characters): the
// member never lists a name the host could not serve. The name is never used as a path.
function isTeamEngineModelName(value) {
  return typeof value === 'string' && value.length <= MAX_MODEL_NAME && PRINTABLE.test(value) && value.trim() === value;
}

// The per-request model profile's context-length bounds (sidecar/protocol.py `model_profile`; the
// sidecar's request_model_profile.py restates them): the one JS rule for a length a profile may carry.
const PROFILE_CONTEXT_MIN = 2048;
const PROFILE_CONTEXT_MAX = 1048576;
function isProfileContextLength(value) {
  return Number.isSafeInteger(value) && value >= PROFILE_CONTEXT_MIN && value <= PROFILE_CONTEXT_MAX;
}

// { id, teamId, modelId } for a well-formed team model id, null otherwise.
function parseTeamModelId(value) {
  if (!isTeamModelId(value)) return null;
  const rest = value.slice(TEAM_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const teamId = rest.slice(0, slash);
  const modelId = rest.slice(slash + 1);
  if (!TEAM_DIR_NAME.test(teamId) || !isTeamEngineModelName(modelId)) return null;
  return { id: value, teamId, modelId };
}

function teamModelId(teamId, modelId) {
  return `${TEAM_MODEL_PREFIX}${teamId}/${modelId}`;
}

function teamEngine(service) {
  try { return service?.options?.getTeamEngine?.() || null; } catch (_error) { return null; }
}

// The team selection loadModel made, while the engine it was made for runs; null otherwise.
function liveTeamSelection(service) {
  const selection = service?._teamEngineSelection || null;
  if (!selection) return null;
  const engineType = String(service.currentEngineType || '').trim().toLowerCase();
  return engineType === ENGINE_TYPE ? selection : null;
}

// Fail closed: a mode that cannot be read counts as Force local on.
function forceLocalOn(service) {
  try { return service?.offlineIntelligenceService?.getMode?.() === 'local_only'; } catch (_error) { return true; }
}

function refusal(reason, message) {
  return Object.assign(new Error(message), {
    code: reason, reason, error_code: TEAM_ERROR_CODES.ENGINE_UNAVAILABLE, category: 'setup', retryable: false,
  });
}

// A team model runs only for the conversation that chose it.
function otherChatRefusal() {
  return refusal('team_engine_other_chat', t('team.engine.refused.otherChat',
    'Another chat is using a team model. Pick a model for this chat.'));
}

function notReadyRefusal() {
  return refusal('team_engine_not_ready', t('team.engine.refused.notReady', 'The team engine is not ready yet. Try again in a moment.'));
}

// Throws the typed refusal; returns the parsed selection when the team model may run now. loadModel
// asks before anything is switched, and resolveModel asks again on every send of a team model.
function assertTeamModelUsable(service, value) {
  const engine = teamEngine(service);
  if (!engine) throw refusal('team_feature_off', t('team.engine.refused.off', 'Turn on the Team feature to use a team model.'));
  if (forceLocalOn(service)) {
    throw refusal('team_force_local', t('team.engine.refused.forceLocal', 'Force local inference is on, so a team model cannot be used.'));
  }
  const parsed = parseTeamModelId(value);
  const team = parsed ? engine.teamState(parsed.teamId) : null;
  if (!team) throw refusal('team_not_found', t('team.engine.refused.unknown', 'That team is not one of your teams.'));
  if (team.online !== true) {
    throw refusal('team_not_connected', t('team.engine.refused.offline', 'That team is not connected right now.'));
  }
  if (team.active !== true) {
    throw refusal('team_member_not_active', t('team.engine.refused.notActive', 'You are not an active member of that team yet.'));
  }
  if (team.portReady !== true) throw notReadyRefusal();
  if (!Array.isArray(team.models) || !team.models.includes(parsed.modelId)) {
    throw refusal('team_model_unavailable', t('team.engine.refused.model', 'That team does not offer this model right now.'));
  }
  return parsed;
}

// The port base url for a live selection, '' when its port is not serving, null without a selection:
// a team selection never falls through to another endpoint.
function teamEngineApiUrl(service) {
  const selection = liveTeamSelection(service);
  if (!selection) return null;
  const port = teamEngine(service)?.portFor(selection.teamId) || null;
  if (!port || port.getStatus?.()?.state !== 'ready') return '';
  return String(port.getBaseUrl?.() || '');
}

// The sidecar config's guard: a live selection whose port does not serve builds no config at all, so
// the sidecar never falls back to its default local endpoint with a team's model.
function assertTeamEndpointServes(service) {
  if (teamEngineApiUrl(service) === '') throw notReadyRefusal();
}

// The rows every listed team adds: one per model, after the list normaliser (which drops extra fields).
function teamModelEntries(service) {
  const engine = teamEngine(service);
  if (!engine || forceLocalOn(service)) return [];
  const rows = [];
  for (const team of engine.listTeams()) {
    for (const modelId of team.models) {
      const contextLength = team.contextLengths?.[modelId];
      rows.push({ id: teamModelId(team.teamId, modelId), engine_type: ENGINE_TYPE, available: true,
        team_id: team.teamId, team_name: team.name || '',
        ...(Number.isSafeInteger(contextLength) ? { context_length: contextLength } : {}) });
    }
  }
  return rows;
}

// The live team model's { id, context_length } for a member's chat.send (slice 4f), null without a live
// team selection: the real model id (never the `team/` list id) and the length the host reported for it.
function teamModelProfile(service) {
  const selection = liveTeamSelection(service);
  if (!selection) return null;
  const lengths = teamEngine(service)?.teamState(selection.teamId)?.contextLengths;
  const contextLength = lengths ? lengths[selection.modelId] : undefined;
  return { id: selection.modelId, context_length: Number.isSafeInteger(contextLength) ? contextLength : null };
}

// Part of the model-list cache key: a team that comes online or changes its models inside the TTL.
function teamCatalogKey(rows) {
  return rows.map((row) => `${row.id}:${row.team_name}:${row.context_length ?? ''}`).join('|');
}

module.exports = {
  assertTeamEndpointServes,
  assertTeamModelUsable,
  isProfileContextLength,
  isTeamEngineModelName,
  isReservedTeamModelId,
  isTeamModelId,
  liveTeamSelection,
  otherChatRefusal,
  parseTeamModelId,
  teamCatalogKey,
  teamEngineApiUrl,
  teamModelEntries,
  teamModelId,
  teamModelProfile,
};
