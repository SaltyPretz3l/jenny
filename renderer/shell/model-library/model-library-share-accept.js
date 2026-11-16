/* Settings › Models › the accept drawer and the "Where it came from" drawer (row 123, slice 6-7; the owner's picks,
 * "The accept drawer" and "A received model"). Loaded with the team assets.
 *
 * Accept: `modelOfferRead` once, then one drawer with the files, the main file's checksum (16 characters, Show all and
 * Show less), the roots with their free space (one that is too small or already holds the file greys Accept, with the
 * footer line), what the sender says (as text, cleaned, never a link) and the fixed warning. Accept keeps the root's
 * display path in the model store (the row's "arriving in") and sends `modelAccept { offer_id, root_index }` with the
 * index from the list this drawer read (the path is kept only once the answer is ok); Decline sends `modelDecline`; Not
 * now only closes. Built once: a push never redraws it. Where it came from: read-only, from the `modelProvenance`
 * answer the store keeps. Both share one drawer: an answer that comes after its opening was closed or replaced writes
 * nothing and closes nothing (the shared drawer's token). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./model-library-share-rows'));
    return;
  }
  root.modelLibraryShareAccept = factory(root, root.modelLibraryShareRows);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, rows) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var P = rows.parts;
  var W = rows.words;
  var esc = P.escapeHtml;
  var DRAWER_ID = 'modelShareAcceptDrawer';
  var SPARE_BYTES = 1024 * 1024 * 1024; // the receiver keeps 1 GB free beyond the files
  var HASH_SHOWN = 16;

  var lastDoc = null;
  function drawerFor(doc) { lastDoc = doc; return P.drawer(doc, DRAWER_ID); }

  // The app's language for dates and times (jenny-i18n), else the system's.
  function localeTag() { return globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined; }
  function dateOf(at) { return at.toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' }); }
  function timeOf(at) { return at.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }); }

  // "today at 10:42" or "13 November 2026 at 10:42"; '' for a time that does not parse.
  function whenText(iso) {
    var at = new Date(iso);
    if (!iso || Number.isNaN(at.getTime())) return '';
    var time = timeOf(at);
    var date = dateOf(at);
    return at.toDateString() === new Date().toDateString() ? jt('settings.models.share.todayAt', 'today at {time}', { time: time })
      : jt('settings.models.share.dateAt', '{date} at {time}', { date: date, time: time });
  }
  // What a file is, from its name: the receiver's offer lists names, sizes and hashes only.
  function whatFile(name, index) {
    if (index === 0) return jt('settings.models.share.fileIsModel', 'The model.');
    if (/mmproj/i.test(name)) return jt('settings.models.share.fileVision', 'Its vision file, which lets the model read images.');
    if (/(^|[-_.])(mtp|draft)/i.test(name)) return jt('settings.models.share.fileDrafter', 'Its drafter, for multi-token prediction.');
    return jt('settings.models.share.fileIsPart', 'A part of the model.');
  }
  function fileRows(files, totalBytes) {
    var list = (files || []).slice(0, 8);
    return '<ul class="mshare-files">' + list.map(function (file, i) {
      var name = rows.clean(file.name, 200);
      return '<li><span class="mshare-file-name" dir="auto">' + esc(name) + '</span><span class="mshare-file-size">' + esc(rows.size(file.size_bytes)) + '</span>'
        + '<span class="mshare-file-what">' + esc(whatFile(name, i)) + '</span></li>';
    }).join('') + '</ul><p class="mshare-total">' + esc(rows.filesText(list.length, totalBytes)) + '</p>';
  }
  function hashOf(files) {
    var hash = files && files[0] && typeof files[0].sha256 === 'string' ? files[0].sha256.toLowerCase() : '';
    return /^[0-9a-f]{64}$/.test(hash) ? hash : '';
  }
  function hashHtml(hash) {
    if (!hash) return P.value('—');
    return '<div class="mshare-hash"><code data-mshare-hash>' + esc(hash.slice(0, HASH_SHOWN)) + '…</code>'
      + rows.act(jt('settings.models.share.showAll', 'Show all'), 'hash-toggle', {}, 'ghost', jt('settings.models.share.showAllTip', 'Show the whole checksum')) + '</div>';
  }
  function toggleHash(host, hash) {
    var code = host.querySelector('[data-mshare-hash]');
    var button = host.querySelector('[data-mshare-action="hash-toggle"]');
    if (!code || !button) return;
    var open = button.getAttribute('aria-expanded') !== 'true';
    code.textContent = open ? hash : hash.slice(0, HASH_SHOWN) + '…';
    button.textContent = open ? jt('settings.models.share.showLess', 'Show less') : jt('settings.models.share.showAll', 'Show all');
    button.title = open ? jt('settings.models.share.showLessTip', 'Show only the start of the checksum') : jt('settings.models.share.showAllTip', 'Show the whole checksum');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function saysRows(prov, sender) {
    var none = jt('settings.models.share.notGiven', 'Not given');
    var licence = rows.cleanBlock(prov.licence, 4096);
    var source = rows.clean(prov.source_url, 512);
    var noteText = rows.cleanBlock(prov.note, 1024);
    return P.row({ key: 'licence', label: jt('settings.models.share.licence', 'Licence'), controlHtml: P.value(licence || none) })
      + P.row({ key: 'source', label: jt('settings.models.share.source', 'Where it is from'), controlHtml: P.value(source || none) })
      + P.row({ key: 'note', label: jt('settings.models.share.note', 'Note'), controlHtml: noteText ? P.value(jt('settings.models.share.quoted', '“{text}”', { text: noteText }), true) : P.value(none) })
      + '<p class="model-tuning-row-desc">' + esc(jt('settings.models.share.provenance', 'Licence and source as {sender} described them. Jenny has not checked them.', { sender: sender })) + '</p>';
  }
  // Opens the drawer and binds its listeners until that opening closes; answers { token, host } or null.
  function openWith(dr, title, bodyHtml, anchor, onClick, onChange) {
    var host = null;
    var token = dr.open({ title: title, bodyHtml: bodyHtml, restoreFocusTo: anchor, cleanup: function () {
      if (!host) return;
      host.removeEventListener('click', onClick);
      if (onChange) host.removeEventListener('change', onChange);
    } });
    if (!token) return null;
    host = dr.host();
    host.querySelector('.inv-drawer-panel').classList.add('mshare-drawer');
    host.addEventListener('click', onClick);
    if (onChange) host.addEventListener('change', onChange);
    return { token: token, host: host };
  }

  /**
   * deps: { documentRef, call(method, payload), store (keepPath), teamId, offerId, teamRole, ownerOf(teamId), anchor,
   *   onRefused(text) }. Answers a promise of whether the drawer opened.
   */
  function openAccept(deps) {
    var d = deps;
    var dr = drawerFor(d.documentRef);
    var asked = dr.begin();
    return d.call('modelOfferRead', { team_id: d.teamId, offer_id: d.offerId }).then(function (answer) {
      if (!dr.current(asked)) return false; // closed, disposed or opened again meanwhile
      if (!answer.ok || !answer.offer) { d.onRefused(rows.reasonText(answer.error && answer.error.reason)); return false; }
      var offer = answer.offer;
      var roots = (Array.isArray(answer.roots) ? answer.roots : []).filter(function (r) { return r && Number.isSafeInteger(r.index) && r.index >= 0 && r.index <= 15; }).slice(0, 16);
      var sender = W.name(offer.sender_name || jt('settings.models.share.someone', 'someone'));
      var name = rows.clean(offer.display_name || jt('settings.models.share.aModel', 'A model'));
      var mainFile = rows.clean(offer.files && offer.files[0] && offer.files[0].name, 200);
      var total = Number(offer.total_bytes) || 0;
      var hash = hashOf(offer.files);
      var good = roots.find(function (r) { return r.fits === true && r.exists !== true; });
      var chosen = good || roots[0] || null;
      var owner = d.ownerOf(d.teamId);
      var hostSide = d.teamRole === 'owner' || Boolean(owner && owner.member_id === offer.sender_member_id);
      var when = whenText(offer.offered_at);
      var rootSelect = roots.length ? P.select({ id: 'modelShareRoot', ariaLabel: jt('settings.models.share.saveTo', 'Save to'), value: String(chosen.index),
        options: roots.map(function (r) { return { value: String(r.index), label: jt('settings.models.share.rootOption', '{path} · {free} free', { path: rows.clean(r.display_path, 260), free: rows.size(r.free_bytes) }) }; }) })
        : P.value(jt('settings.models.share.noRoot', 'Jenny has no model folder to save it in.'));
      var sections = P.section(name, when ? jt('settings.models.share.offeredWhen', '{sender} offered this {when}.', { sender: sender, when: when }) : null,
        P.row({ key: 'files', label: jt('settings.models.share.filesTitle', 'Files'), controlHtml: fileRows(offer.files, total) })
        + P.row({ key: 'hash', label: jt('settings.models.share.checksum', 'Checksum (SHA-256)'), desc: jt('settings.models.share.checksumHelp', 'Jenny checks every part against it as it arrives.'), controlHtml: hashHtml(hash) })
        + P.row({ key: 'root', label: jt('settings.models.share.saveTo', 'Save to'), controlHtml: rootSelect }))
        + P.section(jt('settings.models.share.saysTitle', 'What {sender} says about it', { sender: sender }), null, saysRows(offer.provenance || {}, sender))
        + '<div class="mshare-notes">' + P.status({ tone: 'warning', message: jt('settings.models.share.warn', 'Only accept models from people you trust. A model file can carry hidden behaviour, and a damaged or crafted file can crash or attack the program that loads it. Jenny checks that the file arrives exactly as {sender} sent it, not that it is safe.', { sender: sender }) })
        + (hostSide ? '' : '<p data-mshare-part="relay">' + esc(W.relay(owner ? W.name(owner.display_name) : '')) + '</p>')
        + '<p>' + esc(jt('settings.models.share.noLoad', 'Nothing loads the model until you press Use.')) + '</p></div>';
      var buttons = rows.act(jt('settings.models.share.accept', 'Accept and download'), 'accept', {}, 'primary', jt('settings.models.share.acceptTip', 'Download it into the folder you picked'))
        + rows.act(jt('settings.models.share.decline', 'Decline'), 'accept-decline', {}, 'secondary', jt('settings.models.share.declineTip', 'Tell {sender} you do not want it', { sender: sender }))
        + rows.act(jt('settings.models.share.notNow', 'Not now'), 'accept-close', {}, 'ghost', jt('settings.models.share.notNowTip', 'Close; the offer stays in your Library'));
      var opened = openWith(dr, jt('settings.models.share.acceptTitle', '{sender} offers you a model', { sender: sender }), P.body(sections, buttons), d.anchor, onClick, onChange);
      if (!opened) return false;
      var busy = false;
      var token = opened.token;
      var host = opened.host;
      var q = function (selector) { return host.querySelector(selector); };
      refresh();
      return true;

      function picked() {
        var select = q('#modelShareRoot');
        return select ? roots.find(function (r) { return String(r.index) === select.value; }) || null : null;
      }
      // The Save to note, the Accept button and the footer line follow the root picked.
      function refresh() {
        var r = picked();
        var noteEl = q('[data-model-tuning-row="root"] [data-model-tuning-note]');
        var blocked = !r || r.fits !== true || r.exists === true || offer.state !== 'open';
        var path = r ? rows.clean(r.display_path, 260) : '';
        if (noteEl && r) {
          noteEl.textContent = r.exists === true ? jt('settings.models.share.alreadyThere', 'You already have {file} in {folder}. Jenny never overwrites a model. Pick another folder, or remove yours first.', { file: mainFile, folder: path })
            : r.fits !== true ? jt('settings.models.share.noRoom', 'Not enough room: this needs {need} and {drive} has {free} free. Pick another folder, or free some space.', { need: rows.size(total + SPARE_BYTES), drive: path, free: rows.size(r.free_bytes) })
              : jt('settings.models.share.needs', 'Needs {need}: the files, plus 1 GB to spare. It lands in {folder}.', { need: rows.size(total + SPARE_BYTES), folder: path });
          if (r.exists === true || r.fits !== true) noteEl.setAttribute('data-tone', 'warn'); else noteEl.removeAttribute('data-tone');
        }
        q('[data-mshare-action="accept"]').disabled = busy || blocked;
        q('[data-mshare-status]').textContent = offer.state !== 'open' ? jt('settings.models.share.offerClosed', 'This offer is no longer open.')
          : blocked && !busy ? jt('settings.models.share.pickFolder', 'Pick a folder this fits in to accept.') : '';
      }
      function onChange(event) { if (event.target.id === 'modelShareRoot') refresh(); }
      function onClick(event) {
        var button = event.target.closest('[data-mshare-action]');
        if (!button || button.disabled) return;
        var action = button.getAttribute('data-mshare-action');
        if (action === 'hash-toggle') toggleHash(host, hash);
        else if (action === 'accept-close') dr.close(token);
        else if (action === 'accept') send('modelAccept');
        else if (action === 'accept-decline') send('modelDecline');
      }
      function send(method) {
        var r = picked();
        var payload = { team_id: d.teamId, offer_id: offer.offer_id };
        if (method === 'modelAccept') {
          if (!r) return;
          payload.root_index = r.index;
        }
        busy = true;
        refresh();
        q('[data-mshare-status]').textContent = method === 'modelAccept' ? jt('settings.models.share.accepting', 'Asking {sender} for it…', { sender: sender }) : '';
        d.call(method, payload).then(function (result) {
          // The row's "arriving in" follows an accepted offer even when the drawer was closed meanwhile.
          if (result.ok && method === 'modelAccept') d.store.keepPath(offer.offer_id, String(r.display_path || ''));
          if (!dr.live(token)) return;
          busy = false;
          if (result.ok) { dr.close(token); return; }
          refresh();
          q('[data-mshare-status]').textContent = rows.reasonText(result.error && result.error.reason);
        });
      }
    });
  }

  /** deps: { documentRef, provenance, teamName, modelName, anchor }. Read-only; answers whether it opened. */
  function openAbout(deps) {
    var d = deps;
    var prov = d.provenance || {};
    var sender = W.name(prov.sender_name || jt('settings.models.share.someone', 'someone'));
    var files = Array.isArray(prov.files) ? prov.files : [];
    var total = files.reduce(function (sum, f) { return sum + (Number(f.size_bytes) || 0); }, 0);
    var hash = hashOf(files);
    var at = new Date(prov.received_at);
    var received = Number.isNaN(at.getTime()) ? '' : jt('settings.models.share.receivedOn', 'Received on {date} at {time}, through {team}.', {
      date: dateOf(at), time: timeOf(at), team: W.name(d.teamName) });
    var sections = P.section(jt('settings.models.share.flag', 'From {sender}', { sender: sender }), received || null,
      P.row({ key: 'files', label: jt('settings.models.share.filesTitle', 'Files'), controlHtml: fileRows(files, total) })
      + P.row({ key: 'hash', label: jt('settings.models.share.checksum', 'Checksum (SHA-256)'), desc: jt('settings.models.share.checksumDone', 'Jenny checked every part against it as it arrived.'), controlHtml: hashHtml(hash) }))
      + P.section(jt('settings.models.share.saidTitle', 'What {sender} said about it', { sender: sender }), null, saysRows(prov, sender))
      + '<div class="mshare-notes">' + P.status({ tone: 'warning', message: prov.checked === true
        ? jt('settings.models.share.checkedNotSafe', 'Jenny checked that the file arrived exactly as {sender} sent it, not that it is safe.', { sender: sender })
        : jt('settings.models.share.notChecked', 'Jenny has no record that this file was checked when it arrived.') }) + '</div>';
    var buttons = rows.act(jt('settings.models.share.close', 'Close'), 'about-close', {}, 'secondary', jt('settings.models.share.closeAboutTip', 'Close this'));
    var dr = drawerFor(d.documentRef);
    dr.begin(); // an Accept still reading its offer does not open over this one
    var opened = openWith(dr, jt('settings.models.share.aboutTitle', 'Where {model} came from', { model: rows.clean(d.modelName) }), P.body(sections, buttons), d.anchor, function (event) {
      var button = event.target.closest('[data-mshare-action]');
      if (!button || !opened) return;
      if (button.getAttribute('data-mshare-action') === 'hash-toggle') toggleHash(opened.host, hash);
      else if (button.getAttribute('data-mshare-action') === 'about-close') dr.close(opened.token);
    });
    return Boolean(opened);
  }

  return { openAccept: openAccept, openAbout: openAbout, close: function () { if (lastDoc) P.drawer(lastDoc, DRAWER_ID).cancel(); } };
});
