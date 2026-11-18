/* Team tab: the keyboard focus across redraws and the keys of the view (row 123; moved out of renderer-team-tab.js in
 * slice 3-10, which also added the shared projects to it: the project region to F6 and project rows to Alt+Arrow).
 *
 * - Focus keys: a control is the same one after a redraw when its id matches, or its action and the member, team,
 *   channel, project or conversation it acts on (and its place among controls that share all of that). `capture`
 *   before a redraw, `restore` after: the control that had the focus keeps it; one that is busy gets it back when its
 *   answer is in; one that is gone hands it to the switcher, so the focus never drops to the page. The timeline, the
 *   composer and the project region are never replaced by a render and keep their own focus.
 * - Keys: F6 and Shift+F6 cycle the column, the notice, the timeline, the composer, the picker, an open thread and the
 *   project region (skipping a region that is not shown); Ctrl+F focuses search; Alt+Up/Down moves between column
 *   rows, over the rows of a folded project; the arrow keys on the switcher open its menu. In an open project conversation
 *   Ctrl+F opens that conversation's find instead (row 175 item 8).
 *
 * `createTabFocus(deps)`: `container()`, `live()` (the tab's page state: `owedFocus`, `menuOpen`), `frame()`, and the
 * tab's own `openMenu` and `focusSearch`. SWITCH_ID and CONTROLS are the tab's too (one copy, here). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamTabFocus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SWITCH_ID = 'teamTabSwitch';
  const CONTROLS = '[data-team-action], [data-team-tab-action], [data-team-channel], [data-team-notice]';
  const FRAME_REGIONS = '[data-team-region="timeline"], [data-team-region="composer"], [data-team-region="thread"], [data-team-region="search"], [data-team-region="picker"], [data-team-region="project"]';

  function createTabFocus({ container, live, frame, openMenu, focusSearch }) {
    function keyOf(el) {
      const d = el.dataset || {};
      return { action: d.teamAction || '', tab: d.teamTabAction || '', member: d.memberId || '', team: d.teamId || '', channel: d.teamChannel || '', notice: d.teamNotice || '',
        project: d.projectId || '', session: d.sessionId || '' };
    }
    const FIELDS = ['action', 'tab', 'member', 'team', 'channel', 'notice', 'project', 'session'];
    function sameControl(el, key) {
      const k = keyOf(el);
      return FIELDS.every((field) => k[field] === key[field]);
    }
    function controls(key) { return Array.from(container().querySelectorAll(CONTROLS)).filter((el) => sameControl(el, key)); }
    function focusKey(el) {
      const key = { id: el.id || '', ...keyOf(el), nth: 0 };
      if (!key.id) key.nth = Math.max(0, controls(key).indexOf(el));
      return key;
    }
    function findControl(key) {
      const root = container();
      if (key.id) { const el = root.ownerDocument.getElementById(key.id); return el && root.contains(el) ? el : null; }
      const same = controls(key);
      return same[key.nth] || same[0] || null;
    }

    function capture() {
      const root = container();
      const doc = root.ownerDocument;
      const active = doc.activeElement;
      let key = null;
      const inside = Boolean(active && active !== doc.body && root.contains(active));
      if (inside && !active.closest(FRAME_REGIONS)) key = focusKey(active);
      else if (!active || active === doc.body) key = live().owedFocus;
      live().owedFocus = null;
      return { key, active, inside };
    }

    // Focus the person moved out of the view, or that is still on a node that stayed, is left alone.
    function restore({ key, active, inside }) {
      if (!key || (inside && active.isConnected)) return;
      const again = findControl(key);
      if (again && again.disabled) { live().owedFocus = key; return; }
      const root = container();
      const next = again || root.querySelector('#' + SWITCH_ID) || root.querySelector('button:not([disabled])');
      if (next && typeof next.focus === 'function') next.focus({ preventScroll: true });
    }

    function cycleRegions(back) {
      const f = frame();
      if (!f) return false;
      const doc = container().ownerDocument;
      const firstButton = (el) => el && el.querySelector('button:not([disabled]), [tabindex="0"]');
      const shown = (el) => typeof el.checkVisibility !== 'function' || el.checkVisibility();
      const regions = [
        { root: f.panel, target: () => (f.search.active() ? f.search.focusTarget() : f.panel.querySelector('[data-team-channel][aria-current="true"]') || firstButton(f.panel)) },
        { root: f.regions.notice, target: () => firstButton(f.regions.notice) },
        { root: f.shell.querySelector('[data-team-region="timeline"]'), target: () => f.timeline.focusTarget() },
        { root: f.shell.querySelector('[data-team-region="composer"]'), target: () => f.composer.focusTarget() },
        { root: f.picker && f.shell.querySelector('[data-team-region="picker"]'), target: () => f.picker.focusTarget() },
        { root: f.thread && f.thread.logRoot, target: () => f.thread.focusTarget() },
        { root: f.thread && f.thread.composerRoot, target: () => f.thread.composerTarget() },
        { root: f.project && f.shell.querySelector('[data-team-region="project"]'), target: () => f.project.focusTarget() },
      ].filter((region) => region.root && shown(region.root) && region.target());
      if (!regions.length) return false;
      const at = regions.findIndex((region) => region.root.contains(doc.activeElement));
      const next = regions[(at + (back ? -1 : 1) + regions.length) % regions.length];
      next.target().focus();
      return true;
    }

    function onKeydown(event) {
      if (event.key === 'F6' && !event.ctrlKey && !event.altKey) {
        if (cycleRegions(event.shiftKey)) event.preventDefault();
        return;
      }
      if (frame() && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        // Row 175 item 8: inside an open project conversation Ctrl+F finds in it (its own keys do the same); elsewhere it focuses the search.
        const shown = frame().project;
        if (!(shown && typeof shown.openFind === 'function' && shown.openFind())) focusSearch(event.target);
        return;
      }
      const row = event.target && event.target.closest ? event.target.closest('[data-team-channel], [data-team-project-row]') : null;
      if (row && event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        // The rows under a folded project are not shown, so they are skipped.
        const list = Array.from(container().querySelectorAll('[data-team-channel], [data-team-project-row]'))
          .filter((el) => el === row || !el.closest('.team-proj[data-open="false"] .team-proj__kids'));
        const index = list.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1);
        event.preventDefault();
        (list[Math.max(0, Math.min(index, list.length - 1))] || row).focus();
        return;
      }
      // Arrow keys on the switcher open its menu (the menu itself handles the keys once it is open).
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target && event.target.closest ? event.target.closest('#' + SWITCH_ID) : null;
      if (!target || live().menuOpen) return;
      event.preventDefault();
      openMenu();
    }

    return { capture, restore, onKeydown };
  }

  return { createTabFocus, SWITCH_ID, CONTROLS };
});
