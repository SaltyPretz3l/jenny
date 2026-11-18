/* Team tab: what a shared conversation's channel shows, from the controller's state (row 171). The controller
 * (renderer-team-project-conversation.js) owns the state, the events and the writes; this builds, for one frame:
 * - `view()`: the held messages as channel items (timeline `groupTurns`, kept while the messages and the active turn
 *   stay the same) and the turn running, or just ended and not yet saved, apart as `live` (its row is redrawn with the
 *   stream; a turn the host has not named yet is the stream's own row);
 * - the markup of the log, the live region and the sender's queued rows (renderer-team-project-rows.js), Jenny's line
 *   under her name (the chip, Stop, Send again; kept per turn while it says the same) and the cards a running turn
 *   waits on (one form per question card: the card's radio names repeat across cards);
 * - the transcript popover's model (renderer-team-turn-pop.js), and what the polite live region says when a turn's
 *   state changes (not its clock).
 * `o`: { s (the controller's state), history, approvals, queue, rows, clock, me(), nameOf(id), role(), mayDrive(),
 * running(), streamId(), asking(), projectName(), modelName(saved), liveText() (the stream's words last parsed),
 * notes() (row 172: the quiet lines of changes to Jenny's model and tools, in time order; they join the log by time) }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-timeline'), require('./renderer-team-message-row'), require('./renderer-team-project-column'),
      require('./renderer-team-project-queue'), require('./renderer-team-turn-pop'), require('./renderer-team-project-conversation-parts'),
      require('./renderer-team-turn-adapter'));
    return;
  }
  root.rendererTeamProjectChannel = factory(root.rendererTeamProjectTimeline, root.rendererTeamMessageRow, root.rendererTeamProjectColumn, root.rendererTeamProjectQueue,
    root.rendererTeamTurnPop, root.rendererTeamProjectConversationParts, root.rendererTeamTurnAdapter);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (tl, msgRow, column, queues, turnPop, parts, adapter) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  // The inventory's button builder: the app's global, or under Node the module at first use (the app's `require` throws).
  let nodeButton;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || nodeButton || (nodeButton = require('../inventory/action-button')))(o);
  const STOPS = new Set(['cancelled', 'canceled']);
  const FENCE = '```';
  // A conversation that failed to open: why, and Try again. The controller handles `project-action="reopen"` (opens it again).
  const failedHtml = (why) => '<p class="team-page__lede" role="status">' + escapeHtml(why) + '</p>'
    + actionButton({ plain: true, label: jt('team.chat.tryAgain', 'Try again'), dataset: { 'project-action': 'reopen' } });
  const itemId = (item) => (item.kind === 'turn' ? item.id : item.message.id);

  function createChannel(o) {
    const s = o.s;
    const plan = o.plan || { blank: (x) => x, cardsHtml: () => '', footHtml: () => '', popHtml: () => '', version: () => 0 }; // row 175 item 7
    const grouped = { held: null, active: null, items: [] };
    const leads = new Map(); // turn id -> { sig, html }
    // The log is drawn again only when something it shows changed (a frame of the stream changes the live row only).
    const logMemo = { key: [], html: '' };
    const popMemo = { src: null, prompt: null, base: [], key: [], list: [] };
    let rev = 0;
    const pending = () => o.approvals.pending();

    function cardsHtml() {
      const question = (p) => {
        const prompter = p.prompter_member_id || '';
        return '<form class="team-conv__qform">' + tl.questionHtml(p, { prompter: prompter ? o.nameOf(prompter) : '', mine: prompter === o.me(), canAnswer: o.role() !== 'reader' }) + '</form>';
      };
      return o.approvals.cardsHtml() + plan.cardsHtml() + o.asking().map(question).join('');
    }

    function view() {
      const held = o.history.messages();
      const active = o.running() && s.snapshot ? s.snapshot.active_turn : null;
      if (grouped.held !== held || grouped.active !== active) Object.assign(grouped, { held, active, items: tl.groupTurns(plan.blank(held), { activeTurn: active }) });
      const items = grouped.items.slice();
      const stream = s.stream;
      let at = items.findIndex((i) => i.kind === 'turn' && i.status === 'running');
      if (at < 0 && stream && s.liveTurn) at = items.findIndex((i) => i.kind === 'turn' && i.id === s.liveTurn);
      let live = at >= 0 && at === items.length - 1 ? items.pop() : null;
      if (!live && at < 0 && stream && (!stream.ended || stream.text)) {
        live = { kind: 'turn', id: s.liveTurn || stream.id || 'live', prompt: null, messages: [], text: '', tools: 0, status: 'running', startedAt: '', finishedAt: '', model: '', headless: false };
      }
      if (live && stream) live = { ...live, status: !stream.ended ? 'running' : stream.ended === 'complete' ? 'done' : STOPS.has(stream.ended) ? 'stopped' : 'failed', reason: stream.reason || live.reason || '' };
      // The open popover and what was last said follow the turn when the saved turn id replaces the stream's.
      if (live && s.liveTurn && live.id !== s.liveTurn) {
        if (s.popTurn === s.liveTurn) s.popTurn = live.id;
        if (s.announced.startsWith(s.liveTurn + '|')) s.announced = live.id + s.announced.slice(s.liveTurn.length);
      }
      s.liveTurn = live ? live.id : stream ? s.liveTurn : '';
      return { items, live, turns: items.filter((i) => i.kind === 'turn').concat(live ? [live] : []) };
    }

    function chipOf(item, v) {
      const isLive = item === v.live;
      const st = tl.chipState({ turn: item, stream: isLive ? s.stream : null, question: isLive && o.asking().length > 0, approval: isLive && pending().length > 0, now: o.clock(),
        thoughtMs: s.thought.get(item.id) });
      // A turn waiting on a person does not tick: the row's cards keep what was picked and typed.
      return st.state === 'asks' ? { ...st, elapsed: '' } : st;
    }
    function leadOf(item, v) {
      if (item.kind !== 'turn') return '';
      const prompter = item.prompt && item.prompt.author ? item.prompt.author.member_id : '';
      const st = chipOf(item, v);
      const open = s.popTurn === item.id;
      const canStop = item.status === 'running' && o.mayDrive() && Boolean(o.streamId());
      const canRetry = item.status === 'failed' && prompter === o.me() && o.mayDrive() && Boolean(item.prompt.content);
      const compacted = Math.max(item.compactions || 0, item === v.live && s.stream ? s.stream.compacted || 0 : 0);
      const sig = [st.state, st.label, st.elapsed, open, canStop, canRetry, st.reason || '', compacted].join('\u0000');
      const hit = leads.get(item.id);
      const line = hit && hit.sig === sig ? hit.html : tl.turnLineHtml({ chip: tl.chipHtml({ turnId: item.id, ...st, open }), turnId: item.id, canStop, canRetry, reason: st.reason })
        + tl.compactionLinesHtml(compacted);
      if (!hit || hit.sig !== sig) leads.set(item.id, { sig, html: line });
      // Item 11: the host's receipts of this turn's tool calls stand under it (renderer-team-project-actions.js).
      return (item === v.live ? line + cardsHtml() : line) + (o.under ? o.under(item) : '');
    }
    const liveBody = (item) => (s.stream && s.stream.text && item.id === s.liveTurn ? o.liveText() : null);
    const lastOf = (v) => v.items[v.items.length - 1];

    // A row's time as the rows draw it (a turn's first message, else its start).
    const ms = (value) => (typeof value === 'number' ? value : Date.parse(value));
    const timeOf = (item) => ms(item.kind === 'turn' ? ((item.messages || [])[0] || {}).timestamp || item.startedAt : item.message.timestamp);
    // The rows with the quiet lines put before the first row later than each.
    function withNotes(items, notes) {
      const out = [];
      let next = 0;
      for (const item of items) {
        while (next < notes.length && timeOf(item) > notes[next].at) out.push(notes[next++]);
        out.push(item);
      }
      return out.concat(notes.slice(next));
    }

    function logHtml(v) {
      const top = o.history.topHtml();
      const notes = o.notes ? o.notes() : [];
      const key = [grouped.items, v.items.length, s.popTurn, s.error, s.closed, Boolean(s.snapshot), Boolean(s.stream), o.me(), o.role(), o.mayDrive(), o.streamId(), rev, top,
        msgRow.dayKey(o.clock()), pending().length, o.asking().length, notes, o.underKey ? o.underKey() : '', plan.version()];
      if (key.length === logMemo.key.length && key.every((k, i) => k === logMemo.key[i])) return logMemo.html;
      keep(v);
      logMemo.key = key;
      if (s.error) logMemo.html = failedHtml(s.error);
      else if (!s.snapshot) logMemo.html = '';
      else if (!v.items.length && !v.live && !o.history.more() && !s.stream && !pending().length && !o.asking().length) {
        logMemo.html = s.closed ? '' : tl.heroHtml({ projectName: o.projectName(), canWrite: o.role() !== 'reader' });
      } else logMemo.html = top + o.rows.html(withNotes(v.items, notes), { leadOf: (i) => leadOf(i, v), footOf: plan.footHtml });
      return logMemo.html;
    }
    function liveHtml(v) {
      if (s.error || !s.snapshot) return '';
      const row = v.live ? o.rows.html([v.live], { leadOf: (i) => leadOf(i, v), footOf: plan.footHtml, bodyOf: liveBody, after: lastOf(v) }) : cardsHtml();
      const receipts = o.approvals.receiptsHtml(o.placed);
      return row + (receipts ? '<div class="team-conv__receipts">' + receipts + '</div>' : '') + parts.noteLine(s.closed);
    }
    function queuedHtml(v) {
      const list = o.queue.entries();
      if (!list.length || s.error) return '';
      const items = list.map((e) => ({ kind: 'member', entry: e, message: { id: 'queue:' + e.id, role: 'user', author: { kind: 'member', member_id: o.me() }, content: e.text, timestamp: '' } }));
      return o.rows.html(items, { footOf: (i) => queues.footHtml(i.entry, { running: o.running() || s.settling }), after: v.live || lastOf(v) });
    }
    // Only the rows shown (and the queued ones) keep their markup.
    function keep(v) {
      const kept = v.items.concat(v.live ? [v.live] : []).map(itemId);
      o.rows.keep(kept.concat(o.queue.entries().map((e) => 'queue:' + e.id)));
      const set = new Set(kept);
      for (const id of [...leads.keys()]) if (!set.has(id)) leads.delete(id);
    }

    // The saved messages of the turn, then (while its stream is held) what is not saved yet: the running tools with no
    // row, then the words and reasoning past what the saved segments cover (the tail takes the next event_seq, so the
    // chain sorts it last).
    function withTail(base, stream, t) {
      const cursors = tl.savedCursors(stream, base);
      const callIds = base.map((m) => (m.tool_call ? m.tool_call.call_id : '')).filter(Boolean);
      const seq = adapter.nextEventSeq(base);
      const tools = stream.ended ? [] : adapter.liveToolMessages(stream.tools, callIds, t.id, seq);
      const tail = adapter.liveMessage({ stream, turnId: t.id, model: o.modelName(t.model), saved: base, savedTextLength: cursors.textLength,
        savedReasoningIds: cursors.reasoningIds, eventSeq: Number.isInteger(seq) ? seq + tools.length : undefined,
        compacted: Math.min(1, Math.max(0, (stream.compacted || 0) - (t.compactions || 0))) });
      return tools.length || tail ? base.concat(tools, tail ? [tail] : []) : base;
    }
    // The same list while the turn's messages and the stream's words, reasoning, tools and end stay the same: the popover then skips its body.
    function popMessages(t, v) {
      if (popMemo.src !== t.messages || popMemo.prompt !== t.prompt) {
        const base = turnPop.toLocalMessages(t.prompt ? [t.prompt, ...t.messages] : t.messages);
        Object.assign(popMemo, { src: t.messages, prompt: t.prompt, base, key: [], list: base });
      }
      const stream = t === v.live ? s.stream : null;
      const key = stream ? [stream.id, stream.text, stream.reasoning, stream.tools, stream.ended, stream.compacted] : [];
      if (key.length === popMemo.key.length && key.every((k, i) => k === popMemo.key[i])) return popMemo.list;
      popMemo.key = key;
      popMemo.list = stream ? withTail(popMemo.base, stream, t) : popMemo.base;
      return popMemo.list;
    }

    // The popover's turn: its prompt and saved messages through the whitelist, and the live turn's unsaved tail.
    function popModel(v) {
      const at = v.turns.findIndex((t) => t.id === s.popTurn);
      if (at < 0) return null;
      const t = v.turns[at];
      const isLive = t === v.live && t.status === 'running';
      const messages = popMessages(t, v);
      const author = t.prompt && t.prompt.author ? t.prompt.author.member_id : '';
      const by = author ? o.nameOf(author) : '';
      const st = chipOf(t, v);
      const sub = [by ? jt('team.turn.whose', '{name}’s turn', { name: by }) : '', msgRow.timeText(t.startedAt), isLive ? st.elapsed : st.label, column.clean(o.modelName(t.model), 64)];
      // A turn that failed or was stopped says so in the chip's words; the popover draws the line.
      const end = t.status === 'failed' || t.status === 'stopped'
        ? { kind: t.status, text: st.reason ? jt('team.turn.endWhy', '{label}. {reason}', { label: st.label, reason: st.reason }) : st.label } : null;
      return { turnId: t.id, title: jt('team.turn.title', 'Jenny’s work'), sub: sub.filter(Boolean).join(' · '), promptBy: by, live: isLive, end,
        canStop: isLive && o.mayDrive() && Boolean(o.streamId()),
        canPrev: at > 0 || o.history.more(), canNext: at < v.turns.length - 1, messages, extraHtml: (t === v.live ? cardsHtml() : '') + plan.popHtml(t) };
    }

    // What to say when a turn's state changed since `said` (the last key), or null: working, waiting on a person, how it ended.
    function announce(v, said) {
      const was = said.slice(0, said.lastIndexOf('|'));
      const turn = v.live && v.live.status === 'running' ? v.live : was ? v.turns.find((t) => t.id === was) : null;
      if (!turn) return null;
      const st = chipOf(turn, v);
      const key = turn.id + '|' + (turn.status === 'running' ? st.state : turn.status);
      return key === said ? null : { key, text: st.state === 'live' ? jt('team.turn.working', 'Jenny is working') : st.label };
    }

    // `invalidate()`: names, the project or a turn's time changed, so the log is drawn again.
    return { view, chipOf, logHtml, liveHtml, queuedHtml, popModel, announce, invalidate: () => { rev += 1; }, clear: () => { leads.clear(); logMemo.key = []; } };
  }

  // `el`'s children made to match `html` node by node: a node whose tag stays is kept and only its attributes and text
  // change, so a button pressed while the stream repaints is still there for its click, and an animation runs on.
  function patch(el, html) {
    const template = el.ownerDocument.createElement('template');
    template.innerHTML = html;
    sync(el, template.content);
  }
  function sync(to, from) {
    const want = Array.from(from.childNodes);
    want.forEach((next, i) => {
      const have = to.childNodes[i];
      if (!have) { to.appendChild(next); return; }
      if (have.nodeType !== next.nodeType || have.nodeName !== next.nodeName) { to.replaceChild(next, have); return; }
      if (have.nodeType !== 1) { if (have.nodeValue !== next.nodeValue) have.nodeValue = next.nodeValue; return; }
      for (const name of have.getAttributeNames()) if (!next.hasAttribute(name)) have.removeAttribute(name);
      for (const name of next.getAttributeNames()) if (have.getAttribute(name) !== next.getAttribute(name)) have.setAttribute(name, next.getAttribute(name));
      sync(have, next);
    });
    while (to.childNodes.length > want.length) to.removeChild(to.lastChild);
  }

  // A code fence around what is picked in `field` (or an empty one), the caret inside it.
  function fence(field) {
    const from = field.selectionStart ?? field.value.length;
    const to = field.selectionEnd ?? from;
    const picked = field.value.slice(from, to);
    const text = (from > 0 && field.value[from - 1] !== '\n' ? '\n' : '') + FENCE + '\n' + picked + '\n' + FENCE;
    if (typeof field.setRangeText === 'function') field.setRangeText(text, from, to, 'end'); else field.value = field.value.slice(0, from) + text + field.value.slice(to);
    const caret = from + text.length - FENCE.length - 1;
    field.focus();
    field.setSelectionRange(caret, caret);
  }

  return { createChannel, fence, patch };
});
