'use strict';

// The team's GPUs as this Jenny sees them (row 123 slice 4e; spec "4e as built"). For each team it
// holds the last GPU list: read with `team.node.list` when the team comes online and after its event
// stream resyncs, then replaced by every `team_pool_nodes` event; a list answer is dropped when an
// event arrived after its request was sent (the event is newer). The list reaches the renderer in
// the team state push (team-service.js `snapshot().pools`), never on a channel of its own. It also
// answers the owner's two pool calls (GPU use, the team model).
//
// Every host answer and event is untrusted: rebuilt field by field with the host's own bounds
// before it is kept or answered (owner decision E49's rule); one that fails is refused, never
// passed through. A row carries a node id, an owner's member id, a PC name, states, slot counts
// and model names: never a device id, a job, a lease, a prompt or a reply. Logs carry team ids
// and reason words only.

const { isId } = require('../../../server/team/ids');
const { isCleanText, isCount, isTeamModel } = require('../../../server/team/member-schema');
const { isNodeId } = require('../../../server/team/scheduler/state');
const { failureAnswer, invalidRequest } = require('../team-errors');
// A model name as a node registers it (the agent's own rule); the stored team model is the store's stricter rule.
const { isModelName: isModel } = require('./engine-forward');

const MAX_NODES = 64;
const MAX_MODELS = 64;
const MAX_SLOTS = 4;
const MAX_TOTALS = 64;
const MAX_ROWS = 50;
const INVALID = () => invalidRequest('team_answer_invalid');

const isBool = (value) => typeof value === 'boolean';
const nullOr = (test) => (value) => value === null || test(value);
const isSlot = (value, min) => Number.isSafeInteger(value) && value >= min && value <= MAX_SLOTS;
const isPositive = (value) => Number.isSafeInteger(value) && value > 0;

function checkedModel(entry) {
  if (!entry || typeof entry !== 'object' || !isModel(entry.name) || !nullOr(isPositive)(entry.context_length)
    || !isBool(entry.vision) || !isBool(entry.thinking)) return null;
  return { name: entry.name, context_length: entry.context_length, vision: entry.vision, thinking: entry.thinking };
}

function checkedNode(row) {
  if (!row || typeof row !== 'object' || !isNodeId(row.node_id)) return null;
  if (!isId('member', row.member_id) || !nullOr(isCleanText)(row.label ?? null)) return null;
  if (!isBool(row.online) || !isBool(row.paused) || !isSlot(row.slots, 1) || !isSlot(row.busy_slots, 0)) return null;
  if (row.owner_busy !== undefined && !isBool(row.owner_busy)) return null; // E76: an older host sends none
  if (!Array.isArray(row.models) || row.models.length > MAX_MODELS) return null;
  const models = row.models.map(checkedModel);
  if (models.some((entry) => entry === null)) return null;
  return { node_id: row.node_id, member_id: row.member_id, label: row.label ?? null, online: row.online, paused: row.paused,
    owner_busy: row.paused && row.owner_busy === true, busy_slots: row.busy_slots, slots: row.slots, models };
}

/** The GPU list of a `team.node.list` answer or a `team_pool_nodes` event, rebuilt; null when it fails a rule. */
function checkedList(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.nodes) || value.nodes.length > MAX_NODES) return null;
  const nodes = value.nodes.map(checkedNode);
  if (nodes.some((node) => node === null)) return null;
  const teamModel = value.team_model ?? null;
  const automatic = value.automatic_model ?? null;
  if (!nullOr(isTeamModel)(teamModel) || !nullOr(isModel)(automatic)) return null;
  return { nodes, team_model: teamModel, automatic_model: automatic };
}

/** The owner's GPU use answer, rebuilt; null when it fails a rule. */
function checkedUsage(value) {
  if (!value || !Array.isArray(value.totals) || value.totals.length > MAX_TOTALS) return null;
  if (!Array.isArray(value.rows) || value.rows.length > MAX_ROWS || !nullOr(isPositive)(value.next_cursor ?? null)) return null;
  const totals = [];
  for (const entry of value.totals) {
    if (!entry || !isId('member', entry.member_id) || !isCount(entry.requests) || !isCount(entry.tokens)) return null;
    totals.push({ member_id: entry.member_id, requests: entry.requests, tokens: entry.tokens });
  }
  const rows = [];
  for (const row of value.rows) {
    if (!row || !isPositive(row.seq) || !isCount(row.at) || !isId('member', row.member_id) || !isModel(row.model)) return null;
    if (!nullOr(isNodeId)(row.node_id) || !nullOr(isCount)(row.tokens)
      || !isCount(row.duration_ms) || !nullOr((id) => isId('member', id))(row.node_member_id ?? null)
      || !nullOr(isCleanText)(row.node_label ?? null)) return null;
    // R16-F03: `reported_by` names who reported the count: 'node' (the serving hardware) or null (unknown).
    rows.push({ seq: row.seq, at: row.at, member_id: row.member_id, model: row.model, tokens: row.tokens,
      duration_ms: row.duration_ms, node_member_id: row.node_member_id ?? null, node_label: row.node_label ?? null,
      reported_by: row.reported_by === 'node' ? 'node' : null });
  }
  return { totals, rows, next_cursor: value.next_cursor ?? null };
}

