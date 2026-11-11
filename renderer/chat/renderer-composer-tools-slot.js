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
    function reasonFor(row, vm) {
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
      const vm = controller.getViewModel();
      const rows = rowsFor(vm);
      const browserRow = rows.find((row) => row.id === 'browser_use');
      windowRef.rendererSyncBrowserUse?.({ sessionId: id, enabled: Boolean(browserRow?.on && browserRow.state !== 'blocked'), chipHost });
      // Write only on change, so an unchanged pass stays read-only.
      const hideFilter = rows.length < SEARCH_MIN_ROWS;
      if (filter && filter.hidden !== hideFilter) filter.hidden = hideFilter;
      if (filter && hideFilter && filter.value) filter.value = '';
      const next = JSON.stringify({ id, vm, filter: filter?.value || '' });
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
    return { render, refresh, handleToggleChange, getToolPreferences, extractToolEntries };
  }
  return { createComposerToolsSlot, extractToolEntries };
});
