/* renderer/features/renderer-change-pictures-model.js
 * No DOM. Two things for the before-and-after pictures of a web page:
 *  - which files of one turn matter (turnFiles, from the change ledger), and
 *  - a small per-session cache in front of window.jennyShell.changePictures, so
 *    the Changes panel and the chat share one answer, one in-flight request and
 *    one idea of "already asked".
 * Everything the bridge answers is untrusted: records are only checked for shape
 * here, and the renderer escapes and filters URLs when it draws them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChangePicturesModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WEB_EXTENSIONS = new Set([
    '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg',
    '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  ]);
  const PAGE_EXTENSIONS = new Set(['.html', '.htm']);
  const WORKING_TREE_TURN_ID = '@working-tree';

  const idOf = (value) => (value == null ? '' : String(value).trim());
  const hashOf = (value) => (typeof value === 'string' && value ? value : null);
  const viewportOf = (value) => (value === 'phone' ? 'phone' : 'desktop');
  // When a record was taken, as a number: the store writes an ISO date.
  const takenAt = (record) => {
    const at = typeof record.capturedAt === 'number' ? record.capturedAt : Date.parse(record.capturedAt);
    return Number.isFinite(at) ? at : 0;
  };

  function extensionOf(path) {
    const match = /\.[^./\\]+$/.exec(String(path || '').toLowerCase());
    return match ? match[0] : '';
  }

  function splitPath(path) {
    const text = String(path || '').replace(/\\/g, '/');
    const cut = text.lastIndexOf('/');
    return cut < 0 ? { name: text, folder: '' } : { name: text.slice(cut + 1), folder: text.slice(0, cut) };
  }

  // Pictures are files in the app's own data folder, so only a file: URL is ever drawn.
  function isFileUrl(value) {
    return typeof value === 'string' && /^file:/i.test(value);
  }

  function positiveInt(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /* ── turnFiles ── */

  function normalizedStatus(value) {
    const status = String(value || '').toLowerCase();
    return status === 'created' || status === 'deleted' ? status : 'modified';
  }

  // A rename is "the new path appeared, the old path went away".
  function expandChange(change) {
    const status = normalizedStatus(change.status);
    const sensitive = change.sensitive === true;
    const oldPath = typeof change.oldPath === 'string' ? change.oldPath : '';
    if (oldPath && oldPath !== change.path) {
      const out = [{ path: change.path, status: 'created', beforeHash: null, afterHash: hashOf(change.afterHash), sensitive }];
      if (WEB_EXTENSIONS.has(extensionOf(oldPath))) {
        out.push({ path: oldPath, status: 'deleted', beforeHash: hashOf(change.beforeHash), afterHash: null, sensitive });
      }
      return out;
    }
    return [{ path: change.path, status, beforeHash: hashOf(change.beforeHash), afterHash: hashOf(change.afterHash), sensitive }];
  }

  function turnFiles(changes, turnId) {
    const wanted = idOf(turnId);
    const groups = new Map();
    for (const change of Array.isArray(changes) ? changes : []) {
      if (!change || typeof change.path !== 'string' || idOf(change.turnId) !== wanted) continue;
      if (!WEB_EXTENSIONS.has(extensionOf(change.path))) continue;
      for (const step of expandChange(change)) {
        if (!groups.has(step.path)) groups.set(step.path, []);
        groups.get(step.path).push(step);
      }
    }
    const files = [];
    for (const [path, steps] of groups) {
      const first = steps[0];
      const last = steps[steps.length - 1];
      if (first.status === 'created' && last.status === 'deleted') continue;
      const status = first.status === 'created' ? 'created' : last.status === 'deleted' ? 'deleted' : 'modified';
      const sensitive = steps.some((step) => step.sensitive);
      files.push({
        path,
        status,
        beforeHash: status === 'created' || sensitive ? null : first.beforeHash,
        afterHash: status === 'deleted' ? null : last.afterHash,
      });
    }
    return files;
  }

  function firstPagePath(files) {
    for (const file of Array.isArray(files) ? files : []) {
      if (file && PAGE_EXTENSIONS.has(extensionOf(file.path))) return String(file.path);
    }
    return '';
  }

  function filesSignature(files) {
    return (Array.isArray(files) ? files : [])
      .map((file) => [file && file.path, file && file.status, (file && file.afterHash) || ''].join('|'))
      .sort()
      .join('\n');
  }

  /* ── picture cache ── */

  function validRecord(value) {
    return value && typeof value === 'object' && Array.isArray(value.pages) ? value : null;
  }

  function normalizeFiles(files) {
    const out = [];
    for (const file of Array.isArray(files) ? files : []) {
      if (!file || typeof file.path !== 'string' || !file.path) continue;
      out.push({ path: file.path, status: file.status, beforeHash: file.beforeHash == null ? null : file.beforeHash, afterHash: file.afterHash == null ? null : file.afterHash });
    }
    return out;
  }

  function createPictureCache(options) {
    const opts = options || {};
    const getBridge = typeof opts.getBridge === 'function' ? opts.getBridge : function () { return null; };
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const maxSessions = Math.max(1, positiveInt(opts.maxSessions) || 6);
    const disabledRetryMs = opts.disabledRetryMs == null ? 30000 : opts.disabledRetryMs;
    const workingTreeMinIntervalMs = opts.workingTreeMinIntervalMs == null ? 3000 : opts.workingTreeMinIntervalMs;
    const busyRetryMs = opts.busyRetryMs == null ? 5000 : opts.busyRetryMs;
    const log = typeof opts.log === 'function' ? opts.log : function () {};
    const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : function (fn, ms) { return setTimeout(fn, ms); };

    // Insertion order is the recency order: touching a session moves it last.
    const sessions = new Map();
    const listeners = new Set();
    let disabledUntil = 0;

    function touch(sessionId, create) {
      let session = sessions.get(sessionId);
      if (session) {
        sessions.delete(sessionId);
        sessions.set(sessionId, session);
        return session;
      }
      if (!create) return null;
      session = { id: sessionId, turns: new Map(), listPromise: null, listed: false, wtNextAt: 0, wtTimer: null };
      sessions.set(sessionId, session);
      while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
      return session;
    }

    function turnOf(session, turnId) {
      let turn = session.turns.get(turnId);
      if (!turn) {
        // `record` is the desktop pair and `phone` the phone pair; `viewing` is the size last asked for.
        turn = { record: null, phone: null, viewing: 'desktop', answeredKey: null, fromList: false, retakeFailed: false, pending: new Map(), busy: null };
        session.turns.set(turnId, turn);
      }
      return turn;
    }

    // Without a size this is the pair last asked for, or the one there is (the Changes panel); the chat names 'desktop'.
    function view(turn, viewport) {
      return turn
        ? { record: viewport ? (viewport === 'phone' ? turn.phone : turn.record) : (turn.viewing === 'phone' && turn.phone) || turn.record || turn.phone, pending: turn.pending.size > 0, answered: turn.answeredKey !== null || turn.fromList, retakeFailed: turn.retakeFailed }
        : { record: null, pending: false, answered: false, retakeFailed: false };
    }

    function emit(sessionId, turnId) {
      for (const listener of Array.from(listeners)) {
        try { listener({ sessionId, turnId }); } catch (err) { log('changePictures listener failed', err); }
      }
    }

    function isDisabled() {
      return now() < disabledUntil;
    }

    function startDisabled() {
      disabledUntil = now() + disabledRetryMs;
    }

    function method(name) {
      let bridge = null;
      try { bridge = getBridge(); } catch (err) { log('changePictures bridge lookup failed', err); }
      return bridge && typeof bridge[name] === 'function' ? { bridge, fn: bridge[name] } : null;
    }

    function markAnswered(session, turnId, key) {
      const turn = turnOf(session, turnId);
      const was = turn.answeredKey !== null || turn.fromList;
      turn.answeredKey = key;
      if (!was) emit(session.id, turnId);
    }

    function peek(sessionId, turnId, viewport) {
      const session = touch(idOf(sessionId), false);
      return view(session && session.turns.get(idOf(turnId)), viewport);
    }

    function settled(session, turnId) {
      return Promise.resolve(view(session.turns.get(turnId)));
    }

    // One bridge call: pending is visible from the moment it starts, a rejection
    // or a throw becomes a plain "failed" answer, and an answer for a session
    // that was evicted meanwhile is dropped.
    function launch(session, turnId, key, found, payload, apply) {
      const turn = turnOf(session, turnId);
      let raw;
      try {
        raw = found.fn.call(found.bridge, payload);
      } catch (err) {
        log('changePictures call threw', err);
        raw = { ok: false, reason: 'failed' };
      }
      const promise = Promise.resolve(raw)
        .catch((err) => { log('changePictures call rejected', err); return { ok: false, reason: 'failed' }; })
        .then((answer) => {
          if (turn.pending.get(key) === promise) turn.pending.delete(key);
          if (sessions.get(session.id) === session) {
            apply(answer && typeof answer === 'object' && typeof answer.ok === 'boolean' ? answer : { ok: false, reason: 'failed' });
          }
          emit(session.id, turnId);
          return view(turn);
        });
      turn.pending.set(key, promise);
      emit(session.id, turnId);
      return promise;
    }

    function request(sessionId, turnId, files, requestOptions) {
      const sid = idOf(sessionId);
      const tid = idOf(turnId);
      const ro = requestOptions || {};
      const viewport = viewportOf(ro.viewport);
      const force = ro.force === true;
      if (!sid || !tid) return Promise.resolve(view(null));
      const session = touch(sid, true);
      const turn = turnOf(session, tid);
      const list = normalizeFiles(files);
      if (!list.length) {
        markAnswered(session, tid, viewport + '|');
        return settled(session, tid);
      }
      if (isDisabled()) return settled(session, tid);
      const key = viewport + '|' + filesSignature(list);
      const inFlight = turn.pending.get(key);
      if (inFlight) return inFlight;
      if (!force && turn.answeredKey === key) return settled(session, tid);
      if (!force && turn.busy && turn.busy.key === key && turn.busy.until > now()) return settled(session, tid);
      const found = method('capture');
      if (!found) {
        markAnswered(session, tid, key);
        return settled(session, tid);
      }
      return launch(session, tid, key, found, { sessionId: sid, turnId: tid, files: list, viewport, force }, (answer) => {
        if (answer.ok !== true) {
          if (answer.reason === 'busy') turn.busy = { key, until: now() + busyRetryMs };
          else turn.answeredKey = key;
          return;
        }
        if (answer.enabled === false) { startDisabled(); return; }
        const record = validRecord(answer.record);
        if (record) {
          // A phone pair never takes the desktop pair's place.
          turn[viewport === 'phone' ? 'phone' : 'record'] = record;
          turn.viewing = viewport;
          turn.retakeFailed = false;
        } else if (turn.record || turn.phone) {
          turn.retakeFailed = true;
        }
        turn.busy = null;
        turn.answeredKey = key;
      });
    }

    function requestWorkingTree(sessionId, requestOptions) {
      const sid = idOf(sessionId);
      const ro = requestOptions || {};
      const viewport = viewportOf(ro.viewport);
      const force = ro.force === true;
      if (!sid) return Promise.resolve(view(null));
      const session = touch(sid, true);
      const turn = turnOf(session, WORKING_TREE_TURN_ID);
      if (isDisabled()) return settled(session, WORKING_TREE_TURN_ID);
      const key = '@wt|' + viewport;
      const inFlight = turn.pending.get(key);
      if (inFlight) return inFlight;
      if (!force && now() < session.wtNextAt) {
        // Held back, not dropped: the working tree is asked once more when the spacing ends.
        if (!session.wtTimer) {
          session.wtTimer = setTimer(function () {
            session.wtTimer = null;
            if (sessions.get(sid) === session) requestWorkingTree(sid, { viewport });
          }, Math.max(0, session.wtNextAt - now()));
          if (session.wtTimer && typeof session.wtTimer.unref === 'function') session.wtTimer.unref();
        }
        return settled(session, WORKING_TREE_TURN_ID);
      }
      const found = method('captureWorkingTree');
      if (!found) return settled(session, WORKING_TREE_TURN_ID);
      session.wtNextAt = now() + workingTreeMinIntervalMs;
      return launch(session, WORKING_TREE_TURN_ID, key, found, { sessionId: sid, viewport, force }, (answer) => {
        if (answer.ok !== true) {
          if (answer.reason === 'busy') session.wtNextAt = now() + busyRetryMs;
          return;
        }
        if (answer.enabled === false) { startDisabled(); return; }
        turn.record = validRecord(answer.record);
        turn.retakeFailed = false;
        turn.answeredKey = key;
      });
    }

    function ensureListed(sessionId) {
      const sid = idOf(sessionId);
      if (!sid) return Promise.resolve(false);
      const session = touch(sid, true);
      if (session.listed) return Promise.resolve(true);
      if (session.listPromise) return session.listPromise;
      const found = method('list');
      if (!found) return Promise.resolve(false);
      let raw;
      try {
        raw = found.fn.call(found.bridge, { sessionId: sid });
      } catch (err) {
        log('changePictures list threw', err);
        raw = { ok: false };
      }
      const promise = Promise.resolve(raw)
        .catch((err) => { log('changePictures list rejected', err); return { ok: false }; })
        .then((answer) => {
          if (session.listPromise === promise) session.listPromise = null;
          if (!answer || answer.ok !== true) return false;
          if (answer.enabled === false) {
            startDisabled();
            emit(sid, '');
            return false;
          }
          if (sessions.get(sid) !== session) return true;
          session.listed = true;
          const changed = [];
          for (const item of Array.isArray(answer.records) ? answer.records : []) {
            const record = validRecord(item);
            const turnId = record ? idOf(record.turnId) : '';
            if (!turnId) continue;
            const turn = turnOf(session, turnId);
            // A capture that finished while the list was in flight is newer.
            const slot = turnId !== WORKING_TREE_TURN_ID && viewportOf(record.viewport) === 'phone' ? 'phone' : 'record';
            if (!turn[slot] || takenAt(record) >= takenAt(turn[slot])) turn[slot] = record;
            // A stored phone pair alone does not answer for the desktop pair.
            if (slot === 'record') turn.fromList = true;
            changed.push(turnId);
          }
          for (const turnId of changed) emit(sid, turnId);
          return true;
        });
      session.listPromise = promise;
      return promise;
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.add(listener);
      return function unsubscribe() { listeners.delete(listener); };
    }

    return { peek, ensureListed, request, requestWorkingTree, isDisabled, subscribe };
  }

  return {
    WEB_EXTENSIONS,
    PAGE_EXTENSIONS,
    WORKING_TREE_TURN_ID,
    idOf,
    viewportOf,
    turnFiles,
    firstPagePath,
    filesSignature,
    createPictureCache,
    splitPath,
    isFileUrl,
    positiveInt,
  };
});
