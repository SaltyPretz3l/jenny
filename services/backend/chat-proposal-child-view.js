'use strict';

/* services/backend/chat-proposal-child-view.js - the live state of a New session proposal's child chat
 * (F3b, 2026-10-27). Derived per read from the child's summary, active turn, newest work row and newest
 * rows; never persisted, so the proposal record and its schema stay as they are. The card follows the
 * child through running, waiting, reported, stopped and failed instead of saying "Started" at admission.
 *
 * The tracker maps each child chat to its source chat, so the child's lifecycle events (a turn starts,
 * an approval is asked or resolved, a turn ends) refresh the source chat's cards. Token deltas never do.
 */

const { sessionStatus } = require('../session-directory-scope');
const { isTerminalChatStreamType } = require('../chat-stream-bridge-support');
const { isModelBusyRecoveryRow } = require('./chat-error-recovery');

const ROW_SCAN = 50;
const CHILD_STATES = new Set(['child_created', 'admitted', 'succeeded']);
const RUN_MODES = new Set(['ask', 'auto', 'plan', 'propose']);
const APPROVAL_EVENTS = new Set(['tool_approval_requested', 'tool_approval_needed', 'tool_approval_resolved']);
const ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
// A turn the person stopped, denied or that was interrupted ended on purpose: Stopped, never a failure with Retry.
const STOPPED_TERMINALS = new Set(['cancelled', 'denied', 'interrupted', 'preempted']);
const MAX_TRACKED = 256;

const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

function runMode(summary) {
  if (summary.plan_mode === true) return 'plan';
  const mode = text(summary.run_mode).toLowerCase();
  return RUN_MODES.has(mode) ? mode : '';
}

// Newest first: the newest assistant row and the newest row's turn, within the bounded scan.
function newestRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let assistant = null;
  let newestTurnId = '';
  for (let i = list.length - 1; i >= 0 && i >= list.length - ROW_SCAN; i -= 1) {
    const row = list[i];
    if (!newestTurnId && typeof row?.turn_id === 'string') newestTurnId = row.turn_id;
    if (!assistant && row?.role === 'assistant') assistant = row;
    if (assistant && newestTurnId) break;
  }
  return { assistant, newestTurnId };
}

function errorClass(code, row) {
  if (isModelBusyRecoveryRow(row)) return 'model_busy';
  if (/^CMP-(AI|ENGINE|NET)-/u.test(code)) return 'engine';
  return 'generic';
}

const failedRow = (row) => Boolean(row && (row.stream_error || row.kind === 'assistant_error' || row.error_code
  || row.terminal_report_outcome === 'failed'));

// The newest turn ended on the person's Deny (as the session directory reads a denied failure).
function deniedTurn(rows, turnId) {
  if (!turnId) return false;
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0 && i >= list.length - ROW_SCAN; i -= 1) {
    const row = list[i];
    if (row?.turn_id !== turnId) continue;
    if (row.status === 'denied' || row.tool_call?.approval_state === 'denied' || row.tool_result?.approval_state === 'denied') return true;
  }
  return false;
}

function settledPhase({ work, assistant, probe, rows, newestTurnId }) {
  if (work?.status === 'cancelled' || STOPPED_TERMINALS.has(text(assistant?.terminal_status).toLowerCase())) return 'cancelled';
  if (work?.status === 'failed' && deniedTurn(rows, text(work.turn_id) || newestTurnId)) return 'cancelled';
  if (work?.status === 'failed' || failedRow(assistant)) return 'failed';
  if (!assistant) return work ? 'reported' : 'starting';
  if (typeof assistant.resumable_stop === 'string' && assistant.resumable_stop) {
    // Between the stop and Jenny's automatic resume the child is idle for a moment: it still reads running.
    return probe?.pending === true ? 'running' : 'stopped';
  }
  return 'reported';
}

/** facts: {summary, activeTurn, work, approvalCount, rows, probe:{pending,count,max}, projectLabel,
 *  readReplyTurnId(): string, firstTurnId}. Pure apart from the lazy reply read (final phases only). */
