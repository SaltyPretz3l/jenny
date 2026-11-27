/* Team tab: the Tools chip and the model pill of a shared conversation's composer, and the quiet line that says who
 * changed them (row 172). They are the local composer's own markup and classes (chat-composer-shell-v2.css): a chip that
 * opens the tools panel, a pill that opens the model picker with the Thinking segments. Neither controller is the local
 * one (those are bound to the desktop session store): this module builds the markup from the conversation's snapshot and
 * the team's GPU list, handles its own clicks and keys, and asks `change(patch)` (conversationPreferences) to write.
 *
 * Data in, all read defensively (an older host sends none of it): `snapshot.session` { preferred_model, reasoning_effort,
 * team_tools { read, write }, file_tools, preference_log }. Who may change: whoever may send now (`mayDrive`); anybody
 * else sees both controls disabled, not hidden, and the popover opens read-only with its reason. While a turn runs both
 * lock. No state is optimistic: a refused call changes nothing; an accepted one is kept only until the next snapshot.
 *
 * `foldLog(log, stamps, { nameOf, timeText })` is the pure part: the host's `preference_log` as quiet channel lines.
 * `createControls(o)`: o = { root, nameOf(id), projectName(), role(), mayDrive(), driver() (member id or null), running(),
 * busy(), paused() (the project's rules are paused: no rule allows a change), session() (the snapshot's session or null), pool() ({ nodes, team_model, automatic_model } or null), change(patch)
 * (a promise of the host's answer), redraw(), timeText } -> { box, offline, notes, click, key, dispose }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-column'));
    return;
  }
  root.rendererTeamConversationControls = factory(root.rendererTeamProjectColumn);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (column) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (key, count, params, one, other) => (globalThis.jennyI18n && globalThis.jennyI18n.tn ? globalThis.jennyI18n.tn(key, count, params, one, other) : jt.call(null, key, count === 1 ? one : other, params));
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // The inventory's builders: the app's globals, or under Node the modules at first use (the app's `require` throws).
  const inv = () => globalThis.inventory || {};
  const chipOf = (o) => (inv().chip || require('../inventory/chip'))(o);
  const popoverOf = (o) => (inv().popover || require('../inventory/popover'))(o);
  const toggleOf = (o) => (inv().toggleSwitch || require('../inventory/toggle-switch').toggleSwitch)(o);
  const buttonOf = (o) => (inv().actionButton || require('../inventory/action-button'))(o);

  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const SLIDERS = SVG('<path d="M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>');
  const FILE = SVG('<path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z"/><path d="M9 2.5V5h2.5"/>');
  const PEN = SVG('<path d="M10.5 3.5l2 2-6.5 6.5-2.5.5.5-2.5z"/>');
  const SLOT = '\u2063';
  const MODEL_MAX = 256;
  const LOG_MAX = 50;
  const EFFORTS = Object.freeze(['default', 'low', 'medium', 'high']);
  const NO_NOTES = Object.freeze([]);
  const IDS = Object.freeze({ chip: 'teamConvToolsChip', pill: 'teamConvModelPill', tools: 'teamConvToolsPanel', model: 'teamConvModelPopover' });
  // The two switches. Members are the host's tool names (`propose_change` only where the team host offers it).
  const FAMILIES = Object.freeze([
    { id: 'read', icon: FILE, members: ['read_file', 'list_dir', 'glob_files', 'grep_search'] },
    { id: 'write', icon: PEN, members: ['write_file', 'edit_file', 'propose_change'] },
  ]);
  const familyLabel = (id) => (id === 'read' ? jt('team.conv.prefs.readLabel', 'Read and search files') : jt('team.conv.prefs.writeLabel', 'Write and edit files'));
  const familySub = (id, paused) => (id === 'read' ? jt('team.conv.prefs.readSub', 'Look through this project’s team files')
    : paused ? jt('team.conv.prefs.writeSubPaused', 'Each change asks a writer first.') : jt('team.conv.prefs.writeSub', 'Each change asks a writer first, unless a project rule allows it'));
  function effortLabel(value) {
    if (value === 'low') return jt('team.conv.prefs.effortLow', 'Low');
    if (value === 'medium') return jt('team.conv.prefs.effortMedium', 'Medium');
    if (value === 'high') return jt('team.conv.prefs.effortHigh', 'High');
    return jt('team.conv.prefs.effortDefault', 'Default');
  }

  const text = (value, max) => (typeof value === 'string' ? column.clean(value, max) : '');
  // A message's or entry's time in ms: an ISO string or a number (a host may send either), else NaN.
  const msOf = (value) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
  // The host's model-name rule (services/team/ipc-methods.js `conversationModel`): a name it would refuse is not offered here.
  const MODEL_NAME = /^[!-~][ -~]{0,255}$/u;
  // Attributes put on the first tag of a primitive's markup (it has no slot for aria-disabled or aria-checked).
  const withAttrs = (html, attrs) => html.replace(/^<(\w+)/, '<$1 ' + attrs);

  // ------------------------------------------------------------ the folded log

  // A host entry's values: the model (or null for the team default), the effort and the two switches.
  function valuesOf(v) {
    const o = v && typeof v === 'object' ? v : {};
    return { model: text(o.model, MODEL_MAX) || null, effort: EFFORTS.includes(o.effort) ? o.effort : 'default', read: o.read !== false, write: o.write !== false, plan: o.plan === true };
  }
  function entryOf(e) {
    const at = e && typeof e.at === 'string' ? msOf(e.at) : NaN;
    if (!e || typeof e !== 'object' || !Number.isFinite(at)) return null;
    return { at, raw: e.at, by: typeof e.by === 'string' && e.by ? e.by : null, from: valuesOf(e.from), to: valuesOf(e.to) };
  }

  // "{name} {parts} · {time}": plain text, and the same sentence with the name in bold.
  function noteOf(group, { nameOf, timeText }) {
    const first = group[0];
    const last = group[group.length - 1];
    const { from } = first;
    const { to } = last;
    const parts = [];
    if (from.model !== to.model) {
      parts.push(to.model ? jt('team.conv.prefs.setModel', 'set Jenny to {model}', { model: to.model }) : jt('team.conv.prefs.backToDefault', 'set Jenny back to the team default'));
    }
    if (from.effort !== to.effort) parts.push(jt('team.conv.prefs.setThinking', 'set thinking to {effort}', { effort: effortLabel(to.effort) }));
    for (const family of FAMILIES) {
      if (from[family.id] === to[family.id]) continue;
      const params = { label: familyLabel(family.id) };
      parts.push(to[family.id] ? jt('team.conv.prefs.turnedOn', 'turned on {label}', params) : jt('team.conv.prefs.turnedOff', 'turned off {label}', params));
    }
    if (from.plan !== to.plan) parts.push(to.plan ? jt('team.plan.logOn', 'turned on plan mode: Jenny plans and changes nothing until a plan is accepted') : jt('team.plan.logOff', 'turned off plan mode'));
    if (!parts.length) return null;
    const name = (last.by && column.clean(nameOf(last.by), 64)) || jt('team.conv.prefs.someone', 'Someone');
    const line = jt('team.conv.prefs.line', '{name} {parts} · {time}', { name: SLOT, parts: parts.join(jt('team.conv.prefs.and', ' and ')), time: timeText(last.raw) });
    const html = line.split(SLOT).map(escapeHtml).join('<b>' + escapeHtml(name) + '</b>');
    return { kind: 'note', at: last.at, text: line.split(SLOT).join(name), html: '<div class="team-conv-note" role="note" dir="auto">' + html + '</div>' };
  }

  // The host's `preference_log` as quiet lines, one per group: consecutive entries by one member with no message and no
  // turn of Jenny's (`stamps`, their times in ms) between them. A group's net change is its first entry's `from` against its
  // last entry's `to`; a group that nets no change draws nothing. Entries older than the oldest held message never merge:
  // a message may stand between them on a page this view has not read.
  function foldLog(log, stamps, helpers) {
    const entries = (Array.isArray(log) ? log.slice(-LOG_MAX) : []).map(entryOf).filter(Boolean).sort((a, b) => a.at - b.at);
    const oldest = stamps.length ? Math.min(...stamps) : -Infinity;
    const groups = [];
    for (const e of entries) {
      const group = groups[groups.length - 1];
      const prev = group && group[group.length - 1].at;
      const apart = group && (prev < oldest || stamps.some((t) => t > prev && t < e.at));
      if (group && group[0].by === e.by && !apart) group.push(e); else groups.push([e]);
    }
    return groups.map((g) => noteOf(g, helpers)).filter(Boolean);
  }

  // ------------------------------------------------------------ the controls

  function createControls(o) {
    let open = null; // 'tools' | 'model' | null
    let members = null; // the family whose tool names are shown
    let overlay = null; // { base (the session it was accepted against), patch }: what the host accepted, until the next snapshot
    let notesMemo = { log: null, messages: null, length: 0, notes: NO_NOTES };
    const doc = o.root.ownerDocument;
    const byId = (id) => o.root.querySelector('[id="' + id + '"]');
    // Two conversations can be in one document (the Team tab's and the Board's): every id this view makes carries the conversation's prefix.
    const P = typeof o.idPrefix === 'string' ? o.idPrefix : '';
    const ids = Object.freeze({ chip: P + IDS.chip, pill: P + IDS.pill, tools: P + IDS.tools, model: P + IDS.model });
    const pref = (name) => P + 'teamPref' + name;

    // The GPUs this team offers, grouped by the PC's owner. A model is listed once, under the first PC that offers it.
    function offers() {
      const read = o.pool();
      const nodes = read && Array.isArray(read.nodes) ? read.nodes : null;
      const groups = [];
      const thinking = new Map();
      const ready = new Set(); // models an online, unpaused PC offers
      for (const node of nodes || []) {
        if (!node || node.online !== true || !Array.isArray(node.models)) continue;
        const key = String(node.member_id || node.node_id || '');
        let group = groups.find((g) => g.key === key);
        if (!group) { group = { key, owner: typeof node.member_id === 'string' ? node.member_id : '', pc: text(node.label || '', 64), models: [] }; groups.push(group); }
        for (const m of node.models) {
          if (!m || typeof m.name !== 'string' || !MODEL_NAME.test(m.name)) continue;
          if (node.paused !== true) ready.add(m.name);
          if (thinking.has(m.name)) continue;
          thinking.set(m.name, m.thinking === true);
          group.models.push({ name: text(m.name, MODEL_MAX), key: m.name, thinking: m.thinking === true });
        }
      }
      return { known: nodes !== null, groups: groups.filter((g) => g.models.length), thinking, ready, team: read ? text(read.team_model, 64) : '', automatic: read ? text(read.automatic_model, 64) : '' };
    }

    function view() {
      const base = o.session();
      const s = base || {};
      const patch = overlay && overlay.base === base ? overlay.patch : {};
      const pick = (key) => (Object.hasOwn(patch, key) ? patch[key] : s[key]);
      const switches = pick('team_tools') && typeof pick('team_tools') === 'object' ? pick('team_tools') : {};
      const offer = offers();
      const model = text(pick('preferred_model'), MODEL_MAX) || null;
      const effort = EFFORTS.includes(pick('reasoning_effort')) ? pick('reasoning_effort') : 'default';
      const available = s.file_tools === 'available';
      const on = { read: available && switches.read !== false, write: available && switches.write !== false };
      const only = offer.thinking.size === 1 ? [...offer.thinking.keys()][0] : '';
      const named = offer.team || offer.automatic || text(only, 64);
      const defaultName = named || jt('team.conv.prefs.automatic', 'Automatic');
      const shown = model || defaultName;
      const gone = model !== null && offer.known && !offer.thinking.has(model);
      const stalled = model !== null && offer.known && !gone && !offer.ready.has(model); // listed, but every PC that offers it is paused
      const offline = gone || stalled;
      // The team default (no pick) that no ready PC offers; a default named by no model (Automatic) needs any ready PC.
      const defaultDown = model === null && offer.known && !(named ? offer.ready.has(named) : offer.ready.size > 0);
      const gate = gateOf();
      // The team default named by no offered model (Automatic, or a model not listed): the pool picks, so the segments show
      // while any offered model thinks (the gateway drops the effort for one that does not).
      const thinks = !gone && (offer.thinking.has(shown) ? offer.thinking.get(shown) === true : model === null && [...offer.thinking.values()].some(Boolean));
      const paused = typeof o.paused === 'function' && o.paused() === true;
      return { model, effort, available, paused, on, offer, defaultName, shown, offline, gone, stalled, defaultDown, thinks, locked: gate.locked, line: gate.line,
        count: FAMILIES.filter((f) => on[f.id]).length, off: FAMILIES.filter((f) => available && !on[f.id]).length };
    }

    // Why the controls cannot change now, or '' when they can.
    function gateOf() {
      if (!o.mayDrive()) {
        const driver = o.driver();
        if (o.role() === 'reader') return { locked: true, line: jt('team.conv.prefs.reader', 'Only writers and admins can change these.') };
        return { locked: true, line: driver ? jt('team.conv.prefs.driving', '{name} is driving. Take control to change these.', { name: column.clean(o.nameOf(driver), 64) })
          : jt('team.conv.prefs.nobody', 'Nobody is driving. Take control to change these.') };
      }
      return o.running() ? { locked: true, line: jt('team.conv.prefs.running', 'Changes apply from the next turn.') } : { locked: false, line: '' };
    }
    const readOnly = (v) => (v.line ? '<p class="team-conv-ro" role="status" dir="auto">' + escapeHtml(v.line) + '</p>' : '');

    // ---------------------------------------------------------- the Tools chip and its panel

    function toolsHtml(v) {
      const label = jt('team.conv.prefs.chipTitle', 'Tools for this conversation');
      const count = !v.available ? jt('team.conv.prefs.hostOff', 'off on this host') : v.off ? jt('team.conv.prefs.offCount', '{count} off', { count: v.off }) : '';
      const opened = open === 'tools';
      const button = chipOf({ domId: ids.chip, label: jt('team.conv.prefs.tools', 'Tools'), count, iconHtml: SLIDERS, hasPopup: true, ariaControls: opened ? ids.tools : '', title: label,
        ariaLabel: jt('team.conv.prefs.chipLabel', 'Tools for this conversation: {on} of {total} on', { on: v.count, total: FAMILIES.length }),
        className: 'composer-tools-chip' + (count ? ' composer-tools-chip--off' : '') + (opened ? ' inv-chip--open' : '') });
      const chip = withAttrs(button.replace('aria-expanded="false"', 'aria-expanded="' + opened + '"'), v.locked ? 'aria-disabled="true"' : '');
      return '<span class="team-conv-ctl team-conv-ctl--tools">' + chip + (opened ? panelHtml(v) : '') + '</span>';
    }

    function rowHtml(family, v) {
      const id = family.id;
      const checked = v.on[id];
      const disabled = v.locked || !v.available;
      const label = familyLabel(id);
      const names = jtn('team.conv.prefs.toolCount', family.members.length, { count: family.members.length }, '{count} tool', '{count} tools');
      const sub = v.available ? escapeHtml(familySub(id, v.paused))
        : '<span class="composer-tool-warn">' + escapeHtml(jt('team.conv.prefs.hostReason', 'Off on this host: file access on this team host is not available yet')) + '</span>';
      const shown = members === id;
      return '<div class="composer-tool-row" data-on="' + checked + '" data-blocked="' + !v.available + '"><span class="composer-tool-icon" aria-hidden="true">' + family.icon + '</span>'
        + '<span class="composer-tool-text"><span class="composer-tool-label" id="' + pref('Label-' + id) + '">' + escapeHtml(label) + '</span><span class="composer-tool-sub" id="' + pref('Sub-' + id) + '">' + sub + '</span></span>'
        + '<span class="composer-tool-trail">'
        + buttonOf({ plain: true, className: 'composer-tool-count', ariaExpanded: shown, ariaControls: pref('Members-' + id), title: jt('team.conv.prefs.showMembers', 'Show the tools in {label}', { label }), dataset: { 'pref-members': id }, label: names })
        + toggleOf({ domId: pref('Switch-' + id), bare: true, labelledBy: pref('Label-' + id), describedBy: pref('Sub-' + id), checked, disabled })
        + '</span><div class="composer-tool-members" id="' + pref('Members-' + id) + '"' + (shown ? '' : ' hidden') + '>' + family.members.map((n) => '<code>' + escapeHtml(n) + '</code>').join(', ') + '</div></div>';
    }

    function panelHtml(v) {
      const title = jt('team.conv.prefs.chipTitle', 'Tools for this conversation');
      const reset = v.off ? buttonOf({ plain: true, className: 'composer-chat-link', label: jt('team.conv.prefs.reset', 'Reset to defaults'), title: jt('team.conv.prefs.resetTitle', 'Turn every tool switch back on'),
        disabled: v.locked, dataset: { 'pref-reset': 'tools' } }) : '';
      const inner = '<div class="composer-chat-panel-head"><span class="composer-chat-panel-title">' + escapeHtml(title) + '</span><span class="composer-chat-panel-tally">'
        + escapeHtml(jt('team.conv.prefs.tally', '{on} of {total} on', { on: v.count, total: FAMILIES.length })) + '</span></div>' + readOnly(v)
        + '<div class="composer-chat-list"><section><div class="composer-chat-section-label" dir="auto">' + escapeHtml(jt('team.conv.prefs.section', 'In this project · {project}', { project: o.projectName() })) + '</div>'
        + FAMILIES.map((f) => rowHtml(f, v)).join('') + '</section><p class="composer-chat-always-on">' + escapeHtml(jt('team.conv.prefs.alwaysOn', 'Always on: questions')) + '</p></div>'
        + '<div class="composer-chat-panel-foot">' + reset + '<span>' + escapeHtml(jt('team.conv.prefs.everyone', 'For everyone in this conversation')) + '</span></div>';
      return withAttrs(popoverOf({ domId: ids.tools, ariaLabel: title, className: 'composer-chat-panel', trustedHtml: inner }).replace(' hidden>', '>'), 'tabindex="-1"');
    }

    // ---------------------------------------------------------- the model pill and its picker

    function pillHtml(v) {
      const label = v.shown + (v.effort !== 'default' ? ' · ' + effortLabel(v.effort) : '');
      const title = v.model ? jt('team.conv.prefs.pickedTitle', 'Picked for this conversation') : jt('team.conv.prefs.defaultTitle', 'The team default, set by the host in Settings › Team');
      const dot = v.offline || v.defaultDown ? 'error' : v.offer.ready.has(v.shown) ? 'ok' : '';
      const opened = open === 'model';
      const button = chipOf({ domId: ids.pill, label, iconHtml: dot ? '<span class="composer-model-pill-dot status-dot status-dot--' + dot + '" aria-hidden="true"></span>' : '', hasPopup: true,
        ariaControls: opened ? ids.model : '', title, ariaLabel: jt('team.conv.prefs.pillLabel', 'Model and thinking: {model}. {title}', { model: label, title }),
        className: 'composer-model-pill' + (opened ? ' inv-chip--open' : '') });
      const pill = withAttrs(button.replace('aria-expanded="false"', 'aria-expanded="' + opened + '"'), v.locked ? 'aria-disabled="true"' : '');
      return '<span class="team-conv-ctl team-conv-ctl--model">' + pill + (opened ? pickerHtml(v) : '') + '</span>';
    }

    const nameHtml = (family, tag) => '<span class="composer-model-picker-name"><span class="composer-model-picker-family">' + escapeHtml(family) + '</span><span class="composer-model-picker-tag">' + escapeHtml(tag) + '</span></span>';
    function optionHtml({ name, family, tag, active, offline, stalled, loaded, id }, v) {
      const meta = offline || stalled ? '<span class="composer-model-picker-size">' + escapeHtml(offline ? jt('team.conv.prefs.offline', 'offline') : jt('team.conv.prefs.pausedMeta', 'paused')) + '</span>'
        : loaded ? '<span class="composer-model-picker-loaded status-dot status-dot--ok" role="img" title="' + escapeHtml(jt('team.conv.prefs.available', 'Available now')) + '" aria-label="' + escapeHtml(jt('team.conv.prefs.available', 'Available now')) + '"></span>' : '';
      return buttonOf({ plain: true, role: 'option', className: 'composer-model-picker-option' + (active ? ' is-active' : '') + (offline || stalled ? ' is-unavailable' : ''), ariaSelected: active, disabled: v.locked || offline || stalled,
        domId: id, title: name || family, dataset: { 'pref-model': name }, trustedHtml: nameHtml(family, tag) + '<span class="composer-model-picker-meta">' + meta + '</span>' });
    }

    function pickerHtml(v) {
      const split = (name) => { const at = name.indexOf(':'); return at > 0 ? [name.slice(0, at), name.slice(at)] : [name, '']; };
      const items = [optionHtml({ name: '', family: jt('team.conv.prefs.teamDefault', 'Team default'), tag: ' · ' + v.defaultName, active: v.model === null, loaded: v.offer.ready.has(v.defaultName), id: pref('Model-default') }, v)];
      if (v.gone) { const [family, tag] = split(v.model); items.push(optionHtml({ name: v.model, family, tag, active: true, offline: true, id: pref('Model-picked') }, v)); }
      v.offer.groups.forEach((group, g) => {
        const who = (group.owner && column.clean(o.nameOf(group.owner), 64)) || group.pc;
        items.push('<div class="composer-model-picker-group" role="presentation" dir="auto">' + escapeHtml(jt('team.conv.prefs.onPc', 'On {name}’s PC', { name: who })) + '</div>');
        group.models.forEach((m, i) => { const [family, tag] = split(m.name); items.push(optionHtml({ name: m.key, family, tag, active: v.model === m.key, stalled: !v.offer.ready.has(m.key), loaded: true, id: pref('Model-' + g + '-' + i) }, v)); });
      });
      const segments = v.thinks ? '<div class="composer-model-picker-thinking"><span class="composer-model-picker-thinking-label">' + escapeHtml(jt('team.conv.prefs.thinking', 'Thinking')) + '</span>'
        + '<div class="composer-model-picker-segments" role="radiogroup" aria-label="' + escapeHtml(jt('team.conv.prefs.thinkingEffort', 'Thinking effort')) + '">'
        + EFFORTS.map((e) => withAttrs(buttonOf({ plain: true, role: 'radio', className: 'composer-model-picker-segment' + (v.effort === e ? ' is-active' : ''), disabled: v.locked, domId: pref('Effort-' + e),
          title: jt('team.conv.prefs.thinkingValue', 'Thinking: {effort}', { effort: effortLabel(e) }), dataset: { 'pref-effort': e }, trustedHtml: escapeHtml(effortLabel(e)) }), 'aria-checked="' + (v.effort === e) + '"')).join('') + '</div></div>' : '';
      const inner = '<div class="composer-model-picker">' + readOnly(v) + '<div class="composer-model-picker-list" role="listbox" aria-label="' + escapeHtml(jt('team.conv.prefs.modelLabel', 'Model')) + '">' + items.join('') + '</div>'
        + segments + '<div class="inv-popover-footer">' + escapeHtml(jt('team.conv.prefs.footer', 'Applies to this conversation, for everyone in it. The team default lives in Settings › Team.')) + '</div></div>';
      return withAttrs(popoverOf({ domId: ids.model, ariaLabel: jt('team.conv.prefs.modelPopover', 'Model and thinking'), trustedHtml: inner, className: 'composer-model-popover' }).replace(' hidden>', '>'), 'tabindex="-1"');
    }

    // The line above the field while the picked model's PC is gone or paused; Send waits for it (the box reads `offline`).
    function offlineHtml(v) {
      const model = column.clean(v.model, 64);
      const use = column.button('pref-default', jt('team.conv.prefs.useDefault', 'Use the team default'), { disabled: v.locked,
        title: v.locked ? v.line : jt('team.conv.prefs.useDefaultTitle', 'Go back to the team default ({model})', { model: v.defaultName }) });
      return '<div class="team-drive team-drive--above" role="status"><span dir="auto">' + escapeHtml((v.stalled ? jt('team.conv.prefs.pausedLine', '{model} is paused. Pick another model or use the team default.', { model })
      : jt('team.conv.prefs.offlineLine', '{model} is offline. Pick another model or use the team default.', { model }))) + '</span>' + use + '</div>';
    }
    // The team default no ready PC offers: said, but Send is not held (with no ready PC at all the box's own "nobody shares" line says it).
    const defaultDownHtml = (v) => '<div class="team-drive team-drive--above" role="status"><span dir="auto">' + escapeHtml(jt('team.conv.prefs.defaultDownLine', 'The team default, {model}, is not available now. Pick another model.', { model: column.clean(v.shown, 64) })) + '</span></div>';

    // ---------------------------------------------------------- opening, closing, writing

    // A click outside this view's two controls closes its open popover (the focus stays where it was clicked); a click in
    // another view's controls (the Board can hold more than one) closes it too.
    const away = (event) => {
      const t = event.target;
      // A node the redraw just replaced (the chip that opened it) is no longer in any view: that click is this view's own.
      if (t && t.closest && (!t.closest('.team-conv-ctl') || (t.isConnected && !o.root.contains(t)))) close(false);
    };
    function close(refocus) {
      if (!open) return;
      const trigger = byId(open === 'tools' ? ids.chip : ids.pill);
      open = null;
      members = null;
      doc.removeEventListener('click', away);
      o.redraw();
      const again = byId(trigger ? trigger.id : '');
      if (refocus && again) again.focus({ preventScroll: true });
    }
    function toggle(kind) {
      if (open === kind) { close(true); return; }
      if (!open) doc.addEventListener('click', away);
      open = kind;
      members = null;
      o.redraw();
      const pop = byId(kind === 'tools' ? ids.tools : ids.model);
      const first = pop ? pop.querySelector('.composer-model-picker-option.is-active:not([disabled]), button:not([disabled])') || pop : null;
      if (first) first.focus({ preventScroll: true });
    }

    // The host's answer decides: a refusal says why in the box's note line and changes nothing here.
    async function apply(patch) {
      const v = view();
      if (v.locked || o.busy()) return;
      const answer = await o.change(patch);
      if (!answer || !answer.ok) return;
      const base = o.session();
      if (!base) return;
      const prev = overlay && overlay.base === base ? overlay.patch : {};
      overlay = { base, patch: { ...prev, ...patch, ...(patch.team_tools ? { team_tools: { ...(prev.team_tools || base.team_tools), ...patch.team_tools } } : {}) } };
      o.redraw();
    }
    function pick(name) {
      const v = view();
      if (v.locked || o.busy()) return;
      if (name === (v.model || '')) { close(true); return; }
      // A model that cannot think has no effort to keep: the same call puts it back to Default.
      const thinks = name ? v.offer.thinking.get(name) === true
        : !v.offer.thinking.has(v.defaultName) || v.offer.thinking.get(v.defaultName) === true;
      const patch = { preferred_model: name || null, ...(thinks ? {} : { reasoning_effort: 'default' }) };
      close(true);
      void apply(patch);
    }

    function click(event) {
      const t = event.target && event.target.closest ? event.target : null;
      if (!t) return false;
      const on = (selector) => t.closest(selector);
      if (on('[id="' + ids.chip + '"]')) { toggle('tools'); return true; }
      if (on('[id="' + ids.pill + '"]')) { toggle('model'); return true; }
      const count = on('[data-pref-members]');
      if (count) { members = members === count.dataset.prefMembers ? null : count.dataset.prefMembers; o.redraw(); return true; }
      const track = on('button[role="switch"][id^="' + pref('Switch-') + '"]');
      if (track) { if (!track.disabled) void apply({ team_tools: { [track.id.slice(pref('Switch-').length)]: track.getAttribute('aria-checked') !== 'true' } }); return true; }
      const reset = on('[data-pref-reset]');
      if (reset) { if (!reset.disabled) void apply({ team_tools: { read: true, write: true } }); return true; }
      const model = on('[data-pref-model]');
      if (model) { if (!model.disabled) pick(model.dataset.prefModel); return true; }
      const effort = on('[data-pref-effort]');
      if (effort) { if (!effort.disabled) void apply({ reasoning_effort: effort.dataset.prefEffort }); return true; }
      const back = on('[data-project-action="pref-default"]');
      if (back) { if (!back.disabled) void apply({ preferred_model: null }); return true; }
      return Boolean(on('.team-conv-ctl'));
    }

    // Escape closes the open popover (the focus goes back to its control when it was inside); the arrows walk the
    // options and switches, and Left and Right step the Thinking segments.
    function key(event) {
      if (!open || !event.target || !event.target.closest) return false;
      if (event.key === 'Escape' || event.key === 'Esc') { event.preventDefault(); event.stopPropagation(); close(Boolean(event.target.closest('.team-conv-ctl'))); return true; }
      const pop = event.target.closest('.inv-popover');
      if (!pop) return false;
      const list = (selector) => Array.from(pop.querySelectorAll(selector));
      const wrap = (items, at, by) => items[(at + by + items.length) % items.length];
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const segments = list('[data-pref-effort]:not([disabled])');
        const at = segments.indexOf(event.target.closest('[data-pref-effort]'));
        if (at < 0) return false;
        event.preventDefault();
        const next = wrap(segments, at, event.key === 'ArrowRight' ? 1 : -1);
        next.focus({ preventScroll: true });
        next.click();
        return true;
      }
      const down = event.key === 'ArrowDown';
      const walk = list('[data-pref-model]:not([disabled]), button[role="switch"]:not([disabled]), [data-pref-reset]:not([disabled])');
      const here = walk.indexOf(event.target.closest('[data-pref-model], button[role="switch"], [data-pref-reset]'));
      if ((!down && event.key !== 'ArrowUp') || here < 0) return false;
      event.preventDefault();
      wrap(walk, here, down ? 1 : -1).focus({ preventScroll: true });
      return true;
    }

    return {
      // The box's three pieces and whether a send must wait: the Tools chip, the model pill, the line above the field.
      box() { const v = view(); return { tools: toolsHtml(v), model: pillHtml(v), above: v.offline ? offlineHtml(v) : v.defaultDown && v.offer.ready.size ? defaultDownHtml(v) : '', offline: v.offline }; },
      offline: () => view().offline,
      // True when the pool is read and no ready PC offers the model this conversation would use; the caller decides what that blocks.
      unanswerable() { const v = view(); return v.offline || v.defaultDown; },
      // The folded log for the channel: `messages` are the held ones (a message or a turn of Jenny's ends a group).
      // The same array while the log and the held messages are the same (the channel's memo keys on it).
      notes(messages) {
        const s = o.session();
        const log = s && Array.isArray(s.preference_log) && s.preference_log.length ? s.preference_log : null;
        const list = Array.isArray(messages) ? messages : [];
        if (!log) return NO_NOTES;
        if (notesMemo.log === log && notesMemo.messages === list && notesMemo.length === list.length) return notesMemo.notes;
        const stamps = list.map((m) => msOf(m && m.timestamp)).filter(Number.isFinite);
        notesMemo = { log, messages: list, length: list.length, notes: foldLog(log, stamps, { nameOf: o.nameOf, timeText: o.timeText }) };
        return notesMemo.notes;
      },
      click, key,
      dispose() { doc.removeEventListener('click', away); open = null; },
    };
  }

  return { createControls, foldLog, IDS };
});
