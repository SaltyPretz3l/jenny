/* renderer/shell/renderer-sidebar-copy-items.js
 *
 * The Copy items of the Chats sidebar menus: Copy chat name and Copy chat ID
 * on a chat row, Copy project name and Copy project path on a chat row and on
 * a project header. renderer-session-actions.js loads this module lazily (no
 * startup <script> slot); both menus read it when they open and show no copy
 * items until it has loaded.
 *
 * Project facts come from the shared project switcher. Until its list has
 * loaded the project items still show and resolve on click; once it has, a
 * project without a folder (General, a folderless project) offers no path.
 * Every copy ends in one toast: the copied value, or why nothing was copied.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSidebarCopyItems = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var stringUtils = globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : {});
  var GENERAL_PROJECT_ID = 'project_general';

  /** The title the sidebar row shows (whitespace collapsed, the default title for an untitled chat). */
  function chatName(summary) {
    return stringUtils.resolveDefaultTitle(String(summary && summary.title || '').replace(/\s+/g, ' ').trim());
  }

  function projectIdOf(summary) {
    return String(summary && summary.project_id || '').trim() || GENERAL_PROJECT_ID;
  }

  /**
   * deps.windowRef: the window (clipboard at jennyShell.clipboard).
   * deps.getSwitcher(): the project switcher, or a promise of it (null when unavailable).
   * deps.showToastMessage(message, options), deps.appendClientLog(level, event, data), deps.toastSource.
   */
  function createSidebarCopyItems(deps) {
    var windowRef = deps.windowRef || globalThis;
    var switcher = null;
    var switcherPromise = null;

    function log(level, event, data) {
      if (typeof deps.appendClientLog === 'function') deps.appendClientLog(level, event, data);
    }

    function toast(message, tone, what) {
      if (typeof deps.showToastMessage !== 'function') return;
      deps.showToastMessage(message, { tone: tone, source: deps.toastSource, dedupeKey: 'sidebar-copy:' + what });
    }

    function listLoaded(candidate) {
      var list = candidate && typeof candidate.getProjects === 'function' ? candidate.getProjects() : null;
      return Array.isArray(list) && list.length > 0;
    }

    // The switcher with its project list read; null when there is none. One load in flight.
    function loadSwitcher() {
      if (listLoaded(switcher)) return Promise.resolve(switcher);
      if (switcherPromise) return switcherPromise;
      switcherPromise = Promise.resolve()
        .then(function () { return typeof deps.getSwitcher === 'function' ? deps.getSwitcher() : null; })
        .then(function (resolved) {
          if (!resolved) return null;
          switcher = resolved;
          return listLoaded(resolved) || typeof resolved.refresh !== 'function'
            ? resolved
            : Promise.resolve(resolved.refresh()).then(function () { return resolved; });
        })
        .catch(function (error) {
          log('WARN', 'sessions.copy_project_lookup_failed', { message: String(error && error.message || error).slice(0, 120) });
          return null;
        })
        .then(function (result) { switcherPromise = null; return result; });
      return switcherPromise;
    }

    /** The loaded project record, null when the list is loaded without it, undefined while unknown. */
    function knownProject(projectId) {
      if (!listLoaded(switcher)) {
        loadSwitcher();
        return undefined;
      }
      return switcher.projectById(projectId);
    }

    function copyText(text, what) {
      return Promise.resolve()
        .then(function () { return windowRef.jennyShell.clipboard.writeText(text); })
        .then(function () {
          toast(jt('ide.pathMenu.copiedValue', 'Copied {value}', { value: text }), 'success', what);
          return true;
        }, function (error) {
          log('WARN', 'sessions.copy_failed', { what: what, message: String(error && error.message || error).slice(0, 120) });
          toast(jt('ide.pathMenu.copyFailed', 'Could not copy to the clipboard.'), 'danger', what);
          return false;
        });
    }

    /** The project record after the list has loaded; null when there is none. */
    function projectOf(projectId) {
      return loadSwitcher().then(function (loaded) { return loaded && loaded.projectById(projectId) || null; });
    }

    function copyProjectName(projectId, fallbackName) {
      return projectOf(projectId).then(function (project) {
        var name = String(project && project.name || fallbackName || '').trim();
        if (name) return copyText(name, 'project-name');
        toast(jt('sidebar.copy.projectUnknown', "Couldn't find this chat's project."), 'danger', 'project-name');
        return false;
      });
    }

    function copyProjectPath(projectId) {
      return projectOf(projectId).then(function (project) {
        var rootPath = String(project && project.rootPath || '');
        if (rootPath) return copyText(rootPath, 'project-path');
        toast(jt('sidebar.copy.projectNoFolder', 'This project has no folder.'), 'info', 'project-path');
        return false;
      });
    }

    /** Copy project name, and Copy project path unless the loaded project has no folder. */
    function projectItems(projectId, fallbackName) {
      var project = knownProject(projectId);
      var items = [{ label: jt('sidebar.copy.projectName', 'Copy project name'), action: function () { return copyProjectName(projectId, fallbackName); } }];
      if (project === undefined || (project && project.rootPath)) {
        items.push({ label: jt('sidebar.copy.projectPath', 'Copy project path'), action: function () { return copyProjectPath(projectId); } });
      }
      return items;
    }

    /** The chat row's copy group, led by a separator; plugin chats belong to their provider, not a project. */
    function chatItems(summary) {
      if (!summary || !summary.id) return [];
      var id = String(summary.id);
      var name = chatName(summary);
      var items = [
        { separator: true },
        { label: jt('sidebar.copy.chatName', 'Copy chat name'), action: function () { return copyText(name, 'chat-name'); } },
        { label: jt('sidebar.copy.chatId', 'Copy chat ID'), action: function () { return copyText(id, 'chat-id'); } },
      ];
      return summary.session_type === 'plugin' ? items : items.concat(projectItems(projectIdOf(summary), ''));
    }

    /** The project header menu's copy group, led by a separator. headerLabel names the project until the list loads. */
    function projectMenuItems(projectId, headerLabel) {
      return [{ separator: true }].concat(projectItems(projectId, headerLabel));
    }

    return { chatItems: chatItems, projectMenuItems: projectMenuItems };
  }

  return { createSidebarCopyItems: createSidebarCopyItems, chatName: chatName };
});
