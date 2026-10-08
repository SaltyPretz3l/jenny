/* renderer/features/renderer-ide-editor-groups.js - pure editor-group helpers over
 * the state.ui.ide slice (no DOM, no IPC).
 *
 * ide.openTabs stays the one master list. A file tab in a secondary editor group
 * carries `group: 'editor-N'` (N 2..4); a tab without `group` is in the primary
 * group. ide.activeTabPath is always a primary tab (or ''); each secondary group's
 * active path is runtime-only in ide.groupActive. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorGroups = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Primary + three secondary groups (the layout model's MAX_EDITOR_GROUPS).
  const MAX_GROUPS = 4;
  const GROUP_IDS = ['editor-2', 'editor-3', 'editor-4'];
  const GROUP_ID_RE = /^editor-[2-4]$/;

  function isGroupId(id) {
    return typeof id === 'string' && GROUP_ID_RE.test(id);
  }

  function tabList(ide) {
    return Array.isArray(ide && ide.openTabs) ? ide.openTabs : [];
  }

  // '' = primary (also for an unknown path or an invalid group value).
  function tabGroup(tab) {
    return tab && isGroupId(tab.group) ? tab.group : '';
  }

  function groupOf(ide, path) {
    return tabGroup(tabList(ide).find((tab) => tab.path === path));
  }

  function tabsIn(ide, groupId) {
    return tabList(ide).filter((tab) => tabGroup(tab) === groupId);
  }

  function usedGroups(ide) {
    return GROUP_IDS.filter((id) => tabList(ide).some((tab) => tabGroup(tab) === id));
  }

  function getGroupActive(ide, groupId) {
    if (groupId === '') {
      return ide.activeTabPath || '';
    }
    if (!isGroupId(groupId)) {
      return '';
    }
    const tabs = tabsIn(ide, groupId);
    const stored = ide.groupActive && ide.groupActive[groupId];
    if (tabs.some((tab) => tab.path === stored)) {
      return stored;
    }
    return tabs.length ? tabs[0].path : '';
  }

  function setGroupActive(ide, groupId, path) {
    const valid = (groupId === '' || isGroupId(groupId))
      && tabList(ide).some((tab) => tab.path === path && tabGroup(tab) === groupId);
    if (!valid) {
      return false;
    }
    if (groupId === '') {
      ide.activeTabPath = path;
    } else {
      ide.groupActive = ide.groupActive || {};
      ide.groupActive[groupId] = path;
    }
    return true;
  }

  // The path that should become active in `path`'s group once `path` leaves it:
  // the next tab to the right, else the one to the left, else ''.
  function neighbourInGroup(ide, path) {
    const tabs = tabsIn(ide, groupOf(ide, path));
    const at = tabs.findIndex((tab) => tab.path === path);
    if (at === -1) {
      return '';
    }
    const next = tabs[at + 1] || tabs[at - 1];
    return next ? next.path : '';
  }

  // Local equivalent of renderer-ide-state's sortTabsPinnedFirst (a stable partition).
  function pinnedFirst(tabs) {
    return [...tabs.filter((tab) => tab.pinned === true), ...tabs.filter((tab) => tab.pinned !== true)];
  }

  // Master-list order after `tab` takes final position `index` among destination
  // group `to`'s tabs; a non-integer index appends.
  function reordered(ide, tab, to, index) {
    const rest = tabList(ide).filter((entry) => entry !== tab);
    const dest = rest.filter((entry) => tabGroup(entry) === to);
    if (!Number.isInteger(index) || index >= dest.length) {
      return rest.concat([tab]);
    }
    const before = rest.indexOf(dest[Math.max(0, index)]);
    return rest.slice(0, before).concat([tab], rest.slice(before));
  }

  // Moves a file tab to `toGroup` ('' = primary). `index` is the tab's final
  // position among the destination group's tabs.
  function moveTab(ide, path, toGroup, index) {
    const tab = tabList(ide).find((entry) => entry.path === path);
    if (!tab || !['file', 'diff'].includes(tab.kind) || (toGroup !== '' && !isGroupId(toGroup))) {
      return { ok: false };
    }
    const from = tabGroup(tab);
    if (from === toGroup && !Number.isInteger(index)) {
      return { ok: false };
    }
    const nextTabs = pinnedFirst(reordered(ide, tab, toGroup, index));
    // Same group: refuse when the group's own tab order would not change.
    const order = (tabs) => tabs.filter((entry) => tabGroup(entry) === from).map((entry) => entry.path).join('\u0000');
    if (from === toGroup && order(nextTabs) === order(tabList(ide))) {
      return { ok: false };
    }
    const leavesActive = getGroupActive(ide, from) === path;
    const successor = neighbourInGroup(ide, path);
    ide.openTabs = nextTabs;
    delete tab.transientPreview;
    if (from === toGroup) {
      return { ok: true, from, to: toGroup, primaryActive: ide.activeTabPath };
    }
    ide.groupActive = ide.groupActive || {};
    if (leavesActive && from === '') {
      ide.activeTabPath = successor;
    } else if (leavesActive && successor) {
      ide.groupActive[from] = successor;
    } else if (leavesActive) {
      delete ide.groupActive[from];
    }
    if (toGroup === '') {
      delete tab.group;
      ide.activeTabPath = path;
    } else {
      tab.group = toGroup;
      ide.groupActive[toGroup] = path;
    }
    return { ok: true, from, to: toGroup, primaryActive: ide.activeTabPath };
  }

  // The lowest of editor-2..4 used by neither a tab nor `takenIds` (ids already in
  // the layout), else ''.
  function freeGroupId(ide, takenIds) {
    const taken = new Set(Array.isArray(takenIds) ? takenIds : []);
    const used = new Set(usedGroups(ide));
    return GROUP_IDS.find((id) => !taken.has(id) && !used.has(id)) || '';
  }

  // Moves every tab of a group back to the end of the primary group. The primary's
  // active tab is kept; with none, the first moved tab becomes active.
  function releaseGroup(ide, groupId) {
    if (!isGroupId(groupId)) {
      return [];
    }
    const moved = tabsIn(ide, groupId);
    if (!moved.length) {
      return [];
    }
    const primaryActive = tabsIn(ide, '').some((tab) => tab.path === ide.activeTabPath);
    moved.forEach((tab) => {
      delete tab.group;
    });
    ide.openTabs = pinnedFirst(tabList(ide).filter((tab) => !moved.includes(tab)).concat(moved));
    if (ide.groupActive) {
      delete ide.groupActive[groupId];
    }
    if (!primaryActive) {
      ide.activeTabPath = moved[0].path;
    }
    return moved.map((tab) => tab.path);
  }

  return {
    GROUP_ID_RE,
    MAX_GROUPS,
    freeGroupId,
    getGroupActive,
    groupOf,
    isGroupId,
    moveTab,
    neighbourInGroup,
    releaseGroup,
    setGroupActive,
    tabsIn,
    usedGroups,
  };
});
