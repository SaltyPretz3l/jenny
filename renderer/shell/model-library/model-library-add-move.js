/* GGUF folders ▸ "Add GGUF model…" ▸ Move and add (row 107): the note under the
   folder list that offers to move a picked file out of Downloads into its own
   folder, the move's progress, and the newer-build warning after an add. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.modelLibraryAddMove = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var PROGRESS_POLL_MS = 500;

  function resolveFormatUtils() {
    return (root && root.rendererModelLibraryFormatUtils)
      || (typeof require === 'function' ? require('../renderer-model-library-format-utils') : null);
  }

  function lastSegment(value) {
    var parts = String(value || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function joinPath(dir, name) {
    var base = String(dir || '');
    var separator = base.indexOf('\\') >= 0 || /^[a-z]:/i.test(base) ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + separator + name;
  }

  // options: windowRef, documentRef, escapeHtml, actionButton, rerender(),
  // announce(message), writeModel(filePath, pickedDir) -> Promise<'added'|null>,
  // addRefusal(filePath) -> Promise<why it can't be added, or ''>,
  // tagFor(filePath) -> the library tag the file will be added as.
  function createModelLibraryAddMove(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || root;
    var documentRef = opts.documentRef || windowRef.document || null;
    var escapeHtml = opts.escapeHtml;
    var actionButton = opts.actionButton;
    var formatUtils = resolveFormatUtils();
    var size = function (bytes) { return (formatUtils && formatUtils.formatHumanSize(bytes)) || ''; };
    // { phase: 'confirm'|'moving'|'no-space'|'failed'|'newer-build', ... } or null.
    var state = null;
    var finish = null;
    var pollTimer = 0;
    var disposed = false;

    function llamaServer() {
      return windowRef.jennyShell && windowRef.jennyShell.llamaServer;
    }

    function setState(next) {
      state = next;
      if (!disposed) opts.rerender();
    }

    function done(outcome) {
      var resolve = finish;
      finish = null;
      if (resolve) resolve(outcome);
    }

    function code(value) {
      return '<code>' + escapeHtml(value) + '</code>';
    }

    function button(label, action, variant) {
      return actionButton({ label: label, variant: variant || 'secondary', size: 'sm', dataset: { 'model-library-add-action': action } });
    }

    function link(label, action) {
      return actionButton({ label: label, plain: true, className: 'model-library-add-link', dataset: { 'model-library-add-action': action } });
    }

    function line(html, className) {
      return '<p class="' + (className || 'model-library-add-line') + '">' + html + '</p>';
    }

    function confirmHtml(plan) {
      var sub = plan.companions && plan.companions.length
        ? jt('models.library.add.companions', 'These move with it: {files}.', { files: plan.companions.join(', ') })
        : jt('models.library.add.why', 'Files in {folder} get cleaned up. In its own folder, Jenny keeps finding it, along with any drafter or projector you add later.', { folder: plan.sourceDirName });
      return line(jt('models.library.add.ask', '{file} ({size}) is in {folder}. Move it to {dest}?', {
        file: code(plan.file), size: escapeHtml(size(plan.sizeBytes)), folder: escapeHtml(plan.sourceDirName), dest: code(plan.destDir),
      }))
        + line(escapeHtml(sub), 'model-library-add-sub')
        + '<div class="model-library-add-actions">'
        + button(jt('models.library.add.move', 'Move and add'), 'move', 'primary')
        + button(jt('models.library.add.inPlace', 'Add where it is'), 'in-place')
        + button(jt('common.cancel', 'Cancel'), 'cancel', 'ghost')
        + link(jt('models.library.add.another', 'Another folder…'), 'another')
        + '</div>';
    }

    function progressText() {
      return jt('models.library.add.progress', '{done} of {total} · the original stays in {folder} until the copy is checked', {
        done: size(state.doneBytes) || '0 KB', total: size(state.plan.sizeBytes), folder: state.plan.sourceDirName,
      });
    }

    function movingHtml() {
      var percent = state.plan.sizeBytes > 0 ? Math.min(100, Math.round((state.doneBytes / state.plan.sizeBytes) * 100)) : 0;
      return line(jt('models.library.add.moving', 'Moving {file} to {dest}', { file: code(state.plan.file), dest: code(state.destDir) }))
        + '<div class="model-library-add-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '">'
        + '<i data-model-library-add-bar style="width:' + percent + '%"></i></div>'
        + '<p class="model-library-add-sub model-library-add-num" data-model-library-add-progress-text>' + escapeHtml(progressText()) + '</p>'
        + '<div class="model-library-add-actions">' + button(jt('common.cancel', 'Cancel'), 'cancel', 'ghost') + '</div>';
    }

    function html() {
      if (!state) return '';
      var body = '';
      if (state.phase === 'confirm') body = confirmHtml(state.plan);
      else if (state.phase === 'moving') body = movingHtml();
      else if (state.phase === 'no-space' || state.phase === 'failed') {
        body = line(escapeHtml(state.message))
          + '<div class="model-library-add-actions">'
          + button(jt('models.library.add.inPlace', 'Add where it is'), 'in-place')
          + button(jt('common.cancel', 'Cancel'), 'cancel', 'ghost')
          + link(jt('models.library.add.another', 'Another folder…'), 'another')
          + '</div>';
      } else if (state.phase === 'newer-build') {
        body = line(escapeHtml(jt('models.library.add.newerBuild', 'The bundled llama-server can\'t run {architecture} models.', { architecture: state.architecture })))
          + line(escapeHtml(jt('models.library.add.newerBuildHint', 'Choose a newer llama-server build for {model} in Tune, or update Jenny when a newer bundled build ships.', { model: state.tag })), 'model-library-add-sub')
          + '<div class="model-library-add-actions">'
          + button(jt('models.library.add.openTune', 'Open Tune'), 'open-tune')
          + button(jt('models.library.add.dismiss', 'Dismiss'), 'dismiss', 'ghost')
          + '</div>';
      }
      var role = state.phase === 'moving' ? ' role="status"' : (state.phase === 'confirm' ? ' role="group"' : '');
      return '<div class="model-library-add"' + role + '>' + body + '</div>';
    }

    function stopPolling() {
      if (pollTimer) windowRef.clearInterval(pollTimer);
      pollTimer = 0;
    }

    // Progress repaints in place, so the Cancel button keeps its focus.
    function paintProgress() {
      if (!state || state.phase !== 'moving' || !documentRef) return;
      var percent = state.plan.sizeBytes > 0 ? Math.min(100, Math.round((state.doneBytes / state.plan.sizeBytes) * 100)) : 0;
      var bar = documentRef.querySelector('[data-model-library-add-bar]');
      if (bar) {
        bar.style.width = percent + '%';
        bar.parentNode.setAttribute('aria-valuenow', String(percent));
      }
      var text = documentRef.querySelector('[data-model-library-add-progress-text]');
      if (text) text.textContent = progressText();
    }

    function startPolling() {
      var server = llamaServer();
      if (!server || typeof server.ggufImportStatus !== 'function') return;
      pollTimer = windowRef.setInterval(function () {
        Promise.resolve(server.ggufImportStatus()).then(function (status) {
          if (!state || state.phase !== 'moving' || !status || !status.active) return;
          state.doneBytes = Number(status.doneBytes) || 0;
          paintProgress();
        }, function () { /* the next poll tries again */ });
      }, PROGRESS_POLL_MS);
    }

    // After any add: the build warning when main is sure the bundled build
    // can't read the file's architecture, else the flow is over.
    function afterAdd(outcome, plan, filePath) {
      if (outcome === 'added' && plan && plan.archSupport === 'no' && plan.architecture) {
        setState({ phase: 'newer-build', architecture: plan.architecture, tag: opts.tagFor(filePath) });
      } else {
        setState(null);
      }
      done(outcome);
      return outcome;
    }

    function addInPlace() {
      var current = state;
      setState(null);
      return Promise.resolve(opts.writeModel(current.filePath, current.pickedDir)).then(function (outcome) {
        if (outcome === 'added') {
          opts.announce(jt('models.library.add.addedInPlace', 'Added {model} from {folder}. If you move or delete the file, Jenny can\'t run it.', {
            model: opts.tagFor(current.filePath), folder: current.plan.sourceDirName,
          }));
        }
        return afterAdd(outcome, current.plan, current.filePath);
      }, function () {
        return afterAdd(null, null, current.filePath);
      });
    }

    function failureMessage(result, plan) {
      if (result.reason === 'no_space') {
        return jt('models.library.add.noSpace', 'The destination has {free} free, and {file} needs {size}. Nothing was moved.', {
          free: size(result.freeBytes) || '0 KB', file: plan.file, size: size(plan.sizeBytes),
        });
      }
      if (result.reason === 'exists') {
        return jt('models.library.add.exists', 'A file named {file} is already in that folder. Nothing was moved.', { file: plan.file });
      }
      if (result.reason === 'in_use') {
        return jt('models.library.add.inUse', '{file} is open in another program. Close it, then try again. Nothing was moved.', { file: plan.file });
      }
      if (result.reason === 'busy') {
        return jt('models.library.add.busy', 'Another model is still moving. Try again when it finishes.');
      }
      return jt('models.library.add.moveFailed', 'Could not move {file}. Nothing was changed.', { file: plan.file });
    }

    function move(destRoot) {
      var server = llamaServer();
      var current = state;
      var destDir = destRoot ? joinPath(destRoot, lastSegment(current.plan.destDir)) : current.plan.destDir;
      setState({ phase: 'moving', plan: current.plan, filePath: current.filePath, pickedDir: current.pickedDir, destDir: destDir, doneBytes: 0 });
      startPolling();
      return Promise.resolve().then(function () {
        return server.importGguf(destRoot ? { path: current.filePath, destRoot: destRoot } : { path: current.filePath });
      }).then(function (result) {
        stopPolling();
        if (disposed) return null;
        if (result && result.ok && result.modelPath) {
          setState(null);
          // Once the file has moved, the user is always told where it went.
          var movedNotAdded = function () {
            opts.announce(jt('models.library.add.movedNotAdded', 'Moved {file} to {dir}, but could not add it. Add it from there with Add GGUF model….', { file: current.plan.file, dir: result.dir }));
            return afterAdd(null, null, result.modelPath);
          };
          return Promise.resolve(opts.writeModel(result.modelPath, result.dir)).then(function (outcome) {
            if (outcome !== 'added') return movedNotAdded();
            opts.announce(jt('models.library.add.moved', 'Added {model} · moved to {dir}', { model: opts.tagFor(result.modelPath), dir: result.dir }));
            return afterAdd(outcome, current.plan, result.modelPath);
          }, movedNotAdded);
        }
        if (result && result.reason === 'cancelled') {
          setState(null);
          opts.announce(jt('models.library.add.cancelled', 'Cancelled. Nothing was moved.'));
          done(null);
          return null;
        }
        setState({
          phase: result && result.reason === 'no_space' ? 'no-space' : 'failed',
          plan: current.plan, filePath: current.filePath, pickedDir: current.pickedDir,
          message: failureMessage(result || {}, current.plan),
        });
        return null;
      }, function () {
        stopPolling();
        setState({
          phase: 'failed', plan: current.plan, filePath: current.filePath, pickedDir: current.pickedDir,
          message: failureMessage({}, current.plan),
        });
        return null;
      });
    }

    function chooseAnotherFolder() {
      var server = llamaServer();
      if (!server || typeof server.chooseLibraryFolder !== 'function') return Promise.resolve(null);
      return Promise.resolve(server.chooseLibraryFolder()).then(function (result) {
        if (disposed || !state || state.phase === 'moving') return null;
        if (result && result.ok !== false && result.path) return move(result.path);
        if (result && result.ok === false && result.reason === 'network_path') {
          opts.announce(jt('models.library.networkPath', 'Jenny can\'t use network locations here. Map the share to a drive letter, then choose it from that drive.'));
        }
        return null;
      }, function () {
        opts.announce(jt('models.library.folders.pickerFailed', 'Could not open the folder picker.'));
        return null;
      });
    }

    function openTune() {
      var tag = String(state && state.tag || '').toLowerCase();
      setState(null);
      var buttons = documentRef ? documentRef.querySelectorAll('[data-model-card-action="tune"]') : [];
      for (var i = 0; i < buttons.length; i += 1) {
        var cardTag = String(buttons[i].getAttribute('data-model-tag') || '').replace(/:latest$/i, '').toLowerCase();
        if (cardTag === tag) {
          buttons[i].click();
          return;
        }
      }
      opts.announce(jt('models.library.add.tuneFromCard', 'Open Tune from the model\'s card.'));
    }

    // Starts the flow for a picked file. Resolves once the model is added (or
    // not); a file main can't plan for is added where it is, as before.
    function begin(filePath, pickedDir) {
      var server = llamaServer();
      if (!server || typeof server.planGgufImport !== 'function' || typeof server.importGguf !== 'function') {
        return Promise.resolve(opts.writeModel(filePath, pickedDir));
      }
      var refusal = '';
      // A file that can't be added (a clashing name, a projector) is refused
      // before anything moves.
      return Promise.resolve(opts.addRefusal(filePath)).then(function (reason) {
        refusal = reason;
        return refusal ? null : server.planGgufImport({ path: filePath });
      }).catch(function () {
        return null;
      }).then(function (plan) {
        if (disposed) return null;
        if (refusal) {
          opts.announce(refusal);
          return null;
        }
        if (!plan || plan.ok !== true || plan.inside || !plan.destDir) {
          return Promise.resolve(opts.writeModel(filePath, pickedDir)).then(function (outcome) {
            return afterAdd(outcome, plan && plan.ok ? plan : null, filePath);
          }, function () {
            return afterAdd(null, null, filePath);
          });
        }
        return new Promise(function (resolve) {
          finish = resolve;
          // The last add's outcome would read as this question's.
          opts.announce('');
          setState({ phase: 'confirm', plan: plan, filePath: filePath, pickedDir: pickedDir });
        });
      });
    }

    function handleClick(target) {
      var control = target && typeof target.closest === 'function' ? target.closest('[data-model-library-add-action]') : null;
      if (!control || !state) return false;
      var action = control.getAttribute('data-model-library-add-action');
      var server = llamaServer();
      if (action === 'move' && state.phase === 'confirm') void move('');
      else if (action === 'in-place' && state.phase !== 'moving') void addInPlace();
      else if (action === 'another' && state.phase !== 'moving') void chooseAnotherFolder();
      else if (action === 'cancel' && state.phase === 'moving') {
        if (server && typeof server.cancelGgufImport === 'function') void Promise.resolve(server.cancelGgufImport()).catch(function () {});
      } else if (action === 'cancel') {
        setState(null);
        done(null);
      } else if (action === 'open-tune') openTune();
      else if (action === 'dismiss') setState(null);
      return true;
    }

    // Closing Settings mid-move cancels it: nothing would add the moved file.
    function dispose() {
      if (state && state.phase === 'moving') {
        var server = llamaServer();
        if (server && typeof server.cancelGgufImport === 'function') void Promise.resolve(server.cancelGgufImport()).catch(function () {});
      }
      disposed = true;
      stopPolling();
      done(null);
    }

    return {
      begin: begin,
      html: html,
      handleClick: handleClick,
      isBusy: function () { return Boolean(state && state.phase !== 'newer-build'); },
      dispose: dispose,
    };
  }

  return { createModelLibraryAddMove: createModelLibraryAddMove };
});
