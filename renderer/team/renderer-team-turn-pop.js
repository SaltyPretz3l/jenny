/* Team tab: the transcript popover of a shared conversation (row 171). One turn's full work (the prompt, reasoning,
 * tool rows and text) drawn with the local chat's own pure row chain: normalizeChatMessages -> projectTurnTree ->
 * projectTurnRows -> createTurnRowRenderUtils(...).buildTurnRowListMarkup, inside the chain's own article shells.
 * Questions and approvals never go through the chain: the controller passes the Team builders' markup as `extraHtml`.
 * The messages come from other machines: they reach the chain only through the adapter's whitelist
 * (renderer-team-turn-adapter.js), and the rendered markup is swept of every local-desktop affordance the chain still
 * draws from kept fields (a tool input's path chip, a "Review changes" button, a report_findings block, ...). Without a
 * document to sweep with, or with a chain module missing, the body falls back to the prompt and the last text as plain
 * escaped paragraphs. No conversation state lives here (which turn is open, the queue, the lease): the controller owns it.
 * Row 175: the body is patched in place (renderer-team-turn-pop-patch.js), the chain is keyed by the model's turnId, focus
 * is kept across a repaint, and the scroller's follow state is the popover's own (renderer-team-turn-pop-follow.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-turn-adapter'), require('./renderer-team-turn-pop-patch'), require('./renderer-team-turn-pop-follow'));
    return;
  }
  root.rendererTeamTurnPop = factory(root.rendererTeamTurnAdapter, root.rendererTeamTurnPopPatch, root.rendererTeamTurnPopFollow);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapter, patchApi, followApi) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // A module: the app's global, or under Node the file. In the app `require` is the editor's loader and throws.
  function load(globalName, path) {
    if (globalThis[globalName]) return globalThis[globalName];
    try { return typeof require === 'function' ? require(path) || null : null; } catch (_error) { return null; }
  }
  const escapeHtml = (load('stringUtils', '../shared/string-utils') || {}).escapeHtml
    || ((v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  // The inventory's button builder: the app's global, or under Node the module at first use.
  let nodeButton;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || nodeButton || (nodeButton = require('../inventory/action-button')))(o);

  const toLocalMessages = adapter ? adapter.toLocalMessages : () => [];
  const liveMessage = adapter ? adapter.liveMessage : () => null;
  const clean = adapter ? adapter.clean : (v, max = 80) => String(typeof v === 'string' ? v : '').trim().slice(0, max);

  // The timeline says 'everything' (the chat CSS hides nothing); the rows take the chat's default view, 'thinking', so a
  // settled reasoning phase and a settled tool row start closed, as in the approved mockup ('everything' opens them all).
  const OPEN = '<div class="chat-timeline" data-transcript-view="everything">';
  const ROW_VIEW = 'thinking';
  const ACTIONS = new Set(['stop', 'prev', 'next', 'close']);
  const TOGGLE_CAP = 500;
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const STOP_ICON = SVG('<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>');
  const UP_ICON = SVG('<path d="m4.5 9.5 3.5-3.5 3.5 3.5"/>');
  const DOWN_ICON = SVG('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>');
  const CLOSE_ICON = SVG('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>');
  const NONE = () => '';

  // [chain key, app global, Node path]. The last three only serve the popover's toggles and are optional.
  const CHAIN = [
    ['normalizeChatMessages', 'chatMessageUtils', '../chat/chat-message-utils'],
    ['projectTurnTree', 'rendererTurnTreeProjector', '../chat/renderer-turn-tree-projector'],
    ['projectTurnRows', 'rendererTurnRowProjector', '../chat/renderer-turn-row-projector'],
    ['createTurnRowRenderUtils', 'rendererTurnRowRenderUtils', '../chat/renderer-turn-row-render-utils'],
    ['createReasoningV2Renderer', 'rendererTranscriptReasoningV2', '../chat/renderer-transcript-reasoning-v2'],
    ['ThinkingPanelController', 'chatThinkingUtils', '../chat/chat-thinking-utils'],
    ['groupReasoningByPhase', 'chatThinkingUtils', '../chat/chat-thinking-utils'],
    ['shouldShowThinkingToggle', 'chatThinkingUtils', '../chat/chat-thinking-utils'],
    ['createTurnShellRenderer', 'rendererTurnShell', '../chat/renderer-turn-shell'],
    ['setToolRowExpansion', 'rendererTurnRowToolRenderUtils', '../chat/renderer-turn-row-tool-render-utils'],
    ['clearToolRowExpansionOverridesForSession', 'rendererTurnRowToolRenderUtils', '../chat/renderer-turn-row-tool-render-utils'],
    ['toolRowKeySessionPrefix', 'toolCallUtils', '../chat/tool-call-utils'],
    // Clears one collapsed row's lazy detail context (there is no per-session clear for those): used on dispose.
    ['materializeToolRowDetails', 'rendererTurnRowToolRenderUtils', '../chat/renderer-turn-row-tool-render-utils'],
    ['createReasoningLiveBoxFollow', 'rendererReasoningLiveBoxFollow', '../chat/renderer-reasoning-live-box-follow'],
    ['autocollapse', 'rendererReasoningAutocollapseUtils', '../chat/renderer-reasoning-autocollapse-utils', true],
  ];
  const REQUIRED = CHAIN.slice(0, 9).map((entry) => entry[0]);
  let baseChain = null;
  function resolveChain() {
    if (baseChain) return baseChain;
    const out = {};
    for (const [key, globalName, path, whole] of CHAIN) {
      const mod = load(globalName, path);
      out[key] = mod ? (whole ? mod : mod[key]) : undefined;
    }
    if (REQUIRED.every((key) => typeof out[key] === 'function')) baseChain = out;
    return out;
  }
  // The chain, with an optional override per key (tests), or null when a required module is missing.
  function chainOf(deps) {
    const chain = deps && typeof deps === 'object' ? Object.assign({}, resolveChain(), deps) : resolveChain();
    return REQUIRED.every((key) => typeof chain[key] === 'function') ? chain : null;
  }

  // Affordances the chain draws from fields the whitelist keeps, each acting on the local desktop through a
  // document-level handler (review findings, test summaries, notes, memory, artifacts, code review, logs links).
  const SWEPT = ['[data-inv-error-action]', '[data-inv-artifact-action]', '[data-inv-copy-target]', '.inv-artifact-card',
    '.inv-artifact-figure', '[data-artifact-id]', '[data-review-findings]', '[data-review-finding-action]', '.tool-test-progress',
    '[data-test-progress-action]', '.cal-chat', '[data-cal-chat]', '.notes-chat__row', '[data-notes-open]', '[data-notes-undo]',
    '[data-memory-notes-group]', '[data-memory-undo]', '.session-message-receipt', '[data-session-message-op]',
    '[data-message-strip-action]', '[data-jenny-code-review]', '[data-subagent-open]', '[data-resume-turn]', '.tool-call-row-action'].join(', ');
  const PATH_CLASSES = ['tool-path-chip', 'chat-inline-path'];
  // Removes the swept elements; a path chip or inline path stays as plain text without its link semantics, unless `adopt`
  // (the conversation's path controller, row 175 item 1) keeps it as a chip that opens the project's file explorer.
  function sweepAffordances(rootNode, adopt) {
    rootNode.querySelectorAll(SWEPT).forEach((node) => node.remove());
    // The adapter marks only a change over its bound as truncated (row 175, item 3).
    rootNode.querySelectorAll('.file-diff-truncated').forEach((node) => { node.textContent = jt('team.turn.changeTooLong', 'Change too long to show here.'); });
    rootNode.querySelectorAll('*').forEach((el) => {
      if (adopt && adopt(el)) return;
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('data-chat-path') || name.startsWith('data-inv-')) el.removeAttribute(name);
      }
      if (PATH_CLASSES.some((c) => el.classList.contains(c))) {
        el.classList.remove(...PATH_CLASSES);
        for (const name of ['role', 'tabindex', 'title']) el.removeAttribute(name);
        if (!el.classList.length) el.removeAttribute('class');
      }
    });
  }

  const str = (v) => (typeof v === 'string' ? v : '');
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const isText = (m) => m.role === 'assistant' && (!m.kind || m.kind === 'assistant' || m.kind === 'text');

  function plainBody(messages) {
    const list = messages.map(obj);
    const prompt = list.find((m) => m.role === 'user' && str(m.content).trim());
    const last = list.slice().reverse().find((m) => isText(m) && str(m.content).trim());
    const para = (m) => (m ? '<p class="team-turn-pop__plain" dir="auto">' + escapeHtml(str(m.content)) + '</p>' : '');
    return OPEN + para(prompt) + para(last) + '</div>';
  }

  // A compaction (row 175, F14): one fixed quiet line at its place; the host's notice (its summary, its counts) is never drawn.
  const compactedNotice = () => '<div class="chat-system-notice team-turn-pop__compact" role="note" dir="auto">'
    + escapeHtml(jt('team.turn.compacted', 'Jenny summarised earlier turns to make room. Older details may be forgotten.')) + '</div>';

  const mdWith = (fn) => (text) => {
    const value = String(text == null ? '' : text);
    try { return typeof fn === 'function' ? String(fn(value) || '') : '<p>' + escapeHtml(value) + '</p>'; } catch (_error) { return '<p>' + escapeHtml(value) + '</p>'; }
  };
  // Streaming text (the bubble and a live reasoning body) goes through `liveMarkdown`, which skips the shared cache.
  function createRenderer(chain, markdown, controller, liveMarkdown) {
    const md = mdWith(markdown);
    const live = mdWith(typeof liveMarkdown === 'function' ? liveMarkdown : markdown);
    const units = (text) => ({ html: live(text), units: [], changedStartIndex: -1 });
    const thinking = chain.createReasoningV2Renderer({ escapeHtml, groupReasoningByPhase: chain.groupReasoningByPhase,
      getReasoningEntries: (m) => (m && m.reasoning && Array.isArray(m.reasoning.entries) ? m.reasoning.entries : []),
      renderMarkdown: md, renderStreamingMarkdownUnits: units, shouldShowThinkingToggle: chain.shouldShowThinkingToggle,
      thinkingController: controller });
    // Every card and chip renderer the chain would otherwise resolve from the app's globals answers nothing here.
    const rows = chain.createTurnRowRenderUtils({ escapeHtml, renderMarkdown: md, renderStreamingMarkdownUnits: units,
      renderContextCompactedNotice: compactedNotice,
      renderThinkingWidget: thinking.renderThinkingWidget, getApprovalCardState: () => null, renderApprovalBlock: NONE,
      renderUserQuestionsBlock: NONE, renderUserQuestionsReceipt: NONE, renderArtifactTeaser: NONE, renderMessageAttachments: NONE,
      buildInteractiveBatchRowMarkup: NONE, getFeatureFlags: () => ({}) });
    return { rows, shell: chain.createTurnShellRenderer({ escapeHtml }) };
  }

  // One turn key for every message: the host may stamp a tool message with the collector's id or the stream id.
  function turnKeyOf(messages) {
    const keyed = messages.find((m) => m.role !== 'user' && str(m.turn_id)) || messages.find((m) => str(m.turn_id));
    return keyed ? keyed.turn_id : 'team-turn';
  }

  // The model's turnId keys every row when it has one: a saved message stamped with another turn_id (the collector's or
  // the stream's) must not re-identify the rows.
  function chainBody(messages, chain, renderer, sessionKey, running, turnKey) {
    const key = clean(turnKey, 200) || turnKeyOf(messages);
    const local = chain.normalizeChatMessages(messages.map((m) => ({ ...m, turn_id: key })));
    const turns = obj(chain.projectTurnTree({ messages: local })).turns || [];
    const rows = turns.flatMap((t) => chain.projectTurnRows(obj(t).events || [], { deterministicRowId: true }) || []);
    const streaming = local.filter((m) => m.status === 'streaming').pop();
    const live = Boolean(streaming) || running === true;
    const options = { turnRows: rows, transcriptView: ROW_VIEW, sessionId: sessionKey, turnId: key,
      messageById: new Map(local.map((m) => [m.id, m])), streamingMessageId: streaming ? streaming.id : '',
      turnLive: live, turnPhase: live ? '' : 'done' };
    // The assistant article is keyed by the turn, not by its first message (live-<stream> until the first save).
    const turnAttrs = 'data-turn-id="' + escapeHtml(key) + '" data-pop-key="turn:' + escapeHtml(key) + '"';
    const article = (role, message, list) => {
      const listHtml = list.length ? renderer.rows.buildTurnRowListMarkup(list, local, options) : '';
      if (!listHtml.includes('data-row-id=')) return '';
      const pending = role === 'assistant' && live;
      const msg = obj(message);
      return renderer.shell.buildMessageShellArticle({ className: role === 'user' ? 'user' : 'assistant' + (pending ? ' pending' : ''),
        messageId: str(msg.id), messageRole: role, messageStatus: pending ? 'streaming' : str(msg.status) || 'complete',
        finalizedAt: str(msg.finalizedAt), extraAttributes: role === 'assistant' ? turnAttrs : '',
        innerHtml: '<div class="chat-message-content">' + listHtml + '</div>' });
    };
    return OPEN + article('user', local.find((m) => m.role === 'user'), rows.filter((r) => r.kind === 'user_bubble'))
      + article('assistant', local.find((m) => m.role === 'assistant'), rows.filter((r) => r.kind !== 'user_bubble')) + '</div>';
  }

  function swept(html, doc, adopt) {
    const template = doc.createElement('template');
    template.innerHTML = html;
    sweepAffordances(template.content, adopt);
    return template.innerHTML;
  }

  function bodyOf({ messages, doc, chain, renderer, sessionKey, live, turnKey, adopt }) {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
    if (!doc || typeof doc.createElement !== 'function' || !chain || !renderer) return plainBody(list);
    try {
      return swept(chainBody(list, chain, renderer, sessionKey, live, turnKey), doc, adopt);
    } catch (_error) {
      return plainBody(list);
    }
  }

  /** The chain's markup for one turn of local-shape messages, swept of local affordances; the plain body without the chain. */
  function turnBodyHtml({ messages, markdown, doc, sessionKey, deps, turnId } = {}) {
    const d = doc || globalThis.document;
    const chain = chainOf(deps);
    let renderer;
    try { renderer = chain ? createRenderer(chain, markdown, new chain.ThinkingPanelController()) : null; } catch (_error) { renderer = null; }
    return bodyOf({ messages, doc: d, chain, renderer, sessionKey: clean(sessionKey, 200) || 'team-turn-pop', turnKey: turnId });
  }

  // The asker's name above the prompt (D9) and a failed or stopped turn's end line (A7): plain, escaped, keyed.
  function promptByHtml(name) {
    const who = clean(name, 64);
    return who ? '<p class="team-turn-pop__by" data-pop-key="prompt-by" dir="auto">' + escapeHtml(jt('team.turn.askedBy', 'Asked by {name}', { name: who })) + '</p>' : '';
  }
  function endHtml(end) {
    const e = obj(end);
    const kind = str(e.kind);
    if (kind !== 'failed' && kind !== 'stopped') return '';
    return '<p class="team-turn-pop__end" data-pop-key="end" data-end-kind="' + kind + '">' + escapeHtml(clean(e.text, 240)) + '</p>';
  }

  // ------------------------------------------------------------ the popover

  // Without the patch script (not loaded) the body is replaced whole; without the follow script nothing follows.
  const WHOLE = { patchChildren: (el, fragment) => { el.textContent = ''; el.appendChild(fragment); } };
  const NO_FOLLOW = { afterPatch() {}, reset() {}, isFollowing: () => false, dispose() {} };
  // The scripts beside this one: the factory's under Node, the app's globals (resolved at use, whatever the load order).
  const sideModules = () => [patchApi || globalThis.rendererTeamTurnPopPatch || null, followApi || globalThis.rendererTeamTurnPopFollow || null];
  const rowOf = (rootNode, rowId) => Array.from(rootNode.querySelectorAll('[data-row-id]')).find((n) => n.getAttribute('data-row-id') === rowId) || null;

  // The local settle delay (renderer-stream-reveal-utils.js readSettleDelayMs): the motion token plus its margin.
  function collapseMs(win, doc) {
    let ms = 220;
    try {
      const raw = String(win.getComputedStyle(doc.documentElement).getPropertyValue('--motion-duration-regular') || '').trim();
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n) && /m?s$/.test(raw)) ms = raw.endsWith('ms') ? n : n * 1000;
    } catch (_error) { /* the default */ }
    return ms + 80;
  }

  function iconButton(kind, icon, label, disabled) {
    return actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: label, title: label, disabled: Boolean(disabled),
      dataset: { 'pop-action': kind }, trustedHtml: icon });
  }
  function headHtml(m) {
    const stopLabel = jt('team.turn.stop', 'Stop');
    const stop = m.canStop ? actionButton({ size: 'sm', className: 'team-turn-pop__stop', title: stopLabel, dataset: { 'pop-action': 'stop' },
      trustedHtml: STOP_ICON + escapeHtml(stopLabel) }) : '';
    return '<div class="team-turn-pop__title"><b>' + escapeHtml(clean(m.title, 120)) + '</b><span dir="auto">' + escapeHtml(clean(m.sub, 240)) + '</span></div>'
      + stop + iconButton('prev', UP_ICON, jt('team.turn.earlier', 'Earlier turn'), !m.canPrev)
      + iconButton('next', DOWN_ICON, jt('team.turn.later', 'Later turn'), !m.canNext)
      + iconButton('close', CLOSE_ICON, jt('team.turn.close', 'Close (Esc)'), false);
  }

  /** The popover in `host` (an empty container). `onAction(kind, detail)` gets 'stop' | 'prev' | 'next' | 'close'.
   * `liveMarkdown` draws streaming text (no shared cache); `deps` overrides chain keys (tests). */
  function createTurnPop({ host, doc, markdown, liveMarkdown, sessionKey, onAction, deps, paths } = {}) {
    const d = doc || (host && host.ownerDocument) || globalThis.document;
    const key = clean(sessionKey, 200) || 'team-turn-pop';
    const act = typeof onAction === 'function' ? onAction : () => {};
    const [P, F] = sideModules();
    const toggles = new Map();
    const toolKeys = new Set();
    const patcher = P ? P.createPatcher() : WHOLE;
    let chain = null;
    let chainMemo = null;
    let renderer = null;
    let controller = null;
    let aside = null, headEl = null, scrollEl = null, footEl = null;
    let follow = NO_FOLLOW;
    let liveBox = null;
    let last = {};
    let shown = { head: '', main: '', body: '', foot: '' };
    // What the chain body was last drawn from: the same messages list, live flag and turn draw the same body, so a
    // repaint (the turn's clock, another region's change) skips the chain unless a toggle changed it.
    let drawnFrom = null;
    let followTurn = null;
    let readerToggle = false;
    let disposed = false;

    function chainFor() {
      if (!deps || typeof deps !== 'object') return chainOf(null);
      if (!chainMemo) chainMemo = chainOf(deps);
      return chainMemo;
    }
    function ensureChain() {
      const next = chainFor();
      if (next && next !== chain) {
        chain = next;
        try { controller = controller || new chain.ThinkingPanelController(); renderer = createRenderer(chain, markdown, controller, liveMarkdown); } catch (_error) { renderer = null; }
      }
      return next;
    }
    const ownPrefix = () => (chain && typeof chain.toolRowKeySessionPrefix === 'function' ? chain.toolRowKeySessionPrefix(key) : 'session=' + encodeURIComponent(key) + '|');
    // A remembered toggle is applied once: after its click, and again only when its row's message id changed.
    function applyToggles() {
      for (const t of toggles.values()) {
        if (!t.pending) continue;
        t.pending = false;
        if (t.kind === 'tool' && typeof chain.setToolRowExpansion === 'function' && t.rowKey.startsWith(ownPrefix())) chain.setToolRowExpansion(t.rowKey, t.expanded);
        if (t.kind === 'reason' && controller && controller.isPhaseExpanded(t.messageId, t.phaseKey, t.byDefault) !== t.expanded) {
          controller.togglePhaseExpanded(t.messageId, t.phaseKey, t.byDefault);
        }
      }
    }
    // A reasoning toggle is remembered by its row: at the first save the row keeps its id while the message id under it
    // changes, so the remembered state moves to the new message id (and the body is drawn once more).
    function reconcileReasons() {
      let moved = false;
      for (const t of toggles.values()) {
        const row = t.kind === 'reason' && t.rowId ? rowOf(scrollEl, t.rowId) : null;
        const button = row && row.querySelector('[data-reasoning-toggle]');
        if (!button) continue;
        const messageId = str(button.getAttribute('data-message-id'));
        const phaseKey = str(button.getAttribute('data-phase-key'));
        if (messageId === t.messageId && phaseKey === t.phaseKey) continue;
        Object.assign(t, { messageId, phaseKey, byDefault: button.getAttribute('data-default-expanded') === 'true', pending: true });
        moved = true;
      }
      return moved;
    }
    function patchInto(el, html) {
      const template = d.createElement('template');
      template.innerHTML = html;
      patcher.patchChildren(el, template.content);
    }

    function mainOf(m, turnId) {
      const from = [m.messages, m.live === true, turnId, Boolean(paths && paths.enabled())];
      if (drawnFrom && from.every((v, i) => v === drawnFrom[i])) return shown.main;
      const usable = ensureChain();
      if (usable && renderer) applyToggles();
      const main = bodyOf({ messages: m.messages, doc: d, chain: usable, renderer: usable ? renderer : null, sessionKey: key, live: m.live === true, turnKey: turnId, adopt: paths && paths.adopt });
      // A list the chain could not draw yet (its scripts not loaded) is tried again on the next render.
      drawnFrom = usable ? from : null;
      return main;
    }
    // The phases a reader sees open while they stream: the ones a draw closes collapse through the local auto-collapse
    // instead of snapping shut. Not on the reader's own toggle.
    function openLivePhases() {
      const auto = chain && chain.autocollapse;
      if (!auto || readerToggle || typeof auto.collectOpenReasoningPhaseKeys !== 'function') return null;
      const open = Array.from(scrollEl.querySelectorAll('.reasoning-row-block[data-reasoning-status="streaming"]'))
        .flatMap((block) => auto.collectOpenReasoningPhaseKeys(block));
      return open.length ? open : null;
    }
    function collapseOptions() {
      const win = d.defaultView || globalThis;
      const reducedMotion = typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
      const requestFrame = typeof win.requestAnimationFrame === 'function' ? (cb) => win.requestAnimationFrame(cb) : (cb) => win.setTimeout(cb, 16);
      return { reducedMotion, transitionMs: collapseMs(win, d), windowRef: win, requestFrame };
    }
    // The live reasoning box follows its own bottom when the local module is loaded and its flag is on.
    function liveBoxOf() {
      if (liveBox || !chain || typeof chain.createReasoningLiveBoxFollow !== 'function') return liveBox;
      const isEnabled = () => Boolean(d.documentElement) && d.documentElement.getAttribute('data-reasoning-live-box') === 'on';
      try { liveBox = chain.createReasoningLiveBoxFollow({ isEnabled }); } catch (_error) { liveBox = null; }
      return liveBox;
    }
    function noteToolKey(rowKey) {
      if (!rowKey || toolKeys.has(rowKey)) return;
      toolKeys.add(rowKey);
      if (toolKeys.size > TOGGLE_CAP) toolKeys.delete(toolKeys.values().next().value);
    }
    function settle(handoff) {
      try { if (handoff) chain.autocollapse.replayReasoningHandoff(scrollEl, handoff, collapseOptions()); } catch (_error) { /* optional */ }
      try { const box = liveBoxOf(); if (box) box.sync(scrollEl); } catch (_error) { /* optional */ }
      for (const n of scrollEl.querySelectorAll('[data-tool-row-key]')) noteToolKey(n.getAttribute('data-tool-row-key'));
      follow.afterPatch();
    }
    function drawBody(m, turnId) {
      const main = mainOf(m, turnId);
      shown.main = main;
      // Questions and approvals: patched node by node with the rest, so a picked radio or typed answer survives.
      const extra = typeof m.extraHtml === 'string' && m.extraHtml ? '<div class="team-turn-pop__extra" data-pop-key="extra">' + m.extraHtml + '</div>' : '';
      const body = promptByHtml(m.promptBy) + main + endHtml(m.end) + extra;
      if (body === shown.body) return false;
      const handoff = openLivePhases();
      patchInto(scrollEl, body);
      shown.body = body;
      settle(handoff);
      return true;
    }

    function render(model) {
      if (disposed || !host || !d) return;
      const m = obj(model);
      const turnId = clean(m.turnId, 200);
      last = m;
      if (!aside) build();
      const focused = P ? P.captureFocus(aside) : null;
      paintHead(m, turnId);
      if (drawBody(m, turnId) && reconcileReasons()) { drawnFrom = null; drawBody(m, turnId); }
      // A new turn: a live one follows from the bottom, a settled one opens at its question.
      if (turnId !== followTurn) { followTurn = turnId; follow.reset(m.live === true); }
      if (P) P.restoreFocus(aside, focused, scrollEl);
      paintFoot(m);
    }
    function paintFoot(m) {
      const foot = clean(m.note, 240) || jt('team.turn.foot', 'Reply in the conversation. Everyone here sees this turn.');
      if (foot !== shown.foot) { footEl.textContent = foot; shown.foot = foot; }
    }
    function paintHead(m, turnId) {
      aside.setAttribute('data-turn-id', turnId);
      if (m.live === true) aside.setAttribute('aria-busy', 'true'); else aside.removeAttribute('aria-busy');
      const head = headHtml(m);
      if (head !== shown.head) { patchInto(headEl, head); shown.head = head; }
    }

    function remember(entryKey, entry) {
      toggles.delete(entryKey);
      toggles.set(entryKey, entry);
      while (toggles.size > TOGGLE_CAP) toggles.delete(toggles.keys().next().value);
    }
    // Draw again with the new state; render keeps focus on the toggle (or its replacement).
    function redraw() {
      drawnFrom = null;
      readerToggle = true;
      try { render(last); } finally { readerToggle = false; }
    }
    function toggleTool(el) {
      const rowKey = str(el.getAttribute('data-tool-row-key'));
      if (!rowKey) return;
      const row = el.closest('.tool-call-row');
      const expanded = !(row ? row.getAttribute('data-expanded') === 'true' : el.getAttribute('aria-expanded') === 'true');
      remember(key + '\u0000tool\u0000' + rowKey, { kind: 'tool', rowKey, expanded, pending: true });
      redraw();
    }
    function toggleReason(el) {
      const row = el.closest('[data-row-id]');
      const rowId = row ? str(row.getAttribute('data-row-id')) : '';
      const messageId = str(el.getAttribute('data-message-id'));
      const phaseKey = str(el.getAttribute('data-phase-key'));
      const block = el.closest('.reasoning-row-block');
      const expanded = !(block && block.classList.contains('expanded'));
      // The reader's toggle owns the panel from here: an auto-collapse in flight is abandoned.
      const panel = block && block.querySelector('.reasoning-row-panel');
      const auto = chain && chain.autocollapse;
      if (panel && auto && typeof auto.noteReasoningPanelReaderToggle === 'function') auto.noteReasoningPanelReaderToggle(panel);
      remember(key + '\u0000reason\u0000' + (rowId || messageId + '\u0000' + phaseKey),
        { kind: 'reason', rowId, messageId, phaseKey, expanded, byDefault: el.getAttribute('data-default-expanded') === 'true', pending: true });
      redraw();
    }

    // Row 175 item 8 (find): every row the reader opened shut, then the one row of `ref` ({ kind: 'reason' | 'tool', id }: a
    // reasoning row's message id, a tool call's id) open. Nothing takes the focus. False when the row is not drawn.
    function revealRow(ref) {
      if (!aside || !ref) return false;
      for (const t of toggles.values()) Object.assign(t, { expanded: false, pending: true });
      redraw();
      const tool = ref.kind === 'tool';
      const hit = Array.from(scrollEl.querySelectorAll(tool ? '[data-tool-call-id]' : '[data-reasoning-toggle]')).find((n) => n.getAttribute(tool ? 'data-tool-call-id' : 'data-message-id') === ref.id);
      const toggle = tool ? hit && hit.querySelector('[data-tool-row-toggle]') : hit;
      const block = toggle && toggle.closest(tool ? '.tool-call-row' : '.reasoning-row-block');
      if (!block) return false;
      if (block.getAttribute('data-expanded') !== 'true' && !block.classList.contains('expanded')) (tool ? toggleTool : toggleReason)(toggle);
      return true;
    }

    function onClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const button = target.closest('[data-pop-action]');
      if (button && headEl.contains(button)) {
        const kind = button.getAttribute('data-pop-action');
        if (!button.disabled && ACTIONS.has(kind)) act(kind, { turnId: clean(last.turnId, 200) });
        return;
      }
      const reason = target.closest('[data-reasoning-toggle]');
      if (reason && scrollEl.contains(reason)) { toggleReason(reason); return; }
      const tool = target.closest('[data-tool-row-toggle]');
      if (tool && scrollEl.contains(tool)) toggleTool(tool);
    }
    function onEscape(event, target) {
      if (target && target.closest('textarea, input, .user-questions-block')) return;
      event.preventDefault();
      event.stopPropagation();
      act('close', { turnId: clean(last.turnId, 200) });
    }
    function onKeydown(event) {
      const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
      if (event.key === 'Escape' || event.key === 'Esc') onEscape(event, target);
      else if (event.key === 'Enter' || event.key === ' ') onActivate(event, target);
    }
    function onActivate(event, target) {
      const button = target && target.closest('[role="button"]');
      if (!button || !scrollEl.contains(button) || event.repeat) return;
      if (button.hasAttribute('data-tool-row-toggle')) { event.preventDefault(); toggleTool(button); }
    }

    function build() {
      host.innerHTML = '<aside class="team-turn-pop" id="teamTurnPop" role="complementary" aria-label="' + escapeHtml(jt('team.turn.label', 'Jenny’s work in this turn'))
        + '"><div class="team-turn-pop__head"></div><div class="team-turn-pop__scroll" tabindex="-1"></div><p class="team-turn-pop__foot"></p></aside>';
      aside = host.querySelector('aside.team-turn-pop');
      headEl = aside.querySelector('.team-turn-pop__head');
      scrollEl = aside.querySelector('.team-turn-pop__scroll');
      footEl = aside.querySelector('.team-turn-pop__foot');
      shown = { head: '', main: '', body: '', foot: '' };
      drawnFrom = null;
      followTurn = null;
      follow = F && typeof F.createPopFollow === 'function' ? F.createPopFollow({ el: scrollEl }) : NO_FOLLOW;
      aside.addEventListener('click', onClick);
      aside.addEventListener('keydown', onKeydown);
    }
    function close() {
      if (aside) {
        aside.removeEventListener('click', onClick);
        aside.removeEventListener('keydown', onKeydown);
      }
      follow.dispose();
      follow = NO_FOLLOW;
      if (liveBox) liveBox.dispose();
      liveBox = null;
      aside = headEl = scrollEl = footEl = null;
      shown = { head: '', main: '', body: '', foot: '' };
      if (host) host.textContent = '';
    }
    // The popover's tool-row overrides, and the lazy detail contexts of the rows it drew (no per-session clear exists
    // for those; materializing a context removes it). The local chat's entries stay.
    function clearSessionState() {
      if (typeof chain.clearToolRowExpansionOverridesForSession === 'function') chain.clearToolRowExpansionOverridesForSession(key);
      if (typeof chain.materializeToolRowDetails !== 'function') return;
      const own = ownPrefix();
      for (const rowKey of toolKeys) {
        if (!rowKey.startsWith(own)) continue;
        try { chain.materializeToolRowDetails(rowKey); } catch (_error) { /* already gone */ }
      }
    }
    function dispose() {
      if (chain) clearSessionState();
      close();
      disposed = true;
      toggles.clear();
      toolKeys.clear();
      chain = chainMemo = renderer = controller = null;
    }

    return {
      render,
      close,
      isOpen: () => Boolean(aside),
      revealRow,
      focus: () => { if (scrollEl && typeof scrollEl.focus === 'function') scrollEl.focus(); },
      dispose,
    };
  }

  return { toLocalMessages, liveMessage, turnBodyHtml, createTurnPop };
});
