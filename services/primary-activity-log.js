'use strict';

/* services/primary-activity-log.js - the read-only activity projector behind the Jenny chat's
 * "Activity" and "Permissions" views (row 76, slice S5).
 *
 * It answers "what did the Jenny chat do, and what may it do" from existing records only: the
 * primary's `session_mail` and `chat_proposals` containers, the runtime work index, its
 * transcript's `session_stop` tool rows and the primary-chat controls state. It keeps no store,
 * calls no model and does no I/O of its own. Every dependency is an injected getter
 * (composition-root style, like session-directory-service.js); a missing getter contributes
 * nothing and a throwing reader is one unavailable source, never a throw. Records are data:
 * titles and previews are clipped to 160 code points with control characters stripped, and
 * message bodies never travel beyond that clip. Diagnostics carry the source name only, never
 * titles, bodies or paths. A wake is recognised from the runtime row's idempotency key, never
 * from transcript text a person can type.
 */

const PREVIEW_CODE_POINTS = 160;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const WORK_PAGES = 3;
const WORK_PAGE_ROWS = 100;
const STANDING_PREFIX = 'standing.';
const WAKE_KEY_PREFIX = 'wake_';
const UNKNOWN_CHAT = 'another chat';
const UNKNOWN_PROJECT = 'a project';
const EVERY_PROJECT = 'Every project';
const HISTORY_KINDS = new Set(['paused', 'resumed', 'reset', 'forgot']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const asArray = (value) => (Array.isArray(value) ? value : []);

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOf(value) {
  const ms = timeMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

// Whitespace and control characters become single spaces, format characters (bidi marks and the
// like) are dropped, then the text is cut to 160 code points (an ellipsis counts as one).
function clip(value) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/[\s\p{Cc}]+/gu, ' ').replace(/\p{Cf}/gu, '').trim();
  if (!flat) return null;
  const points = Array.from(flat);
  return points.length > PREVIEW_CODE_POINTS ? `${points.slice(0, PREVIEW_CODE_POINTS - 1).join('')}…` : flat;
}

function clampLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : DEFAULT_LIMIT;
}