function deriveChildView(facts = {}) {
  const summary = facts.summary;
  if (!summary) return withKey({ phase: 'gone' });
  const { work = null, activeTurn = null, probe = null } = facts;
  const { assistant, newestTurnId } = newestRows(facts.rows);
  let phase;
  if (summary.archived_at) phase = 'archived';
  else {
    const status = sessionStatus({ summary, activeTurn, work, approvalCount: facts.approvalCount || 0 });
    if (status === 'running' || status === 'queued') phase = 'running';
    else if (status.startsWith('waiting_')) phase = 'waiting';
    else if (status === 'needs_attention') phase = 'attention';
    else phase = settledPhase({ work, assistant, probe, rows: facts.rows, newestTurnId });
  }
  const view = {
    phase,
    model: text(summary.preferred_model) || text(summary.last_model_used),
    run_mode: runMode(summary),
    project_label: text(facts.projectLabel, 80),
    resume_count: Number.isSafeInteger(probe?.count) && probe.count > 0 ? probe.count : 0,
    resume_max: Number.isSafeInteger(probe?.max) && probe.max > 0 ? probe.max : 0,
    turn_started_at: phase === 'running' ? text(activeTurn?.started_at, 40) || null : null,
    error_code: null,
    error_class: null,
    failed_turn_is_first: false,
    retry: null,
    reply_turn_id: null,
  };
  if (phase === 'failed') {
    const code = text(assistant?.error_code || assistant?.terminal_report_error_code, 64);
    view.error_code = ERROR_CODE_RE.test(code) ? code : null;
    view.error_class = errorClass(view.error_code || '', assistant);
    const failedTurnId = text(work?.turn_id) || text(assistant?.turn_id);
    view.failed_turn_is_first = Boolean(failedTurnId) && failedTurnId === facts.firstTurnId;
    // Retry only the child's newest turn, through the child's own Retry turn (it targets the failed reply).
    const retryable = failedTurnId && failedTurnId === newestTurnId && assistant?.turn_id === failedTurnId;
    if (retryable && typeof assistant.id === 'string' && assistant.id) view.retry = { message_id: assistant.id };
  }
  if (phase === 'reported' || phase === 'stopped' || phase === 'failed') {
    let reply;
    try { reply = text(facts.readReplyTurnId?.(assistant?.terminal_report_message_id)); } catch { reply = ''; }
    view.reply_turn_id = reply || null;
  }
  return withKey(view);
}

// The renderer compares `key` to repaint a card whose record revision did not move.
function withKey(view) {
  return { ...view, key: JSON.stringify(view) };
}

/** readFacts(childId, sourceId) -> facts | null (null: unreadable, so the card keeps its plain receipt). */
function createChildTracker({ readFacts = () => null, changed = () => {} } = {}) {
  const parents = new Map(); // child session id -> source session id
  const turns = new Map(); // child session id -> its newest seen turn id

  function view(record) {
    if (record?.kind !== 'session' || record.decision?.choice !== 'new_session') return null;
    const childId = text(record.child_session_id, 256);
    if (!childId || !CHILD_STATES.has(record.action_state)) return null;
    boundedSet(parents, childId, record.source_session_id);
    let facts;
    try { facts = readFacts(childId, record.source_session_id); } catch { facts = null; }
    return facts ? deriveChildView({ ...facts, firstTurnId: record.first_turn_turn_id }) : null;
  }

  // A child turn's first event, an approval change or a terminal refreshes the source's cards; a source
  // turn's terminal does too (the wake turn that admitted the child's report gives "See the reply").
  // A chat can be both a child and the source of its own New session cards: both roles are checked.
  function onEvent(event) {
    const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : '';
    if (!sessionId) return;
    const terminal = isTerminalChatStreamType(event.type);
    const source = parents.get(sessionId);
    if (source) {
      const turnId = typeof event.turnId === 'string' ? event.turnId : '';
      const firstOfTurn = turnId && turns.get(sessionId) !== turnId;
      if (firstOfTurn) boundedSet(turns, sessionId, turnId);
      if (firstOfTurn || terminal || APPROVAL_EVENTS.has(event.type)) changed(source);
    }
    if (terminal && [...parents.values()].includes(sessionId)) changed(sessionId);
  }

  // Something outside the chat-stream changed a child (Jenny's automatic resume took its report).
  function touch(childId) {
    const source = parents.get(childId);
    if (source) changed(source);
  }

  return { view, onEvent, touch };
}

module.exports = { createChildTracker, deriveChildView };
