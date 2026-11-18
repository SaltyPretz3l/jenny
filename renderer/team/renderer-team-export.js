/* Export of a member's readable team conversations (row 123, slice 2a-6c; owner picks 10 to 16, 2026-11-12,
 * mockup team-chat-2a6c). Spec C6: no route; the client pages `chatHistory` and `chatThread`
 * (100 a page) and saves through the existing save dialog.
 *
 * Order (owner pick 16): gather everything first with a progress line, then the save dialog with the name filled
 * in and two types (Markdown first, JSON second), then the line says what was written and stays until closed.
 * Cancel while gathering, Cancel in the dialog and the team going offline part way each save nothing; a stop
 * offers Try again. One export at a time, for the Team tab, the palette and the Leave confirmation alike (one
 * shared exporter per window).
 *
 * What goes in: the conversations this member can read (the overview's list), oldest first; thread replies under
 * the message they answer; a deleted message only while it has replies, as the app's own line, never its text;
 * edited ones marked. Names are the names on screen; mention tokens become names. No key, token, invite, member
 * key or device id is gathered: a message carries its id, sender name, time, edited mark and text only.
 *
 * The gathered document crosses to main once; main builds only the format whose type was picked
 * (services/team-export-format.js, through services/save-file-handler.js). Every history read names a top bound,
 * so even the first page goes straight to the host instead of opening the channel in the live cache. The host
 * does not limit history or thread reads; the overview asked first is limited, so a second export started at once
 * can fail with the generic line.
 *
 * Row 175 item 8 (D15): "This conversation…" also exports the open project conversation (page id `conv:<session>`):
 * the prompts under their askers and each turn's last words under "Jenny", paged by `conversationOpen`; no reasoning or tool row. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-store'), require('./renderer-team-channels'));
    return;
  }
  root.rendererTeamExport = factory(root.rendererTeamStore, root.rendererTeamChannels);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (teamStore, channels) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const PAGE = 100;
  const TOP = Number.MAX_SAFE_INTEGER; // the first page's bound: the newest messages
  const OFFLINE = new Set(['team_not_connected', 'team_offline', 'team_connecting']);
  const BOTTOM_SLACK_PX = 48;
  const CONV = 'conv:'; // a project conversation's page id (renderer-team-project-column.js)
  const CONV_PAGES = 200; // the most pages of one conversation (about 4,000 messages)

  const tag = () => (globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined);
  const timeline = () => globalThis.rendererTeamProjectTimeline || require('./renderer-team-project-timeline');
  const isTimeline = (m) => m && typeof m === 'object' && typeof m.id === 'string' && Number.isSafeInteger(m.seq);
  const bySeq = (a, b) => a.seq - b.seq;

  // ------------------------------------------------------------------ gather

  // One conversation, newest page first, then each thread's replies oldest first. `step(answer)` says whether to
  // go on (a refusal, a cancel or the team going offline stops it). A deleted message stays only with replies.
  async function gather({ call, teamId, channelId, step }) {
    const messages = [];
    let before = TOP;
    for (;;) {
      const answer = await call('chatHistory', { team_id: teamId, channel_id: channelId, before_seq: before, limit: PAGE });
      if (!step(answer)) return null;
      const page = (Array.isArray(answer.messages) ? answer.messages : []).filter((m) => isTimeline(m) && !m.thread_root_id && m.seq < before);
      messages.push(...page);
      step(null, page.filter((m) => !m.deleted).length);
      if (answer.has_more !== true || !page.length) break;
      before = page.reduce((low, m) => Math.min(low, m.seq), before);
    }
    messages.sort(bySeq);
    const kept = [];
    for (const message of messages) {
      message.replies = [];
      let after = 0;
      while (message.reply_count > 0) {
        const answer = await call('chatThread', { team_id: teamId, channel_id: channelId, root_id: message.id, after_seq: after, limit: PAGE });
        if (!step(answer)) return null;
        const page = (Array.isArray(answer.replies) ? answer.replies : []).filter((m) => isTimeline(m) && m.seq > after);
        const live = page.filter((m) => !m.deleted);
        message.replies.push(...live);
        step(null, live.length);
        if (answer.has_more !== true || !page.length) break;
        after = page.reduce((high, m) => Math.max(high, m.seq), after);
      }
      message.replies.sort(bySeq);
      if (!message.deleted || message.replies.length) kept.push(message);
    }
    return kept;
  }

  // A host message time as the document wants it: an ISO string.
  const isoOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === 'string' ? v : '');
  const spoken = (m) => m.role === 'user' || (m.role === 'assistant' && (!m.kind || m.kind === 'message') && typeof m.content === 'string' && m.content.trim() !== '');

  // One project conversation (newest page, then older ones): its prompts and each turn's last words, oldest first; null when `step` stopped it.
  async function gatherConversation({ call, teamId, sessionId, step, nameOf, onTitle }) {
    const ids = { team_id: teamId, session_id: sessionId };
    let held = [];
    let before = '';
    let title = '';
    for (let pages = 0; pages < CONV_PAGES; pages += 1) {
      const answer = await call('conversationOpen', before ? { ...ids, before_message_id: before } : ids);
      if (!step(answer)) return null;
      const snap = answer.snapshot && typeof answer.snapshot === 'object' ? answer.snapshot : {};
      const known = new Set(held.map((m) => m.id));
      const page = (Array.isArray(snap.messages) ? snap.messages : []).filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && !known.has(m.id));
      if (!title && snap.session && typeof snap.session.title === 'string') { title = snap.session.title.replace(/\s+/g, ' ').trim().slice(0, 120); if (title) onTitle(title); }
      held = page.concat(held);
      step(null, page.filter(spoken).length);
      if (snap.has_more !== true || !page.length || typeof snap.next_before_message_id !== 'string' || !snap.next_before_message_id) break;
      before = snap.next_before_message_id;
    }
    const jenny = jt('team.conv.jenny', 'Jenny');
    const messages = [];
    for (const item of timeline().groupTurns(held)) {
      if (item.kind === 'member') {
        const m = item.message;
        if (typeof m.content === 'string' && m.content.trim()) messages.push({ id: m.id, sender: nameOf(m.author && m.author.member_id), sent_at: isoOf(m.timestamp), edited: false, text: m.content, replies: [] });
      } else if (item.kind === 'turn' && item.text.trim()) {
        const last = item.messages.findLast((m) => m && m.role === 'assistant' && m.content === item.text);
        messages.push({ id: String(item.id), sender: jenny, sent_at: isoOf((last && last.timestamp) || item.startedAt), edited: false, text: item.text, replies: [] });
      }
    }
    return { name: title || jt('team.projects.untitled', 'Untitled conversation'), kind: 'channel', messages };
  }

  // "{team} {channel} {yyyy-mm-dd}.md" (or "{team} {yyyy-mm-dd}.md"), safe as a Windows file name.
  function fileName(team, conversation, date, timeZone) {
    // The date is always YYYY-MM-DD in Latin digits, whatever the locale.
    const parts = Object.fromEntries(new Intl.DateTimeFormat(tag(), Object.assign(timeZone ? { timeZone } : {}, { year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' }))
      .formatToParts(date).map((x) => [x.type, x.value]));
    const raw = [team, conversation, parts.year + '-' + parts.month + '-' + parts.day].filter(Boolean).join(' ');
    // eslint-disable-next-line no-control-regex
    const safe = raw.replace(/[<>:"/\\|?*\u0000-\u001f#]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
    return Array.from(safe).slice(0, 120).join('').trim() + '.md';
  }

  // --------------------------------------------------------------- exporter

  const countOf = (doc) => doc.conversations.reduce((sum, c) => sum + c.messages.reduce((n, m) => n + (m.deleted ? 0 : 1) + m.replies.length, 0), 0);

  // One run at a time. `phase`: idle, gathering, saving, done, stopped (offline part way), failed (a refusal or the save).
  function createExporter({ call = (m, p) => teamStore.getTeamStore().call(m, p), saveFile = defaultSave, teamOf = defaultTeam, now = () => Date.now() } = {}) {
    let state = { phase: 'idle' };
    let run = 0;
    let last = null;
    const listeners = new Set();
    const set = (next) => { state = next; for (const fn of [...listeners]) { try { fn(state); } catch (_error) { /* one reader must not stop the others */ } } };
    const running = () => state.phase === 'gathering' || state.phase === 'saving';

    async function start({ teamId, scope = 'all', channelId = '', origin = 'tab' } = {}) {
      if (running() || !teamId) return false;
      const team = teamOf(teamId);
      if (!team) return false;
      const mine = ++run;
      last = { teamId, scope, channelId, origin };
      const teamName = team.team_name || jt('settings.team.joined.unnamed', 'Unnamed team');
      const base = { teamId, scope, origin, teamName, label: '', done: 0, total: 0, count: 0 };
      set({ ...base, phase: 'gathering' });
      const stopped = (answer) => {
        const offline = teamOf(teamId)?.state !== 'online' || Boolean(answer && answer.error && OFFLINE.has(answer.error.reason));
        set({ ...state, phase: offline ? 'stopped' : 'failed' });
        return false;
      };
      const step = (answer, added) => {
        if (mine !== run) return false;
        if (answer === null) { set({ ...state, count: state.count + (added || 0) }); return true; }
        if (!answer || !answer.ok || teamOf(teamId)?.state !== 'online') return stopped(answer);
        return true;
      };
      const overview = await call('chatOverview', { team_id: teamId });
      if (!step(overview)) return false;
      const members = new Map((Array.isArray(overview.members) ? overview.members : []).map((m) => [m.member_id, m]));
      const nameOf = (id) => (members.get(id) || {}).display_name || jt('team.chat.formerMember', 'Former member');
      const titleOf = (row) => (channels.isDirect(row) ? channels.namesText(channels.others(row, team.member_id).map(nameOf)) : '#' + channels.channelName(row.channel_id));
      const rows = (Array.isArray(overview.channels) ? overview.channels : []).filter((r) => r && typeof r.channel_id === 'string' && (r.kind !== 'dm' || channels.isDirect(r)));
      const ordered = rows.filter((r) => r.channel_id === channels.CHANNEL).concat(rows.filter((r) => r.channel_id !== channels.CHANNEL && !channels.isDirect(r)),
        rows.filter(channels.isDirect).sort((a, b) => titleOf(a).localeCompare(titleOf(b), tag(), { sensitivity: 'base' })));
      const conv = scope === 'one' && String(channelId).startsWith(CONV);
      const chosen = conv ? [{ channel_id: channelId }] : scope === 'one' ? ordered.filter((r) => r.channel_id === channelId) : ordered;
      if (!chosen.length) return stopped({ ok: false, error: { reason: 'team_chat_not_found' } });
      set({ ...state, total: chosen.length, label: conv ? jt('team.projects.untitled', 'Untitled conversation') : scope === 'one' ? titleOf(chosen[0]) : '' });
      const conversations = [];
      for (const row of chosen) {
        if (conv) {
          const one = await gatherConversation({ call, teamId, sessionId: channelId.slice(CONV.length), step, nameOf, onTitle: (label) => set({ ...state, label }) });
          if (!one) return false;
          conversations.push(one);
          set({ ...state, done: state.done + 1 });
          continue;
        }
        const messages = await gather({ call, teamId, channelId: row.channel_id, step });
        if (!messages) return false;
        // A deleted root carries who deleted it and never its text.
        const shape = (m) => Object.assign({ id: m.id, sender: m.deleted ? '' : m.author && m.author.kind === 'jenny' ? 'Jenny' : nameOf(m.author && m.author.member_id), sent_at: m.created_at,
          edited: Boolean(m.edited_at) && !m.deleted, text: m.deleted ? '' : channels.mentionText(m.text, nameOf), replies: (m.replies || []).map(shape) },
        m.deleted ? { deleted: true, deleted_by: nameOf(m.deleted.by) } : {});
        conversations.push({ name: titleOf(row), kind: channels.isDirect(row) ? 'direct' : 'channel', messages: messages.map(shape) });
        set({ ...state, done: state.done + 1 });
      }
      if (mine !== run) return false;
      const doc = { kind: 'team-export', team: teamName, exportedAt: now(), exportedBy: team.display_name || '', locale: tag(), conversations,
        words: { edited: jt('team.export.edited', ' (edited)'), facts: jt('team.export.facts', '{team} · exported {when} by {you} · {count} messages'),
          deleted: jt('team.chat.deletedBy', 'Message deleted by {name}') } };
      set({ ...state, phase: 'saving', count: countOf(doc) });
      await new Promise((resolve) => { setTimeout(resolve, 0); }); // the line says "saving" before the dialog
      if (mine !== run) return false;
      let result;
      try {
        result = await saveFile({
          defaultName: fileName(teamName, scope === 'one' ? state.label : '', new Date(doc.exportedAt)),
          format: 'markdown',
          document: doc,
          filters: [{ name: jt('team.export.typeMarkdown', 'Markdown, to read'), extensions: ['md'] }, { name: jt('team.export.typeJson', 'JSON, for other tools'), extensions: ['json'] }],
          title: jt('team.export.dialogTitle', 'Export messages'),
        });
      } catch (_error) {
        if (mine === run) set({ ...state, phase: 'failed' });
        return false;
      }
      if (mine !== run) return false;
      if (!result || result.canceled || !result.path) { set({ phase: 'idle' }); return false; }
      set({ ...state, phase: 'done', path: String(result.path) });
      return true;
    }

    return {
      start,
      running,
      state: () => state,
      // Cancel while gathering: nothing is saved and the line closes (the dialog has its own Cancel).
      cancel() { if (state.phase !== 'gathering') return; run += 1; set({ phase: 'idle' }); },
      retry() { if (!last || running()) return false; const again = last; set({ phase: 'idle' }); return start(again); },
      dismiss() { if (!running()) set({ phase: 'idle' }); },
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    };
  }

  function defaultSave(payload) {
    const dialog = typeof window !== 'undefined' && window.jennyShell && window.jennyShell.dialog;
    if (!dialog || typeof dialog.saveFile !== 'function') return Promise.reject(new Error('save unavailable'));
    return dialog.saveFile(payload);
  }
  function defaultTeam(teamId) { return (teamStore.getTeamStore().snapshot().teams || []).find((t) => t && t.team_id === teamId) || null; }

  let shared = null;
  function getExporter() { if (!shared) shared = createExporter(); return shared; }

  // ------------------------------------------------------------------- words

  // The sentence for the state, as approved; '' while nothing is to be said.
  function lineText(s) {
    const count = (s.count || 0).toLocaleString(tag());
    switch (s.phase) {
      case 'gathering':
      case 'saving':
        return s.scope === 'one'
          ? jt('team.export.runningOne', 'Exporting {channel}: {count} messages so far', { channel: s.label, count })
          : jt('team.export.runningAll', 'Exporting: {done} of {total} conversations done, {count} messages so far', { done: s.done, total: s.total, count });
      case 'done':
        return s.scope === 'one'
          ? jt('team.export.doneOne', 'Exported {count} messages from {channel} to {path}', { count, channel: s.label, path: s.path })
          : jt('team.export.doneAll', 'Exported {count} messages from {total} conversations to {path}', { count, total: s.total, path: s.path });
      case 'stopped': return jt('team.export.stopped', 'The export stopped: {team} went offline. Nothing was saved.', { team: s.teamName });
      case 'failed': return jt('artifacts.actions.exportFailed', 'Export failed. Try again.');
      default: return '';
    }
  }

  // ------------------------------------------------------------ the tab's line

  // The team menu's last entry: "Export" with its nested menu (owner pick 10); greyed out offline or while one runs.
  function menuItems({ team, channelId, onPick }) {
    const exporter = getExporter();
    const offline = !team || team.state !== 'online';
    const entry = { label: jt('team.export.menu', 'Export'), value: 'export', disabled: offline || exporter.running(),
      description: offline ? jt('team.export.needsOnline', 'Needs the team online') : '',
      items: [{ label: jt('team.export.menuOne', 'This conversation…'), value: 'export-one', disabled: !/^(chan_|conv:)/.test(String(channelId || '')), action: () => onPick('one', channelId) },
        { label: jt('team.export.menuAll', 'Every conversation…'), value: 'export-all', action: () => onPick('all', '') }] };
    return [{ separator: true }, entry];
  }

  // One status row under the channel head while an export started from the tab is running or has something to say.
  // A new phase redraws it (the timeline keeps its distance from the bottom); a new count only rewrites the
  // words in place, so the Cancel button, its focus and a click in flight stay.
  function createLine() {
    const exporter = getExporter();
    let mounted = null; // { slot, teamId, logOf, html, phase }
    let off = null;
    function paint() {
      if (!mounted || !mounted.slot.isConnected) return;
      const s = exporter.state();
      const text = s.origin === 'tab' && s.teamId === mounted.teamId ? lineText(s) : '';
      const phase = text ? s.phase : '';
      const words = phase && phase === mounted.phase ? mounted.slot.querySelector('.inv-status-row-message') : null;
      if (words) { if (words.textContent !== text) words.textContent = text; return; }
      const inv = globalThis.inventory || {};
      let html = '';
      if (text && typeof inv.statusRow === 'function' && typeof inv.actionButton === 'function') {
        const button = (label, action) => inv.actionButton({ label, variant: 'ghost', size: 'sm', dataset: { 'team-export-action': action } });
        const tone = s.phase === 'done' ? 'success' : s.phase === 'gathering' || s.phase === 'saving' ? 'pending' : s.phase === 'failed' ? 'danger' : 'warning';
        const actions = s.phase === 'gathering' ? button(jt('team.export.cancel', 'Cancel'), 'cancel')
          : s.phase === 'done' ? button(jt('team.export.close', 'Close'), 'close')
            : s.phase === 'saving' ? '' : button(jt('team.export.retry', 'Try again'), 'retry') + button(jt('team.export.close', 'Close'), 'close');
        html = '<div class="team-export">' + inv.statusRow({ tone, message: text, spinner: tone === 'pending', compact: true, ariaLive: 'polite' }) + actions + '</div>';
      }
      mounted.phase = phase;
      if (html === mounted.html) return;
      const log = mounted.logOf();
      const fromBottom = log ? log.scrollHeight - log.scrollTop - log.clientHeight : 0;
      mounted.slot.innerHTML = html;
      mounted.html = html;
      if (log && log.clientHeight > 0) log.scrollTop = fromBottom <= BOTTOM_SLACK_PX ? log.scrollHeight : log.scrollHeight - log.clientHeight - fromBottom;
    }
    function onClick(event) {
      const button = event.target && event.target.closest ? event.target.closest('[data-team-export-action]') : null;
      if (!button) return;
      const action = button.getAttribute('data-team-export-action');
      if (action === 'cancel') exporter.cancel();
      else if (action === 'close') exporter.dismiss();
      else if (action === 'retry') void exporter.retry();
    }
    return {
      mount(slot, teamId, logOf = () => null) {
        if (mounted && mounted.slot !== slot) mounted.slot.removeEventListener('click', onClick);
        if (!slot) { mounted = null; return; }
        mounted = { slot, teamId, logOf, html: null, phase: '' };
        slot.addEventListener('click', onClick);
        if (!off) off = exporter.subscribe(paint);
        paint();
      },
      dispose() { if (off) off(); off = null; if (mounted) mounted.slot.removeEventListener('click', onClick); mounted = null; },
    };
  }

  // The Team tab's one line per window.
  let line = null;
  function tabLine() { if (!line) line = createLine(); return line; }

  return { createExporter, getExporter, tabLine, menuItems, lineText, fileName };
});
