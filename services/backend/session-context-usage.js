'use strict';

// Electron-owned "last authoritative context usage" seed.
//
// The composer context ring reads from an in-memory renderer store that is
// written only when a turn reaches its terminal `chat.done`. On a cold reopen
// that store is empty, so a long conversation falls back to the client-side
// chars/4 estimate measured against the FULL context window — visibly too low
// on both the numerator and the denominator until the next turn completes.
//
// Electron therefore persists a bounded projection of the last authoritative
// reading on the session record as `context_usage`:
//
//   {
//     version: 1,
//     used_tokens: authoritative context occupancy at the end of the turn,
//     context_window: the engine's effective window for that turn,
//     compact_threshold_tokens: the auto-compact denominator (0 when unknown),
//     model: the model that produced the reading,
//     usage_source: 'provider' | 'estimate',
//     updated_at: ISO timestamp,
//   }
//
// Consumption contract (renderer/shell/renderer-shell-runtime-utils.js
// `getContextMeterOptions`): the record seeds ONLY the two continuity inputs
// of the fallback estimate — the numerator floor and the auto-compact
// denominator, the latter only while the record's model still matches the
// active one. It is never promoted to an authoritative stored record, so it
// cannot suppress the fallback estimate or outlive the first real reading of
// the reopened session.
//
// Only a TERMINAL reading is eligible: mid-turn `context.usage` snapshots are
// ephemeral by contract and renderer estimates are not authoritative at all.
//
// The record describes a history that no longer exists once that history is
// rewritten, so the store drops it on truncate / edit-and-resend and on a full
// message replacement (electron-session-store.js). A branched session is built
// from an explicit field allowlist, so it never inherits one.

const SESSION_CONTEXT_USAGE_VERSION = 1;
const CONTEXT_USAGE_SOURCES = new Set(['provider', 'estimate']);
const CONTEXT_USAGE_MODEL_MAX_CHARS = 200;
const CONTEXT_USAGE_UPDATED_AT_MAX_CHARS = 64;

function positiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

// Fails closed to null: an omitted, malformed, negative, fractional, or
// wrong-version record is simply "no seed", never a startup crash and never a
// half-populated row on disk.
function normalizeSessionContextUsage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Number(input.version) !== SESSION_CONTEXT_USAGE_VERSION) return null;
  const usedTokens = positiveInteger(input.used_tokens);
  if (usedTokens <= 0) return null;
  const contextWindow = positiveInteger(input.context_window);
  const compactThresholdTokens = positiveInteger(input.compact_threshold_tokens);
  // A reading with no denominator at all cannot seed a ring.
  if (contextWindow <= 0 && compactThresholdTokens <= 0) return null;
  const usageSource = String(input.usage_source || '').trim();
  if (!CONTEXT_USAGE_SOURCES.has(usageSource)) return null;
  return {
    version: SESSION_CONTEXT_USAGE_VERSION,
    used_tokens: usedTokens,
    context_window: contextWindow,
    compact_threshold_tokens: compactThresholdTokens,
    model: String(input.model || '').trim().slice(0, CONTEXT_USAGE_MODEL_MAX_CHARS),
    usage_source: usageSource,
    updated_at: String(input.updated_at || '').trim().slice(0, CONTEXT_USAGE_UPDATED_AT_MAX_CHARS),
  };
}

// Terminal `chat.done` usage (already through rebuildChatDoneUsage) -> record.
// Built key-by-key; the usage object is never spread into the persisted row.
// Returns null for any usage block that is not authoritative enough to seed a
// ring, so the caller has one truthiness check rather than a policy of its own.
function buildSessionContextUsageRecord(usage, { updatedAt = null } = {}) {
  const source = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : null;
  if (!source) return null;
  const providerTokens = positiveInteger(source.last_request_input_tokens);
  const estimateTokens = positiveInteger(source.context_tokens_estimate);
  // Commit 1 made the sidecar the single source of truth for this number
  // (max of provider truth and the sidecar estimate). Older payloads that
  // predate `context_used_tokens` reconstruct the same max locally.
  const usedTokens = positiveInteger(source.context_used_tokens)
    || Math.max(providerTokens, estimateTokens);
  if (usedTokens <= 0) return null;
  const declaredSource = String(source.context_used_source || '').trim();
  const usageSource = CONTEXT_USAGE_SOURCES.has(declaredSource)
    ? declaredSource
    : (usedTokens === providerTokens ? 'provider' : 'estimate');
  return normalizeSessionContextUsage({
    version: SESSION_CONTEXT_USAGE_VERSION,
    used_tokens: usedTokens,
    context_window: source.context_window,
    compact_threshold_tokens: source.compact_threshold_tokens,
    model: source.model,
    usage_source: usageSource,
    updated_at: String(updatedAt || new Date().toISOString()),
  });
}

// chat.done seam (chat-stream-managed-runtime-notifications.js). Fail-soft in
// every direction: a non-authoritative reading, a missing session id, an older
// store without the setter, or a store write that throws all degrade to "no
// seed persisted" — the ring keeps working from live state either way.
function persistTerminalContextUsage(ctx, usage) {
  const record = buildSessionContextUsageRecord(usage);
  if (!record) return false;
  const sessionId = String(ctx?.resolvedSessionId || '').trim();
  if (!sessionId) return false;
  try {
    return Boolean(ctx?.service?.sessionStore?.setSessionContextUsage?.(sessionId, record));
  } catch (_error) {
    try {
      ctx?.service?._emitServiceLog?.('WARN', 'chat.context_usage_not_persisted', {
        sessionId,
        streamId: String(ctx?.streamId || ''),
        reason: 'persistence_exception',
      });
    } catch (_logError) {
      // Seed persistence stays best-effort even when diagnostics are down.
    }
    return false;
  }
}

module.exports = {
  SESSION_CONTEXT_USAGE_VERSION,
  buildSessionContextUsageRecord,
  normalizeSessionContextUsage,
  persistTerminalContextUsage,
};
