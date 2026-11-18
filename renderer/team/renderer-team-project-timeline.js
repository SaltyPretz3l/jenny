/* Team tab: the pure builders of a shared conversation (rows 169 and 171). Strings in, strings out: the channel's turns
 * (host messages grouped into one turn per saved `turn_id`), Jenny's working chip and the line it sits on, a pending
 * question card with its who-line, the "Show earlier messages" button and the empty state; plus the small reducers the
 * controller keeps its state with (the running turn from its stream events, live reasoning deltas, held messages merged
 * with a snapshot page) and the two DOM readers of the questions card (its answers, its lock). Everything is text from
 * another machine: cleaned of control, bidi and zero-width characters where it names a person, a model or a
 * tool, and escaped where it enters markup. A builder never throws on a missing or wrongly typed field. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../chat/renderer-user-questions-block'));
    return;
  }
  root.rendererTeamProjectTimeline = factory(root.rendererUserQuestionsBlock);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (questions) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // The inventory's button builder: the app's global, or under Node the module at first use (the app's `require` throws).
  let nodeButton;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || nodeButton || (nodeButton = require('../inventory/action-button')))(o);

  const LIMITS = Object.freeze({ held: 400, reasoning: 65536, entries: 128, preview: 120, status: 80, live: 256 * 1024, tools: 32 });
  const ENDS = new Set(['complete', 'error', 'cancelled', 'canceled', 'failed']);
  // eslint-disable-next-line no-control-regex -- control, bidi and zero-width characters are exactly what this removes.
  const INVISIBLE =/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u200b-\u200d\ufeff]/g;
  const ITERATION = /^Starting iteration \d+\/\d+/;
  // A saved answer with no words that did not end well, by the host's message status.
  const FAILED = new Set(['runtime_error', 'error', 'failed', 'timeout', 'interrupted', 'incomplete']);
  const STOPPED = new Set(['cancelled', 'canceled', 'stopped']);

  const str = (v) => (typeof v === 'string' ? v : '');
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const cut = (text, max) => (text.length <= max ? text : Array.from(text).slice(0, max).join(''));
  const esc = (v) => escapeHtml(str(v));

  // Text from the host: invisible and directional characters out, whitespace collapsed, cut by code point.
  function clean(value, max = 80) {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return cut(text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(), max).trim();
  }
  function elapsedText(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    const total = Math.max(0, Math.floor(ms / 1000));
    return total < 60 ? total + 's' : Math.floor(total / 60) + 'm ' + String(total % 60).padStart(2, '0') + 's';
  }

  // ------------------------------------------------------------ why a turn failed (row 175 F4), compaction (F14)

  // A failed turn's reason is one of these groups, chosen from a code the host sent (lower-cased, [a-z0-9_.-], at most 64);
  // the codes are the host's own (the scheduler's job reasons, the pool's refusals, the terminal subcodes and the CMP-AI/STREAM
  // registry). A code with no row here shows no reason: nothing of the error itself ever reaches the page.
  const REASON_CODES = Object.freeze({
    timeout: ['timeout', 'turn', 'first_byte_timeout', 'job_timeout', 'stall_timeout', 'queue_timeout', 'wait_timeout', 'cmp-sidecar-0001'],
    node_lost: ['node_lost', 'node_stopped', 'node_fail', 'stream_incomplete', 'cmp-stream-incomplete'],
    pool_busy: ['pool_busy', 'no_eligible_node', 'cmp-ai-0003'],
    unavailable: ['unavailable', 'team_pool_unavailable', 'model_unavailable', 'conversation_model_offline', 'allowed_nodes_unavailable',
      'model_not_in_pool', 'team_model_not_offered', 'host_unavailable', 'cmp-ai-0002'],
    cancelled: ['cancelled', 'canceled', 'lease_cancelled', 'service_stop', 'app_shutdown', 'dispose', 'handoff_deadline'],
    context_too_long: ['context_overflow', 'context_too_long', 'context_length_exceeded', 'job_request_too_large', 'size_bound'],
    model_error: ['model_error', 'provider_error', 'cmp-stream-reasoning-only'],
  });
  const REASON_OF = new Map(Object.entries(REASON_CODES).flatMap(([group, codes]) => codes.map((code) => [code, group])));
  const REASON_PATTERN = /^[a-z0-9_.-]{1,64}$/;
  // Where a code may sit on a stream end or a saved answer, most specific first.
  const REASON_FIELDS = ['error_code', 'terminal_subcode', 'cancel_reason', 'reason', 'category', 'status'];
  const REASON_COPY = Object.freeze({
    timeout: () => jt('team.turn.why.timeout', 'It took too long to answer.'),
    node_lost: () => jt('team.turn.why.nodeLost', 'The member sharing the model went offline.'),
    pool_busy: () => jt('team.turn.why.poolBusy', 'Every shared model was busy.'),
    unavailable: () => jt('team.turn.why.unavailable', 'No shared model was available.'),
    cancelled: () => jt('team.turn.why.cancelled', 'The host stopped this turn.'),
    context_too_long: () => jt('team.turn.why.contextTooLong', 'The conversation is too long for this model.'),
    model_error: () => jt('team.turn.why.modelError', 'The model returned an error.'),
  });
  const MAX_COMPACTIONS = 20;
  const MAX_COMPACT_LINES = 5;

  /** The reason group ('timeout', 'node_lost', ...) a host stream end or saved answer names, or '' when it names none we know. */
  function failureReason(source) {
    const e = obj(source);
    for (const field of REASON_FIELDS) {
      const code = typeof e[field] === 'string' ? e[field].toLowerCase() : '';
      const group = REASON_PATTERN.test(code) ? REASON_OF.get(code) : '';
      if (group) return group;
    }
    return '';
  }
  /** The fixed sentence for a reason group, or '' for anything else. */
  function reasonText(group) {
    return typeof group === 'string' && Object.hasOwn(REASON_COPY, group) ? REASON_COPY[group]() : '';
  }

  const isNote = (n) => Boolean(n) && typeof n === 'object' && !Array.isArray(n);
  const noteKey = (n) => [clean(n.occurredAt, 64), Number(n.tokensBefore) || 0, Number(n.tokensAfter) || 0, clean(n.strategy, 40)].join('|');
  /** How many distinct compactions the saved messages hold (a message's `context_compacted` and its `context_compactions`). */
  function compactionCount(messages) {
    const seen = new Set();
    for (const m of Array.isArray(messages) ? messages : []) {
      const message = obj(m);
      const notes = [message.context_compacted].concat(Array.isArray(message.context_compactions) ? message.context_compactions : []);
      for (const n of notes) if (isNote(n)) seen.add(noteKey(n));
    }
    return Math.min(seen.size, MAX_COMPACTIONS);
  }
  /** One quiet line per compaction (at most five), trusted markup. */
  function compactionLinesHtml(count) {
    const n = Number.isSafeInteger(count) && count > 0 ? Math.min(count, MAX_COMPACT_LINES) : 0;
    const line = '<p class="team-turn-compact" role="note" dir="auto">'
      + escapeHtml(jt('team.turn.compacted', 'Jenny summarised earlier turns to make room. Older details may be forgotten.')) + '</p>';
    return line.repeat(n);
  }

  // ------------------------------------------------------------ reducers

  // A string, a list of { text } entries (the live wire), or a saved message's { source, entries } (the host's shape).
  function reasoningText(value) {
    const list = Array.isArray(value) ? value : Array.isArray(obj(value).entries) ? obj(value).entries : null;
    const text = typeof value === 'string' ? value
      : list ? list.map((e) => str(obj(e).text)).filter(Boolean).join('\n\n') : '';
    return cut(text.trim(), LIMITS.reasoning);
  }
  function nextText(known, entry) {
    if (typeof entry.text === 'string') return entry.text;
    if (known === undefined) return entry.append;
    const base = entry.base_length;
    return (typeof base === 'number' && base >= 0 && base < known.length ? known.slice(0, base) : known) + entry.append;
  }
  // The live reasoning of a running turn: `wire` entries are full { id, text } or deltas { id, append, base_length }.
  function applyReasoning(list, wire) {
    const out = (Array.isArray(list) ? list : []).map((e) => ({ id: e.id, text: e.text }));
    for (const raw of Array.isArray(wire) ? wire : []) {
      const entry = obj(raw);
      if (typeof entry.id !== 'string' || !entry.id || (typeof entry.text !== 'string' && typeof entry.append !== 'string')) continue;
      const at = out.findIndex((e) => e.id === entry.id);
      const text = cut(nextText(at < 0 ? undefined : out[at].text, entry), LIMITS.reasoning);
      if (at < 0) out.push({ id: entry.id, text }); else out[at] = { id: entry.id, text };
    }
    return out.slice(-LIMITS.entries);
  }
  // `page` is the newer window (a snapshot's messages). No overlap with a non-empty held list is a gap: page only.
  function mergeMessages(held, page, cap = LIMITS.held) {
    const old = (Array.isArray(held) ? held : []).filter((m) => typeof obj(m).id === 'string');
    const next = Array.isArray(page) ? page : [];
    const pageIds = new Set(next.map((m) => obj(m).id).filter((id) => typeof id === 'string'));
    const first = old.findIndex((m) => pageIds.has(m.id));
    let messages = next;
    let dropped = old.length > 0;
    if (!next.length) { messages = old; dropped = false; } else if (!old.length) dropped = false;
    else if (first >= 0) { messages = old.slice(0, first).concat(next); dropped = false; }
    if (messages.length > cap) { messages = messages.slice(-cap); dropped = true; }
    return { messages: messages.slice(), dropped };
  }

  // ------------------------------------------------------------ the running turn

  // The running turn as the controller holds it. The times are the controller's clock: when the turn started here, when
  // its first reasoning and its first words arrived, when it ended.
  function startStream(id, now) {
    return { id: str(id), text: '', reasoning: [], status: '', tools: [], ended: '', startedAt: now, reasonedAt: 0, reasonLastAt: 0, textAt: 0, endedAt: 0 };
  }
  function toolsAfter(tools, e) {
    const id = str(e.call_id);
    const state = e.type === 'tool_use' ? 'running' : (e.status === 'error' || e.status === 'failed' ? 'failed' : 'done');
    const known = id ? tools.findIndex((t) => t.id === id) : -1;
    const next = known < 0 ? tools.concat({ id, name: str(e.tool_name), state }) : tools.map((t, i) => (i === known ? { ...t, state } : t));
    return next.slice(-LIMITS.tools);
  }
  function textAfter(stream, e) {
    if (typeof e.aggregate === 'string') return e.aggregate.slice(0, LIMITS.live);
    return typeof e.content === 'string' && stream.text.length < LIMITS.live ? (stream.text + e.content).slice(0, LIMITS.live) : stream.text;
  }
  // A preserving reset (the host's `discard_scope` 'none': a tool continuation, its text already saved as a segment) clears
  // only the words not yet read back; any other reset (`all`, `live_slice`, or no mode field at all) also erases the live
  // reasoning. The saved segments the host keeps or deletes come back with the snapshot a reset asks for.
  function resetOf(e) {
    const keeps = e.discard_scope === 'none' || (e.discard_scope === undefined && e.reason === 'tool_continuation');
    return keeps ? { text: '', textAt: 0 } : { text: '', textAt: 0, reasoning: [], reasonedAt: 0, reasonLastAt: 0 };
  }
  // One `chat_stream` event ({ stream_id, event: { type, ... } }) applied: a new stream object, or the same one when
  // nothing changed. `started` begins a turn; an event with no turn begun, or after its end, changes nothing.
  function applyStream(stream, outer, now) {
    const e = obj(obj(outer).event);
    if (e.type === 'started') return startStream(obj(outer).stream_id, now);
    if (!stream || stream.ended) return stream || null;
    const next = { ...stream };
    if (Array.isArray(e.reasoning)) {
      next.reasoning = applyReasoning(stream.reasoning, e.reasoning);
      if (!next.reasonedAt && reasoningText(next.reasoning)) next.reasonedAt = now;
      if (next.reasonedAt) next.reasonLastAt = now;
    }
    if (e.type === 'delta') { next.text = textAfter(stream, e); if (!next.textAt && next.text) next.textAt = now; }
    else if (e.type === 'stream_reset') Object.assign(next, resetOf(e));
    else if (e.type === 'thinking_status') next.status = clean(e.text, LIMITS.status);
    else if (e.type === 'tool_use' || e.type === 'tool_result') next.tools = toolsAfter(stream.tools, e);
    else Object.assign(next, noteOf(stream, e, now));
    return next;
  }
  // What an end (with the reason its host fields give) or a compaction changes on the running turn; nothing for any other event.
  function noteOf(stream, e, now) {
    if (ENDS.has(e.type)) return { ended: e.type, endedAt: now, reason: e.type === 'complete' ? '' : failureReason(e) };
    if (e.type === 'context_compacted') return { compacted: Math.min((stream.compacted || 0) + 1, MAX_COMPACTIONS) };
    return {};
  }
  // A turn running when the snapshot was read: its words and reasoning so far (the host's `live_projection`:
  // `assistant_text` and `reasoning`; it may be absent before the first word), or null when none runs.
  function projectStream(snapshot, now) {
    const snap = obj(snapshot);
    const turn = obj(snap.active_turn);
    if (!snap.active_turn || ENDS.has(str(turn.status) || str(turn.state))) return null;
    const projection = obj(snap.live_projection);
    const stream = startStream(projection.stream_id || turn.stream_id, now);
    stream.text = str(projection.assistant_text).slice(0, LIMITS.live);
    stream.reasoning = applyReasoning([], projection.reasoning);
    if (stream.text) stream.textAt = now;
    if (reasoningText(stream.reasoning)) { stream.reasonedAt = now; stream.reasonLastAt = now; }
    return stream;
  }
  // The turn shown after a snapshot. A running turn's own events are newer than a snapshot read while it runs, so it
  // is kept (with the snapshot's words when those are longer: events were missed); an ended one stays, with its
  // reply, until a snapshot holds the answer (`answered`) or shows another turn.
  function streamAfter(held, snapshot, now, answered) {
    const projected = projectStream(snapshot, now);
    if (!held) return projected;
    if (held.ended) return projected || (answered || !held.text ? null : held);
    if (!projected || (projected.id && held.id && projected.id !== held.id)) return projected;
    if (projected.text.length <= held.text.length) return held;
    return { ...held, text: projected.text, reasoning: projected.reasoning.length ? projected.reasoning : held.reasoning, textAt: held.textAt || now };
  }

  // ------------------------------------------------------------ the unsaved tail (row 175)

  const norm = (v) => str(v).replace(/\s+/g, ' ').trim();
  // How much of `text` (the stream's words) the saved assistant segments of the turn cover, in order from the start of the
  // text: each saved segment that continues the text at the cursor moves it to its end (a cumulative `aggregate` after
  // a saved segment, the approval-resume path, then leaves only what follows). A segment from before a reset does not
  // continue the text and is skipped; one longer than the words read so far (the snapshot is ahead) covers them all.
  function savedTextEnd(text, saved) {
    const words = str(text);
    let end = 0;
    for (const m of Array.isArray(saved) ? saved : []) {
      if (obj(m).role !== 'assistant' || TOOL_KINDS.has(m.kind) || !str(m.content).trim()) continue;
      let from = end;
      while (from < words.length && /\s/.test(words[from])) from += 1;
      const rest = words.slice(from);
      const seg = [str(m.content), str(m.content).trim()].find((c) => rest.startsWith(c));
      if (seg) end = from + seg.length;
      else if (rest && str(m.content).startsWith(rest)) end = words.length;
    }
    return end;
  }
  // The ids of the live reasoning entries a saved message of the turn already holds (by id, else by the same words).
  function savedReasoningIds(entries, saved) {
    const ids = new Set();
    const texts = new Set();
    for (const m of Array.isArray(saved) ? saved : []) {
      for (const e of Array.isArray(obj(obj(m).reasoning).entries) ? m.reasoning.entries : []) {
        if (str(obj(e).id)) ids.add(e.id);
        if (norm(obj(e).text)) texts.add(norm(e.text));
      }
    }
    return (Array.isArray(entries) ? entries : []).filter((e) => ids.has(obj(e).id) || texts.has(norm(obj(e).text))).map((e) => e.id);
  }
  /** What the saved messages of the running turn already cover: { textLength, reasoningIds } for the tail's words and reasoning. */
  function savedCursors(stream, saved) {
    const s = obj(stream);
    return { textLength: savedTextEnd(s.text, saved), reasoningIds: savedReasoningIds(s.reasoning, saved) };
  }

  // ------------------------------------------------------------ a question from Jenny

  function whoLine(mine, prompter, canAnswer) {
    const name = clean(prompter, 64);
    const asked = mine ? jt('team.conv.askedMine', 'Your turn asked.') : name ? jt('team.conv.askedBy', '{name}\u2019s turn asked.', { name }) : '';
    const rule = canAnswer ? jt('team.conv.askedAnyone', 'Anyone who can write in this project and is viewing this conversation can answer.')
      : jt('team.conv.askedReadOnly', 'Only members who can write in this project can answer.');
    return asked ? asked + ' ' + rule : rule;
  }
  function questionHtml(pending, { prompter = '', mine = false, canAnswer = true, note = '' } = {}) {
    const p = obj(pending);
    const card = questions && questions.renderUserQuestionsBlock
      ? questions.renderUserQuestionsBlock({ toolCallId: p.call_id, questionRef: p.question_ref, questions: shownQuestions(p.questions) }) : '';
    if (!card) return '';
    return '<div class="team-conv__question" data-question-ref="' + esc(p.question_ref) + '" data-stream-id="' + esc(p.stream_id) + '">' + card
      + '<p class="team-conv__who" dir="auto">' + escapeHtml(whoLine(mine, prompter, canAnswer)) + '</p>'
      + (str(note) ? '<p class="team-composer__hint" role="status">' + esc(note) + '</p>' : '') + '</div>';
  }
  // The host sends each option as { id, label }; the chat's card draws strings, so it gets the labels. The card keeps
  // the first 8 and drops blank ones, so the options it draws are these, in this order.
  const optionOf = (o) => (typeof o === 'string' ? { id: o, label: o } : { id: str(obj(o).id) || str(obj(o).label), label: str(obj(o).label) || str(obj(o).id) });
  const optionsOf = (q) => (Array.isArray(obj(q).options) ? obj(q).options : []).slice(0, 8).map(optionOf).filter((o) => o.label.trim());
  function shownQuestions(list) {
    return (Array.isArray(list) ? list : []).map((q) => ({ ...obj(q), options: optionsOf(q).map((o) => o.label) }));
  }
  // The card's answers in the host's shape ({ question_id, answer[, other] }, at most 8). A picked option is sent as its
  // id, found by its place on the card (the host checks ids; labels may repeat or be cut).
  function collectAnswers(block, pending) {
    if (!block || typeof block.querySelectorAll !== 'function') return [];
    const asked = Array.isArray(obj(pending).questions) ? obj(pending).questions : [];
    return Array.from(block.querySelectorAll('[data-user-question-id]')).slice(0, 8).map((node) => {
      const questionId = cut(node.getAttribute('data-user-question-id') || '', 240);
      const options = optionsOf(asked.find((q) => str(obj(q).id) === questionId));
      const inputs = Array.from(node.querySelectorAll('[data-user-question-option]'));
      const toId = (el) => { const o = options[inputs.indexOf(el)]; return o ? o.id : cut(String(el.value), 240); };
      const free = node.querySelector('[data-user-question-free-text]');
      const checked = inputs.filter((el) => el.checked).map(toId);
      const picked = free ? cut(String(free.value || ''), 8000) : node.getAttribute('data-multi-select') === 'true' ? checked : checked[0] || '';
      const entry = { question_id: questionId, answer: picked };
      const toggle = node.querySelector('[data-user-question-other-toggle]');
      const input = node.querySelector('[data-user-question-other-input]');
      const other = toggle && toggle.checked && input ? String(input.value || '').trim() : '';
      return other ? { ...entry, other: cut(other, 8000) } : entry;
    });
  }
  // The card's own count and Submit state, after an edit.
  function syncQuestion(block) { if (questions && questions.syncUserQuestionsState) questions.syncUserQuestionsState(block); }
  function lockQuestion(block, locked) {
    if (!block || typeof block.querySelectorAll !== 'function') return;
    block.setAttribute('aria-busy', locked ? 'true' : 'false');
    block.querySelectorAll('button, input, textarea, select').forEach((el) => { el.disabled = Boolean(locked); });
    if (!locked) syncQuestion(block);
  }

  // ------------------------------------------------------------ the channel (row 171)

  const TOOL_KINDS = new Set(['tool_use', 'tool_result']);
  const CHIP_DOTS = Object.freeze({ live: 'active', asks: 'pending', failed: 'error' });
  const STOP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/></svg>';
  const toMs = (v) => { const ms = typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN; return Number.isFinite(ms) ? ms : NaN; };
  const stamp = (m) => { const v = obj(m).timestamp; return typeof v === 'string' || typeof v === 'number' ? v : ''; };

  function turnItem(g, { running, headless }) {
    const ms = g.messages;
    const said = ms.filter((m) => m.role === 'assistant' && !TOOL_KINDS.has(m.kind));
    const spoken = said.findLast((m) => typeof m.content === 'string' && m.content.trim());
    const last = said[said.length - 1];
    const status = running ? 'running' : last && FAILED.has(last.status) ? 'failed' : last && STOPPED.has(last.status) ? 'stopped' : 'done';
    const named = ms.findLast((m) => m.role === 'assistant' && str(m.model_used));
    const end = obj(ms[ms.length - 1]).finalized_at;
    return { kind: 'turn', id: g.id, prompt: g.prompt || null, messages: ms.slice(), text: spoken ? spoken.content : '', tools: ms.filter((m) => m.kind === 'tool_use').length, status,
      reason: status === 'failed' ? failureReason(last) : '', compactions: compactionCount(ms),
      startedAt: stamp(g.prompt || ms[0]), finishedAt: typeof end === 'string' || typeof end === 'number' ? end : '', model: named ? named.model_used : '', headless };
  }

  // The held host messages, in order, as channel items: { kind: 'member', message } per user message, and one
  // { kind: 'turn', ... } per saved `turn_id` (messages without one join the run after the user message before them),
  // placed right after its prompt, or where its first message was when no prompt is held. `activeTurn` is the snapshot's:
  // its turn is 'running', and an empty running turn follows its prompt while nothing of it is saved yet.
  function groupTurns(messages, { activeTurn } = {}) {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object' && !Array.isArray(m));
    const active = obj(activeTurn);
    const on = Boolean(activeTurn) && !ENDS.has(str(active.status));
    const liveIds = new Set([str(active.turn_id), str(active.stream_id)].filter(Boolean));
    const activeUser = str(active.user_message_id);
    const promptOf = new Map();
    for (const m of list) if (m.role === 'user' && str(m.turn_id) && !promptOf.has(m.turn_id)) promptOf.set(m.turn_id, m);
    const groups = new Map();
    let lastUser = null;
    let orphan = '';
    list.forEach((m, index) => {
      if (m.role === 'user') { lastUser = m; return; }
      const tid = str(m.turn_id);
      const untagged = tid ? '' : lastUser ? 'after:' + str(lastUser.id) : (orphan = orphan || 'at:' + str(m.id));
      const key = tid ? 'T' + tid : 'U' + untagged;
      if (!groups.has(key)) groups.set(key, { id: tid || untagged, tid, prompt: tid ? promptOf.get(tid) || lastUser : lastUser, messages: [], first: index });
      groups.get(key).messages.push(m);
    });
    const isActive = (g) => on && (g.tid ? liveIds.has(g.tid) : Boolean(activeUser && g.prompt && str(g.prompt.id) === activeUser));
    const byPrompt = new Map();
    const loose = new Map();
    for (const g of groups.values()) {
      if (!g.prompt) { loose.set(g.first, g); continue; }
      if (!byPrompt.has(g.prompt)) byPrompt.set(g.prompt, []);
      byPrompt.get(g.prompt).push(g);
    }
    const saved = [...groups.values()].some(isActive);
    const item = (g) => turnItem(g, { running: isActive(g), headless: !g.prompt && g.messages[0] === list[0] });
    const items = [];
    list.forEach((m, index) => {
      if (m.role !== 'user') { if (loose.has(index)) items.push(item(loose.get(index))); return; }
      items.push({ kind: 'member', message: m });
      for (const g of byPrompt.get(m) || []) items.push(item(g));
      if (on && !saved && activeUser && str(m.id) === activeUser) {
        items.push(turnItem({ id: str(active.turn_id) || 'after:' + activeUser, prompt: m, messages: [] }, { running: true, headless: false }));
      }
    });
    return items;
  }

  // What a saved tool call works on, for the chip: its input's path, else a summary, else ''.
  function toolSubject(message) {
    const call = obj(obj(message).tool_call);
    let input = obj(call.input_json);
    if (typeof call.input_json === 'string' && call.input_json.length <= 65536) {
      try { input = obj(JSON.parse(call.input_json)); } catch (_error) { input = {}; }
    }
    return clean(str(input.path) || str(input.file_path) || str(call.summary) || str(input.summary), 64);
  }

  // A failed turn's chip: the same words as ever, and the reason's sentence when its code is one we know.
  function failedChip(t) {
    const reason = reasonText(t.reason);
    return { state: 'failed', label: jt('team.turn.failed', 'Jenny could not finish this answer'), elapsed: '', ...(reason ? { reason } : {}) };
  }

  // The working chip's words: { state ('live' | 'asks' | 'done' | 'failed' | 'stopped'), label, elapsed }. `turn` is a
  // groupTurns item, `stream` the running turn (applyStream's), `thoughtMs` the client's memory of how long a finished
  // turn took when the host's times do not say.
  function chipState({ turn, stream, question = false, approval = false, now = 0, thoughtMs } = {}) {
    const t = obj(turn);
    if (t.status === 'running') {
      const s = obj(stream);
      const elapsed = typeof s.startedAt === 'number' && s.startedAt > 0 ? elapsedText(now - s.startedAt) : '';
      if (approval) return { state: 'asks', label: jt('team.conv.waitingApproval', 'Waiting for approval'), elapsed };
      if (question) return { state: 'asks', label: jt('team.conv.waitingAnswer', 'Waiting for an answer'), elapsed };
      const tool = (Array.isArray(s.tools) ? s.tools : []).findLast((x) => obj(x).state === 'running');
      if (tool) {
        const call = str(tool.id) ? (Array.isArray(t.messages) ? t.messages : []).findLast((m) => obj(obj(m).tool_call).call_id === tool.id) : null;
        const name = clean(str(tool.name) || obj(obj(call).tool_call).tool_name, 64);
        const subject = call ? toolSubject(call) : '';
        if (name) return { state: 'live', label: subject ? clean(jt('team.turn.tool', '{tool} · {subject}', { tool: name, subject }), 64) : name, elapsed };
      }
      if (str(s.text)) return { state: 'live', label: jt('team.turn.writing', 'Writing…'), elapsed };
      const said = clean(s.status, LIMITS.status);
      return { state: 'live', label: (said && !ITERATION.test(said) ? said : '') || jt('team.conv.thinking', 'Thinking…'), elapsed };
    }
    if (t.status === 'failed') return failedChip(t);
    if (t.status === 'stopped') return { state: 'stopped', label: jt('team.turn.stopped', 'Stopped before Jenny answered'), elapsed: '' };
    const span = toMs(t.finishedAt) - toMs(t.startedAt);
    const ms = span > 0 ? span : typeof thoughtMs === 'number' && thoughtMs > 0 ? thoughtMs : NaN;
    const duration = Number.isFinite(ms) ? elapsedText(ms) : '';
    const tools = Number.isSafeInteger(t.tools) && t.tools > 0 ? t.tools : 0;
    let label;
    if (tools && duration) label = jtn('team.turn.worked', tools, { duration }, 'Worked for {duration} · {count} tool', 'Worked for {duration} · {count} tools');
    else if (tools) label = jtn('team.turn.doneTools', tools, {}, 'Done · {count} tool', 'Done · {count} tools');
    else if (duration) label = jt('team.conv.thoughtFor', 'Thought for {duration}', { duration });
    else label = jt('team.turn.done', 'Done');
    return { state: 'done', label, elapsed: '' };
  }

  // The chip: one button that opens the turn's transcript (`open`: its popover is open).
  function chipHtml({ turnId = '', state = 'done', label = '', elapsed = '', open = false } = {}) {
    const time = clean(elapsed, 16);
    return actionButton({ plain: true, className: 'team-turn-chip', ariaExpanded: Boolean(open), ariaControls: 'teamTurnPop',
      title: jt('team.turn.chipTitle', 'Show what Jenny thought and did in this turn'), dataset: { state: clean(state, 16), 'project-action': 'turn-open', 'turn-id': str(turnId) },
      trustedHtml: '<span class="status-dot status-dot--' + (CHIP_DOTS[state] || 'muted') + '" aria-hidden="true"></span>'
        + '<span class="team-turn-chip__label' + (state === 'live' ? ' shimmer-active' : '') + '" dir="auto">' + escapeHtml(clean(label, LIMITS.status)) + '</span>'
        + (time ? '<span class="team-turn-chip__time">' + escapeHtml(time) + '</span>' : '')
        + '<span class="team-turn-chip__more" aria-hidden="true">' + escapeHtml(open ? jt('team.turn.hide', 'Hide') : jt('team.turn.showWork', 'Show work')) + '</span>' });
  }

  // The line under Jenny's name: the chip (trusted markup), Stop for whoever may stop the turn, Send again after a failure,
  // and under it a failed turn's reason (text, escaped).
  function turnLineHtml({ chip = '', canStop = false, canRetry = false, turnId = '', reason = '' } = {}) {
    const stopLabel = jt('team.conv.stopTitle', 'Stop this turn');
    const stop = canStop ? actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: stopLabel, title: stopLabel, dataset: { 'project-action': 'stop' }, trustedHtml: STOP_ICON }) : '';
    const again = canRetry ? actionButton({ label: jt('team.turn.sendAgain', 'Send again'), size: 'sm', title: jt('team.turn.sendAgainTitle', 'Send your message again as a new turn'),
      dataset: { 'project-action': 'send-again', 'turn-id': str(turnId) } }) : '';
    const why = str(reason) ? '<p class="team-turn-reason" dir="auto">' + esc(reason) + '</p>' : '';
    return '<div class="team-turn-line">' + str(chip) + stop + again + '</div>' + why;
  }

  // ------------------------------------------------------------ the edges

  function earlierHtml({ more = false, busy = false } = {}) {
    if (!more) return '';
    const label = busy ? jt('team.conv.earlierLoading', 'Loading earlier messages\u2026') : jt('team.conv.earlierShow', 'Show earlier messages');
    return actionButton({ plain: true, className: 'team-conv__earlier', label, title: jt('team.conv.earlierTitle', 'Show the messages before these'), disabled: Boolean(busy),
      dataset: { 'project-action': 'earlier' } });
  }
  function heroHtml({ projectName = '', canWrite = true } = {}) {
    const project = clean(projectName, 80);
    const lede = project
      ? jt('team.conv.emptyLede', 'In {project}. Everyone in the project can read it. Jenny answers on a GPU a member shares, so that member and the team host can read it too.', { project })
      : jt('team.conv.emptyLedePlain', 'Everyone in the project can read it. Jenny answers on a GPU a member shares, so that member and the team host can read it too.');
    const text = canWrite ? lede : lede + ' ' + jt('team.conv.emptyReader', 'You can read here; writers and admins can send.');
    return '<div class="team-conv__hero"><h3 class="hero-title">' + escapeHtml(jt('team.conv.emptyTitle', 'New conversation')) + '</h3><p dir="auto">' + escapeHtml(text) + '</p></div>';
  }

  return { LIMITS, ENDS, clean, elapsedText, reasoningText, applyReasoning, startStream, applyStream, projectStream, streamAfter, savedTextEnd, savedReasoningIds, savedCursors,
    questionHtml, collectAnswers, lockQuestion, syncQuestion, earlierHtml, heroHtml, mergeMessages, groupTurns, chipState, chipHtml, turnLineHtml,
    failureReason, reasonText, compactionCount, compactionLinesHtml };
});
