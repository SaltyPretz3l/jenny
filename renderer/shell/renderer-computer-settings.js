/* renderer/shell/renderer-computer-settings.js
 *
 * Settings > Tools > Computer (row 196, C12): the Stop key and "Your programs".
 * The switch row comes from the tool config fields (host #toolsComputerList); this controller fills
 * #toolsComputerExtra in the same group. It reads window.jennyShell.computerUse only while the Tools
 * section is shown, and never throws on a missing bridge.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererComputerSettings = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var HOST_ID = 'toolsComputerExtra';
  var TOOLS_SECTION_SELECTOR = '.settings-card[data-settings-section="tools"]';
  var DEFAULT_CHORD = 'Ctrl+Alt+Shift+F12';
  var NAME_MAX = 120;

  var escapeHtml = ((root && root.stringUtils) || (typeof require === 'function' ? require('../shared/string-utils') : {})).escapeHtml;
  function actionButton(opts) {
    return ((root && root.inventoryActionButton) || (typeof require === 'function' ? require('../inventory/action-button') : null))(opts);
  }
  function textField(opts) {
    return ((root && root.inventoryTextField) || (typeof require === 'function' ? require('../inventory/text-field') : null))(opts);
  }

  function normalizePrograms(answer) {
    var list = answer && answer.ok !== false && Array.isArray(answer.programs) ? answer.programs : [];
    return list.filter(function (p) { return p && typeof p.path === 'string' && p.path; })
      .map(function (p) { return { name: String(p.name || p.path), path: p.path }; });
  }

  function createComputerSettingsController(deps) {
    var d = deps || {};
    var windowRef = d.windowRef || globalThis;
    var documentRef = d.documentRef || windowRef.document || null;
    var view = { status: null, programs: [], loaded: false, renaming: '', busy: false, message: '' };
    var disposed = false;
    var shown = false;
    var observer = null;
    var unsubscribeStatus = null;
    var host = null;

    function bridge() { return (windowRef.jennyShell && windowRef.jennyShell.computerUse) || null; }
    function toolsCard() { return documentRef && documentRef.querySelector(TOOLS_SECTION_SELECTOR); }
    function group() { return host && host.closest('.cu-settings-group'); }
    function call(name, payload) {
      var b = bridge();
      if (!b || typeof b[name] !== 'function') return Promise.resolve(null);
      return Promise.resolve().then(function () { return b[name](payload); }).catch(function () { return null; });
    }

    function offWindows() {
      var platform = (windowRef.navigator && windowRef.navigator.platform) || '';
      return (view.status && view.status.reason === 'not_windows') || (!bridge() && platform && !/^win/i.test(platform));
    }

    function noteText() {
      if (offWindows()) return jt('settings.tools.computer.windowsOnly', 'Windows only for now.');
      if (!bridge()) return jt('settings.tools.computer.notAvailable', 'Not available in this version.');
      return view.message;
    }

    function keyRowHtml() {
      var s = view.status || {};
      var taken = s.stopChordRegistered === false
        ? ' ' + jt('settings.tools.computer.stopKey.taken', 'Another program holds this key right now. Use Stop on the pill.') : '';
      return '<div class="settings-field-row" data-cu-key><div class="settings-field-row-text">'
        + '<span class="settings-field-label">' + escapeHtml(jt('settings.tools.computer.stopKey.label', 'Stop key')) + '</span>'
        + '<p class="settings-field-description">' + escapeHtml(jt('settings.tools.computer.stopKey.description', 'Press it anywhere to stop Jenny at once, even over an administrator’s window. Touching the mouse or a key pauses it.') + taken) + '</p>'
        + '</div><div class="cu-key-cell"><kbd>' + escapeHtml(s.stopChord || DEFAULT_CHORD) + '</kbd></div></div>';
    }

    function nameHtml(p, off) {
      if (view.renaming === p.path) {
        return textField({
          id: 'cuProgramNameInput', value: p.name, maxLength: NAME_MAX, className: 'cu-program-name-input',
          ariaLabel: jt('settings.tools.computer.programs.nameLabel', 'Program name'), dataset: { 'cu-input': 'name' },
        });
      }
      return actionButton({
        plain: true, className: 'settings-field-label cu-program-name', label: p.name, disabled: off,
        title: jt('settings.tools.computer.programs.renameTitle', 'Click to rename'), dataset: { 'cu-action': 'rename', 'cu-path': p.path },
      });
    }

    function rowHtml(p, off) {
      return '<div class="settings-field-row knowledge-folders-row cu-program-row" title="' + escapeHtml(p.path) + '">'
        + '<div class="settings-field-row-text">' + nameHtml(p, off)
        + '<p class="settings-field-description knowledge-folders-row-path cu-program-path" title="' + escapeHtml(p.path) + '">' + escapeHtml(p.path) + '</p></div>'
        + '<div class="knowledge-folders-row-actions">' + actionButton({
          plain: true, className: 'settings-secondary knowledge-folders-remove-btn', label: jt('common.remove', 'Remove'),
          disabled: off, dataset: { 'cu-action': 'remove', 'cu-path': p.path },
        }) + '</div></div>';
    }

    function programsHtml(off) {
      var rows = view.programs.map(function (p) { return rowHtml(p, off); }).join('')
        || (view.loaded ? '<p class="settings-note">' + escapeHtml(jt('settings.tools.computer.programs.empty', 'No programs of your own yet.')) + '</p>' : '');
      return '<h5 class="cu-subheading">' + escapeHtml(jt('settings.tools.computer.programs.heading', 'Your programs')) + '</h5>'
        + '<p class="settings-group-copy">' + escapeHtml(jt('settings.tools.computer.programs.copy', 'Programs with no Start menu entry, such as your own builds. Jenny may start only these and Start menu programs, and still asks first.')) + '</p>'
        + '<div class="knowledge-folders-list">' + rows + '</div>'
        + '<div class="knowledge-folders-add-row">' + actionButton({
          plain: true, className: 'settings-primary', label: jt('settings.tools.computer.programs.add', 'Add program…'),
          disabled: off || view.busy, dataset: { 'cu-action': 'add' },
        }) + '</div>';
    }

    function syncGroup() {
      var g = group();
      if (!g) return;
      if (offWindows()) g.setAttribute('aria-disabled', 'true');
      else g.removeAttribute('aria-disabled');
    }

    function render() {
      if (!host || disposed) return;
      var off = Boolean(offWindows());
      host.innerHTML = keyRowHtml() + (bridge() ? programsHtml(off) : '')
        + '<div class="settings-note" aria-live="polite">' + escapeHtml(noteText()) + '</div>';
      syncGroup();
      var input = view.renaming && host.querySelector('.inv-text-field-control');
      if (input) { input.focus(); input.select(); }
    }

    function patchKey(status) {
      view.status = status || null;
      var row = host && host.querySelector('[data-cu-key]');
      if (row) row.outerHTML = keyRowHtml();
      syncGroup();
    }

    function load() {
      var b = bridge();
      if (b && !unsubscribeStatus && typeof b.onStatus === 'function') {
        unsubscribeStatus = b.onStatus(function (status) { if (!disposed) patchKey(status); });
      }
      return Promise.all([call('status'), call('listPrograms')]).then(function (answers) {
        if (disposed) return;
        view.status = answers[0] && answers[0].ok !== false ? answers[0] : null;
        view.programs = normalizePrograms(answers[1]);
        view.loaded = true;
        view.renaming = '';
        render();
      });
    }

    function findProgram(path) {
      return view.programs.filter(function (p) { return p.path === path; })[0] || null;
    }

    function removeProgram(path) {
      view.message = '';
      view.programs = view.programs.filter(function (p) { return p.path !== path; });
      render();
      call('removeProgram', { path: path }).then(function (r) { if (!r || r.ok !== true) void load(); });
    }

    function addProgram() {
      if (view.busy) return;
      view.busy = true;
      view.message = '';
      render();
      call('addProgram').then(function (r) {
        if (disposed) return;
        view.busy = false;
        if (r && r.ok === true && r.program && r.program.path) {
          if (!findProgram(r.program.path)) view.programs.push({ name: String(r.program.name || r.program.path), path: r.program.path });
        } else if (r && r.reason === 'cancelled') {
          view.message = '';
        } else if (r && r.reason === 'too_many') {
          view.message = jt('settings.tools.computer.programs.tooMany', 'Your program list is full. Remove one first.');
        } else {
          view.message = jt('settings.tools.computer.programs.addFailed', 'That program could not be added.');
        }
        render();
      });
    }

    function startRename(path) {
      view.message = '';
      view.renaming = path;
      render();
    }

    function commitRename(input) {
      var path = view.renaming;
      if (!path) return;
      view.renaming = '';
      var program = findProgram(path);
      var name = String((input && input.value) || '').trim();
      if (!program || !name || name.length > NAME_MAX || name === program.name) { render(); return; }
      var previous = program.name;
      program.name = name;
      render();
      call('renameProgram', { path: path, name: name }).then(function (r) {
        if (disposed || (r && r.ok === true)) return;
        program.name = previous;
        view.message = jt('settings.tools.computer.programs.renameFailed', 'That name could not be saved.');
        render();
      });
    }

    function onClick(event) {
      var el = event.target && event.target.closest && event.target.closest('[data-cu-action]');
      if (!el || el.disabled) return;
      var action = el.getAttribute('data-cu-action');
      var path = el.getAttribute('data-cu-path') || '';
      if (action === 'remove') removeProgram(path);
      else if (action === 'rename') startRename(path);
      else if (action === 'add') addProgram();
    }

    function onKeydown(event) {
      if (!event.target || event.target.getAttribute('data-cu-input') !== 'name') return;
      if (event.key === 'Enter') commitRename(event.target);
      else if (event.key === 'Escape') { view.renaming = ''; render(); }
    }

    function onFocusout(event) {
      if (event.target && event.target.getAttribute && event.target.getAttribute('data-cu-input') === 'name') commitRename(event.target);
    }

    // The bridge is read only while the Tools card is on screen.
    function syncWatch() {
      var card = toolsCard();
      var settingsView = documentRef.getElementById('settingsView');
      var now = !disposed && Boolean(card && card.classList.contains('settings-section-active') && (!settingsView || settingsView.classList.contains('active-view')));
      if (now === shown) return;
      shown = now;
      if (now) void load();
    }

    function bind() {
      host = documentRef && documentRef.getElementById(HOST_ID);
      if (!host) return;
      host.addEventListener('click', onClick);
      host.addEventListener('keydown', onKeydown);
      host.addEventListener('focusout', onFocusout);
      if (typeof windowRef.MutationObserver === 'function') {
        observer = new windowRef.MutationObserver(syncWatch);
        [documentRef.getElementById('settingsView'), toolsCard()].forEach(function (node) {
          if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
        });
      }
      syncWatch();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (observer) observer.disconnect();
      if (typeof unsubscribeStatus === 'function') unsubscribeStatus();
      unsubscribeStatus = null;
      if (host) {
        host.removeEventListener('click', onClick);
        host.removeEventListener('keydown', onKeydown);
        host.removeEventListener('focusout', onFocusout);
      }
    }

    return { bind: bind, dispose: dispose, render: render };
  }

  return { createComputerSettingsController: createComputerSettingsController };
});
