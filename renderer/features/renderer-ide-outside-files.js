/* renderer/features/renderer-ide-outside-files.js - files opened in the IDE
 * from outside the Workspace (row 137: "Open with Jenny", "File: Open File...").
 *
 * Main holds each file behind an opaque grant id (outsideFiles.* bridge); the
 * IDE keys the document and tab as `outside://<id>/<name>`. The name keeps the
 * real file name and extension, so tab labels, language detection and preview
 * routing work unchanged; the `scheme://` form can never collide with a
 * Workspace-relative key (normalizeIdeRelativePath collapses '//').
 *
 * Two parts:
 *  - A window-level registry (this file's module scope): isOutsideKey, keyFor,
 *    describe, and the action entry points. IDE feature modules reach it as
 *    `globalThis.rendererIdeOutsideFiles` (or require() in tests) to gate
 *    themselves for outside documents, without new constructor deps.
 *  - createIdeOutsideFiles(deps): the controller-owned instance that reads,
 *    saves, reconciles and reports the open set. It binds itself as the
 *    registry's active instance.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeOutsideFiles = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OUTSIDE_PREFIX = 'outside://';
  const OUTSIDE_KEY_RE = /^outside:\/\/(o[0-9a-f]{24})\/([^/\\]+)$/;

  // key -> { id, name, dirLabel, fullPath, encoding, readOnly }
  const metaByKey = new Map();
  let activeInstance = null;

  function isOutsideKey(key) {
    return typeof key === 'string' && OUTSIDE_KEY_RE.test(key);
  }

  function keyFor(item) {
    const id = String(item?.id || '');
    const name = String(item?.name || '');
    const key = `${OUTSIDE_PREFIX}${id}/${name}`;
    return isOutsideKey(key) ? key : '';
  }

  function joinDisplayPath(dirLabel, name) {
    const dir = String(dirLabel || '');
    if (!dir) return String(name || '');
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
  }

  // Registers (or refreshes) what the IDE knows about an outside document.
  function registerMeta(key, meta) {
    if (!isOutsideKey(key)) return null;
    const match = OUTSIDE_KEY_RE.exec(key);
    const previous = metaByKey.get(key) || {};
    const next = {
      id: match[1],
      name: match[2],
      dirLabel: String(meta?.dirLabel ?? previous.dirLabel ?? ''),
      encoding: String(meta?.encoding ?? previous.encoding ?? ''),
      readOnly: meta?.readOnly === undefined ? previous.readOnly === true : meta.readOnly === true,
    };
    next.fullPath = joinDisplayPath(next.dirLabel, next.name);
    metaByKey.set(key, next);
    return next;
  }

  function forgetMeta(key) {
    metaByKey.delete(key);
  }

  function clearMeta() {
    metaByKey.clear();
  }

  // { id, name, dirLabel, fullPath, encoding, readOnly } for a registered
  // outside key; null for anything else (including Workspace keys).
  function describe(key) {
    if (!isOutsideKey(key)) return null;
    const meta = metaByKey.get(key);
    return meta ? { ...meta } : null;
  }

  // The display path for anything that shows or copies "the path" of a
  // document: the real path for an outside key, the key itself otherwise.
  function displayPathFor(key) {
    const meta = describe(key);
    return meta ? meta.fullPath : String(key || '');
  }

  function unavailable() {
    return Promise.resolve({ ok: false, code: 'outside_files_unavailable' });
  }

  function callActive(method, args) {
    const fn = activeInstance && typeof activeInstance[method] === 'function' ? activeInstance[method] : null;
    return fn ? fn(...args) : unavailable();
  }

  function bindActiveInstance(instance) {
    activeInstance = instance || null;
  }

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noop() {}

  // CMP-WORKSPACEFS codes the instance reacts to.
  const CODE_NOT_FOUND = 'CMP-WORKSPACEFS-0004';
  const CODE_ROOT_TRANSITIONING = 'CMP-WORKSPACEFS-0008';
  const CODE_UNSUPPORTED_ENCODING = 'CMP-WORKSPACEFS-0013';
  const CODE_GRANT_UNKNOWN = 'CMP-WORKSPACEFS-0017';
  const CODE_WRITE_CONFLICT = 'CMP-WORKSPACEFS-0020';
  const GONE_CODES = new Set([CODE_NOT_FOUND, CODE_ROOT_TRANSITIONING, CODE_GRANT_UNKNOWN]);
  const OPEN_SET_DEBOUNCE_MS = 100;
  const FOCUS_RECHECK_MS = 2000;

  // The controller-owned instance: reads, saves, reconciles and reports the open
  // set for outside documents. Deps are injected; only the bridge getter has a
  // global default. The editor document, tab and Monaco model all live under the
  // outside key; nothing here ever sees or sends a path (grant ids only).
  function createIdeOutsideFiles(deps = {}) {
    const {
      getBridge = () => globalThis.jennyShell?.outsideFiles || null,
      getIde = () => ({}),
      ideStateUtils = {},
      editorHost = null,
      renderTabs = noop,
      onActivated = noop,
      showToastMessage = noop,
      showShellErrorToast = noop,
      appendClientLog = noop,
      mergePreparedAttachments = null,
      windowRef = null,
      now = Date.now,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
    } = deps;

    // key -> { id, name, fileVersion, encoding, editable, generation }
    const docs = new Map();
    const pendingOpens = new Map();
    const reconciling = new Map(); // key -> rerun requested
    const saving = new Set();
    let epoch = 1;
    let generation = 0;
    let disposed = false;
    let openSetTimer = null;
    let lastFocusCheck = 0;
    let lastFailureCode = '';

    const bridge = () => {
      try { return getBridge() || null; } catch (_error) { return null; }
    };

    function codeOf(result) {
      return String(result?.code || result?.error_code || '');
    }

    function displayName(key) {
      return describe(key)?.name || docs.get(key)?.name || String(key).split('/').pop();
    }

    function markStale(key, stale = true) {
      ideStateUtils.setTabStale?.(getIde(), key, stale);
      renderTabs();
    }

    function ideHasTab(key) {
      return Boolean(ideStateUtils.getTab?.(getIde(), key));
    }

    // --- open set (main watches these files and persists them for restore) ---
    function reportOpenSet() {
      openSetTimer = null;
      const b = bridge();
      if (disposed || typeof b?.setOpenSet !== 'function') return;
      const ids = [];
      for (const tab of getIde().openTabs || []) {
        const id = describe(tab?.path)?.id;
        if (id && !ids.includes(id)) ids.push(id);
      }
      try { Promise.resolve(b.setOpenSet({ ids })).catch(noop); } catch (_error) { /* bridge gone */ }
    }

    function scheduleOpenSet() {
      if (disposed) return;
      if (openSetTimer) clearTimer(openSetTimer);
      openSetTimer = setTimer(reportOpenSet, OPEN_SET_DEBOUNCE_MS);
    }

    // --- loading text into the editor host ---
    function loadPayload(key, read) {
      return {
        path: key,
        content: read.content,
        mtimeMs: read.mtimeMs,
        eol: read.eol,
        encoding: read.encoding,
        readOnly: read.editable !== true,
      };
    }

    function readOnlyNotice(key, encoding) {
      showToastMessage(
        jt('ide.outside.readOnlyNotice', 'Read-only: {name} uses {encoding}. Jenny edits UTF-8 and UTF-16 files.', { name: displayName(key), encoding }),
        { tone: 'info', dedupeKey: `ide:outside:readonly:${key}` },
      );
    }

    function failOpen(key, result) {
      lastFailureCode = codeOf(result) || 'unknown';
      const name = displayName(key);
      const message = lastFailureCode === CODE_GRANT_UNKNOWN
        ? jt('ide.outside.grantGone', '{name} is no longer open in Jenny. Open it again.', { name })
        : jt('ide.outside.openFailed', 'Couldn’t open {name}.', { name });
      showShellErrorToast(message, {
        title: jt('ide.fileLifecycle.couldNotOpen', 'Could Not Open'),
        dedupeKey: `ide:outside:open:${key}`,
      });
      appendClientLog('WARN', 'ide.outside_open_failed', { code: lastFailureCode });
      return false;
    }

    function refuseAtTabCap(key) {
      const capacity = ideStateUtils.checkTabCapacity?.(getIde(), key);
      if (!capacity || capacity.ok !== false) return false;
      showShellErrorToast(
        jt('ide.fileLifecycle.tabLimitReached', 'Tab limit reached ({limit} tabs) — close a tab before opening {path}.', { limit: capacity.limit, path: displayName(key) }),
        { title: jt('ide.fileLifecycle.tabLimit', 'Tab Limit'), dedupeKey: 'ide:tab-cap' },
      );
      lastFailureCode = 'TAB_LIMIT';
      return true;
    }

    function activateExisting(key) {
      if (!ideHasTab(key)) return false;
      ideStateUtils.setActiveTab?.(getIde(), key);
      editorHost.activateDocument(key);
      onActivated(key);
      renderTabs();
      return true;
    }

    async function doOpen(key, item, { activate, background }) {
      const b = bridge();
      if (!b || typeof b.readText !== 'function') return failOpen(key, { code: 'outside_files_unavailable' });
      const ide = getIde();
      if (!background && refuseAtTabCap(key)) return false;
      const myEpoch = epoch;
      let read;
      try {
        read = await b.readText({ id: item.id });
      } catch (error) {
        read = { ok: false, code: String(error?.code || 'bridge_failed') };
      }
      if (myEpoch !== epoch || disposed) return false;
      if (!read || read.ok !== true || typeof read.content !== 'string') return failOpen(key, read);
      // A parallel open can fill the strip during the read; check before the document exists.
      if (!background && refuseAtTabCap(key)) return false;
      const createdDoc = !editorHost.hasDocument(key);
      const applied = await editorHost.openDocument({
        ...loadPayload(key, read),
        shouldApply: () => myEpoch === epoch && !disposed,
      });
      if (!applied) return false;
      generation += 1;
      docs.set(key, {
        id: item.id,
        name: item.name,
        fileVersion: String(read.fileVersion || ''),
        encoding: String(read.encoding || ''),
        editable: read.editable === true,
        generation,
      });
      registerMeta(key, { encoding: read.encoding, readOnly: read.editable !== true });
      if (!background) {
        const previousActive = ide.activeTabPath;
        const hadActive = Boolean(previousActive && ideHasTab(previousActive));
        ideStateUtils.openTab?.(ide, key, {});
        if (!ideHasTab(key)) {
          if (createdDoc) { editorHost.closeDocument(key); docs.delete(key); }
          return false;
        }
        if (!activate && hadActive) ide.activeTabPath = previousActive;
        else editorHost.activateDocument(key);
        if (activate || !hadActive) onActivated(key);
        renderTabs();
        scheduleOpenSet();
      }
      if (read.editable !== true) readOnlyNotice(key, read.encoding);
      return true;
    }

    async function open(item, { activate = true, background = false } = {}) {
      const key = keyFor(item);
      if (!key || !editorHost || disposed) return false;
      lastFailureCode = '';
      registerMeta(key, { dirLabel: item.dirLabel });
      if (editorHost.hasDocument(key) && (background || ideHasTab(key))) {
        if (!background && activate) activateExisting(key);
        return true;
      }
      if (pendingOpens.has(key)) {
        const ok = await pendingOpens.get(key);
        if (ok && !background && activate) activateExisting(key);
        return ok;
      }
      const run = doOpen(key, item, { activate, background }).catch((error) => {
        appendClientLog('WARN', 'ide.outside_open_threw', { message: String(error?.message || error).slice(0, 200) });
        return false;
      });
      pendingOpens.set(key, run);
      try {
        return await run;
      } finally {
        pendingOpens.delete(key);
      }
    }

    // --- save ---
    async function save(key, options = {}) {
      const state = docs.get(key);
      const b = bridge();
      if (!state || !editorHost?.hasDocument(key) || saving.has(key)) return false;
      if (!state.editable) {
        if (options.unattended !== true) readOnlyNotice(key, state.encoding);
        return false;
      }
      const content = typeof options.content === 'string' ? options.content : editorHost.getValue(key);
      const savedVersionId = options.savedVersionId !== undefined ? options.savedVersionId : editorHost.getAltVersionId?.(key);
      if (typeof content !== 'string' || typeof b?.writeText !== 'function') return false;
      const name = displayName(key);
      saving.add(key);
      try {
        let result;
        try {
          result = await b.writeText({ id: state.id, content, expectedFileVersion: state.fileVersion });
        } catch (error) {
          result = { ok: false, code: String(error?.code || 'bridge_failed'), message: String(error?.message || '') };
        }
        if (docs.get(key) !== state || !editorHost.hasDocument(key)) return false;
        if (result?.ok === true) {
          state.fileVersion = String(result.fileVersion || state.fileVersion);
          editorHost.markSaved(key, { mtimeMs: result.mtimeMs, savedVersionId, savedContent: content });
          markStale(key, false);
          appendClientLog('INFO', 'ide.outside_save_succeeded', { unattended: options.unattended === true });
          return true;
        }
        const code = codeOf(result);
        markStale(key, true);
        if (code === CODE_WRITE_CONFLICT) {
          showShellErrorToast(jt('ide.fileLifecycle.changedOnDisk', 'File changed on disk since it was loaded.'), {
            title: jt('ide.fileLifecycle.saveConflict', 'Save Conflict'), dedupeKey: `ide:save:${key}`,
          });
        } else if (code === CODE_GRANT_UNKNOWN) {
          showShellErrorToast(jt('ide.outside.grantGone', '{name} is no longer open in Jenny. Open it again.', { name }), {
            title: jt('ide.fileLifecycle.saveFailed', 'Save Failed'), dedupeKey: `ide:save:${key}`,
          });
        } else if (code === CODE_UNSUPPORTED_ENCODING && result?.details?.reason === 'read_only_encoding') {
          state.editable = false;
          registerMeta(key, { readOnly: true });
          markStale(key, false);
          readOnlyNotice(key, state.encoding);
        } else {
          showShellErrorToast(String(result?.message || '') || jt('ide.fileLifecycle.saveFileFailed', 'Could not save the file.'), {
            title: jt('ide.fileLifecycle.saveFailed', 'Save Failed'), dedupeKey: `ide:save:${key}`,
          });
        }
        appendClientLog('WARN', 'ide.outside_save_failed', { code, unattended: options.unattended === true });
        return false;
      } finally {
        saving.delete(key);
      }
    }

    // --- reload from disk (Revert, and the clean branch of reconcile) ---
    async function reloadInto(key, read, { onlyIfClean }) {
      const state = docs.get(key);
      if (!state || !editorHost.hasDocument(key)) return false;
      const priorVersion = state.fileVersion;
      const applied = await editorHost.openDocument({
        ...loadPayload(key, read),
        shouldApply: () => docs.get(key) === state && state.fileVersion === priorVersion
          && editorHost.hasDocument(key) && (!onlyIfClean || editorHost.isDirty?.(key) !== true),
        onApplied: () => {
          state.fileVersion = String(read.fileVersion || '');
          state.encoding = String(read.encoding || state.encoding);
          state.editable = read.editable === true;
          registerMeta(key, { encoding: state.encoding, readOnly: !state.editable });
        },
      });
      if (!applied) return false;
      if (getIde().activeTabPath === key) editorHost.activateDocument(key);
      markStale(key, false);
      return true;
    }

    // ifVersion (a re-check): main answers { unchanged: true } from one stat when the file is as last seen.
    async function readDisk(key, ifVersion = '') {
      const state = docs.get(key) || describe(key);
      const b = bridge();
      if (!state || typeof b?.readText !== 'function') return { ok: false, code: 'outside_files_unavailable' };
      try {
        const read = await b.readText(ifVersion ? { id: state.id, ifVersion } : { id: state.id });
        return read?.ok === true ? read : { ok: false, code: codeOf(read) };
      } catch (error) {
        return { ok: false, code: String(error?.code || 'bridge_failed') };
      }
    }

    async function revert(key) {
      const read = await readDisk(key);
      if (read.ok !== true) return { ok: false, code: read.code };
      return await reloadInto(key, read, { onlyIfClean: false }) ? { ok: true } : { ok: false, code: 'reload_refused' };
    }

    // --- external changes ---
    function staleBecauseGone(key) {
      if (editorHost.isDirty?.(key) === true) {
        showToastMessage(
          jt('ide.watch.deletedWithUnsavedEdits', '{path} was deleted on disk. Its unsaved editor remains open so you can copy the changes.', { path: describe(key)?.fullPath || key }),
          { dedupeKey: `ide:stale:${key}` },
        );
      }
      markStale(key, true);
    }

    async function reconcileKey(key) {
      const state = docs.get(key);
      if (!state || !editorHost.hasDocument(key) || saving.has(key)) return;
      const heldVersion = state.fileVersion;
      const read = await readDisk(key, heldVersion);
      if (docs.get(key) !== state || saving.has(key) || state.fileVersion !== heldVersion) return; // a save landed meanwhile
      if (read.ok !== true) {
        if (GONE_CODES.has(read.code)) staleBecauseGone(key);
        return;
      }
      if (read.unchanged === true || String(read.fileVersion || '') === state.fileVersion) return; // our own save's echo
      if (editorHost.isDirty?.(key) === true) {
        showToastMessage(
          jt('ide.watch.changedWithUnsavedEdits', '{path} changed on disk. Your unsaved edits now differ from the file.', { path: describe(key)?.fullPath || key }),
          { dedupeKey: `ide:stale:${key}` },
        );
        markStale(key, true);
        return;
      }
      if (!await reloadInto(key, read, { onlyIfClean: true }) && editorHost.isDirty?.(key) === true) markStale(key, true);
    }

    function keyForId(id) {
      for (const [key, state] of docs) if (state.id === id) return key;
      return '';
    }

    async function reconcile(change = {}) {
      const key = keyForId(String(change.id || ''));
      if (!key || disposed) return;
      if (reconciling.has(key)) { reconciling.set(key, true); return; }
      reconciling.set(key, false);
      try {
        do {
          reconciling.set(key, false);
          if (change.kind === 'deleted') staleBecauseGone(key);
          else await reconcileKey(key);
        } while (reconciling.get(key) === true && docs.has(key));
      } catch (error) {
        appendClientLog('WARN', 'ide.outside_reconcile_failed', { message: String(error?.message || error).slice(0, 200) });
      } finally {
        reconciling.delete(key);
      }
    }

    function onWindowFocus() {
      const t = now();
      if (t - lastFocusCheck < FOCUS_RECHECK_MS) return;
      lastFocusCheck = t;
      for (const state of [...docs.values()]) void reconcile({ id: state.id, kind: 'changed' });
    }

    // --- other bridge actions ---
    async function simple(method, key, extra = {}) {
      const state = docs.get(key) || describe(key);
      const b = bridge();
      if (!state || typeof b?.[method] !== 'function') return { ok: false, code: 'outside_files_unavailable' };
      try {
        return await b[method]({ id: state.id, ...extra });
      } catch (error) {
        return { ok: false, code: String(error?.code || 'bridge_failed') };
      }
    }

    async function attachToChat(key, sessionId) {
      const result = await simple('attach', key, { session_id: String(sessionId || '') });
      if (result?.ok === true && typeof mergePreparedAttachments === 'function') {
        mergePreparedAttachments({ accepted: result.accepted || [], rejected: result.rejected || [] }, sessionId);
      }
      return result;
    }

    const unsubscribe = (() => {
      const b = bridge();
      if (typeof b?.onChange !== 'function') return null;
      try { return b.onChange((change) => { void reconcile(change); }); } catch (_error) { return null; }
    })();
    windowRef?.addEventListener?.('focus', onWindowFocus);

    const instance = {
      open,
      save,
      revert,
      readDisk,
      reconcile,
      reveal: (key) => simple('reveal', key),
      attachToChat,
      readImage: (key, relPath) => simple('readImage', key, { relPath: String(relPath || '') }),
      isReadOnly: (key) => (docs.has(key) ? !docs.get(key).editable : describe(key)?.readOnly === true),
      // The open item for a registered key (a closed-tab reopen); null when unknown.
      itemFor: (key) => {
        const meta = describe(key);
        return meta ? { kind: 'outside', id: meta.id, name: meta.name, dirLabel: meta.dirLabel } : null;
      },
      // The failure code of the last open() that returned false ('' after a success).
      getLastFailureCode: () => lastFailureCode,
      forget: (key) => { docs.delete(key); forgetMeta(key); },
      // Mirrors captureReload's revision for Workspace documents: changes with every edit.
      getRevision: (key) => {
        const state = docs.get(key);
        if (!state || !editorHost?.hasDocument(key)) return null;
        return `${state.generation}:${editorHost.getAltVersionId?.(key) ?? ''}`;
      },
      // The lifecycle disposed this key's document (tab closed). Meta stays for a reopen.
      closed: (key) => {
        if (docs.delete(key)) scheduleOpenSet();
      },
      reset: () => {
        epoch += 1;
        docs.clear();
        pendingOpens.clear();
        reconciling.clear();
        saving.clear();
        clearMeta();
        scheduleOpenSet();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        epoch += 1;
        if (openSetTimer) clearTimer(openSetTimer);
        openSetTimer = null;
        try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (_error) { /* best effort */ }
        windowRef?.removeEventListener?.('focus', onWindowFocus);
        docs.clear();
        if (activeInstance === instance) bindActiveInstance(null);
      },
    };
    bindActiveInstance(instance);
    return instance;
  }

  return {
    OUTSIDE_PREFIX,
    isOutsideKey,
    keyFor,
    registerMeta,
    forgetMeta,
    clearMeta,
    describe,
    displayPathFor,
    bindActiveInstance,
    createIdeOutsideFiles,
    // Action entry points for gate modules; each resolves { ok:false } when no
    // IDE instance is bound.
    revert: (key) => callActive('revert', [key]),
    readDisk: (key) => callActive('readDisk', [key]),
    reveal: (key) => callActive('reveal', [key]),
    attachToChat: (key, sessionId) => callActive('attachToChat', [key, sessionId]),
    readImage: (key, relPath) => callActive('readImage', [key, relPath]),
  };
});
