/* Team tab: the pure adapter from a shared conversation's host messages to the local chat's message shape (row 171).
 * The transcript popover (renderer-team-turn-pop.js) draws one turn with the local chat's own row chain; the host's
 * messages come from other machines, so they reach that chain only through this whitelist. Every message is rebuilt
 * from a fixed set of fields (copies, never the input objects); everything else is dropped.
 *
 * Fields the chain reads to draw local-desktop affordances, dropped here (where the chain reads them):
 * - `tool_result.metadata`: path chips, row summaries, calendar, notes, memory and message receipts, test summaries,
 *   image provenance (renderer-turn-row-tool-render-utils.js buildToolCallRowMarkup, from about line 266; the
 *   projector's cloneSubagentReportMetadata in renderer-turn-tree-projector.js about line 472). Row 175: a write_file or
 *   edit_file result gets `metadata.diff` built here from its call's own input (never copied from the host), so the local
 *   diff row draws the change; see `changeOf`.
 * - `tool_result.generated_artifacts`: artifact teasers and image figures (tool render utils buildResultArtifactsMarkup;
 *   projector about line 473). `tool_result.trusted_attachment_refs`: inline images (tool-call-utils
 *   getTrustedToolResultImages; projector about line 475).
 * - `tool_call.user_questions`, `question_ref`: question cards (renderer-turn-row-render-utils.js buildToolCallMessage
 *   and renderer-turn-row-interactive-cards.js). `tool_call.approval_state`, `policy_*`, `reason`, `one_off_only`:
 *   approval cards and receipts (projector, kind 'tool_use', about line 341). `approval_state` is always 'none'.
 * - `attachments`: attachment chips under the prompt (projector user_prompt, about line 951; bubble utils).
 * - `recovery_actions`, `next_action`, `recovery_*`, `retryable`, `stream_error`, `error_code` on a message: the error
 *   recovery card with its actions (projector assistant_error; render utils buildErrorCodeNoticeMarkup).
 *   Row 175: a failed turn's reason is not read here; renderer-team-project-timeline.js `failureReason` maps the raw host
 *   message's code to one fixed group, so no code or error text reaches the chain.
 * - `resumable_stop`: the resume button (render utils buildAssistantTextRowMarkup). `agent_status`,
 *   `agent_status_steps`, `agent_progress_snapshot`: local status notices (projector). Row 175: `context_compacted` is
 *   kept as five bounded fields (`compactedOf`) so the popover draws its one fixed line; the summary text is never kept.
 * - `interactive_batch`, `interactive_round_recap`, `plan_object`, `plan_document`, `author` and any other field.
 *   Row 175 item 7: a `plan_document` message never reaches the chain (its edit hooks and buttons are the local chat's); `planOf` keeps
 *   it as a bounded whitelist for the Team's own read-only plan row (renderer-team-project-plan.js).
 * The chain also draws affordances from fields the popover must keep (the input's path, a report_findings output):
 * the popover removes those from the rendered markup (renderer-team-turn-pop.js `sweepAffordances`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamTurnAdapter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({ content: 256 * 1024, output: 64 * 1024, inputJson: 64 * 1024, summary: 600, entry: 64 * 1024,
    entries: 128, id: 200, depth: 8, list: 512 });
  // Row 175: the most input text of one write_file / edit_file call and the most lines of its change the popover draws.
  const DIFF = Object.freeze({ chars: 64 * 1024, lines: 400, edits: 20, path: 512 });
  const DIFF_TOOLS = new Set(['write_file', 'edit_file']);
  const MAX_COUNT = Number.MAX_SAFE_INTEGER;
  // Kinds the projector turns into question, approval, plan, suggestion or local-command cards (renderer-turn-tree-projector.js
  // about lines 263-334: question_batch, plan_proposal, plan_document, interactive_round_recap, proactive_suggestion,
  // slash_command_output; memory_note is never a row). The Team draws its questions and approvals with its own builders.
  const DROPPED_KINDS = new Set(['question_batch', 'plan_document', 'plan_proposal', 'interactive_round_recap',
    'proactive_suggestion', 'slash_command_output', 'memory_note', 'plan_object']);
  const ROLES = new Set(['user', 'assistant', 'tool']);
  // Removed at any depth of a copied structure (turn_events, phases, visible_segments, tool_steps).
  const STRIPPED_KEYS = new Set(['metadata', 'generated_artifacts', 'artifacts', 'attachments', 'review_findings',
    '__proto__', 'constructor', 'prototype']);
  // eslint-disable-next-line no-control-regex -- control, bidi and zero-width characters are exactly what this removes.
  const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u200b-\u200d\ufeff]/g;

  const str = (v) => (typeof v === 'string' ? v : '');
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const cut = (text, max) => (text.length <= max ? text : Array.from(text).slice(0, max).join(''));

  // Text that names something (a tool, a status): invisible and directional characters out, whitespace collapsed.
  function clean(value, max = 80) {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return cut(text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(), max).trim();
  }
  const id = (v) => cut(str(v).trim(), LIMITS.id);

  // A bounded JSON-shaped copy without the stripped keys: no shared references, no prototype keys, no functions.
  function copy(value, depth = 0) {
    if (typeof value === 'string') return cut(value, LIMITS.content);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean' || value === null) return value;
    if (!value || typeof value !== 'object' || depth >= LIMITS.depth) return undefined;
    if (Array.isArray(value)) return value.slice(0, LIMITS.list).map((v) => copy(v, depth + 1)).filter((v) => v !== undefined);
    const out = {};
    for (const key of Object.keys(value)) {
      if (STRIPPED_KEYS.has(key)) continue;
      const next = copy(value[key], depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  const copyList = (value) => (Array.isArray(value) ? copy(value) : undefined);

  function reasoningOf(value) {
    const r = obj(value);
    if (!Array.isArray(r.entries)) return undefined;
    const entries = r.entries.slice(0, LIMITS.entries)
      .map((e, i) => ({ id: id(obj(e).id) || 'entry-' + i, text: cut(str(obj(e).text), LIMITS.entry) }))
      .filter((e) => e.text);
    return { source: clean(r.source, 40), entries };
  }

  function inputOf(json) {
    if (!json.trim().startsWith('{')) return {};
    try {
      const parsed = JSON.parse(json);
      return isPlain(parsed) ? copy(parsed) : {};
    } catch (_error) {
      return {};
    }
  }

  // `shrunk`: the path of a change too long to draw. Its call then carries the path alone, so the row's arguments do not
  // print the text the diff row declined to show.
  function toolCallOf(value, shrunk) {
    const c = obj(value);
    const inputJson = shrunk ? JSON.stringify({ path: shrunk }) : cut(str(c.input_json), LIMITS.inputJson);
    return { call_id: id(c.call_id), tool_name: clean(c.tool_name, 80), input: shrunk ? { path: shrunk } : inputOf(inputJson), input_json: inputJson,
      status: clean(c.status, 40), summary: clean(c.summary, LIMITS.summary), approval_state: 'none' };
  }

  function toolResultOf(value, calls) {
    const r = obj(value);
    const out = { call_id: id(r.call_id), tool_name: clean(r.tool_name, 80), output_text: cut(str(r.output_text), LIMITS.output),
      is_error: r.is_error === true, error_code: clean(r.error_code, 64) };
    if (typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms) && r.duration_ms >= 0) out.duration_ms = r.duration_ms;
    const change = out.call_id && !out.is_error && calls ? calls.get(out.call_id) : null;
    return change ? { ...out, metadata: { diff: change } } : out;
  }

  // ---------------------------------------------------------- Jenny's edits as diffs (row 175, item 3)

  // The lines of a text as a diff reads them: no empty last line for a final newline, no carriage return.
  function textLines(text) {
    const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  const hunkOf = (before, after, start) => {
    const old = textLines(before);
    const next = textLines(after);
    return { oldStart: start, oldLines: old.length, newStart: 1, newLines: next.length, lines: old.map((l) => '-' + l).concat(next.map((l) => '+' + l)) };
  };
  const isEdit = (e) => isPlain(e) && typeof e.old_string === 'string' && e.old_string !== '' && typeof e.new_string === 'string';
  // The [before, after] texts the call changes: write_file's content as a new file, edit_file's strings (one, or `edits`).
  function sidesOf(tool, input) {
    if (tool === 'write_file') return typeof input.content === 'string' ? [['', input.content]] : null;
    const edits = Array.isArray(input.edits) ? input.edits.slice(0, DIFF.edits) : [input];
    const valid = edits.filter(isEdit).map((e) => [e.old_string, e.new_string]);
    return valid.length ? valid : null;
  }
  function parseInput(json) {
    if (json.length > LIMITS.content || !json.trim().startsWith('{')) return null;
    try {
      const parsed = JSON.parse(json);
      return isPlain(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  /** The `metadata.diff` of a write_file / edit_file call from its own input_json: hunks of text, a path-only `truncated`
   * diff when the change is over 64 KiB of text or 400 lines, null when there is nothing to draw. The host's metadata is not read. */
  function changeOf(tool, json) {
    const input = parseInput(json);
    const path = input ? clean(str(input.path) || str(input.file_path), DIFF.path) : '';
    const sides = path ? sidesOf(tool, input) : null;
    if (!sides) return null;
    const chars = sides.reduce((n, [before, after]) => n + before.length + after.length, 0);
    const start = tool === 'write_file' ? 0 : 1;
    const hunks = chars > DIFF.chars ? [] : sides.map(([before, after]) => hunkOf(before, after, start));
    const lines = hunks.reduce((n, h) => n + h.lines.length, 0);
    if (chars > DIFF.chars || lines > DIFF.lines) return { path, truncated: true, truncation_reason: 'line_limit' };
    const drawn = hunks.filter((h) => h.lines.length);
    const tally = (mark) => drawn.reduce((n, h) => n + h.lines.filter((l) => l.startsWith(mark)).length, 0);
    return { path, additions: tally('+'), deletions: tally('-'), hunks: drawn };
  }
  // call id -> the change of each write_file / edit_file call, so its result (a later message) can carry it.
  function changesOf(list) {
    const calls = new Map();
    for (const m of list) {
      const c = obj(obj(m).tool_call);
      const tool = clean(c.tool_name, 80);
      const callId = id(c.call_id);
      if (callId && obj(m).role === 'assistant' && DIFF_TOOLS.has(tool)) {
        const change = changeOf(tool, str(c.input_json));
        if (change) calls.set(callId, change);
      }
    }
    return calls;
  }

  // ---------------------------------------------------------- a compaction notice (row 175, F14)

  const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_COUNT, Math.max(0, Math.floor(v))) : 0);
  /** A host `context_compacted` as five bounded fields (the chain dedupes and orders by them), or null; the summary is dropped. */
  function compactedOf(value) {
    if (!isPlain(value)) return null;
    return { strategy: clean(value.strategy, 40), tokensBefore: count(value.tokensBefore), tokensAfter: count(value.tokensAfter),
      phase: clean(value.phase, 40), occurredAt: clean(value.occurredAt, 64) };
  }

  // The path of this call's change when it is too long to draw ('' otherwise).
  function shrunkPath(calls, call) {
    const change = calls ? calls.get(id(obj(call).call_id)) : null;
    return change && change.truncated ? change.path : '';
  }

  // One host message to the local shape, or null when its role or kind does not belong in the popover.
  function localMessage(message, calls) {
    const m = obj(message);
    const role = str(m.role);
    const said = clean(m.kind, 40).toLowerCase();
    // A host may save Jenny's words as kind 'message'; the chain draws an assistant kind it does not know as a notice.
    const kind = role === 'assistant' && said === 'message' ? '' : said;
    if (!ROLES.has(role) || DROPPED_KINDS.has(kind)) return null;
    const out = { id: id(m.id), role, kind, content: cut(str(m.content), LIMITS.content), status: clean(m.status, 40),
      terminal_subcode: clean(m.terminal_subcode, 64), timestamp: cut(str(m.timestamp), 64), turn_id: id(m.turn_id),
      parent_stream_id: id(m.parent_stream_id) };
    if (Number.isInteger(m.event_seq) && m.event_seq >= 0) out.event_seq = m.event_seq;
    const finalized = cut(str(m.finalized_at) || str(m.finalizedAt), 64);
    if (finalized) { out.finalized_at = finalized; out.finalizedAt = finalized; }
    const reasoning = reasoningOf(m.reasoning);
    if (reasoning) out.reasoning = reasoning;
    for (const key of ['phases', 'visible_segments', 'tool_steps', 'turn_events']) {
      const list = copyList(m[key]);
      if (list) out[key] = list;
    }
    if (isPlain(m.tool_call)) out.tool_call = toolCallOf(m.tool_call, shrunkPath(calls, m.tool_call));
    if (isPlain(m.tool_result)) out.tool_result = toolResultOf(m.tool_result, calls);
    const compacted = compactedOf(m.context_compacted);
    if (compacted) out.context_compacted = compacted;
    return out;
  }

  // ---------------------------------------------------------- a plan document (row 175, item 7)

  // Text with invisible and directional characters out, newlines kept, cut and trimmed.
  const plainText = (v, max) => cut(str(v).replace(INVISIBLE, ''), max).trim();
  const PLAN_STATES = new Set(['pending', 'approved', 'approved_auto', 'accepted', 'rejected', 'abandoned', 'superseded']);
  /** A host `plan_document` message as { id, turn_id, plan } with bounded text fields only, or null for any other message. */
  function planOf(message) {
    const m = obj(message);
    if (clean(m.kind, 40).toLowerCase() !== 'plan_document' || !isPlain(m.plan_document)) return null;
    const p = m.plan_document;
    const list = (v, n, max, one) => (Array.isArray(v) ? v.slice(0, 100).map((x) => plainText(one(x), max)).filter(Boolean).slice(0, n) : []);
    const state = clean(p.transition || p.state || p.status, 40).toLowerCase();
    return { id: id(m.id), turn_id: id(m.turn_id), plan: { plan_id: id(p.plan_id), tool_call_id: id(p.tool_call_id), approval_id: id(p.approval_id),
      title: plainText(p.title || p.summary, 120), summary: plainText(p.summary, 1200), steps: list(p.steps, 20, 300, (x) => (typeof x === 'string' ? x : obj(x).summary)),
      notes: plainText(p.notes, 4000), verification: plainText(typeof p.verification === 'string' ? p.verification : obj(p.verification).summary, 1200),
      feedback: plainText(p.feedback, 800), plan_edited: p.plan_edited === true, files_read: list(p.files_read, 20, 300, (x) => x),
      state: PLAN_STATES.has(state) ? state : 'pending', decided_by: id(p.decided_by), decided_at: clean(p.decided_at, 64) } };
  }

  /** The host messages of ONE turn (the prompt first when known) to new local-shape messages. Never mutates its input. */
  function toLocalMessages(turnMessages) {
    const list = Array.isArray(turnMessages) ? turnMessages : [];
    const calls = changesOf(list);
    return list.map((message) => localMessage(message, calls)).filter(Boolean);
  }

  /** The event_seq a message placed after every saved one takes: the highest saved + 1, 0 with nothing saved, undefined
   * when messages are saved but none carries one (the chain then orders by position, which is last). */
  function nextEventSeq(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const seqs = list.map((m) => obj(m).event_seq).filter((n) => Number.isInteger(n) && n >= 0);
    if (seqs.length) return seqs.reduce((a, b) => (b > a ? b : a)) + 1;
    return list.length ? undefined : 0;
  }

  /** A running tool call with no saved tool_use message yet, as a synthetic running tool_use message (ids 'live-tool-<call id>'). */
  function liveToolMessages(tools, savedCallIds, turnId, firstSeq) {
    const skip = new Set(Array.from(savedCallIds || [], id));
    const out = [];
    for (const tool of Array.isArray(tools) ? tools : []) {
      const callId = id(obj(tool).id);
      if (obj(tool).state !== 'running' || !callId || skip.has(callId)) continue;
      skip.add(callId);
      const message = { id: 'live-tool-' + callId, role: 'assistant', kind: 'tool_use', content: '', status: '', turn_id: id(turnId),
        tool_call: toolCallOf({ call_id: callId, tool_name: obj(tool).name, status: 'running' }) };
      if (Number.isInteger(firstSeq)) message.event_seq = firstSeq + out.length;
      out.push(message);
    }
    return out;
  }

  // The tail's status by how the stream ended: streaming while it has not.
  const TAIL_STATUS = Object.freeze({ complete: 'complete', error: 'error', failed: 'error', cancelled: 'cancelled', canceled: 'cancelled' });

  /** The running turn's words and reasoning not yet saved, as one synthetic assistant message, or null when none is left.
   * `savedTextLength`: how much of `stream.text` the saved segments cover; `savedReasoningIds`: the live reasoning entries
   * (by id) already saved. `saved`: the turn's saved local messages, so the tail sorts after them (`eventSeq` overrides).
   * `compacted`: compaction events the saved messages do not hold yet; the tail then carries the notice even with no words. */
  function liveMessage({ stream, turnId, model, saved, savedTextLength = 0, savedReasoningIds = [], eventSeq, compacted = 0 } = {}) {
    const s = obj(stream);
    const from = Number.isInteger(savedTextLength) && savedTextLength > 0 ? savedTextLength : 0;
    const content = cut(str(s.text).slice(from).replace(/^\s+/, ''), LIMITS.content);
    const skip = new Set(Array.from(savedReasoningIds || []));
    const entries = (Array.isArray(s.reasoning) ? s.reasoning : [])
      .filter((e) => !skip.has(obj(e).id))
      .map((e, i) => ({ id: id(obj(e).id) || 'live-reasoning-' + i, text: cut(str(obj(e).text), LIMITS.entry) }))
      .filter((e) => e.text.trim()).slice(-LIMITS.entries);
    const noted = Number.isSafeInteger(compacted) && compacted > 0;
    if (!content.trim() && !entries.length && !noted) return null;
    const out = { id: 'live-' + id(s.id), role: 'assistant', kind: '', content, status: TAIL_STATUS[str(s.ended)] || (s.ended ? 'complete' : 'streaming'), turn_id: id(turnId) };
    const seq = Number.isInteger(eventSeq) ? eventSeq : Array.isArray(saved) ? nextEventSeq(saved) : undefined;
    if (Number.isInteger(seq)) out.event_seq = seq;
    if (entries.length) out.reasoning = { source: 'provider', entries };
    if (noted) out.context_compacted = { strategy: 'live', tokensBefore: 0, tokensAfter: 0, phase: '', occurredAt: 'live' };
    const modelName = clean(model, 64);
    if (modelName) out.model_used = modelName;
    return out;
  }

  return { toLocalMessages, planOf, liveMessage, liveToolMessages, nextEventSeq, clean, DROPPED_KINDS, STRIPPED_KEYS, LIMITS };
});