function createPoolView({ log = () => {}, onChange = () => {} } = {}) {
  const teams = new Map(); // team id -> { manager, unsubscribe, list, online, events }
  let stopped = false;
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const tell = () => { try { onChange(); } catch { say('WARN', 'team.pool.notify_failed'); } };

  function keep(teamId, entry, list) {
    if (teams.get(teamId) !== entry || stopped) return;
    if (JSON.stringify(list) === JSON.stringify(entry.list)) return;
    entry.list = list;
    tell();
  }

  // Reads the list once. A host with no pool answers no list (no GPUs); another failure keeps what was held.
  // An event that arrived while the answer was on its way is newer: the answer is not kept.
  async function refresh(teamId, entry) {
    const sentAt = entry.events;
    const answer = await entry.manager.command('team.node.list', {});
    if (entry.events !== sentAt) return entry.list ? { ok: true, ...entry.list } : failureAnswer(answer);
    if (answer?.ok !== true) {
      if (answer?.error?.reason === 'team_pool_unavailable') keep(teamId, entry, null);
      return failureAnswer(answer);
    }
    const list = checkedList(answer);
    if (!list) { say('WARN', 'team.pool.list_refused', { team_id: teamId }); return INVALID(); }
    keep(teamId, entry, list);
    return { ok: true, ...list };
  }

  function onEvent(teamId, entry, event) {
    if (event?.event_type === 'resync_required') { void refresh(teamId, entry); return; }
    if (event?.event_type !== 'team_pool_nodes') return;
    entry.events += 1;
    const list = checkedList(event);
    if (!list) { say('WARN', 'team.pool.event_refused', { team_id: teamId }); return; }
    keep(teamId, entry, list);
  }

  // A team's connection changed (team-service.js calls this on every manager change).
  function connectionChanged(teamId, manager) {
    if (stopped || !manager) return;
    let entry = teams.get(teamId);
    if (!entry || entry.manager !== manager) {
      if (entry) entry.unsubscribe();
      entry = { manager, unsubscribe: () => {}, list: null, online: false, events: 0 };
      teams.set(teamId, entry);
      const current = entry;
      current.unsubscribe = manager.onEvent((event) => onEvent(teamId, current, event));
    }
    let row;
    try { row = manager.snapshot(); } catch { row = null; }
    const online = row?.state === 'online' && row.member_state === 'active';
    if (online && !entry.online) void refresh(teamId, entry);
    if (!online && entry.list !== null && row?.state !== 'reconnecting' && row?.state !== 'connecting') keep(teamId, entry, null);
    entry.online = online;
  }

  function drop(teamId) {
    const entry = teams.get(teamId);
    if (!entry) return;
    entry.unsubscribe();
    teams.delete(teamId);
    tell();
  }

  async function call(method, value) {
    const entry = teams.get(value.team_id);
    if (!entry) return invalidRequest('team_not_found');
    if (method === 'gpuList') return refresh(value.team_id, entry);
    if (method === 'gpuUse') {
      const params = {};
      if (value.cursor !== undefined) params.cursor = value.cursor;
      if (value.limit !== undefined) params.limit = value.limit;
      const answer = await entry.manager.command('team.pool.usage', params);
      if (answer?.ok !== true) return failureAnswer(answer);
      const usage = checkedUsage(answer);
      return usage ? { ok: true, ...usage } : INVALID();
    }
    if (method === 'teamModelSet') {
      const answer = await entry.manager.command('team.pool.model.set', { model: value.model });
      return answer?.ok === true ? { ok: true } : failureAnswer(answer);
    }
    return invalidRequest();
  }

  return {
    connectionChanged, drop, call,
    // { team id: { nodes, team_model, automatic_model } } for every team with a list.
    snapshot() {
      const out = {};
      for (const [teamId, entry] of teams) if (entry.list) out[teamId] = entry.list;
      return out;
    },
    stopAll() { stopped = true; for (const entry of teams.values()) entry.unsubscribe(); teams.clear(); },
    resources: () => ({ teams: teams.size }),
  };
}

module.exports = { createPoolView };
