/* GGUF folders ▸ "Add GGUF model…" ▸ Move and add (row 107): the note under the
   folder list that offers to move a picked file out of Downloads into its own
   folder, the move's progress, and what runs the model after an add: the build
   Jenny picked on its own (row 142), or the warning that none can read it. */
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

  // The row-142 pieces (Get build, Add runtime folder…) load with the Settings scripts;
  // until they do the warning below shows as it always has.
  function resolveBuilds() {
    return (root && root.modelLibraryRuntimeBuilds)
      || (typeof require === 'function' ? require('./model-library-runtime-builds') : null);
  }

  function resolveFit() {
    return (root && root.modelLibraryFit)
      || (typeof require === 'function' ? require('./model-library-fit') : null);
  }

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
  // fitFor(filePath, plan) -> {needMb, cardMb, ctx, smallNeedMb} or null (optional: no estimate, no warning),
  // showFits() closes the drawer and filters the Library to models that fit (optional),
  // announce(message), writeModel(filePath, pickedDir) -> Promise<'added'|null>,
  // addRefusal(filePath) -> Promise<why it can't be added, or ''>,
  // tagFor(filePath) -> the library tag the file will be added as,
  // addRuntimeFolder() -> Promise<outcome> (the runtime folders list's own add), optional.
  function createModelLibraryAddMove(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || root;
    var documentRef = opts.documentRef || windowRef.document || null;
    var escapeHtml = opts.escapeHtml;
    var actionButton = opts.actionButton;
    var formatUtils = resolveFormatUtils();
    var size = function (bytes) { return (formatUtils && formatUtils.formatHumanSize(bytes)) || ''; };
    // { phase: 'confirm'|'moving'|'no-space'|'failed'|'newer-build'|'auto-build'|'no-reader'|'build-ready', ... } or null.
    var state = null;
    var download = null;
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

    function fitHtml(fit, plan, filePath) {
      var gb = resolveFit().gbLabel;
      var pct = Math.min(100, Math.round((fit.needMb / fit.cardMb) * 1000) / 10);
      var ticks = [8, 16, 24].filter(function (t) { return t * 1024 < fit.cardMb; }).map(function (t) {
        return '<i class="mm-tick" style="inset-inline-start:' + Math.round((t * 1024 / fit.cardMb) * 1000) / 10 + '%"><span>' + t + '</span></i>';
      }).join('');
      var small = fit.smallNeedMb > 0 ? (fit.smallNeedMb > fit.cardMb
        ? jt('models.library.add.fitSmallerNo', 'A smaller context does not fix it: at 8K it still needs about {n}.', { n: gb(fit.smallNeedMb) })
        : jt('models.library.add.fitSmallerYes', 'At an 8K context it needs about {n} and fits.', { n: gb(fit.smallNeedMb) })) : '';
      return line(jt('models.library.add.fitLine', '{file} ({size}) is too large for your graphics card.', {
        file: code(plan.file || lastSegment(filePath)), size: escapeHtml(size(fit.sizeBytes || plan.sizeBytes)),
      }))
        + '<div class="mm-bar" role="img" aria-label="' + escapeHtml(jt('models.library.add.fitAria', 'Graphics memory: this model needs about {n} of {total}', { n: gb(fit.needMb), total: gb(fit.cardMb) })) + '">'
        + '<i class="mm-fill" style="width:0%"></i><i class="mm-ghost mm-ghost--over" style="width:' + pct + '%"></i>' + ticks + '</div>'
        + '<div class="mm-legend"><span class="mm-preview mm-preview--over"><b>' + escapeHtml(jt('models.library.add.fitNeeds', 'Needs about {n}', { n: gb(fit.needMb) })) + '</b> '
        + escapeHtml(jt('models.library.add.fitNeedsRest', 'at a {ctx} context · {m} more than this card has', { ctx: Math.round(fit.ctx / 1024) + 'K', m: gb(fit.needMb - fit.cardMb) }))
        + '</span><span class="mm-free">' + escapeHtml(jt('models.library.add.fitCard', '{n} card', { n: gb(fit.cardMb) })) + '</span></div>'
        + line(escapeHtml(jt('models.library.add.fitSlow', 'It will still run, but part of it sits in ordinary memory, so replies will be slow.') + (small ? ' ' + small : '')), 'model-library-add-sub')
        + '<div class="model-library-add-actions">'
        + button(jt('models.library.add.fitAnother', 'Choose another file'), 'another-file', 'primary')
        + button(jt('models.library.add.fitAnyway', 'Add anyway'), 'add-anyway')
        + button(jt('common.cancel', 'Cancel'), 'cancel', 'ghost')
        + (typeof opts.showFits === 'function' ? link(jt('models.library.add.fitShow', 'Show models that fit'), 'show-fits') : '')
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
      if (state.phase === 'confirm') {
        body = (state.kept ? line(escapeHtml(jt('models.library.add.fitKept', 'Too large for this card: it will run slowly. You chose to add it anyway.')), 'model-library-add-sub') : '') + confirmHtml(state.plan);
      } else if (state.phase === 'fit') body = fitHtml(state.fit, state.plan, state.filePath);
      else if (state.phase === 'moving') body = movingHtml();
      else if (state.phase === 'no-space' || state.phase === 'failed') {
        body = line(escapeHtml(state.message))
          + '<div class="model-library-add-actions">'
          + button(jt('models.library.add.inPlace', 'Add where it is'), 'in-place')
          + button(jt('common.cancel', 'Cancel'), 'cancel', 'ghost')
          + link(jt('models.library.add.another', 'Another folder…'), 'another')
          + '</div>';
      } else if (state.phase === 'auto-build') {
        body = line(escapeHtml(jt('models.library.runtime.autoBuildLine', 'Added. It runs on llama.cpp build {build}.', { build: state.build })))
          + line(escapeHtml(jt('models.library.runtime.autoBuildSub', 'The bundled build can\'t read {architecture} models, so Jenny picks build {build} each time it starts this model.', { architecture: state.architecture, build: state.build })), 'model-library-add-sub')
          + '<div class="model-library-add-actions">'
          + link(jt('models.library.runtime.changeInTune', 'Change in Tune'), 'open-tune')
          + button(jt('models.library.add.dismiss', 'Dismiss'), 'dismiss', 'ghost')
          + '</div>';
      } else if (state.phase === 'build-ready') {
        body = line(escapeHtml(jt('models.library.runtime.buildReady', 'Build {build} is ready.', { build: state.build })))
          + '<div class="model-library-add-actions">' + button(jt('models.library.add.dismiss', 'Dismiss'), 'dismiss', 'ghost') + '</div>';
      } else if (state.phase === 'no-reader') {
        body = noReaderHtml();
      } else if (state.phase === 'newer-build') {
        body = line(escapeHtml(jt('models.library.add.newerBuild', 'The bundled llama-server can\'t run {architecture} models.', { architecture: state.architecture })))
          + line(escapeHtml(jt('models.library.add.newerBuildHint', 'Choose a newer llama-server build for {model} in Tune, or update Jenny when a newer bundled build ships.', { model: state.tag })), 'model-library-add-sub')
          + '<div class="model-library-add-actions">'
          + button(jt('models.library.add.openTune', 'Open Tune'), 'open-tune')
          + button(jt('models.library.add.dismiss', 'Dismiss'), 'dismiss', 'ghost')
          + '</div>';
      }
      var statusRole = state.phase === 'moving' || state.phase === 'auto-build' || state.phase === 'no-reader' || state.phase === 'build-ready';
      var role = statusRole ? ' role="status"' : (state.phase === 'confirm' || state.phase === 'fit' ? ' role="group"' : '');
      return '<div class="model-library-add' + (state.phase === 'fit' ? ' model-library-add-fit' : '') + '"' + role + '>' + body + '</div>';
    }

    function noReaderHtml() {
      var builds = resolveBuilds();
      var dl = download && download.state();
      var dismiss = button(jt('models.library.add.dismiss', 'Dismiss'), 'dismiss', 'ghost');
      if (dl && (dl.phase === 'starting' || dl.phase === 'running')) {
        var parts = builds.downloadParts(dl);
        return line(escapeHtml(parts.line))
          + '<div class="model-library-add-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + parts.percent + '">'
          + '<i data-model-library-add-bar style="width:' + parts.percent + '%"></i></div>'
          + '<p class="model-library-add-sub model-library-add-num" data-model-library-add-progress-text>' + escapeHtml(parts.sub) + '</p>'
          + '<div class="model-library-add-actions">' + button(jt('common.cancel', 'Cancel'), 'download-cancel', 'ghost') + '</div>';
      }
      if (dl && dl.phase === 'failed') {
        var failed = builds.downloadParts(dl);
        return line(escapeHtml(failed.line)) + line(escapeHtml(failed.sub), 'model-library-add-sub')
          + '<div class="model-library-add-actions">' + button(jt('models.library.tuning.companion.retry', 'Try again'), 'get-build') + dismiss + '</div>';
      }
      var offer = state.offer;
      var sub = dl && dl.phase === 'refused' ? dl.message
        : offer ? jt('models.library.runtime.noReaderSubGet', 'Add a folder of newer llama.cpp builds, or get build {build}.', { build: offer.build })
          : jt('models.library.runtime.noReaderSub', 'Add a folder of newer llama.cpp builds, or choose a build in Tune.');
      return line(escapeHtml(jt('models.library.runtime.noReaderLine', 'Added, but no llama-server build Jenny knows can read {architecture} models.', { architecture: state.architecture })))
        + line(escapeHtml(sub), 'model-library-add-sub')
        + '<div class="model-library-add-actions">'
        + button(builds.addFolderText(), 'add-runtime-folder')
        + (offer ? button(builds.getBuildText(offer.build), 'get-build') : '')
        + dismiss + '</div>';
    }

    function paintDownload(dl) {
      if (!documentRef || !state || state.phase !== 'no-reader') return;
      var parts = resolveBuilds().downloadParts(dl);
      var bar = documentRef.querySelector('[data-model-library-add-bar]');
      if (bar) {
        bar.style.width = parts.percent + '%';
        bar.parentNode.setAttribute('aria-valuenow', String(parts.percent));
      }
      var text = documentRef.querySelector('[data-model-library-add-progress-text]');
      if (text) text.textContent = parts.sub;
    }

    // Asks main again what runs the model: the build Jenny now picks on its own, or no change.
    function askAgain() {
      var server = llamaServer();
      var builds = resolveBuilds();
      var current = state;
      if (!builds || !server || typeof server.runtimeOptions !== 'function') return Promise.resolve(null);
      return Promise.resolve().then(function () { return server.runtimeOptions({ modelTag: current.tag }); }).then(function (answer) {
        var read = builds.readOptions(answer);
        if (disposed || state !== current || !read) return null;
        if (read.current.source === 'auto') {
          setState({ phase: 'auto-build', architecture: current.architecture, tag: current.tag, build: read.current.build });
        } else if (current.readyBuild) {
          setState({ phase: 'build-ready', build: current.readyBuild });
        } else {
          current.offer = read.download || current.offer;
          opts.rerender();
        }
        return read;
      }, function () { return null; });
    }

    function downloadChanged(dl) {
      if (disposed || !state || state.phase !== 'no-reader') return;
      if (dl && dl.phase === 'ready') {
        state.readyBuild = dl.build;
        download.reset();
        void askAgain();
        return;
      }
      opts.rerender();
    }

    function getBuild() {
      var builds = resolveBuilds();
      if (!builds || !state || state.phase !== 'no-reader' || !state.offer) return;
      if (!download) download = builds.createBuildDownload({ windowRef: windowRef, onChange: downloadChanged, onProgress: paintDownload });
      void download.start(state.architecture, state.offer.build);
    }

    function addRuntimeFolder() {
      var builds = resolveBuilds();
      var current = state;
      if (!builds || !current || current.phase !== 'no-reader') return;
      var run = typeof opts.addRuntimeFolder === 'function' ? opts.addRuntimeFolder()
        : builds.addRuntimeFolder(windowRef, builds.settingsWriter(windowRef));
      void Promise.resolve(run).then(function (outcome) {
        if (disposed || state !== current || !outcome) return null;
        if (outcome.state === 'added') return askAgain();
        if (outcome.state === 'refused' || outcome.state === 'failed') opts.announce(builds.folderRefusalText(outcome.reason));
        return null;
      });
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

    // The bundled build can't read the file and no build Jenny picks on its own can either: ask main
    // what is left to offer. Without an answer the warning below shows as it always has.
    function settleNoReader(plan, tag) {
      var server = llamaServer();
      var builds = resolveBuilds();
      var warning = function () {
        if (!disposed && !state) setState({ phase: 'newer-build', architecture: plan.architecture, tag: tag });
      };
      if (!builds || !server || typeof server.runtimeOptions !== 'function') {
        warning();
        return;
      }
      Promise.resolve().then(function () { return server.runtimeOptions({ modelTag: tag }); }).then(function (answer) {
        var read = builds.readOptions(answer);
        if (disposed || state) return;
        if (!read) {
          warning();
          return;
        }
        var offer = read.download || (plan.downloadBuild && Number(plan.downloadBuild.build) > 0 ? { build: Number(plan.downloadBuild.build) } : null);
        if (read.current.source === 'auto') setState({ phase: 'auto-build', architecture: plan.architecture, tag: tag, build: read.current.build });
        else setState({ phase: 'no-reader', architecture: plan.architecture, tag: tag, offer: offer });
      }, warning);
    }

    // After any add: what runs the model when main is sure the bundled build
    // can't read the file's architecture, else the flow is over.
    function afterAdd(outcome, plan, filePath) {
      if (outcome === 'added' && plan && plan.archSupport === 'no' && plan.architecture) {
        var tag = opts.tagFor(filePath);
        if (plan.autoBuild && Number(plan.autoBuild.build) > 0) {
          setState({ phase: 'auto-build', architecture: plan.architecture, tag: tag, build: Number(plan.autoBuild.build) });
        } else {
          settleNoReader(plan, tag);
        }
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
        return Promise.resolve().then(function () {
          return plan && plan.ok === true && typeof opts.fitFor === 'function' ? opts.fitFor(filePath, plan) : null;
        }).catch(function () { return null; }).then(function (fit) {
          if (disposed) return null;
          return new Promise(function (resolve) {
            finish = resolve;
            if (fit && fit.cardMb > 0 && fit.needMb > fit.cardMb) {
              opts.announce('');
              setState({ phase: 'fit', fit: fit, plan: plan, filePath: filePath, pickedDir: pickedDir });
            } else {
              void proceed(plan, filePath, pickedDir, false);
            }
          });
        });
      });
    }

    // Past the fit step: add where it is, or ask where the file should live.
    function proceed(plan, filePath, pickedDir, kept) {
      if (!plan || plan.ok !== true || plan.inside || !plan.destDir) {
        if (state && state.phase === 'fit') setState(null); // a second click on Add anyway finds no strip
        return Promise.resolve(opts.writeModel(filePath, pickedDir)).then(function (outcome) {
          return afterAdd(outcome, plan && plan.ok ? plan : null, filePath);
        }, function () {
          return afterAdd(null, null, filePath);
        });
      }
      // The last add's outcome would read as this question's.
      opts.announce('');
      setState({ phase: 'confirm', plan: plan, filePath: filePath, pickedDir: pickedDir, kept: kept });
      return null;
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
      } else if (action === 'add-anyway' && state.phase === 'fit') void proceed(state.plan, state.filePath, state.pickedDir, true);
      else if ((action === 'another-file' || action === 'show-fits') && state.phase === 'fit') {
        setState(null);
        done(null);
        if (action === 'show-fits') opts.showFits();
        else windowRef.setTimeout(function () { var add = documentRef && documentRef.querySelector('[data-model-library-folder-action="add-model"]'); if (add) add.click(); }, 0);
      } else if (action === 'open-tune') openTune();
      else if (action === 'add-runtime-folder') addRuntimeFolder();
      else if (action === 'get-build') getBuild();
      else if (action === 'download-cancel') {
        if (download) void download.cancel();
      } else if (action === 'dismiss') {
        if (download) download.reset();
        setState(null);
      }
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
      if (download) download.dispose();
      done(null);
    }

    return {
      begin: begin,
      html: html,
      handleClick: handleClick,
      isBusy: function () { return Boolean(state && ['newer-build', 'auto-build', 'no-reader', 'build-ready'].indexOf(state.phase) < 0); },
      dispose: dispose,
    };
  }

  return { createModelLibraryAddMove: createModelLibraryAddMove };
});