function createPrimaryActivityLog({
  primarySessionId = () => null, readMail = () => null, readProposals = () => null, runtimeStore = () => null,
  peekMessages = () => [], controls = () => null, getSessionSummary = () => null, getProject = () => null,
  featureFlags = () => ({}), now = () => new Date(), log = () => {},
} = {}) {
  const nowMs = () => timeMs(typeof now === 'function' ? now() : now) ?? Date.now();

  // One call's working state: a source that throws is logged once for the call.
  function session() {
    const unavailable = new Set();
    const titles = new Map();
    const fail = (source) => {
      if (unavailable.has(source)) return;
      unavailable.add(source);
      try { log('WARN', 'primary_activity_log.source_unavailable', { source }); } catch (_error) { /* diagnostics only */ }
    };
    const run = (source, fn, fallback = null) => {
      try { return fn(); } catch (_error) { fail(source); return fallback; }
    };
    const chatTitle = (sessionId) => {
      if (!isText(sessionId)) return UNKNOWN_CHAT;
      if (!titles.has(sessionId)) {
        const summary = run('session_summary', () => getSessionSummary(sessionId));
        titles.set(sessionId, clip(summary?.title) || UNKNOWN_CHAT);
      }
      return titles.get(sessionId);
    };
    const project = (projectId) => {
      if (!isText(projectId) || projectId === '*') return null;
      const found = run('project', () => getProject(projectId));
      return isRecord(found) && isText(found.id) ? { id: found.id, name: clip(found.name) } : null;
    };
    return { fail, run, chatTitle, project };
  }

  function flagState() {
    let flags;
    try { flags = featureFlags() || {}; } catch (_error) { flags = {}; }
    return flags.primary_activity_log === false || flags.primary_chat === false ? 'disabled' : 'ok';
  }

  function primaryId() {
    const id = primarySessionId();
    return isText(id) ? id : null;
  }

  function gate() {
    if (flagState() === 'disabled') return { ok: false, reason: 'disabled' };
    let sessionId;
    try { sessionId = primaryId(); } catch (_error) { return { ok: false, reason: 'unavailable' }; }
    return sessionId ? { ok: true, sessionId } : { ok: false, reason: 'not_found' };
  }

  // The mail container: accepts the bare container or the mail store's `{ ok, mail }` read.
  function loadMail(ctx, sessionId) {
    const raw = ctx.run('mail', () => readMail(sessionId));
    if (!isRecord(raw)) return null;
    if (raw.ok === false) { ctx.fail('mail'); return null; }
    return isRecord(raw.mail) ? raw.mail : raw;
  }

  function loadProposals(ctx, sessionId) {
    const raw = ctx.run('proposals', () => readProposals(sessionId));
    if (!isRecord(raw)) return null;
    if (raw.ok === false) { ctx.fail('proposals'); return null; }
    return raw;
  }

  function loadControls(ctx) {
    const service = ctx.run('controls', () => controls());
    if (!service) return null;
    const state = ctx.run('controls', () => service.getState());
    if (!isRecord(state)) return null;
    if (state.ok === false) { ctx.fail('controls'); return null; }
    return state;
  }

  function authorizationOf(auth) {
    if (auth.kind === 'agent_directional') return 'grant';
    if (auth.kind === 'agent_once') return 'approval';
    if (auth.kind === 'user_send') return 'user';
    return null;
  }

  function entry(fields) {
    return {
      id: null, kind: null, at: null, status: null, title: null, detail: null, session_id: null,
      project: null, authorization: null, permission_id: null, ...fields,
    };
  }

  // ---------- mail ----------

  function mailEntries(ctx, mail) {
    const out = [];
    const authorizations = new Map(asArray(mail.authorizations).filter(isRecord).map((a) => [a.authorization_id, a]));
    for (const record of asArray(mail.outbox)) {
      const envelope = record?.envelope;
      if (!isRecord(envelope) || !isText(envelope.message_id)) continue;
      const report = envelope.kind === 'terminal_report';
      const denied = record.state === 'cancelled' && record.send_requested_at === null;
      const auth = isText(record.authorization_id) ? authorizations.get(record.authorization_id) : null;
      out.push(entry({
        id: `out:${envelope.message_id}`, kind: report ? 'report_sent' : 'message_sent', at: isoOf(record.prepared_at),
        status: denied ? 'denied' : record.state ?? null, title: ctx.chatTitle(envelope.destination_session_id),
        detail: report ? clip(envelope.report?.outcome) : clip(envelope.body),
        session_id: envelope.destination_session_id ?? null, authorization: auth ? authorizationOf(auth) : null,
      }));
    }
    for (const record of asArray(mail.inbox)) {
      const envelope = record?.envelope;
      if (!isRecord(envelope) || !isText(envelope.message_id)) continue;
      const state = record.context?.state;
      out.push(entry({
        id: `in:${envelope.message_id}`, kind: envelope.kind === 'terminal_report' ? 'report_received' : 'message_received',
        at: isoOf(record.delivered_at), status: state === 'excluded_by_user' ? 'excluded' : state ?? null,
        title: ctx.chatTitle(envelope.source_session_id), detail: clip(envelope.body),
        session_id: envelope.source_session_id ?? null,
      }));
    }
    // A discard receipt keeps no envelope: its kind and source are unknown, so it reads as a message.
    for (const receipt of asArray(mail.discarded)) {
      if (!isRecord(receipt) || !isText(receipt.message_id)) continue;
      out.push(entry({
        id: `in:${receipt.message_id}`, kind: 'message_received', at: isoOf(receipt.discarded_at),
        status: 'discarded', title: UNKNOWN_CHAT,
      }));
    }
    for (const auth of asArray(mail.authorizations)) {
      if (!isRecord(auth) || auth.kind !== 'agent_directional' || !isText(auth.authorization_id)) continue;
      const base = {
        title: ctx.chatTitle(auth.destination_session_id), detail: clip(auth.purpose),
        session_id: auth.destination_session_id ?? null, authorization: 'grant',
      };
      out.push(entry({ id: `grant:${auth.authorization_id}:created`, kind: 'grant_created', at: isoOf(auth.created_at), ...base }));
      if (auth.revoked_at) {
        out.push(entry({ id: `grant:${auth.authorization_id}:revoked`, kind: 'grant_revoked', at: isoOf(auth.revoked_at), ...base }));
      }
    }
    return out;
  }

  // ---------- proposals ----------

  const isStanding = (grant) => typeof grant?.source_user_message_id === 'string'
    && grant.source_user_message_id.startsWith(STANDING_PREFIX);

  function launchStatus(grant) {
    if (grant.revoked_at) return 'revoked';
    if (!(grant.remaining > 0)) return 'spent';
    const expires = timeMs(grant.expires_at);
    return expires !== null && expires <= nowMs() ? 'expired' : 'live';
  }

  function proposalEntries(ctx, data) {
    const out = [];
    const grants = new Map(asArray(data.launch_grants).filter(isRecord).map((g) => [g.authorization_ref, g]));
    for (const record of asArray(data.records)) {
      if (!isRecord(record) || record.kind !== 'session' || !isText(record.proposal_id)) continue;
      const ref = record.binding?.session?.launch_grant_ref ?? null;
      const grant = ref ? grants.get(ref) : null;
      let authorization = null;
      let permissionId = null;
      if (!ref) authorization = 'offer';
      else if (isStanding(grant)) {
        authorization = 'permission';
        permissionId = grant.source_user_message_id.slice(STANDING_PREFIX.length) || null;
      } else if (grant) authorization = 'linked'; // a pruned grant stays unknown: never claim a source
      out.push(entry({
        id: `prop:${record.proposal_id}`, kind: 'proposal', at: isoOf(record.created_at),
        status: `${record.decision_state}/${record.action_state}`, title: clip(record.normalized_input?.title),
        detail: clip(record.decision?.choice), session_id: record.child_session_id ?? null,
        project: ctx.project(record.options?.destination_project_id), authorization, permission_id: permissionId,
      }));
    }
    for (const grant of grants.values()) {
      if (isStanding(grant) || !isText(grant.authorization_ref)) continue;
      const ids = asArray(grant.destination_project_ids);
      out.push(entry({
        id: `lgrant:${grant.authorization_ref}`, kind: 'launch_grant', at: isoOf(grant.created_at),
        status: launchStatus(grant), project: ids.length === 1 ? ctx.project(ids[0]) : null,
      }));
    }
    return out;
  }

  // ---------- runtime work (wakes) ----------

  // Newest-first work rows for the primary whose key marks a wake; at most three pages.
  function wakeRows(ctx, sessionId, store) {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < WORK_PAGES; page += 1) {
      const result = ctx.run('runtime', () => store.listSummaries({
        sessionId, limit: WORK_PAGE_ROWS, ...(cursor ? { cursor } : {}),
      }));
      if (!isRecord(result)) break;
      for (const row of asArray(result.items)) {
        if (isRecord(row) && row.session_id === sessionId && isText(row.work_id)
          && typeof row.idempotency_key === 'string' && row.idempotency_key.startsWith(WAKE_KEY_PREFIX)) rows.push(row);
      }
      cursor = isText(result.next_cursor) ? result.next_cursor : null;
      if (!cursor) break;
    }
    return rows;
  }

  // The stored record is read only for entries that reach the returned window.
  function wakeEntries(ctx, sessionId) {
    const store = ctx.run('runtime', () => runtimeStore());
    if (!store || typeof store.listSummaries !== 'function') return [];
    return wakeRows(ctx, sessionId, store).map((row) => {
      const wake = entry({ id: `wake:${row.work_id}`, kind: 'woken', at: isoOf(row.created_at), status: row.status ?? null });
      wake.resolve = () => {
        const record = ctx.run('runtime', () => store.get(row.work_id));
        wake.title = clip(record?.input?.request?.visiblePrompt);
      };
      return wake;
    });
  }

  // ---------- transcript (session_stop) ----------

  function stopTarget(call) {
    const direct = call?.input?.session_id;
    if (isText(direct)) return direct;
    try {
      const parsed = typeof call?.input_json === 'string' ? JSON.parse(call.input_json) : null;
      return isText(parsed?.session_id) ? parsed.session_id : null;
    } catch (_error) { return null; }
  }

  function stopEntries(ctx, sessionId) {
    const rows = asArray(ctx.run('transcript', () => peekMessages(sessionId), []));
    const results = new Map();
    for (const row of rows) {
      if (isRecord(row) && row.kind === 'tool_result' && isText(row.tool_result?.call_id)) results.set(row.tool_result.call_id, row);
    }
    const out = [];
    for (const row of rows) {
      const call = isRecord(row) && row.kind === 'tool_use' ? row.tool_call : null;
      if (!isRecord(call) || call.tool_name !== 'session_stop' || !isText(call.call_id)) continue;
      const target = stopTarget(call);
      const result = results.get(call.call_id)?.tool_result;
      const text = typeof result?.output_text === 'string' && target ? result.output_text.split(target).join('that chat') : result?.output_text;
      const resultState = isText(result?.approval_state) ? result.approval_state : null;
      out.push(entry({
        id: `stop:${call.call_id}`, kind: 'stop', at: isoOf(row.timestamp),
        status: (call.approval_state === 'pending' && resultState) || call.approval_state || resultState || null,
        title: ctx.chatTitle(target), detail: clip(text), session_id: target,
      }));
    }
    return out;
  }

  // ---------- controls ----------

  function controlEntries(ctx, state) {
    const out = [];
    for (const permission of asArray(state.permissions)) {
      if (!isRecord(permission) || !isText(permission.permission_id)) continue;
      const every = permission.project_id === '*';
      const found = isRecord(permission.project) ? permission.project : ctx.project(permission.project_id);
      const base = {
        title: every ? EVERY_PROJECT : clip(found?.name) || UNKNOWN_PROJECT,
        detail: asArray(permission.run_modes).length ? permission.run_modes.join(', ') : null,
        project: every || !isText(found?.id) ? null : { id: found.id, name: clip(found.name) },
        permission_id: permission.permission_id,
      };
      out.push(entry({ id: `perm:${permission.permission_id}:granted`, kind: 'permission_granted', at: isoOf(permission.created_at), ...base }));
      if (permission.revoked_at) {
        out.push(entry({ id: `perm:${permission.permission_id}:revoked`, kind: 'permission_revoked', at: isoOf(permission.revoked_at), ...base }));
      }
    }
    for (const row of asArray(state.history)) {
      if (!isRecord(row) || !HISTORY_KINDS.has(row.kind)) continue;
      out.push(entry({ id: `hist:${row.kind}:${row.at}`, kind: row.kind, at: isoOf(row.at) }));
    }
    return out;
  }

  function collect(ctx, sessionId) {
    const all = [];
    const mail = loadMail(ctx, sessionId);
    if (mail) all.push(...mailEntries(ctx, mail));
    const proposals = loadProposals(ctx, sessionId);
    if (proposals) all.push(...proposalEntries(ctx, proposals));
    all.push(...wakeEntries(ctx, sessionId));
    all.push(...stopEntries(ctx, sessionId));
    const state = loadControls(ctx);
    if (state) all.push(...controlEntries(ctx, state));
    return all;
  }

  function list({ limit = DEFAULT_LIMIT, before = null } = {}) {
    const checked = gate();
    if (!checked.ok) return checked;
    const ctx = session();
    const max = clampLimit(limit);
    const beforeMs = before === null || before === undefined ? null : timeMs(before);
    const unique = new Map();
    for (const item of collect(ctx, checked.sessionId)) {
      if (item.at === null || unique.has(item.id)) continue;
      if (beforeMs !== null && !(timeMs(item.at) < beforeMs)) continue;
      unique.set(item.id, item);
    }
    const ordered = [...unique.values()].sort((a, b) => timeMs(b.at) - timeMs(a.at) || (a.id < b.id ? 1 : -1));
    const entries = ordered.slice(0, max).map((item) => {
      const { resolve, ...rest } = item;
      if (typeof resolve === 'function') resolve();
      return { ...rest, title: item.title };
    });
    return { ok: true, schema_version: 1, session_id: checked.sessionId, entries, truncated: ordered.length > max };
  }

  // ---------- permissions ----------

  function messageGrantLive(auth) {
    if (auth.revoked_at || !(auth.remaining_sends > 0)) return false;
    const expires = timeMs(auth.expires_at);
    return expires === null || expires > nowMs();
  }

  function permissions() {
    const checked = gate();
    if (!checked.ok) return checked;
    const ctx = session();
    const state = loadControls(ctx);
    const launch = asArray(state?.permissions).filter(isRecord).map((permission) => ({
      ...permission,
      project: isRecord(permission.project) ? permission.project : ctx.project(permission.project_id),
    }));
    const mail = loadMail(ctx, checked.sessionId);
    const byCreated = (a, b) => (timeMs(b.created_at) ?? 0) - (timeMs(a.created_at) ?? 0);
    const messageGrants = asArray(mail?.authorizations)
      .filter((auth) => isRecord(auth) && auth.kind === 'agent_directional' && isText(auth.authorization_id))
      .sort(byCreated)
      .map((auth) => ({
        grant_id: auth.authorization_id,
        destination: { session_id: auth.destination_session_id ?? null, title: ctx.chatTitle(auth.destination_session_id) },
        purpose: clip(auth.purpose), created_at: auth.created_at ?? null, expires_at: auth.expires_at ?? null,
        remaining_sends: auth.remaining_sends ?? 0, revoked_at: auth.revoked_at ?? null, live: messageGrantLive(auth),
      }));
    const proposals = loadProposals(ctx, checked.sessionId);
    const turnGrants = asArray(proposals?.launch_grants)
      .filter((grant) => isRecord(grant) && !isStanding(grant) && isText(grant.authorization_ref))
      .sort(byCreated)
      .map((grant) => ({
        authorization_ref: grant.authorization_ref, destination_project_ids: asArray(grant.destination_project_ids),
        created_at: grant.created_at ?? null, expires_at: grant.expires_at ?? null, remaining: grant.remaining ?? 0,
        revoked_at: grant.revoked_at ?? null, live: launchStatus(grant) === 'live',
      }));
    return { ok: true, schema_version: 1, launch, message_grants: messageGrants, turn_grants: turnGrants };
  }

  return { list, permissions };
}

module.exports = { createPrimaryActivityLog, PREVIEW_CODE_POINTS };
