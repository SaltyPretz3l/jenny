'use strict';

// `away_digest` (row 86 D3): what happened across the user's chats while they were away, for the primary Jenny chat's
// "While you were away" turn and for "what did I miss?". Read-only, policy `auto`, no card; it answers in Plan mode
// and read-only chats too, like schedule_list. The facts come from the digest port
// (`context.backendService.primaryDigestPresence.factsSince`, services/main/primary-digest-wiring.js) over data main
// already holds; this tool only validates the window, re-checks that the caller is the primary chat and never puts
// exception text in a result.
const { manifestSchema } = require('./tool-result');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');

const NAME = 'away_digest';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = DAY_MS;
const MAX_WINDOW_MS = 30 * DAY_MS;
// An instant with an explicit offset, so a window never depends on the machine's local zone.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Default off (`=== true`), unlike the default-on primary flags; either switch removes the tool (it is not
// registered), and a stale context still refuses here.
const digestsOff = (context) => {
  const flags = context?.backendService?.featureFlags;
  return flags?.primary_digests !== true || flags?.primary_chat === false;
};
const result = (value) => jsonToolResult(NAME, 'While you were away: facts', value);
const refused = (reason) => result({ ok: false, reason });

function instantMs(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// The window's start: the caller's `since` (future refused, older than 30 days clamped), else the last time the user
// was present, else 24 h back. `undefined` means the caller's `since` is malformed or in the future.
function windowStart(input, context, nowMs) {
  const floor = nowMs - MAX_WINDOW_MS;
  if (input.since !== undefined) {
    const ms = instantMs(input.since);
    if (ms === null || ms > nowMs) return undefined;
    return Math.max(ms, floor);
  }
  let present;
  try {
    present = instantMs(context.backendService?.primaryChatControls?.getDigest?.()?.lastPresentAt);
  } catch (_error) {
    present = null;
  }
  return present !== null && present <= nowMs ? Math.max(present, floor) : nowMs - DEFAULT_WINDOW_MS;
}

function isPrimaryCaller(context) {
  const caller = String(context.sessionId || '');
  const primaryId = context.backendService?.primaryChatControls?.primarySessionId?.() ?? null;
  return Boolean(caller) && typeof primaryId === 'string' && primaryId === caller;
}

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'While you were away: facts',
  async execute(input = {}, context = {}) {
    if (digestsOff(context)) return refused('disabled');
    if (!plainInput(input, ['since'])) return refused('invalid_input');
    const port = context.backendService?.primaryDigestPresence;
    if (typeof port?.factsSince !== 'function') return refused('disabled');
    try {
      if (!isPrimaryCaller(context)) return refused('not_primary');
    } catch (_error) {
      return refused('unavailable');
    }
    const nowMs = Date.now();
    const sinceMs = windowStart(input, context, nowMs);
    if (sinceMs === undefined) return refused('invalid_input');
    try {
      const answer = await port.factsSince({ since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() });
      if (!answer || answer.ok !== true || !Array.isArray(answer.items)) return refused('unavailable');
      const { since, until, items, truncated, counts } = answer;
      return result({ ok: true, since, until, items, truncated: truncated === true, counts: counts ?? {} });
    } catch (_error) {
      return refused('unavailable');
    }
  },
};
