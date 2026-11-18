/* Team desktop notifications and the way into the Team tab from outside it (row 123, slice 2a-6c; owner picks
 * 2026-11-12, mockup team-chat-2a6c).
 *
 * The subscriber: the chat store keeps only the channels a timeline shows, so this reads the `team.onChat`
 * pushes itself, for every channel of every team the chat store holds, while the gate holds the store (the
 * gate starts and stops it with the store; with the `team` flag off nothing here exists). For each new message
 * it applies the spec's rules and hands one candidate to the desktop notifications controller, which sends it
 * to main (main gates the switch, focus, the count per conversation and the click):
 * - never for your own message, an edit, a deletion or a message seen before (a bounded set of ids);
 * - the channel's own level: `none` never, `all` every message, `mentions` (the default for channels; `all` for
 *   direct conversations) only when it mentions you or the channel;
 * - a thread reply only when it mentions you or the thread is one you follow. The host's follow rule is implicit
 *   (you started the thread, replied in it or were mentioned in it) unless you set it by hand, which no push
 *   carries: this keeps the implicit part for the threads it saw in this window;
 * - not for the conversation shown at its latest messages in the focused window (owner pick 8).
 * Titles and second lines are the approved wording; with the preview switch on main shows the message's first
 * line instead. No candidate carries a key, an invite, a member key or a device id: the routing fields are the
 * team, channel, message and thread ids and the message's seq, and mention tokens become names.
 *
 * The way in: a toast's click, a palette row and the palette's export actions ask for an intent here. With the
 * Team tab shown it runs at once; otherwise the tab is opened and the intent runs when the tab attaches, after its
 * first drawing, if that is within 10 seconds (else it is dropped, never run at a later unrelated open). A toast
 * for a team this Jenny is no longer in, with no Team tab left to open, is answered by the desktop notifications
 * controller's toast ("You are no longer in that team.").
 *
 * Row 175 (F1, F2 with F3 folded in; owner decisions D1, D2): a project conversation is reachable from outside the tab
 * (the `conversation` intent: the Team tab opens on that conversation; one no longer listed says so), and main's
 * `project_notice` pushes on `team.onProject` (services/team/project-list.js: this member's own turn finished, failed or
 * waits on an approval or a question, or an approval waits with no writer viewing, never while this member views that
 * conversation, each once) become `teamProject` candidates: the conversation's title (clipped) and one fixed sentence,
 * never message text. Main's `project_waiting` pushes count the approvals that wait for this member, for the Team tab's
 * number (`waitingCount`, `onWaiting`). The switch is one row for every team (Settings > Notifications,
 * `categories.teamProject`, under the Team row), a deviation from D2's per-team list. Row 175 F13 (D8): an `asked` notice (a
 * teammate asked this member to look, or to decide an approval) toasts "<Name> asked you to …" every time, also while that
 * conversation is open, and opens it on a click; it adds no Needs-you row and no digest notice. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-chat-store'), require('./renderer-team-channels'));
    return;
  }
  root.rendererTeamNotify = factory(root.rendererTeamChatStore, root.rendererTeamChannels);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatStore, channels) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SEEN_MAX = 1000;
  const FOLLOW_MAX = 200;
  const PREVIEW_MAX = 240;
  const TITLE_MAX = 120;
  const BOTTOM_SLACK_PX = 48;
  const PENDING_MS = 10000;
  const PROJECT_TITLE_MAX = 80;
  const WAITING_MAX = 2000;
  const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,123}$/;
  const PROJECT_ID = /^project_[A-Za-z0-9_-]{1,128}$/;
  const NOTICE_ID = /^[0-9]{1,15}$/;
  // Row 175 F10: what Home, the Needs-you inbox and the away digest read (in memory only, bounded).
  const ATTENTION_MAX = 50;
  const ATTENTION_TTL_MS = 24 * 60 * 60 * 1000;
  const ATTENTION_EVENT = 'jenny:team-attention';
  const ATTENTION_EMPTY = Object.freeze({ key: '', waiting: Object.freeze([]), notices: Object.freeze([]) });
  // The second line of a project toast, by main's notice word (D2's approved sentences).
  const NOTICE_BODIES = Object.freeze({
    finished: () => jt('team.notify.projectFinished', 'Jenny finished your turn.'),
    failed: () => jt('team.notify.projectFailed', 'Jenny could not finish your turn.'),
    approval: () => jt('team.notify.projectApproval', 'Jenny is waiting for your approval.'),
    question: () => jt('team.notify.projectQuestion', 'Jenny has a question for you.'),
    unattended: () => jt('team.notify.projectUnattended', 'An approval is waiting. Nobody who can answer is viewing.'),
  });
  const MEMBER_ID = /^member_[A-Za-z0-9_-]{1,128}$/;

  const clip = (text, max) => { const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim()); return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };
  function firstLine(text) { return String(text || '').split(/\r?\n/).find((line) => line.trim()) || ''; }
  function bounded(set, value, max) { set.delete(value); set.add(value); while (set.size > max) set.delete(set.values().next().value); }

  // ---------------------------------------------------------------- intents

  let tabApi = null;
  let pending = null; // { intent, at }
  let active = null; // the notifier the window holds: what `attention()` reads
  function shell() { return globalThis.rendererTopNavShellController || null; }

  // A palette row, an export action or a toast's click. Runs now when the Team tab is shown, else after it opens.
  function request(intent) {
    if (!intent || typeof intent !== 'object') return false;
    // Row 175 F10: a conversation asked for from anywhere (a toast, a palette row, a Home row) is acted on: its rows leave.
    if (intent.kind === 'conversation' && active) active.dismiss(intent.teamId, intent.sessionId);
    if (tabApi) { void runIntent(tabApi, intent); return true; }
    const nav = shell();
    pending = { intent, at: Date.now() };
    let opened;
    try { opened = Boolean(nav && typeof nav.openTeamView === 'function' && nav.openTeamView()); } catch (_error) { opened = false; }
    if (!opened) pending = null;
    return opened;
  }

  // The Team tab attaches once it has drawn (renderer-team-tab.js) and runs what was asked at most 10 s before.
  function attachTab(api) {
    tabApi = api;
    const asked = pending && Date.now() - pending.at <= PENDING_MS ? pending.intent : null;
    pending = null;
    if (asked) void runIntent(api, asked);
    return function detach() { if (tabApi === api) tabApi = null; };
  }

  // The Team tab's side of an intent, built from the controls the tab hands over (`tab`).
  function tabIntents(tab) {
    const frame = () => tab.frame();
    const team = (teamId) => tab.teams().find((t) => t.team_id === teamId) || null;
    return {
      show(teamId, channelId, others) {
        if (tab.selectedTeamId() !== teamId) tab.selectTeam(teamId);
        if (channelId) tab.showChannel(teamId, channelId, others);
        if (channelId === channels.NEW && frame() && frame().picker) frame().picker.focus();
      },
      hasTeam: (teamId) => tab.offeredTeams().some((t) => t.team_id === teamId),
      online: (teamId) => Boolean(team(teamId) && team(teamId).state === 'online'),
      memberOf: (teamId) => (team(teamId) || {}).member_id || '',
      jump: (target) => frame() && frame().jumper.jump(target),
      // A page with no timeline (a project page or conversation) says it in the head's note line instead.
      note(text) {
        const f = frame();
        if (f && f.timeline) f.timeline.setNote(text);
        else if (typeof tab.headNote === 'function') tab.headNote(text);
      },
      focusSearch: () => tab.focusSearch(null),
      call: tab.call,
      exportStart: (teamId, scope) => tab.exportStart(teamId, scope),
      // Row 175 F1: true when the conversation was shown, false when it is no longer listed.
      openConversation: (teamId, sessionId) => (typeof tab.openConversation === 'function' ? tab.openConversation(teamId, sessionId) : Promise.resolve(false)),
      shown() {
        const f = frame();
        // A project conversation is shown as the page `conv:<session id>`; Home marks its row "on screen" (row 175 F16).
        const page = f ? String(f.shown.channelId) : '';
        return f ? { teamId: f.shown.teamId, channelId: f.shown.channelId, sessionId: page.startsWith('conv:') && SESSION_ID.test(page.slice(5)) ? page.slice(5) : '',
          log: f.timeline ? f.timeline.logRoot : null } : null;
      },
    };
  }

  // Whether the message the toast named is still there: a deleted or vanished one opens the channel at its latest.
  async function stillThere(api, intent) {
    const { teamId, channelId, messageId, threadRootId, seq } = intent;
    if (!messageId || !Number.isSafeInteger(seq) || seq <= 0) return true;
    const answer = threadRootId
      ? await api.call('chatThread', { team_id: teamId, channel_id: channelId, root_id: threadRootId, after_seq: seq - 1, limit: 1 })
      : await api.call('chatHistory', { team_id: teamId, channel_id: channelId, before_seq: seq + 1, limit: 1 });
    if (!answer || !answer.ok) return Boolean(answer && answer.error && answer.error.reason !== 'team_chat_not_found');
    const list = threadRootId ? answer.replies : answer.messages;
    const found = Array.isArray(list) ? list.find((m) => m && m.id === messageId) : null;
    return Boolean(found && !found.deleted);
  }

  async function runIntent(api, intent) {
    try {
      const { kind, teamId } = intent;
      if (kind === 'search') { api.focusSearch(); return; }
      if (teamId && !api.hasTeam(teamId)) { api.note(jt('team.notify.gone', 'You are no longer in that team.')); return; }
      if (kind === 'new') { api.show(teamId, channels.NEW); return; }
      if (kind === 'person') { await openPerson(api, teamId, intent.memberId); return; }
      if (kind === 'export') { api.exportStart(teamId, intent.scope); return; }
      if (kind === 'conversation') { await openConversation(api, intent); return; }
      if (kind !== 'open' || !intent.channelId) return;
      api.show(teamId, intent.channelId);
      // Offline the channel opens with what this PC has; the jump needs the host.
      if (!intent.messageId || !api.online(teamId)) return;
      if (!(await stillThere(api, intent))) { api.note(jt('team.notify.deleted', 'That message was deleted.')); return; }
      api.jump({ channel_id: intent.channelId, message_id: intent.messageId, seq: intent.seq || 0, root_id: intent.threadRootId || null });
    } catch (_error) { /* an intent that cannot run leaves the tab as it is */ }
  }

  // Row 175 F1: a project conversation, in its team (selected first); one no longer listed says so in the shown channel.
  async function openConversation(api, intent) {
    if (typeof intent.sessionId !== 'string' || !SESSION_ID.test(intent.sessionId)) return;
    api.show(intent.teamId);
    if (!(await api.openConversation(intent.teamId, intent.sessionId))) api.note(jt('team.notify.conversationGone', 'That conversation is no longer here.'));
  }

  // A person: your one-to-one conversation with them when it exists (no create call); else chatDmOpen makes the empty
  // conversation, as the New message picker's Start does (orchestrator decision, 2026-11-12).
  async function openPerson(api, teamId, memberId) {
    const chat = chatStore.getChatStore();
    const state = chat.team(teamId);
    const me = api.memberOf(teamId);
    const row = state ? channels.existing(state.channels, me, [memberId]) : null;
    if (row) { api.show(teamId, row.channel_id); return; }
    const answer = await api.call('chatDmOpen', { team_id: teamId, member_ids: [memberId] });
    if (answer && answer.ok && typeof answer.channel_id === 'string') api.show(teamId, answer.channel_id, [memberId]);
  }

  // ------------------------------------------------------------- subscriber

  function createNotifier({ windowRef, state, store, controller = () => state && state.desktopNotificationsController, onWaiting = () => {}, now = Date.now } = {}) {
    const chat = chatStore.getChatStore();
    const seen = new Set();
    const follows = new Map(); // team id -> root ids this member follows (implicitly) in this window
    const waiting = new Map(); // team id + session id -> approvals waiting for this member (main's `project_waiting`)
    const wait = new Map(); // row 175 F10: team, session and kind -> what waits on this member (main's `project_notice`)
    const done = []; // row 175 F10: finished and failed turns of this member, newest last
    // An approval row a zero count removed, kept a little: a resync or reconnect sends 0 and then the seeded count, and
    // the row comes back with the count instead of waiting for a notice main has already told (key -> row).
    const parked = new Map();
    let off = null;

    const teams = () => (store.snapshot().teams || []).filter((t) => t && t.state !== 'needs_repair');
    const teamOf = (teamId) => teams().find((t) => t.team_id === teamId) || null;
    const followsOf = (teamId) => { if (!follows.has(teamId)) follows.set(teamId, new Set()); return follows.get(teamId); };
    const nameOf = (teamId, id) => (chat.member(teamId, id) || {}).display_name || jt('team.chat.formerMember', 'Former member');

    // The focused window shows this conversation at its latest messages.
    function onScreen(teamId, channelId) {
      const doc = windowRef && windowRef.document;
      if (!tabApi || !doc || typeof doc.hasFocus !== 'function' || !doc.hasFocus() || !state || !state.ui || state.ui.activeView !== 'team') return false;
      const shown = tabApi.shown();
      if (!shown || shown.teamId !== teamId || shown.channelId !== channelId) return false;
      if (chat.timeline(teamId, channelId).hasNewer) return false;
      const log = shown.log;
      return !log || log.clientHeight === 0 || log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK_PX;
    }

    function titleFor(team, record, row, sender, many) {
      if (row && channels.isDirect(row)) {
        const authorId = record.author && record.author.member_id;
        const others = row.participants.filter((id) => id !== team.member_id && id !== authorId).map((id) => nameOf(team.team_id, id));
        if (!others.length) return sender;
        if (others.length === 1) return jt('team.notify.withOne', '{sender}, with {name}', { sender, name: others[0] });
        if (others.length === 2) return jt('team.notify.withTwo', '{sender}, with {first} and {second}', { sender, first: others[0], second: others[1] });
        return jt('team.notify.withMany', '{sender}, with {name} and {count} others', { sender, name: others[0], count: others.length - 1 });
      }
      const title = jt('team.notify.inChannel', '{sender} in #{channel}', { sender, channel: channels.channelName(record.channel_id) });
      return many ? jt('team.notify.inTeam', '{title} · {team}', { title, team: team.team_name || '' }) : title;
    }

    // One record of a `messages` push: a candidate, or null.
    function consider(team, channelId, record) {
      if (!record || typeof record.id !== 'string' || !Number.isSafeInteger(record.seq) || !record.author || typeof record.author !== 'object') return null;
      const known = seen.has(record.id);
      bounded(seen, record.id, SEEN_MAX);
      if (known || record.deleted || record.edited_at) return null;
      const author = record.author;
      const me = team.member_id;
      const mentions = Array.isArray(record.mentions) ? record.mentions : [];
      const root = typeof record.thread_root_id === 'string' ? record.thread_root_id : '';
      const followed = followsOf(team.team_id);
      if (author.kind !== 'jenny' && author.member_id === me) { bounded(followed, root || record.id, FOLLOW_MAX); return null; }
      const mentioned = Boolean(me) && (mentions.includes(me) || mentions.includes('channel'));
      if (root && mentions.includes(me)) bounded(followed, root, FOLLOW_MAX);
      const row = chat.channel(team.team_id, channelId);
      const direct = channels.isDirectId(channelId);
      const level = (row && row.notify) || (direct ? 'all' : 'mentions');
      if (level === 'none') return null;
      if (root ? !(mentioned || followed.has(root)) : !(level === 'all' || mentioned)) return null;
      if (onScreen(team.team_id, channelId)) return null;
      const sender = author.kind === 'jenny' ? 'Jenny' : nameOf(team.team_id, author.member_id);
      let body = jt('team.notify.newMessage', 'New message');
      if (direct) body = jt('team.notify.direct', 'Direct message');
      if (mentioned) body = jt('team.notify.mentioned', 'Mentioned you');
      else if (root) body = jt('team.notify.followed', 'Replied in a thread you follow');
      const others = row && channels.isDirect(row) ? row.participants.filter((id) => id !== me).map((id) => nameOf(team.team_id, id)) : [];
      const candidate = {
        category: 'team', key: 'team:' + record.id, teamId: team.team_id, channelId, messageId: record.id, seq: record.seq,
        title: clip(titleFor(team, record, row, sender, teams().length > 1), TITLE_MAX), body, sender: clip(sender, 80),
        conversation: clip(direct ? (others.length ? channels.namesText(others) : sender) : '#' + channels.channelName(channelId), TITLE_MAX),
      };
      if (root) candidate.threadRootId = root;
      const preview = clip(firstLine(channels.mentionText(record.text, (id) => nameOf(team.team_id, id))), PREVIEW_MAX);
      if (preview) candidate.preview = preview;
      return candidate;
    }

    // What the renderer already holds of the settings: off, or team off, cannot toast, so nothing is sent (main decides the rest).
    function canToast() {
      const settings = state && state.ui && state.ui.notifications;
      return !settings || (settings.enabled !== false && !(settings.categories && settings.categories.team === false));
    }

    // Row 175 F2: what the renderer holds of the settings: off, Team off or Project activity off cannot toast.
    function canToastProject() {
      const settings = state && state.ui && state.ui.notifications;
      const categories = (settings && settings.categories) || {};
      return canToast() && categories.teamProject !== false;
    }

    // One `project_notice` push: a candidate, or null. Titles are host text, clipped; main chose the notice word.
    function projectCandidate(payload) {
      const team = teamOf(payload.team_id);
      const body = payload.notice === 'asked' ? askedBody(payload) : Object.hasOwn(NOTICE_BODIES, payload.notice) ? NOTICE_BODIES[payload.notice]() : '';
      if (!team || chatStore.LOCKED_STATES.has(team.state) || !body || typeof payload.session_id !== 'string' || !SESSION_ID.test(payload.session_id)
        || typeof payload.notice_id !== 'string' || !NOTICE_ID.test(payload.notice_id)) return null;
      const candidate = { category: 'teamProject', key: 'teamProject:' + payload.session_id.slice(-60) + ':' + payload.notice_id, teamId: team.team_id,
        sessionId: payload.session_id, title: clip(payload.title, PROJECT_TITLE_MAX) || jt('team.notify.projectUntitled', 'A project conversation'), body };
      if (typeof payload.project_id === 'string' && PROJECT_ID.test(payload.project_id)) candidate.projectId = payload.project_id;
      return candidate;
    }

    // F13: who asked, and to look or to decide an approval; '' when the asker is not a member id.
    function askedBody(payload) {
      if (typeof payload.asker_member_id !== 'string' || !MEMBER_ID.test(payload.asker_member_id)) return '';
      const params = { name: clip(nameOf(payload.team_id, payload.asker_member_id), 64), title: clip(payload.title, PROJECT_TITLE_MAX) || jt('team.notify.projectUntitled', 'A project conversation') };
      return typeof payload.approval_id === 'string' ? jt('team.notify.askedApproval', '{name} asked you to decide an approval in {title}', params) : jt('team.notify.asked', '{name} asked you to look at {title}', params);
    }

    function tellWaiting() { try { onWaiting(); } catch (_error) { /* the number must not stop the pushes */ } }

    function setWaiting(teamId, sessionId, count) {
      const key = teamId + '\u0000' + sessionId;
      const before = waiting.get(key) || 0;
      const next = Number.isSafeInteger(count) && count > 0 ? count : 0;
      const rowKey = waitKey(teamId, sessionId, 'approval');
      if (!next && wait.has(rowKey)) { parked.set(rowKey, wait.get(rowKey)); while (parked.size > ATTENTION_MAX) parked.delete(parked.keys().next().value); }
      if (!next && forget(teamId, sessionId, 'approval')) announce();
      const back = next ? parked.get(rowKey) : null;
      if (back) { parked.delete(rowKey); if (now() - back.at < ATTENTION_TTL_MS) { wait.set(rowKey, back); announce(); } }
      if (before === next || (next && !before && waiting.size >= WAITING_MAX)) return;
      if (next) waiting.set(key, next); else waiting.delete(key);
      tellWaiting();
    }

    function dropTeam(teamId) {
      const before = waiting.size;
      for (const key of [...waiting.keys()]) if (key.startsWith(teamId + '\u0000')) waiting.delete(key);
      const mine = wait.size + done.length;
      for (const key of [...wait.keys()]) if (key.startsWith(teamId + '\u0000')) wait.delete(key);
      for (const key of [...parked.keys()]) if (key.startsWith(teamId + '\u0000')) parked.delete(key);
      for (let i = done.length - 1; i >= 0; i -= 1) if (done[i].teamId === teamId) done.splice(i, 1);
      if (wait.size + done.length !== mine) announce();
      if (waiting.size !== before) tellWaiting();
    }

    // ------------------------------------------------ row 175 F10: what waits, and what finished, for the home views

    function announce() {
      try {
        if (windowRef && typeof windowRef.dispatchEvent === 'function') windowRef.dispatchEvent(new (windowRef.Event || Event)(ATTENTION_EVENT));
      } catch (_error) { /* a view that cannot be told reads it on its next pass */ }
    }

    const waitKey = (teamId, sessionId, kind) => teamId + '\u0000' + sessionId + '\u0000' + kind;

    function forget(teamId, sessionId, kind) { return wait.delete(waitKey(teamId, sessionId, kind)); }

    // A conversation asked for (a click on a row or a toast): everything that waited in it leaves.
    function dismiss(teamId, sessionId) {
      const gone = [forget(teamId, sessionId, 'approval'), forget(teamId, sessionId, 'question')];
      if (gone.includes(true)) announce();
    }

    // One accepted notice: finished and failed turns go to the digest; an approval or a question waits until answered,
    // its turn ends or the conversation is opened. Bounded, and never kept longer than a day.
    function remember(payload, candidate) {
      const base = { teamId: candidate.teamId, sessionId: candidate.sessionId, projectId: candidate.projectId || '', title: candidate.title, at: now() };
      const word = payload.notice;
      if (word === 'approval' || word === 'unattended' || word === 'question') {
        const kind = word === 'question' ? 'question' : 'approval';
        const key = waitKey(base.teamId, base.sessionId, kind);
        wait.delete(key);
        wait.set(key, { ...base, kind, unattended: word === 'unattended', count: 1 });
        while (wait.size > ATTENTION_MAX) wait.delete(wait.keys().next().value);
      } else {
        forget(base.teamId, base.sessionId, 'question');
        done.push({ ...base, notice: word, id: payload.notice_id });
        while (done.length > ATTENTION_MAX) done.shift();
      }
      announce();
    }

    // The project's name from the project store once the Team tab has loaded it, else the team's own name.
    function whereOf(teamId, projectId) {
      let name;
      try {
        const projects = windowRef && windowRef.rendererTeamProjectStore && windowRef.rendererTeamProjectStore.getProjectStore();
        const row = projects && projectId ? projects.project(teamId, projectId) : null;
        name = row && typeof row.name === 'string' ? clip(row.name, PROJECT_TITLE_MAX) : '';
      } catch (_error) { name = ''; }
      return name || clip((teamOf(teamId) || {}).team_name, PROJECT_TITLE_MAX);
    }

    // With Team or Project activity off (Settings > Notifications) the home views show no Team row at all.
    function shownOnHome() {
      const categories = (state && state.ui && state.ui.notifications && state.ui.notifications.categories) || {};
      return categories.team !== false && categories.teamProject !== false;
    }

    // What the Needs-you inbox and the away digest draw: waiting rows in arrival order, finished and failed turns of the
    // last 24 hours. `onScreen` needs the Team tab to say which conversation it shows (`shown().sessionId`).
    function attention() {
      if (!shownOnHome()) return ATTENTION_EMPTY;
      const cutoff = now() - ATTENTION_TTL_MS;
      const frame = tabApi && state && state.ui && state.ui.activeView === 'team' ? tabApi.shown() : null;
      const fresh = (row) => row.at >= cutoff && Boolean(teamOf(row.teamId));
      const rows = [...wait.values()].filter(fresh).map((row) => ({ kind: row.kind, unattended: row.unattended, teamId: row.teamId,
        projectId: row.projectId, sessionId: row.sessionId, title: row.title, where: whereOf(row.teamId, row.projectId), count: row.count,
        onScreen: Boolean(frame && frame.teamId === row.teamId && frame.sessionId === row.sessionId) }));
      const notices = done.filter(fresh).map((row) => ({ notice: row.notice, teamId: row.teamId, projectId: row.projectId, sessionId: row.sessionId,
        title: row.title, where: whereOf(row.teamId, row.projectId), at: row.at, id: row.id }));
      if (!rows.length && !notices.length) return ATTENTION_EMPTY;
      const key = rows.map((r) => [r.kind, r.unattended, r.teamId, r.sessionId, r.title, r.where, r.count, r.onScreen].join('\u0002')).join('\u0001')
        + '\u0003' + notices.map((n) => [n.teamId, n.id, n.notice, n.title, n.where, n.at].join('\u0002')).join('\u0001');
      return { key, waiting: rows, notices };
    }

    function onProject(payload) {
      if (!payload || typeof payload !== 'object' || typeof payload.team_id !== 'string') return;
      if (payload.kind === 'team_gone') { dropTeam(payload.team_id); return; }
      if (payload.kind === 'project_waiting' && typeof payload.session_id === 'string') { setWaiting(payload.team_id, payload.session_id, payload.count); return; }
      if (payload.kind !== 'project_notice') return;
      const candidate = projectCandidate(payload);
      if (candidate && payload.notice !== 'asked') remember(payload, candidate);
      const target = candidate && canToastProject() ? controller() : null;
      if (target && typeof target.notifyTeam === 'function') target.notifyTeam(candidate);
    }

    function onChat(payload) {
      if (!payload || typeof payload !== 'object' || typeof payload.team_id !== 'string') return;
      if (payload.type === 'cleared') { follows.delete(payload.team_id); return; }
      if (payload.type !== 'messages' || payload.reset === true || typeof payload.channel_id !== 'string' || !Array.isArray(payload.messages)) return;
      const team = teamOf(payload.team_id);
      if (!team || !chat.team(team.team_id) || chatStore.LOCKED_STATES.has(team.state)) return;
      for (const record of payload.messages) {
        // `consider` still runs while nothing can toast: it records seen messages and followed threads.
        const candidate = consider(team, payload.channel_id, record);
        if (candidate && !canToast()) continue;
        const target = candidate ? controller() : null;
        if (target && typeof target.notifyTeam === 'function') target.notifyTeam(candidate);
      }
    }

    // A team toast's click: the window is already forward (main); the Team tab opens at the message. False when
    // nothing opened because the team is gone (the controller then says so with a toast).
    function onOpen(payload) {
      if (payload && payload.category === 'teamProject') return onProjectOpen(payload);
      if (!payload || typeof payload.teamId !== 'string' || typeof payload.channelId !== 'string') return true;
      const opened = request({ kind: 'open', teamId: payload.teamId, channelId: payload.channelId, messageId: payload.messageId || '',
        threadRootId: payload.threadRootId || '', seq: Number.isSafeInteger(payload.seq) ? payload.seq : 0 });
      return opened || Boolean(teamOf(payload.teamId));
    }

    // A project toast's click: the conversation intent (F1).
    function onProjectOpen(payload) {
      if (typeof payload.teamId !== 'string' || typeof payload.sessionId !== 'string') return true;
      const opened = request({ kind: 'conversation', teamId: payload.teamId, sessionId: payload.sessionId, projectId: payload.projectId || '' });
      return opened || Boolean(teamOf(payload.teamId));
    }

    function start() {
      if (off) return;
      const api = windowRef && windowRef.jennyShell && windowRef.jennyShell.team;
      const unsubscribe = api && typeof api.onChat === 'function' ? api.onChat(onChat) : null;
      const unsubscribeProject = api && typeof api.onProject === 'function' ? api.onProject(onProject) : null;
      const target = controller();
      if (target && typeof target.setTeamOpenHandler === 'function') target.setTeamOpenHandler(onOpen);
      off = () => {
        for (const fn of [unsubscribe, unsubscribeProject]) if (typeof fn === 'function') { try { fn(); } catch (_error) { /* best effort */ } }
        const current = controller();
        if (current && typeof current.setTeamOpenHandler === 'function') current.setTeamOpenHandler(null);
      };
    }

    function stop() {
      if (off) off();
      off = null;
      seen.clear();
      follows.clear();
      waiting.clear();
      wait.clear();
      done.length = 0;
      if (active === api) { active = null; announce(); }
    }

    // The approvals waiting for this member across the teams (the Team tab's number).
    function waitingCount() {
      let total = 0;
      for (const count of waiting.values()) total += count;
      return total;
    }

    start();
    const api = { stop, waitingCount, attention, dismiss };
    active = api;
    return api;
  }

  // Row 175 F10: what waits on this member and what finished, for Home, the inbox and the digest (empty without a notifier).
  function attention() { return active ? active.attention() : ATTENTION_EMPTY; }

  // What the shown Team tab shows ({ teamId, channelId, log }), or null while it is hidden.
  function shownFrame() { return tabApi ? tabApi.shown() : null; }

  return { createNotifier, request, attachTab, tabIntents, shownFrame, attention, ATTENTION_EVENT };
});
