/* Files waiting in a team composer (row 123, slice 2c renderer; owner picks 2026-11-13, picks 1, 2, 3 and 9).
 *
 * One stash per composer place (team, channel, thread), kept while Jenny runs and never saved with the draft: a
 * channel switch keeps the files, a restart forgets them (the host lets a staged upload go after an hour anyway).
 * - Three ways in: the paperclip (main's file dialog, several files, no filter), a paste of files, and a drop of
 *   files anywhere over the channel (`.team-main`) or over an open thread's column (`aside.team-thread`, its own
 *   composer). A drag shows an overlay only when it carries files; dragenter/dragleave are counted so it does not
 *   flicker. Offline the overlay says so and a drop adds nothing.
 * - At most 8 files a message; the rest are not added and a note under the chips says how many. A file over 4 MiB
 *   is added with its refusal and never sent. Uploads start at once, at most 3 at a time across the app (the host
 *   allows 4 per member), the rest "Waiting to upload".
 * - A chip: the picture (an object URL of its own bytes; png, jpeg, webp and gif only, made only for a file that
 *   will upload) or a file glyph, the name, a second line with the state in words, Retry where the approved table
 *   shows it, and ×. A file uploaded more than an hour ago is expired (one timer for the next expiry); so is every
 *   ready file when a post is refused `team_chat_not_found` (a host restart), and Retry uploads it again. An empty
 *   file or a folder is refused before anything is read. The bytes stay until the file is sent or removed.
 * - Stashes with no file and no composer showing them are dropped; a team left, deleted, revoked or held local
 *   drops its stashes (renderer-team-tab-gate.js `forget`).
 * - `blockReason(hasWords)` is why Send is greyed, or '': offline with files, files still uploading, files that
 *   did not upload, an expired file, files and no words (the host's text rule stays).
 * Names are text: escaped in markup, never part of a path, URL, selector or log. Nothing here reaches a log. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-files'), require('./renderer-team-store'));
    return;
  }
  root.rendererTeamAttach = factory(root.rendererSettingsTeamStrings, root.rendererTeamFiles, root.rendererTeamStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, files, teamStore) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const MAX_FILES = 8;
  const MAX_BYTES = 4 * 1024 * 1024;
  const AT_ONCE = 3;
  const STAGED_MS = 60 * 60 * 1000;
  const NAME_MAX = 255;
  const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
  const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
  const CLIP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 7.6 8.1 12.5a3.2 3.2 0 0 1-4.6-4.6l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.8a1.1 1.1 0 0 1-1.5-1.5l4.6-4.6"/></svg>';

  const stashes = new Map(); // team|channel|thread -> { files: [], notAdded: 0, listeners: Set }
  const queue = []; // files waiting for an upload slot, oldest first
  let running = 0;
  let expiryTimer = null;
  let seq = 0;

  function inv() { return globalThis.inventory || {}; }
  function store() { return teamStore && teamStore.getTeamStore ? teamStore.getTeamStore() : null; }
  function urls() { return globalThis.URL || null; }

  function stashOf(key) {
    if (!stashes.has(key)) stashes.set(key, { key, files: [], notAdded: 0, listeners: new Set() });
    return stashes.get(key);
  }
  // A stash with nothing in it and no composer showing it goes.
  function prune(stash) {
    if (!stash.files.length && !stash.notAdded && !stash.listeners.size && stashes.get(stash.key) === stash) stashes.delete(stash.key);
  }
  function tell(stash) { for (const listener of [...stash.listeners]) listener(); }

  // ------------------------------------------------------------ names and types

  function two(n) { return String(n).padStart(2, '0'); }
  const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  function pastedName(type, now = new Date()) {
    return jt('team.attach.pasted', 'Pasted picture {time}.{ext}', { time: two(now.getHours()) + '-' + two(now.getMinutes()), ext: EXTENSIONS[type] || EXTENSIONS['image/png'] });
  }
  // The host's name rule (1-255 characters, no control character, no / or \) decides; this only fills a missing name:
  // a pasted picture is named by the time and its type, anything else nameless is "file".
  function nameOf(file, picture, type) {
    const name = typeof file.name === 'string' ? file.name : '';
    if (picture && (!name || name === 'image.png')) return pastedName(type);
    if (!name) return 'file';
    return name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name;
  }
  // A file whose bytes are still here can upload again (Retry).
  function canUpload(file) { return Boolean(file.blob || file.bytes) && (file.state === 'failed' || file.state === 'expired'); }
  function typeOf(type) { const t = String(type || '').toLowerCase(); return TYPE_PATTERN.test(t) ? t : 'application/octet-stream'; }

  // ------------------------------------------------------------ the upload queue

  function schedule() {
    while (running < AT_ONCE && queue.length) {
      const file = queue.shift();
      if (file.state !== 'waiting' || file.removed) continue;
      void upload(file);
    }
  }
  async function bytesOf(file) {
    if (file.bytes) return file.bytes;
    return new Uint8Array(await file.blob.arrayBuffer());
  }
  async function upload(file) {
    running += 1;
    file.state = 'uploading';
    tell(file.stash);
    let answer;
    try {
      const bytes = await bytesOf(file);
      if (bytes.byteLength > MAX_BYTES) answer = { ok: false, error: { code: '', reason: 'attachment_size_limit' } };
      else if (file.removed) answer = null;
      else {
        const teams = store();
        answer = teams ? await teams.call('chatUpload', { team_id: file.teamId, channel_id: file.channelId, upload_id: file.uploadId,
          name: file.name, type: file.type, bytes }) : { ok: false, error: { code: '', reason: 'team_not_connected' } };
      }
    } catch {
      answer = { ok: false, error: { code: '', reason: 'team_not_connected' } };
    }
    running -= 1;
    if (!file.removed && answer) {
      if (answer.ok && answer.attachment && typeof answer.attachment.id === 'string') {
        file.state = 'ready';
        file.attachment = answer.attachment;
        file.uploadedAt = Date.now();
        armExpiry(); // the bytes stay until the file is sent or removed, so an expired file can upload again
      } else {
        file.state = 'failed';
        file.error = (answer && answer.error) || { code: '', reason: 'team_chat_answer_invalid' };
      }
      tell(file.stash);
    }
    schedule();
  }
  function enqueue(file) {
    file.state = 'waiting';
    file.error = null;
    queue.push(file);
    schedule();
  }

  // ------------------------------------------------------------ the hour's expiry

  function armExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    let next = Infinity;
    for (const stash of stashes.values()) for (const file of stash.files) if (file.state === 'ready') next = Math.min(next, file.uploadedAt + STAGED_MS);
    if (next === Infinity) return;
    expiryTimer = setTimeout(expireDue, Math.max(0, next - Date.now()));
  }
  function expireDue() {
    expiryTimer = null;
    const now = Date.now();
    for (const stash of stashes.values()) {
      let changed = false;
      for (const file of stash.files) if (file.state === 'ready' && now >= file.uploadedAt + STAGED_MS) { file.state = 'expired'; changed = true; }
      if (changed) tell(stash);
    }
    armExpiry();
  }

  // ------------------------------------------------------------ adding and removing

  function forget(file) {
    file.removed = true;
    if (file.state === 'uploading') {
      const teams = store();
      if (teams) void teams.call('chatUploadCancel', { team_id: file.teamId, upload_id: file.uploadId });
    }
    if (file.url && urls()) urls().revokeObjectURL(file.url);
    file.url = '';
    file.blob = null;
    file.bytes = null;
  }

  // Why a file is refused before anything is read: empty (a folder reads as empty), over 4 MiB, or no bytes.
  function refusal(item, size) {
    if (size > MAX_BYTES || (item.blob === null && !item.bytes)) return 'attachment_size_limit';
    if (size <= 0) return 'attachment_empty';
    return '';
  }
  // `list`: [{ name, type, size, blob? , bytes? }] (a File is a blob with a name). Answers how many were added.
  function addTo(stash, where, list, extraNotAdded = 0) {
    const room = Math.max(0, MAX_FILES - stash.files.length);
    const taken = list.slice(0, room);
    stash.notAdded = Math.max(0, list.length - room) + extraNotAdded;
    for (const item of taken) {
      const declared = String(item.type || '').toLowerCase();
      const picture = PREVIEW_TYPES.has(declared);
      const size = Number(item.size) || (item.bytes ? item.bytes.byteLength : 0);
      const file = { uploadId: 'up' + Date.now().toString(36) + (seq += 1), teamId: where.teamId, channelId: where.channelId, stash,
        name: nameOf(item, picture, declared), type: typeOf(declared), size, blob: item.blob || null, bytes: item.bytes || null,
        url: '', state: 'waiting', error: null, attachment: null, uploadedAt: 0, removed: false, picture };
      const refused = refusal(item, size);
      stash.files.push(file);
      if (refused) {
        file.state = 'failed';
        file.error = { code: '', reason: refused };
        file.blob = null;
        file.bytes = null;
        continue;
      }
      if (picture && urls() && typeof urls().createObjectURL === 'function' && typeof Blob === 'function') {
        try { file.url = urls().createObjectURL(file.blob || new Blob([file.bytes], { type: declared })); } catch { file.url = ''; }
      }
      enqueue(file);
    }
    tell(stash);
    return taken.length;
  }

  // ------------------------------------------------------------ one composer's view

  // `root` is the composer root; `ctx()` the tab's context ({ online, canWrite, channelName, channelTitle, direct });
  // `onChange` redraws the composer's hint and Send.
  function createAttach({ root, teamId, channelId, threadRootId = null, ctx, onChange }) {
    const key = teamId + '|' + channelId + '|' + (threadRootId || '');
    const where = { teamId, channelId };
    let stash = stashOf(key);
    let lastTray = null; // the chips' markup last written, so a redraw with nothing changed writes nothing
    let host = null;
    let overlay = null;
    let depth = 0;
    let picking = false;
    let mounted = false;

    const q = (selector) => root.querySelector(selector);
    const list = () => stash.files;

    function buttonHtml(c) {
      const label = jt('team.attach.button', 'Attach files');
      return inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: buttonReason(c) || label, title: buttonTitle(c), disabled: Boolean(buttonReason(c)),
        dataset: { 'team-composer': 'attach' }, trustedHtml: CLIP });
    }
    function buttonReason(c) {
      if (!c.online) return jt('team.attach.buttonOffline', 'Attach files. Needs the team online');
      if (list().length >= MAX_FILES) return jt('team.attach.buttonFull', 'Attach files. A message can carry up to 8 files.');
      return '';
    }
    function buttonTitle(c) { return buttonReason(c) || jt('team.attach.buttonTitle', 'Attach files (up to 8, 4 MB each)'); }
    const trayHtml = () => '<div class="attachment-tray team-staged" role="group" aria-label="' + escapeHtml(jt('team.attach.trayLabel', 'Files to send')) + '" hidden></div><p class="team-staged__note" role="status" hidden></p>';

    function lineOf(file) {
      if (file.state === 'uploading') return { text: jt('team.attach.uploading', 'Uploading…'), tone: 'busy' };
      if (file.state === 'waiting') return { text: jt('team.attach.waiting', 'Waiting to upload'), tone: 'busy' };
      if (file.state === 'expired') return { text: jt('team.attach.expired', 'Waited more than an hour, so the team server let it go. Attach it again.'), tone: 'danger', retry: canUpload(file) };
      if (file.state === 'failed') return { text: words.uploadErrorText(file.error), tone: 'danger', retry: words.uploadRetry(file.error) };
      return { text: jt('team.attach.meta', '{type} · {size}', { type: files.typeWord(file.type, file.name), size: files.sizeText(file.size) }) };
    }
    function chipHtml(file) {
      const line = lineOf(file);
      const preview = file.url
        ? '<img class="attachment-chip-preview" src="' + escapeHtml(file.url) + '" alt="">'
        : '<span class="team-staged__glyph" aria-hidden="true">' + files.FILE_GLYPH + '</span>';
      const remove = jt('team.attach.remove', 'Remove {name}', { name: file.name });
      return '<div class="attachment-chip attachment-chip-image" data-team-upload="' + escapeHtml(file.uploadId) + '">' + preview
        + '<span class="attachment-chip-copy"><span class="attachment-chip-name" dir="auto" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</span>'
        + '<span class="attachment-chip-meta"' + (line.tone ? ' data-tone="' + line.tone + '"' : '') + '>' + escapeHtml(line.text)
        + (line.retry ? inv().actionButton({ plain: true, className: 'team-staged__retry', label: jt('team.attach.retry', 'Retry'),
          ariaLabel: jt('team.attach.retry', 'Retry') + ' ' + file.name, title: jt('team.attach.retry', 'Retry') + ' ' + file.name, dataset: { 'team-composer': 'attach-retry', 'team-upload': file.uploadId } }) : '')
        + '</span></span>'
        + inv().actionButton({ plain: true, className: 'attachment-chip-remove', ariaLabel: remove, title: remove, dataset: { 'team-composer': 'attach-remove', 'team-upload': file.uploadId }, trustedHtml: CLOSE })
        + '</div>';
    }

    function draw() {
      if (!mounted) return;
      const tray = q('.team-staged');
      const note = q('.team-staged__note');
      if (tray) {
        const html = list().map(chipHtml).join('');
        if (html !== lastTray) { tray.innerHTML = html; lastTray = html; }
        tray.hidden = !list().length;
      }
      if (note) {
        const text = stash.notAdded ? jtn('team.attach.notAdded', stash.notAdded, {}, 'A message can carry up to 8 files. {count} was not added.', 'A message can carry up to 8 files. {count} were not added.') : '';
        if (note.textContent !== text) note.textContent = text;
        note.hidden = !text;
      }
      const button = q('[data-team-composer="attach"]');
      if (button) {
        const c = ctx();
        const reason = buttonReason(c);
        button.disabled = Boolean(reason);
        button.title = buttonTitle(c);
        button.setAttribute('aria-label', reason || jt('team.attach.button', 'Attach files'));
      }
    }
    // The composer's redraw draws the tray too (renderer-team-composer.js `refresh`): one draw per change.
    function changed() { if (onChange) onChange(); else draw(); }

    // ------------------------------------------------------------ drop

    function dropWords() {
      const c = ctx();
      const place = c.direct ? c.channelTitle : '#' + c.channelName;
      return c.online
        ? { title: jt('team.attach.dropTitle', 'Drop to attach to {channel}', { channel: place }),
          line: jt('team.attach.dropLine', 'Up to 8 files, 4 MB each. Pictures show in the message; other files are downloaded.') }
        : { title: jt('team.attach.dropOffline', 'Files need the team online'), line: '' };
    }
    function hasFiles(event) {
      const types = event.dataTransfer && event.dataTransfer.types;
      return Boolean(types && Array.prototype.indexOf.call(types, 'Files') >= 0);
    }
    function showOverlay(on) {
      if (!host) return;
      if (!on) { if (overlay) { overlay.remove(); overlay = null; } return; }
      const said = dropWords();
      if (!overlay) {
        overlay = host.ownerDocument.createElement('div');
        overlay.className = 'team-drop';
        overlay.setAttribute('aria-hidden', 'true');
        host.appendChild(overlay);
      }
      overlay.dataset.blocked = String(!ctx().online);
      overlay.innerHTML = '<div class="team-drop__words"><strong>' + escapeHtml(said.title) + '</strong>' + (said.line ? '<span>' + escapeHtml(said.line) + '</span>' : '') + '</div>';
    }
    function onDragEnter(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (depth === 1) showOverlay(true);
    }
    function onDragOver(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = ctx().online ? 'copy' : 'none';
    }
    function onDragLeave(event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) showOverlay(false);
    }
    function onDrop(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      showOverlay(false);
      if (!ctx().online || !ctx().canWrite) return;
      addFiles(Array.from(event.dataTransfer.files || []));
    }

    // ------------------------------------------------------------ the ways in

    function addFiles(fileList) {
      const items = fileList.filter(Boolean).map((file) => ({ name: file.name, type: file.type, size: file.size, blob: file }));
      if (items.length) addTo(stash, where, items);
    }
    function onPaste(event) {
      const pasted = event.clipboardData && event.clipboardData.files ? Array.from(event.clipboardData.files) : [];
      if (!pasted.length) return false; // pasted text stays text
      event.preventDefault();
      if (!ctx().online) return 'offline'; // the composer says so in its hint
      addFiles(pasted);
      return true;
    }
    async function pick() {
      if (picking || buttonReason(ctx())) return;
      picking = true;
      try {
        const teams = store();
        const answer = teams ? await teams.call('chatAttachPick', { team_id: teamId, room: Math.max(1, MAX_FILES - list().length) }) : null;
        // The team was let go or the view torn down while the dialog was open: nothing is added.
        if (!mounted || stashes.get(key) !== stash || !answer || !answer.ok || !Array.isArray(answer.files)) return;
        const items = answer.files.map((f) => ({ name: f.name, type: f.type, size: f.size, blob: null, bytes: f.bytes ? new Uint8Array(f.bytes) : null }));
        if (items.length || answer.not_added) addTo(stash, where, items, Number(answer.not_added) || 0);
      } finally {
        picking = false;
      }
    }
    function remove(uploadId) {
      const at = list().findIndex((f) => f.uploadId === uploadId);
      if (at < 0) return;
      forget(list()[at]);
      list().splice(at, 1);
      stash.notAdded = 0;
      tell(stash);
      armExpiry();
    }
    function retry(uploadId) {
      const file = list().find((f) => f.uploadId === uploadId);
      if (!file || !canUpload(file) || (file.state === 'failed' && !words.uploadRetry(file.error))) return;
      enqueue(file);
      tell(stash);
    }

    // ------------------------------------------------------------ Send

    function blockReason(hasWords) {
      const all = list();
      if (!all.length) return '';
      if (!ctx().online) return jt('team.attach.blockOffline', 'Files need the team online. Remove them to send the text now.');
      const pending = all.filter((f) => f.state === 'waiting' || f.state === 'uploading').length;
      if (pending) return jtn('team.attach.blockWaiting', pending, {}, 'Waiting for {count} file to finish uploading', 'Waiting for {count} files to finish uploading');
      if (all.some((f) => f.state === 'failed')) return jt('team.attach.blockFailed', 'Remove or retry the files that did not upload');
      if (all.some((f) => f.state === 'expired')) return jt('team.attach.blockExpired', 'Attach the expired file again, or remove it');
      if (!hasWords) return jt('team.attach.blockWords', 'Add a few words to send these files');
      return '';
    }
    // The posted files, in chip order.
    function ids() { return list().filter((f) => f.state === 'ready').map((f) => f.attachment.id); }
    // After a post: the files it carried go; one added while it was out stays.
    function clearSent(sent) {
      const gone = new Set(sent);
      for (const file of list().filter((f) => f.attachment && gone.has(f.attachment.id))) forget(file);
      stash.files = list().filter((f) => !f.removed);
      stash.notAdded = 0;
      tell(stash);
      armExpiry();
    }
    // A post refused `team_chat_not_found`: the files staged long enough ago are expired; with none that old (the host
    // restarted and lost them) every ready file is. Each can upload again. Answers whether any was marked.
    function markExpired(now = Date.now()) {
      const ready = list().filter((f) => f.state === 'ready');
      const old = ready.filter((f) => now - f.uploadedAt >= STAGED_MS - 5 * 60 * 1000);
      for (const file of old.length ? old : ready) file.state = 'expired';
      if (ready.length) { tell(stash); armExpiry(); }
      return ready.length > 0;
    }

    function onClick(control) {
      const action = control.dataset.teamComposer;
      if (action === 'attach') { void pick(); return true; }
      if (action === 'attach-remove') { remove(control.dataset.teamUpload); return true; }
      if (action === 'attach-retry') { retry(control.dataset.teamUpload); return true; }
      return false;
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      stash = stashOf(key); // a new one when the old one was dropped empty
      lastTray = null;
      stash.listeners.add(changed);
      host = root.closest('.team-thread') || root.closest('.team-main');
      if (host) {
        host.addEventListener('dragenter', onDragEnter);
        host.addEventListener('dragover', onDragOver);
        host.addEventListener('dragleave', onDragLeave);
        host.addEventListener('drop', onDrop);
      }
      draw();
    }
    function unmount() {
      if (!mounted) return;
      mounted = false;
      stash.listeners.delete(changed);
      prune(stash);
      if (host) {
        host.removeEventListener('dragenter', onDragEnter);
        host.removeEventListener('dragover', onDragOver);
        host.removeEventListener('dragleave', onDragLeave);
        host.removeEventListener('drop', onDrop);
      }
      showOverlay(false);
      host = null;
      depth = 0;
    }

    return { buttonHtml, trayHtml, mount, unmount, refresh: draw, blockReason, ids, clearSent, markExpired, onPaste, onClick };
  }

  // Team switch and teardown: every waiting file is forgotten, its object URL revoked, the timer cleared.
  function disposeAll() {
    for (const stash of stashes.values()) { for (const file of stash.files) forget(file); stash.files.length = 0; stash.listeners.clear(); }
    stashes.clear();
    queue.length = 0;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  // A team that is shown no more (switch, leave, Force local): its stashes go.
  function forgetTeam(teamId) {
    for (const [key, stash] of stashes) {
      if (!key.startsWith(teamId + '|')) continue;
      for (const file of stash.files) forget(file);
      stash.files.length = 0;
      stashes.delete(key);
    }
    armExpiry();
  }

  return { createAttach, disposeAll, forgetTeam,
    _state: () => ({ running, queued: queue.length, stashes: stashes.size, timer: expiryTimer !== null }) };
});
