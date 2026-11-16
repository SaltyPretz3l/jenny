/* Files in a team message (row 123, slice 2c renderer; owner picks 2026-11-13, picks 4, 5, 6 and 7).
 *
 * Under a message's text and above its foot, never for a deleted message: first its pictures in a wrapping row, then
 * its other files, each kind in the order the message gives.
 * - A picture is an attachment the host stored as `kind: 'image'` with a png, jpeg or webp type. Anything else,
 *   whatever its name or declared type (an SVG, a web page, a `.png` the host kept as a file), is a file line and
 *   is never drawn. One picture is 220 px tall, several 140 px each (styles/team-chat.css), so nothing below moves
 *   when one arrives. A picture is a button that opens the image viewer on the message's pictures.
 * - A picture is fetched only when its row comes near the viewport (checked after each patch and once per animation
 *   frame on scroll), at most 3 at once, as a data: URL main checked (image types, at most 4 MiB, 8192 px a side,
 *   40 megapixels; one main refuses is drawn as a file line). The bytes live in one cache for the shown team,
 *   bounded at 64 MiB of data: URL characters. A picture near the viewport or open in the viewer is never dropped;
 *   room is made by dropping the picture longest out of view, which is fetched again only when it comes back into
 *   view. One that does not fit beside the pictures in view waits with its name and size, and "Show picture" fetches
 *   it. The cache goes when another team is shown, the team is left, deleted, revoked or held local, and on teardown.
 * - The bytes never enter a row's markup: a row is built only when its signature changes, and each drawn <img> gets
 *   its src after the patch, so an unrelated redraw never decodes a picture again.
 * - Not shown yet, failed, gone (`team_chat_not_found`) and offline keep the frame's height and say so in words.
 * - A file line: a glyph, the name, "{type} · {size}" and Download, which opens main's save dialog. While it runs
 *   the line says "Downloading…", then "Saved to {folder}" with "Show in folder", or "Not downloaded. {reason}".
 *   Cancelling the dialog says nothing. Offline and gone grey Download with the reason.
 * Names are drawn as the save dialog suggests them (`shownName`), as text (escaped, `dir="auto"`); ids are checked against the host's pattern before they reach markup.
 * Nothing here reaches a log. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-store'));
    return;
  }
  root.rendererTeamFiles = factory(root.rendererSettingsTeamStrings, root.rendererTeamStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, teamStore) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const ATT_ID = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
  const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  const CACHE_MAX = 64 * 1024 * 1024;
  const AT_ONCE = 3;
  const NEAR_PX = 600;
  const FILE_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5l3.2 3.2v9.2H4z"/><path d="M9 1.8V5h3.2"/></svg>';
  const DL_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.8 7.4 8 10.6l3.2-3.2M3 13.5h10"/></svg>';

  // ------------------------------------------------------------ words for a file

  const TYPE_WORDS = {
    picture: () => jt('team.files.type.picture', 'Picture'), pdf: () => jt('team.files.type.pdf', 'PDF'),
    text: () => jt('team.files.type.text', 'Text'), spreadsheet: () => jt('team.files.type.spreadsheet', 'Spreadsheet'),
    document: () => jt('team.files.type.document', 'Document'), slides: () => jt('team.files.type.slides', 'Slides'),
    archive: () => jt('team.files.type.archive', 'Archive'), video: () => jt('team.files.type.video', 'Video'),
    audio: () => jt('team.files.type.audio', 'Audio'), json: () => jt('team.files.type.json', 'JSON'),
    markdown: () => jt('team.files.type.markdown', 'Markdown'), svg: () => jt('team.files.type.svg', 'SVG image'),
    web: () => jt('team.files.type.web', 'Web page'), file: () => jt('team.files.type.file', 'File'),
  };
  const BY_TYPE = {
    'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'text', 'text/markdown': 'markdown', 'text/html': 'web',
    'application/xhtml+xml': 'web', 'application/json': 'json', 'text/csv': 'spreadsheet', 'text/tab-separated-values': 'spreadsheet',
    'application/vnd.ms-excel': 'spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
    'application/vnd.oasis.opendocument.spreadsheet': 'spreadsheet', 'application/msword': 'document', 'application/rtf': 'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document', 'application/vnd.oasis.opendocument.text': 'document',
    'application/vnd.ms-powerpoint': 'slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'slides',
    'application/vnd.oasis.opendocument.presentation': 'slides', 'application/zip': 'archive', 'application/x-7z-compressed': 'archive',
    'application/x-tar': 'archive', 'application/gzip': 'archive', 'application/x-rar-compressed': 'archive', 'application/vnd.rar': 'archive',
  };
  const BY_EXTENSION = {
    png: 'picture', jpg: 'picture', jpeg: 'picture', gif: 'picture', webp: 'picture', bmp: 'picture', svg: 'svg', pdf: 'pdf',
    txt: 'text', log: 'text', md: 'markdown', markdown: 'markdown', html: 'web', htm: 'web', json: 'json', csv: 'spreadsheet',
    tsv: 'spreadsheet', xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet', doc: 'document', docx: 'document', odt: 'document',
    rtf: 'document', ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides', zip: 'archive', '7z': 'archive', tar: 'archive',
    gz: 'archive', tgz: 'archive', rar: 'archive', mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
    mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
  };
  // From the declared type, then the name's extension; "File" for anything else.
  function typeWord(type, name) {
    const t = String(type || '').toLowerCase();
    let key = BY_TYPE[t] || (t.startsWith('image/') ? 'picture' : t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : '');
    if (!key) {
      const dot = String(name || '').lastIndexOf('.');
      key = dot > 0 ? BY_EXTENSION[String(name).slice(dot + 1).toLowerCase()] || '' : '';
    }
    return TYPE_WORDS[key || 'file']();
  }
  // "84 KB", "1.2 MB", the way Jenny writes sizes elsewhere; the host's 4 MiB cap reads "4 MB".
  function sizeText(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n < 1024 * 1024) return jt('team.files.sizeKb', '{size} KB', { size: Math.max(1, Math.round(n / 1024)) });
    const mb = n / (1024 * 1024);
    return jt('team.files.sizeMb', '{size} MB', { size: mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10 });
  }

  // ------------------------------------------------------------ the shown team's pictures

  function inv() { return globalThis.inventory || {}; }
  // The name a row and the viewer draw: chat-attachments.js `saveName`'s rule, so the save dialog suggests the same.
  function shownName(name) {
    const base = String(name || '').replaceAll('\\', '/').replace(/\/+$/u, '').split('/').pop();
    // eslint-disable-next-line no-control-regex -- control characters are not drawn in a name.
    const clean = base.replace(/\p{Cf}/gu, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').trim().replace(/[. ]+$/u, '').slice(0, 200);
    return clean && clean !== '.' && clean !== '..' ? clean : 'file';
  }
  // About how long a picture's data: URL is, from its size: what a fetch would add to the cache.
  const urlLength = (bytes) => Math.ceil(Math.max(0, Number(bytes) || 0) / 3) * 4 + 23;

  // { teamId, cache: Map(id -> data URL), total, peak, tick, seen: Map(id -> tick last in view), status: Map(id -> { state, error }),
  //   saves: Map, views: Set({ redraw, near: Set }), viewing: Set | null }
  let team = null;
  let running = 0;
  const queue = [];

  function teamFor(teamId) {
    if (!team || team.teamId !== teamId) {
      if (team) dropTeam();
      team = { teamId, cache: new Map(), total: 0, peak: 0, tick: 0, seen: new Map(), status: new Map(), saves: new Map(), views: new Set(), viewing: null };
    }
    return team;
  }
  function dropTeam() {
    if (!team) return;
    for (const map of [team.cache, team.seen, team.status, team.saves, team.views]) map.clear();
    team = null;
    queue.length = 0;
  }
  function store() { return teamStore && teamStore.getTeamStore ? teamStore.getTeamStore() : null; }
  function tellViews(t) { for (const view of [...t.views]) view.redraw(); }
  // In view in some log (near its viewport), or open in the viewer: never dropped to make room.
  function keptIds(t) {
    const ids = new Set(t.viewing || []);
    for (const view of t.views) for (const id of view.near) ids.add(id);
    return ids;
  }
  function inView(t, id) { for (const view of t.views) if (view.near.has(id)) return true; return false; }
  // Entries that may go to make room, the one longest out of view first.
  function spare(t, keep) {
    const kept = keptIds(t);
    return [...t.cache.keys()].filter((id) => id !== keep && !kept.has(id)).sort((a, b) => (t.seen.get(a) || 0) - (t.seen.get(b) || 0));
  }
  // Whether a picture of about `length` characters would fit, counting the room fetches already out will take.
  function fits(t, id, length) {
    let room = CACHE_MAX - t.total;
    for (const other of spare(t, id)) room += t.cache.get(other).length;
    for (const [other, held] of t.status) if (other !== id && held.state === 'loading') room -= held.length || 0;
    return length <= room;
  }
  // Out of the cache. One dropped off screen is fetched again when it comes back into view; one dropped in view (only
  // for a click) waits for a click.
  function evict(t, id, inSight) {
    t.total -= t.cache.get(id).length;
    t.cache.delete(id);
    if (inSight) t.status.set(id, { state: 'waiting', error: null }); else t.status.delete(id);
  }
  // Keeps `url` when it fits under the bound by dropping entries out of view, the one longest out of view first; a
  // click (`force`) may also drop pictures in view that are not open in the viewer. False when it does not fit.
  function cachePut(t, id, url, force) {
    if (t.cache.has(id)) { t.total -= t.cache.get(id).length; t.cache.delete(id); }
    for (const other of spare(t, id)) { if (t.total + url.length <= CACHE_MAX) break; evict(t, other, false); }
    if (force && t.total + url.length > CACHE_MAX) {
      const viewing = t.viewing || new Set();
      const shown = [...t.cache.keys()].filter((other) => other !== id && !viewing.has(other)).sort((a, b) => (t.seen.get(a) || 0) - (t.seen.get(b) || 0));
      for (const other of shown) { if (t.total + url.length <= CACHE_MAX) break; evict(t, other, true); }
    }
    if (t.total + url.length > CACHE_MAX) return false;
    t.cache.set(id, url);
    t.total += url.length;
    if (!t.seen.has(id)) t.seen.set(id, (t.tick += 1));
    t.peak = Math.max(t.peak, t.total);
    return true;
  }

  function pump() {
    while (running < AT_ONCE && queue.length) {
      const job = queue.shift();
      if (!team || team.teamId !== job.teamId) continue;
      // Its row left view while it waited: dropped, and asked again when it comes back.
      if (!job.force && !inView(team, job.id)) { team.status.delete(job.id); continue; }
      void fetchOne(job);
    }
  }
  async function fetchOne({ teamId, channelId, id, force }) {
    running += 1;
    let answer;
    try {
      const teams = store();
      answer = teams ? await teams.call('chatAttachmentImage', { team_id: teamId, channel_id: channelId, attachment_id: id }) : null;
    } catch {
      answer = null;
    }
    running -= 1;
    const t = team && team.teamId === teamId ? team : null;
    if (t && t.status.has(id)) {
      if (answer && answer.ok && typeof answer.data_url === 'string' && DATA_URL.test(answer.data_url)) {
        t.status.set(id, { state: cachePut(t, id, answer.data_url, force) ? 'shown' : 'waiting', error: null });
      } else {
        const error = (answer && answer.error) || { code: '', reason: 'team_chat_answer_invalid' };
        const state = error.reason === 'team_chat_not_found' ? 'gone' : error.reason === 'team_attachment_not_image' ? 'file' : 'failed';
        t.status.set(id, { state, error });
      }
      tellViews(t);
    }
    pump();
  }
  function request(t, channelId, id, force = false, length = 0) {
    t.status.set(id, { state: 'loading', error: null, length });
    queue.push({ teamId: t.teamId, channelId, id, force });
    pump();
  }

  // ------------------------------------------------------------ one log's view

  const valid = (a) => Boolean(a) && typeof a === 'object' && typeof a.id === 'string' && ATT_ID.test(a.id) && typeof a.name === 'string';
  const isPicture = (a) => a.kind === 'image' && PICTURE_TYPES.has(String(a.mime || '').toLowerCase());

  // `scroll` is the log element; `ctx()` the tab's context ({ online, me, nameOf(id), author(a) });
  // `onChange` redraws the log (rows patch by signature, so only a changed row is redrawn).
  function createFiles({ teamId, channelId, scroll, ctx, onChange }) {
    const t = teamFor(teamId);
    const messages = new Map(); // id -> message, for the rows drawn
    const built = new Map(); // message id -> { sig, html }: a row's block is built again only when its signature changes
    let disposed = false;
    let frame = 0;
    const win = (scroll && scroll.ownerDocument && scroll.ownerDocument.defaultView) || globalThis;
    const view = { redraw: () => { if (!disposed && onChange) onChange(); }, near: new Set() };
    t.views.add(view);

    // A picture the main process refused to draw (too large, or not what it claims) is a file line.
    function split(message) {
      const all = message && !message.deleted && Array.isArray(message.attachments) ? message.attachments.filter(valid) : [];
      const drawn = (a) => isPicture(a) && (t.status.get(a.id) || {}).state !== 'file';
      return { pictures: all.filter(drawn), others: all.filter((a) => !drawn(a)) };
    }
    function pictureState(a, c) {
      const held = t.status.get(a.id);
      if (held && held.state === 'shown' && t.cache.has(a.id)) return 'shown';
      if (held && (held.state === 'gone' || held.state === 'failed' || held.state === 'waiting')) return held.state;
      return c.online ? 'loading' : 'offline';
    }
    // The bytes never enter the markup: `paint` sets each picture's src after the patch.
    function pictureHtml(a, c) {
      const state = pictureState(a, c);
      const shown = shownName(a.name);
      const name = escapeHtml(shown);
      if (state === 'shown') {
        return inv().actionButton({ plain: true, className: 'team-img', dataset: { 'team-file': 'open', 'team-att': a.id },
          ariaLabel: jt('team.files.pictureLabel', '{name}, picture, {size}. Open larger', { name: shown, size: sizeText(a.size_bytes) }),
          title: shown, trustedHtml: '<img alt="" decoding="async" data-team-src="' + a.id + '">' });
      }
      let inner;
      if (state === 'loading') inner = '<span>' + escapeHtml(jt('team.files.loading', 'Loading {name}…', { name: shown })) + '</span>';
      else if (state === 'failed') {
        inner = '<span>' + escapeHtml(jt('team.files.failed', 'This picture could not be loaded. {reason}', { reason: words.errorText(t.status.get(a.id).error) })) + '</span>'
          + inv().actionButton({ label: jt('team.chat.tryAgain', 'Try again'), variant: 'ghost', size: 'sm', dataset: { 'team-file': 'retry', 'team-att': a.id } });
      } else if (state === 'waiting') {
        inner = '<b dir="auto">' + name + '</b><span>' + escapeHtml(jt('team.attach.meta', '{type} · {size}', { type: typeWord(a.mime, a.name), size: sizeText(a.size_bytes) })) + '</span>'
          + inv().actionButton({ label: jt('team.files.showPicture', 'Show picture'), variant: 'ghost', size: 'sm', ariaLabel: jt('team.files.showPicture', 'Show picture') + ' ' + shown, title: jt('team.files.showPicture', 'Show picture') + ' ' + shown,
            dataset: { 'team-file': 'fetch', 'team-att': a.id } });
      } else if (state === 'gone') inner = '<b dir="auto">' + name + '</b><span>' + escapeHtml(jt('team.files.gone', 'This picture is no longer on the team server.')) + '</span>';
      else inner = '<b dir="auto">' + name + '</b><span>' + escapeHtml(jt('team.files.offline', 'This picture needs the team online.')) + '</span>';
      return '<div class="team-img" data-state="' + state + '" data-team-att="' + a.id + '" role="' + (state === 'loading' ? 'status' : 'group')
        + '" aria-label="' + name + '"><span class="team-img__words">' + inner + '</span></div>';
    }

    function fileHtml(a, c) {
      const gone = (t.status.get(a.id) || {}).state === 'gone';
      const save = t.saves.get(a.id);
      const shown = shownName(a.name);
      const why = gone ? jt('team.files.downloadGone', 'Download. No longer on the team server')
        : !c.online ? jt('team.files.downloadOffline', 'Download. Needs the team online') : '';
      const label = jt('team.files.download', 'Download');
      const button = inv().actionButton({ variant: 'ghost', size: 'sm', className: 'team-file__dl-btn', disabled: Boolean(why) || Boolean(save && save.state === 'busy'),
        ariaLabel: why || label + ' ' + shown, title: why || jt('team.files.downloadTitle', 'Download {name}. Jenny does not check what is inside a file.', { name: shown }),
        dataset: { 'team-file': 'download', 'team-att': a.id }, trustedHtml: DL_GLYPH + escapeHtml(label) });
      let after = '';
      if (save && save.state === 'busy') after = '<span class="team-file__meta" role="status">' + escapeHtml(jt('team.files.downloading', 'Downloading…')) + '</span>';
      else if (save && save.state === 'saved') {
        after = '<span class="team-file__meta" role="status">' + escapeHtml(jt('team.files.saved', 'Saved to {folder}', { folder: save.folder })) + '</span>'
          + inv().actionButton({ plain: true, className: 'team-thread-link', label: jt('team.files.reveal', 'Show in folder'), dataset: { 'team-file': 'reveal', 'team-att': a.id } });
      } else if (save && save.state === 'failed') {
        after = '<span class="team-file__meta" data-tone="danger" role="status">' + escapeHtml(jt('team.files.notDownloaded', 'Not downloaded. {reason}', { reason: words.errorText(save.error) })) + '</span>';
      }
      const meta = gone ? jt('team.files.fileGone', 'No longer on the team server') : jt('team.attach.meta', '{type} · {size}', { type: typeWord(a.mime, a.name), size: sizeText(a.size_bytes) });
      return '<div class="team-file"' + (gone ? ' data-gone="true"' : '') + '><span class="team-file__glyph" aria-hidden="true">' + FILE_GLYPH + '</span>'
        + '<span class="team-file__text"><span class="team-file__name" dir="auto" title="' + escapeHtml(shown) + '">' + escapeHtml(shown) + '</span>'
        + '<span class="team-file__meta">' + escapeHtml(meta) + '</span></span><span class="team-file__dl">' + button + after + '</span></div>';
    }

    // What the block shows: each file's id and state, and whether the team is online.
    function sigOf(pictures, others, c) {
      const save = (a) => { const s = t.saves.get(a.id); return s ? s.state + (s.folder || '') : ''; };
      return (c.online ? 'on' : 'off') + ':' + pictures.map((a) => a.id + pictureState(a, c)).join(',') + ';'
        + others.map((a) => a.id + ((t.status.get(a.id) || {}).state || '') + save(a)).join(',');
    }
    // A message's block and its signature, { sig, html } ('' for no files or a deleted message). `c` is the pass's
    // context, read once by the caller; the markup is built only when the signature changed.
    function row(message, c) {
      const { pictures, others } = split(message);
      if (!pictures.length && !others.length) { if (message) { messages.delete(message.id); built.delete(message.id); } return { sig: '', html: '' }; }
      messages.set(message.id, message);
      const sig = sigOf(pictures, others, c);
      const held = built.get(message.id);
      if (held && held.sig === sig) return held;
      const html = '<div class="team-files">'
        + (pictures.length ? '<div class="team-imgs" data-many="' + (pictures.length > 1) + '">' + pictures.map((a) => pictureHtml(a, c)).join('') + '</div>' : '')
        + others.map((a) => fileHtml(a, c)).join('') + '</div>';
      const next = { sig, html };
      built.set(message.id, next);
      return next;
    }

    // Each drawn picture without its bytes gets them from the cache (a row drawn again, or a picture just fetched).
    function paint() {
      for (const img of scroll.querySelectorAll('img[data-team-src]:not([src])')) {
        const url = t.cache.get(img.dataset.teamSrc);
        if (url) img.src = url;
      }
    }
    // Which pictures are near the viewport: those are marked seen now, fetched when they have no state yet, and fetched
    // again when they come back into view after being dropped or found not to fit.
    function look() {
      frame = 0;
      if (disposed || !scroll) return;
      const online = ctx().online;
      const box = scroll.getBoundingClientRect();
      const was = view.near;
      view.near = new Set();
      for (const el of scroll.querySelectorAll('.team-img[data-team-att]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom < box.top - NEAR_PX || r.top > box.bottom + NEAR_PX) continue;
        const id = el.dataset.teamAtt;
        view.near.add(id);
        t.seen.set(id, (t.tick += 1));
        const state = (t.status.get(id) || {}).state;
        if (!online || (state && !(state === 'waiting' && !was.has(id)))) continue;
        const row2 = el.closest('.team-msg');
        const message = row2 ? messages.get(row2.dataset.messageId) : null;
        const a = message ? message.attachments.find((x) => valid(x) && x.id === id) : null;
        if (!a) continue;
        if (fits(t, id, urlLength(a.size_bytes))) request(t, message.channel_id || channelId, id, false, urlLength(a.size_bytes));
        else if (state !== 'waiting') { t.status.set(id, { state: 'waiting', error: null }); view.redraw(); }
      }
    }
    // After a patch: the bytes, then what is near. On scroll: what is near, once per animation frame.
    function scan() {
      if (disposed || !scroll) return;
      paint();
      if (frame) { (win.cancelAnimationFrame || clearTimeout)(frame); frame = 0; }
      look();
    }
    function soon() {
      if (frame || disposed) return;
      frame = win.requestAnimationFrame ? win.requestAnimationFrame(look) : setTimeout(look, 16);
    }

    function findAttachment(row2, id) {
      const message = row2 ? messages.get(row2.dataset.messageId) : null;
      const found = message && Array.isArray(message.attachments) ? message.attachments.find((a) => valid(a) && a.id === id) : null;
      return found ? { message, attachment: found } : null;
    }
    // The team words' own date and time format (renderer-settings-team-strings.js `formatTime`).
    function whenText(iso) { return words.formatTime(Date.parse(iso)); }
    function openViewer(button, message, id) {
      const c = ctx();
      const shown = split(message).pictures.filter((a) => pictureState(a, c) === 'shown');
      const own = message.author && message.author.kind === 'member' && message.author.member_id === c.me;
      const items = shown.map((a) => ({ kind: 'source', src: t.cache.get(a.id), title: shownName(a.name),
        caption: own ? jt('team.files.fromYou', 'From you · {when} · {size}', { when: whenText(message.created_at), size: sizeText(a.size_bytes) })
          : jt('team.files.from', 'From {name} · {when} · {size}', { name: c.author(message.author).name, when: whenText(message.created_at), size: sizeText(a.size_bytes) }),
        actions: {
          'save-as': () => saveTo(message, a).then((answer) => (answer && answer.ok && answer.saved === false ? { canceled: true } : answer)),
          copy: () => call('chatAttachmentCopy', message, a),
        } }));
      const index = shown.findIndex((a) => a.id === id);
      const viewer = globalThis.rendererImageViewerController;
      if (index < 0 || !viewer || typeof viewer.open !== 'function') return;
      // The pictures handed to the viewer stay in the cache while it is open.
      const viewing = new Set(shown.map((a) => a.id));
      t.viewing = viewing;
      Promise.resolve(viewer.open({ items, index, contextNode: button })).catch(() => false)
        .then(() => { if (t.viewing === viewing) t.viewing = null; });
    }
    // Show in folder names only the attachment (ipc-methods.js chatAttachmentReveal); the rest name its channel too.
    function call(method, message, a, extra = {}) {
      const teams = store();
      const where = method === 'chatAttachmentReveal' ? {} : { channel_id: message.channel_id || channelId };
      return teams ? teams.call(method, { team_id: teamId, ...where, attachment_id: a.id, ...extra }) : Promise.resolve({ ok: false });
    }
    function saveTo(message, a) { return call('chatAttachmentSave', message, a, { name: a.name }); }
    async function download(message, a) {
      const held = t.saves.get(a.id);
      if (held && held.state === 'busy') return;
      t.saves.set(a.id, { state: 'busy' });
      tellViews(t);
      const answer = await saveTo(message, a);
      if (!team || team !== t) return;
      if (answer && answer.ok && answer.saved === false) t.saves.delete(a.id); // the dialog was cancelled: nothing to say
      else if (answer && answer.ok && answer.saved) t.saves.set(a.id, { state: 'saved', folder: String(answer.folder || '') });
      else {
        const error = (answer && answer.error) || { code: '', reason: 'team_chat_answer_invalid' };
        if (error.reason === 'team_chat_not_found') { t.saves.delete(a.id); t.status.set(a.id, { state: 'gone', error }); } else t.saves.set(a.id, { state: 'failed', error });
      }
      tellViews(t);
    }

    function onClick(event) {
      const control = event.target && event.target.closest ? event.target.closest('[data-team-file]') : null;
      if (!control || control.disabled || !scroll.contains(control)) return;
      const found = findAttachment(control.closest('.team-msg'), control.dataset.teamAtt);
      if (!found) return;
      event.stopPropagation();
      const action = control.dataset.teamFile;
      const { message, attachment } = found;
      if (action === 'open') openViewer(control, message, attachment.id);
      else if (action === 'retry') { t.status.delete(attachment.id); tellViews(t); }
      else if (action === 'fetch') { request(t, message.channel_id || channelId, attachment.id, true); tellViews(t); }
      else if (action === 'download') void download(message, attachment);
      else if (action === 'reveal') void call('chatAttachmentReveal', message, attachment);
    }
    if (scroll) {
      scroll.addEventListener('click', onClick);
      scroll.addEventListener('scroll', soon, { passive: true });
    }

    return {
      row,
      scan,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (frame) (win.cancelAnimationFrame || clearTimeout)(frame);
        t.views.delete(view);
        messages.clear();
        built.clear();
        if (scroll) { scroll.removeEventListener('click', onClick); scroll.removeEventListener('scroll', soon); }
      },
    };
  }

  // Teardown, and a team left, deleted, revoked or held local: the cache, the states and the queue go; a fetch still
  // out finds no team and is dropped.
  function disposeAll() { dropTeam(); }
  function forgetTeam(teamId) { if (team && team.teamId === teamId) dropTeam(); }

  return { createFiles, disposeAll, forgetTeam, shownName, typeWord, sizeText, FILE_GLYPH, CACHE_MAX, AT_ONCE };
});
