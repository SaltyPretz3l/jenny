/* Owns composer Tools hydration and the focus-preserving chat panel. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-composer-v2-model'), require('./renderer-composer-v2-toggle'), require('../shared/string-utils'));
    return;
  }
  root.rendererComposerToolsSlot = factory(root.rendererComposerV2Model, root.rendererComposerV2Toggle, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, toggleModule, strings) {
  'use strict';
  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback, params) =>
    params ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : fallback))(...args);
  const jtn = (key, count, params, one, other) => (globalThis.jennyI18n?.tn ? globalThis.jennyI18n.tn(key, count, params, one, other) : jt.call(null, key, count === 1 ? one : other, params));
  const { escapeHtml } = strings;
  const sliders = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6"/></svg>';
  // On the 16px family icon grid, so connection rows line up with the family rows.
  const plug = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2v3.5m5-3.5v3.5M4 5.5h8v2a4 4 0 0 1-8 0zm4 6v2.5"/></svg>';
  const SEARCH_MIN_ROWS = 8;
  const COMPUTER = 'computer_use';
  const toolSettings = () => jt('composer.chatPanel.computer.toolSettings', 'Tool settings');
  // Electron's own reasons for withholding the Computer tool (status().reason); any other reason is not overridden.
  const COMPUTER_REASONS = {
    sandbox: () => ({ text: jt('composer.chatPanel.computer.sandbox', 'Off while the command sandbox is on'), fix: 'settings', label: toolSettings() }),
    strict_safety: () => ({ text: jt('composer.chatPanel.computer.strictSafety', 'Off in strict safety mode'), fix: 'settings', label: toolSettings() }),
    engine_not_local: () => ({ text: jt('composer.chatPanel.computer.notLocal', 'Needs a model on this computer') }),
    not_windows: () => ({ text: jt('composer.chatPanel.computer.notWindows', 'Windows only for now') }),
  };
  function extractToolEntries(list) {
    return (Array.isArray(list) ? list : []).map(model.normalizeToolEntry).filter((entry) => entry.name);
  }

  function createComposerToolsSlot(deps = {}) {
    const { state = {}, windowRef = globalThis, slot = null, controller = null,
      appendClientLog = () => {} } = deps;
    let hydrated = null;
    let signature = null;
    let serial = 0;
    const mounted = new Map();
    const sections = new Map();
    // Row ids the user expanded; a search can show members without touching this.
    const expanded = new Set();
    const panel = slot?.querySelector('#composerChatPanel');
    const chipHost = slot?.querySelector('#composerChatChipHost');
    const list = slot?.querySelector('#composerChatPanelList');
    const filter = panel?.querySelector('[data-chat-panel-filter]');
    const tally = panel?.querySelector('[data-chat-panel-tally]');
    const emptyLine = panel?.querySelector('[data-chat-panel-empty]');
    const resetButton = panel?.querySelector('[data-chat-panel-action="reset"]');
    const rowsFor = (vm) => [...vm.sections.flatMap((section) => section.families), ...vm.connections];
    const focusInside = (node) => node.contains(slot.ownerDocument.activeElement);
    // The Computer row's extras from the bridge: Electron's status and this chat's granted programs (null: unknown).
    const computer = { status: null, grants: null, sessionId: '', watching: false };
    const chatId = () => String(state.currentSessionId || '').trim();
    const bridge = () => windowRef.jennyShell?.computerUse;
    const ask = async (method, args) => { try { return await bridge()?.[method]?.(args); } catch (_error) { return null; } };
    function hydrate(force = false) {
      const id = String(state.currentSessionId || '').trim();
      const active = state.sessions?.find((session) => String(session?.id || '').trim() === id);
      const categories = active?.tool_category_overrides;
      const connections = active?.tool_connection_overrides;
      if (force || !hydrated || hydrated.id !== id || hydrated.categories !== categories || hydrated.connections !== connections) {
        // The panel describes one chat; a session switch closes it and drops its query.
        if (hydrated && hydrated.id !== id && panel && !panel.hidden) {
          windowRef.inventory?.popover?.close(panel, { restoreFocus: false });
          if (filter) filter.value = '';
        }
        controller?.hydrateForSession(id, categories, connections);
        hydrated = { id, categories, connections };
      }
      return id;
    }
    // The row's Electron reason wins over the sidecar's; with no computer tool at all, "not_windows" still shows the row.
    function withComputer(vm) {
      const computerReason = computer.status?.reason;
      if (!COMPUTER_REASONS[computerReason]) return vm;
      const ids = model.SURFACE_FAMILY_UI.map((family) => family.id);
      const block = (row) => ({ ...row, on: false, state: 'blocked', usable: 0, computerReason });
      const sections = vm.sections.map((section) => {
        if (section.id !== 'reach') return section;
        if (section.families.some((row) => row.id === COMPUTER)) return { ...section, families: section.families.map((row) => (row.id === COMPUTER ? block(row) : row)) };
        if (computerReason !== 'not_windows') return section;
        const family = model.SURFACE_FAMILY_UI[ids.indexOf(COMPUTER)];
        const families = section.families.slice();
        const next = families.findIndex((row) => ids.indexOf(row.id) > ids.indexOf(COMPUTER));
        families.splice(next < 0 ? families.length : next, 0, block({ id: COMPUTER, overridden: false, total: 0, reason: '', members: [], approval: 'none',
          label: family.label(), description: family.description(), icon: family.icon, defaultOff: true }));
        return { ...section, families };
      });
      return { ...vm, sections };
    }
    function reasonFor(row, vm) {
      if (row.computerReason) return COMPUTER_REASONS[row.computerReason]();
      const reason = row.reason || row.members?.find((member) => !member.usable)?.reason || '';
      if (vm.lockdown && row.state === 'blocked') return { text: jt('composer.chatPanel.offlineReason', 'Offline for this chat') };
      // Exact sidecar reason constants (sidecar/ai/tools/assembly.py); any other reason shows as sent.
      if (reason === 'config disabled') return { text: jt('composer.chatPanel.offSettings', 'Off in Settings'), fix: 'settings', label: jt('composer.chatPanel.turnOn', 'Turn on') };
      if (reason === 'workspace requirement missing') return { text: jt('composer.chatPanel.needsProject', 'Needs a project'), fix: 'project', label: jt('composer.chatPanel.chooseProject', 'Choose project') };
      return { text: reason };
    }
    function element(html) {
      const template = slot.ownerDocument.createElement('template');
      template.innerHTML = html;
      return template.content.firstElementChild;
    }
    const warn = (text) => '<span class="composer-tool-warn">' + escapeHtml(text) + '</span>';
    // The separator is text beside the fix button, never inside it.
    const reasonHtml = (reason) => warn(reason.text) + (reason.fix ? ' · ' + windowRef.inventory.actionButton({
      label: reason.label, plain: true, className: 'composer-chat-link', dataset: { 'tool-fix': reason.fix } }) : '');
    // Rewrites a node's markup only when it changed and holds no focus; true means "retry next render".
    function setHtml(owner, field, node, html) {
      if (owner[field] === html) return false;
      if (focusInside(node)) return true;
      node.innerHTML = html;
      owner[field] = html;
      return false;
    }
    function grantsHtml(grants) {
      if (!grants.length) return '<p class="composer-tool-grants-empty">' + escapeHtml(jt('composer.chatPanel.computer.empty', 'No programs yet. Jenny asks the first time it needs one.')) + '</p>';
      return '<span class="composer-tool-grants-label">' + escapeHtml(jt('composer.chatPanel.computer.allowed', 'Allowed in this chat')) + '</span>'
        + grants.map((grant) => { const revokeLabel = jt('composer.chatPanel.computer.revokeLabel', 'Revoke {name}', { name: grant.name });
          return '<div class="composer-tool-grant" title="' + escapeHtml(grant.path) + '"><span class="composer-tool-grant-name">' + escapeHtml(grant.name) + '</span>'
          + (grant.viewOnly ? '<span class="composer-tool-grant-kind">' + escapeHtml(jt('composer.chatPanel.computer.viewOnly', 'View only')) + '</span>' : '')
          + windowRef.inventory.actionButton({ label: jt('composer.chatPanel.computer.revoke', 'Revoke'), plain: true, className: 'composer-chat-link',
            ariaLabel: revokeLabel, title: revokeLabel, dataset: { 'grant-path': grant.path } }) + '</div>'; }).join('');
    }
    // Revoke is immediate: the line goes at once, then the bridge's answer is re-read. Clicks here never flip the row.
    function grantsClick(event) {
      event.stopPropagation();
      const path = event.target.closest('[data-grant-path]')?.dataset.grantPath;
      if (path === undefined) return;
      const entry = mounted.get(COMPUTER);
      computer.grants = (computer.grants || []).filter((grant) => grant.path !== path);
      if (focusInside(entry.grants)) entry.track.focus();
      render();
      ask('revoke', { sessionId: chatId(), path }).then(reloadComputer);
    }
    // Returns true when a focused list kept its markup.
    function patchGrants(entry, on) {
      if (!entry.grants) {
        entry.grants = element('<div class="composer-tool-grants" role="group" aria-label="' + escapeHtml(jt('composer.chatPanel.computer.groupLabel', 'Programs in this chat')) + '" hidden></div>');
        entry.grants.addEventListener('click', grantsClick);
        entry.node.appendChild(entry.grants);
      }
      const grants = on ? computer.grants : null;
      entry.grants.hidden = !grants;
      return grants ? setHtml(entry, 'grantsHtml', entry.grants, grantsHtml(grants)) : false;
    }
    function mountRow(row, section) {
      const inv = windowRef.inventory;
      const key = 'composer-chat-tool-' + (++serial);
      const node = element('<div class="composer-tool-row">'
        + '<span class="composer-tool-icon" aria-hidden="true">' + (row.icon || plug) + '</span>'
        + '<span class="composer-tool-text"><span class="composer-tool-label" id="' + key + '-label"></span>'
        + '<span class="composer-tool-sub" id="' + key + '-sub"></span></span>'
        + '<span class="composer-tool-trail">'
        + inv.actionButton({ plain: true, className: 'composer-tool-count', ariaExpanded: false, ariaControls: key + '-members', dataset: { 'chat-panel-members': row.id } })
        + inv.toggleSwitch({ id: 'tool-target:' + row.id, bare: true, labelledBy: key + '-label', describedBy: key + '-sub' })
        + '</span><div class="composer-tool-members" id="' + key + '-members" hidden></div></div>');
      node.dataset.toolTarget = row.id;
      section.appendChild(node);
      const entry = { id: row.id, node, forced: false, subHtml: null, membersHtml: null,
        label: node.querySelector('.composer-tool-label'), sub: node.querySelector('.composer-tool-sub'),
        count: node.querySelector('[data-chat-panel-members]'), members: node.querySelector('.composer-tool-members'),
        track: node.querySelector('[data-inv-toggle]') };
      mounted.set(row.id, entry);
      return entry;
    }
    function syncMembers(entry) {
      const open = expanded.has(entry.id) || entry.forced;
      entry.members.hidden = !open;
      entry.count.setAttribute('aria-expanded', String(open));
    }
    // Returns true when a focused node kept some markup from updating.
    function patchRow(row, vm, entry, { query, shared }) {
      const { node, track } = entry;
      const blocked = row.state === 'blocked';
      const on = row.on && !blocked;
      node.dataset.on = String(on);
      node.dataset.blocked = String(blocked);
      entry.label.textContent = row.label;
      const reason = blocked ? reasonFor(row, vm) : null;
      const partial = row.usable > 0 && row.usable < row.total;
      const base = row.kind === 'mcp' ? jt('composer.chatPanel.mcpServer', 'MCP server') : row.description || '';
      let deferred = setHtml(entry, 'subHtml', entry.sub, blocked && !shared && reason.text ? reasonHtml(reason)
        : escapeHtml(base) + (partial ? ' · ' + warn(jt('composer.chatPanel.ready', '{usable} of {total} ready', row)) : ''));
      windowRef.inventory.toggleSwitch.setChecked(track, on);
      windowRef.inventory.toggleSwitch.setDisabled(track, blocked);
      const members = row.members || [];
      entry.count.hidden = !members.length;
      entry.count.textContent = jtn('composer.chatPanel.toolCount', members.length, { count: members.length }, '{count} tool', '{count} tools');
      entry.count.setAttribute('aria-label', jt('composer.chatPanel.showMembers', 'Show the tools in {label}', { label: row.label }));
      deferred = setHtml(entry, 'membersHtml', entry.members, members.map((member) => '<code>' + escapeHtml(member.name) + '</code>'
        + (member.asksFirst ? ' ' + warn(jt('composer.chatPanel.asksFirst', 'asks first')) : '')).join(', ')) || deferred;
      if (row.id === COMPUTER) deferred = patchGrants(entry, on) || deferred;
      const labelHit = row.label.toLowerCase().includes(query);
      const memberHit = members.some((member) => member.name.toLowerCase().includes(query));
      node.hidden = !labelHit && !memberHit;
      entry.forced = !!query && memberHit && !labelHit;
      syncMembers(entry);
      return deferred;
    }
    const rowSwitches = () => [...list.querySelectorAll('.composer-tool-row')]
      .filter((node) => !node.hidden && !node.parentElement.hidden)
      .map((node) => node.querySelector('[data-inv-toggle]')).filter((track) => !track.disabled);
    const focusables = () => [...(filter && !filter.hidden ? [filter] : []), ...rowSwitches()];
    function render() {
      const id = hydrate();
      if (!panel || !controller || !windowRef.inventory?.actionButton) return;
      if (computer.sessionId !== id) computer.grants = null;
      const vm = withComputer(controller.getViewModel());
      const rows = rowsFor(vm);
      const browserRow = rows.find((row) => row.id === 'browser_use');
      windowRef.rendererSyncBrowserUse?.({ sessionId: id, enabled: Boolean(browserRow?.on && browserRow.state !== 'blocked'), chipHost });
      // Write only on change, so an unchanged pass stays read-only.
      const hideFilter = rows.length < SEARCH_MIN_ROWS;
      if (filter && filter.hidden !== hideFilter) filter.hidden = hideFilter;
      if (filter && hideFilter && filter.value) filter.value = '';
      const next = JSON.stringify({ id, vm, grants: computer.grants, filter: filter?.value || '' });
      if (signature === next) return;
      const query = (filter?.value || '').toLowerCase().trim();
      const { on, off, total } = toggleModule.countRows(vm);
      const showOff = vm.hasOverrides && off > 0 && !vm.lockdown;
      let chip = chipHost.querySelector('#composerToolsChip');
      if (!chip && rows.length) {
        chip = element(windowRef.inventory.chip({ id: 'composer-tools', domId: 'composerToolsChip', iconHtml: sliders,
          label: ' ', hasPopup: true, ariaControls: 'composerChatPanel', className: 'composer-tools-chip' }));
        chipHost.appendChild(chip);
      }
      if (chip) {
        chip.querySelector('.inv-chip-label').textContent = vm.lockdown ? jt('composer.chatPanel.offline', 'Offline') : jt('composer.chatPanel.toolsLabel', 'Tools');
        windowRef.inventory.chip.setCount(chip, showOff ? jt('composer.chatPanel.offCount', '{count} off', { count: off }) : '');
        chip.classList.toggle('composer-tools-chip--off', showOff);
        chip.setAttribute('aria-label', jt('composer.chatPanel.chipLabel', 'Tools for this chat: {on} of {total} on', { on, total }));
      }
      tally.textContent = (vm.lockdown ? jt('composer.chatPanel.offline', 'Offline') + ' · ' : '') + jt('composer.chatPanel.tally', '{on} of {total} on', { on, total });
      const groups = [...vm.sections.map((section) => ({ id: section.id, rows: section.families })), { id: 'connections', rows: vm.connections }];
      const labels = { project: jt('composer.chatPanel.inProject', 'In this project'), create: jt('composer.chatPanel.create', 'Create'), reach: jt('composer.chatPanel.reach', 'Reach'), connections: jt('composer.chatPanel.connections', 'Connections') };
      let deferred = false;
      for (const group of groups) {
        let section = sections.get(group.id);
        if (!section && group.rows.length) {
          section = { node: element('<section><div class="composer-chat-section-label"></div></section>'), headHtml: null };
          section.head = section.node.firstElementChild;
          sections.set(group.id, section);
          list.insertBefore(section.node, emptyLine);
        }
        // One reason on the label when every row in a multi-row section is blocked for it.
        const reasons = group.rows.map((row) => (row.state === 'blocked' ? reasonFor(row, vm) : null));
        const shared = group.rows.length > 1 && reasons[0]?.text && reasons.every((reason) => reason?.text === reasons[0].text) ? reasons[0] : null;
        if (section) deferred = setHtml(section, 'headHtml', section.head, escapeHtml(labels[group.id]) + (shared ? ' · ' + reasonHtml(shared) : '')) || deferred;
        for (const [index, row] of group.rows.entries()) {
          const entry = mounted.get(row.id) || mountRow(row, section.node);
          deferred = patchRow(row, vm, entry, { query, shared }) || deferred;
          if (section.node.children[index + 1] !== entry.node) {
            if (focusInside(entry.node)) deferred = true;
            else section.node.insertBefore(entry.node, section.node.children[index + 1] || null);
          }
        }
      }
      const ids = new Set(rows.map((row) => row.id));
      for (const [rowId, entry] of mounted) {
        if (ids.has(rowId)) continue;
        if (focusInside(entry.node)) { deferred = true; continue; }
        entry.node.remove(); mounted.delete(rowId);
      }
      // Insert only out-of-order nodes, preserving existing focused controls.
      groups.filter((group) => sections.has(group.id)).forEach((group, index) => {
        const { node } = sections.get(group.id);
        if (list.children[index] !== node) {
          if (focusInside(node)) deferred = true;
          else list.insertBefore(node, list.children[index] || null);
        }
      });
      for (const { node } of sections.values()) node.hidden = ![...node.querySelectorAll('.composer-tool-row')].some((rowNode) => !rowNode.hidden);
      const noMatch = !!query && [...sections.values()].every(({ node }) => node.hidden);
      emptyLine.hidden = !noMatch;
      if (noMatch) emptyLine.textContent = jt('composer.chatPanel.noMatch', 'No tool matches “{query}”.', { query: filter.value.trim() });
      resetButton.hidden = !vm.hasOverrides;
      signature = deferred ? null : next;
    }
    async function refreshComputer() {
      if (!bridge()) return;
      const id = chatId();
      watchComputer();
      const [status, granted] = await Promise.all([ask('status'), id ? ask('grants', { sessionId: id }) : null]);
      if (id !== chatId()) return;
      computer.status = status?.ok ? status : null;
      computer.grants = granted?.ok && Array.isArray(granted.grants) ? granted.grants.filter((grant) => typeof grant?.path === 'string')
        .map((grant) => ({ name: String(grant.name || grant.path), path: grant.path, viewOnly: grant.viewOnly === true })) : null;
      computer.sessionId = id;
      render();
    }
    const reloadComputer = () => refreshComputer().catch((error) => appendClientLog('WARN', 'composer.computer_refresh_failed', { message: error.message || String(error) }));
    // Listens only once the panel has opened, so a chat that never opens Tools never subscribes.
    function watchComputer() {
      if (computer.watching) return;
      computer.watching = true;
      bridge().onStatus?.((status) => { if (status?.ok) { computer.status = status; render(); } });
      // Grants change only on an open or focus step, or when the turn ends.
      windowRef.rendererComputerStepDisplay?.turnState?.subscribe?.((sessionId, entry) => {
        const grantsMayChange = entry?.state === 'idle' || (entry?.state === 'thinking' && (entry.action === 'open' || entry.action === 'focus'));
        if (grantsMayChange && sessionId === chatId() && !panel?.hidden) reloadComputer();
      });
    }
    panel?.addEventListener('inv-popover-toggle', (event) => { if (event.target === panel && event.detail?.open) reloadComputer(); });
    function settle(persistence) {
      render();
      Promise.resolve(persistence).then(render, (error) => appendClientLog('WARN', 'composer.tool_toggle_failed', { message: error.message || String(error) }));
      return persistence;
    }
    function handleToggleChange(event) {
      hydrate();
      const id = String(event?.detail?.id || '');
      if (!id.startsWith('tool-target:') || !controller) return;
      return settle(controller.setToggle(id.slice(12), event.detail.checked === true));
    }
    function clearFilter() {
      if (!filter?.value) return;
      filter.value = '';
      render();
    }
    if (panel) panel.__jennyChatPanel = {
      render, clearFilter,
      // Clicks the switch so the inventory's delegated handler toggles it exactly once.
      toggleRow: (id) => { mounted.get(id)?.track.click(); },
      toggleMembers: (id) => {
        const entry = mounted.get(id);
        if (!entry) return;
        // A search opened this row: the click collapses it until the query changes.
        if (entry.forced) { entry.forced = false; expanded.delete(id); } else if (!expanded.delete(id)) expanded.add(id);
        syncMembers(entry);
      },
      reset: () => {
        hydrate();
        const done = settle(controller.resetToDefaults());
        // Reset hides its own button, so focus moves to the first switch instead of the body.
        rowSwitches()[0]?.focus();
        return done;
      },
      focusFirst: () => { clearFilter(); focusables()[0]?.focus(); },
      moveFocus: (event) => {
        const items = focusables();
        const active = slot.ownerDocument.activeElement;
        // From a row's count button or fix link, move relative to that row's switch.
        const index = items.indexOf(items.includes(active) ? active : active?.closest?.('.composer-tool-row')?.querySelector('[data-inv-toggle]'));
        const down = event.key === 'ArrowDown';
        if (!items.length || (!down && event.key !== 'ArrowUp')) return;
        event.preventDefault();
        items[index < 0 ? (down ? 0 : items.length - 1) : (index + (down ? 1 : -1) + items.length) % items.length].focus();
      },
    };
    async function refresh() {
      if (!controller || !windowRef.jennyShell?.tools?.list) return;
      try {
        const list = await windowRef.jennyShell.tools.list();
        controller.setAvailableTools(extractToolEntries(list));
        controller.hydrateFromToolSettings(state.features?.tools);
        hydrate(true); render();
      } catch (error) {
        appendClientLog('WARN', 'composer.tool_toggles_refresh_failed', { message: error.message || String(error) });
      }
    }
    function getToolPreferences() {
      hydrate();
      return controller?.getToggleStates() || { families: {}, connections: {} };
    }
    return { render, refresh, refreshComputer, handleToggleChange, getToolPreferences, extractToolEntries };
  }
  return { createComposerToolsSlot, extractToolEntries };
});
