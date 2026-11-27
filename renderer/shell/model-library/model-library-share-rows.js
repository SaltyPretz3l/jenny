/* Settings › Models › model sharing inside the Library rows (row 123, slice 6-7; TEAM_MODEL_SHARING_SPEC "6-7 as built",
 * the owner's picks fork 2 A). Pure markup from the model store's rows (renderer/team/renderer-team-model-store.js):
 * the sender's state block under a model's meta line, the incoming rows under "From your team", the "From {sender}" flag
 * of a received model and its arrived line. Loaded with the team assets (the gate's list); the Library draws none of it
 * while this file is not loaded.
 *
 * Every name, file name and note here came from another member or the host: `clean` drops control, bidi and
 * zero-width characters and cuts it before `escapeHtml`. Sizes use the Library's formatter; a rate is MB a second
 * (1 MB = 1,000,000 bytes, one decimal) and minutes left come from the bytes left and the rate, nothing while it is 0.
 * Buttons carry `data-mshare-action` with the team and the offer, request or transfer id; the share section answers
 * them. A progress bar sits in `[data-mshare-progress="<in|out>:<id>"]` so a push patches only that bar (`patchProgress`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../renderer-settings-team-strings').modelWords);
    return;
  }
  root.modelLibraryShareRows = factory(root, root.rendererSettingsTeamStrings.modelWords);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, words) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count: count }, params || {})); };
  function lazy(name, path) { return root[name] || (typeof require === 'function' ? require(path) : null); }
  var escapeHtml = function (value) { return lazy('stringUtils', '../../shared/string-utils').escapeHtml(value); };
  function button(options) { return lazy('inventoryActionButton', '../../inventory/action-button')(options); }
  function progressBar(options) { return lazy('inventoryProgressBar', '../../inventory/progress-bar')(options); }

  // The text helpers are the team strings' `modelWords` (the Team tab and Settings, Team load only those).
  var clean = words.clean;
  var size = words.size;
  var filesText = words.filesText;
  var reasonText = words.reasonText;
  var count = function (value) { return Number.isFinite(value) && value > 0 ? value : 0; };

  // "{done} of {total} · {rate} MB/s · about {n} min left"; rate and minutes only while the rate is above 0.
  function progressText(t, checking) {
    var done = count(t.bytes_done);
    var total = count(t.bytes_total);
    if (checking) return jt('settings.models.share.checked', '{done} of {total} checked', { done: size(done), total: size(total) });
    var parts = [jt('settings.models.share.of', '{done} of {total}', { done: size(done), total: size(total) })];
    var rate = count(t.rate_bps);
    var minutes = rate > 0 ? Math.ceil((total - done) / rate / 60) : 0;
    if (rate > 0) {
      parts.push(jt('settings.models.share.rate', '{rate} MB/s', { rate: (rate / 1e6).toFixed(1) }));
      // A rate too small to finish in a day says no time at all, never "Infinity".
      if (total > done && Number.isFinite(minutes) && minutes <= 1440) parts.push(jt('settings.models.share.left', 'about {n} min left', { n: Math.max(1, minutes) }));
    }
    return parts.join(' · ');
  }
  function progressHtml(key, t, name, checking) {
    var total = count(t.bytes_total);
    var percent = total > 0 ? Math.min(100, Math.round((count(t.bytes_done) / total) * 1000) / 10) : 0;
    return progressBar({ value: percent, max: 100, label: jt('settings.models.share.progressFor', 'Progress for {model}', { model: name }),
      displayText: progressText(t, checking), warningThreshold: 2, dangerThreshold: 2, className: 'model-card-pull-progress' })
      .replace('<div class="inv-progress', '<div data-mshare-progress="' + escapeHtml(key) + '"' + (checking ? ' data-mshare-checking="true"' : '') + ' class="inv-progress');
  }
  // A push's new bytes on the bar already drawn: its width, value and text, nothing else. The bar is found by comparing
  // the attribute (an id from main is never built into a selector).
  function removeAsk(t) { return jt('settings.models.share.removeAsk', 'Remove the {size} received so far?', { size: size(count(t.bytes_done)) }); }
  function patchProgress(container, key, t) {
    var want = String(key);
    var bar = container ? Array.prototype.find.call(container.querySelectorAll('[data-mshare-progress]'), function (el) { return el.getAttribute('data-mshare-progress') === want; }) : null;
    if (!bar) return false;
    var total = count(t.bytes_total);
    var percent = total > 0 ? Math.min(100, Math.round((count(t.bytes_done) / total) * 1000) / 10) : 0;
    bar.style.setProperty('--progress', Math.round(percent) + '%');
    bar.setAttribute('aria-valuenow', String(percent));
    var text = bar.querySelector('.inv-progress-text');
    if (text) text.textContent = progressText(t, bar.getAttribute('data-mshare-checking') === 'true');
    return true;
  }

  // One button: label, its tooltip, the action and the ids it acts on.
  function act(label, action, ids, variant, title) {
    var dataset = { 'mshare-action': action };
    Object.keys(ids || {}).forEach(function (k) { if (ids[k] != null) dataset['mshare-' + k] = String(ids[k]); });
    return button({ label: label, title: title || label, variant: variant || 'secondary', size: 'sm', dataset: dataset });
  }
  function note(text, tone) {
    return '<span class="model-card-note"' + (tone ? ' data-tone="' + tone + '"' : '') + '>' + escapeHtml(text) + '</span>';
  }
  // The block: a line, then a progress bar with the buttons, or the line with the buttons.
  function block(o) {
    var acts = o.acts || '';
    var inner = o.progress
      ? (o.line ? note(o.line, o.tone) : '') + '<div class="model-card-pull-state">' + o.progress + acts + '</div>'
      : (o.line ? '<div class="model-card-pull-state">' + note(o.line, o.tone) + acts + '</div>' : '');
    return inner || o.people ? '<div class="mrow-share">' + inner + (o.people || '') + '</div>' : '';
  }

  // ------------------------------------------------------------------ the sender

  var QUEUED = function () { return jt('settings.models.share.queued', 'Waiting for a turn: the team moves only a few models at a time.'); };
  // One transfer of an outgoing offer: { line, tone, progress, acts } (who: the receiver's cleaned name).
  function sendView(row, t, ctx, who) {
    var ids = { team: ctx.teamId, transfer: t.transfer_id };
    var stop = act(jt('settings.models.share.stop', 'Stop'), 'send-stop', ids, 'danger', jt('settings.models.share.stopTip', 'Stop sending to {name}', { name: who }));
    var key = 'out:' + t.transfer_id;
    if (t.state === 'accepted' && t.queued) return { line: jt('settings.models.share.acceptedQueued', '{name} accepted. {queued}', { name: who, queued: QUEUED() }), short: jt('settings.models.share.personQueued', 'waiting for a turn'), acts: stop };
    if (t.state === 'accepted' || t.state === 'flowing') {
      return { line: jt('settings.models.share.sending', 'Sending to {name}.', { name: who }), progress: progressHtml(key, t, row.name, false),
        acts: act(jt('settings.models.share.pause', 'Pause'), 'send-pause', ids, 'secondary', jt('settings.models.share.pauseTip', 'Pause sending to {name}', { name: who })) + stop };
    }
    if (t.state === 'paused') {
      if (t.reason === 'paused_by_sender') {
        return { line: jt('settings.models.share.sendPaused', 'Paused. {name} keeps what has arrived.', { name: who }), tone: 'warn', short: jt('settings.models.share.personPaused', 'paused'),
          progress: progressHtml(key, t, row.name, false), acts: act(jt('settings.models.share.resume', 'Resume'), 'send-resume', ids, 'primary', jt('settings.models.share.resumeTip', 'Carry on sending to {name}', { name: who })) + stop };
      }
      if (t.reason === 'paused_by_receiver') return { line: jt('settings.models.share.theyPaused', '{name} paused it. It carries on when they resume.', { name: who }), tone: 'warn', short: jt('settings.models.share.personTheyPaused', 'they paused it'), progress: progressHtml(key, t, row.name, false), acts: stop };
      return { line: jt('settings.models.share.theyAway', '{name}’s Jenny is not answering. It carries on when they are back, for up to an hour.', { name: who }), tone: 'warn', short: jt('settings.models.share.personAway', 'not answering'), progress: progressHtml(key, t, row.name, false), acts: stop };
    }
    if (t.state === 'done') return { line: jt('settings.models.share.sent', '{name} has it, checked.', { name: who }), short: jt('settings.models.share.personDone', 'has it'), done: true };
    return { line: reasonText(t.reason), tone: 'danger', short: jt('settings.models.share.personEnded', 'stopped'), done: true };
  }

  // The state block for one outgoing offer, or '' when there is nothing to say (withdrawn by this member).
  // ctx: { teamId, teamName }.
  function outgoingBlock(row, ctx) {
    var name = clean(row.display_name || row.tag);
    var r = Object.assign({}, row, { name: name });
    var who = clean(row.member_name || jt('settings.models.share.someone', 'someone'));
    var team = clean(ctx.teamName);
    var ids = { team: ctx.teamId, request: row.request_id };
    var ok = act(jt('settings.models.share.ok', 'OK'), 'out-dismiss', ids, 'ghost', jt('settings.models.share.okTip', 'Hide this line'));
    var withdraw = function (label) { return act(label || jt('settings.models.share.withdraw', 'Withdraw'), 'withdraw', ids, 'secondary', jt('settings.models.share.withdrawTip', 'Withdraw this offer')); };
    var transfers = Array.isArray(row.transfers) ? row.transfers : [];
    if (row.state === 'reading' || row.state === 'offering') {
      // How much of the files has been read (`read_done`, bytes), on the transfers' bar.
      var read = { bytes_done: Math.min(count(row.read_done), count(row.total_bytes)), bytes_total: count(row.total_bytes), rate_bps: 0 };
      // Read, but the offer has not reached the host yet: say so, and the Cancel withdraws it.
      var sending = row.state === 'offering' && count(row.read_done) >= count(row.total_bytes);
      var line = sending
        ? (row.audience === 'team' ? jt('settings.models.share.offeringToTeam', 'Offering to everyone in {team}. Waiting to reach the host.', { team: team })
          : jt('settings.models.share.offeringTo', 'Offering to {name}. Waiting to reach {team}.', { name: who, team: team }))
        : (row.audience === 'team' ? jt('settings.models.share.readingTeam', 'Reading the file before offering it to everyone in {team}.', { team: team })
          : jt('settings.models.share.reading', 'Reading the file before offering it to {name}.', { name: who }));
      return block({ line: line,
        progress: read.bytes_total > 0 ? progressHtml('read:' + row.request_id, read, name, false) : '',
        acts: act(jt('settings.models.share.cancel', 'Cancel'), 'withdraw', ids, 'danger', sending ? jt('settings.models.share.withdrawTip', 'Withdraw this offer') : jt('settings.models.share.cancelOfferTip', 'Stop reading and offer nothing')) });
    }
    if (row.state === 'failed') {
      var failed = row.reason === 'model_source_changed' ? jt('settings.models.share.changed', 'This file changed while it was being sent, so sending stopped. Offer it again to send the new file.')
        : row.reason === 'team_model_offer_limit' ? jt('settings.models.share.offerLimit', 'You have 16 offers open, the most there can be. Withdraw one, then offer this again.') : reasonText(row.reason);
      return block({ line: failed, tone: 'danger', acts: ok });
    }
    if (row.audience === 'team') {
      if (row.state === 'ended' && row.reason === 'withdrawn') return '';
      var people = transfers.length ? '<ul class="mrow-share-people">' + transfers.map(function (t) {
        var person = clean(t.member_name || jt('settings.models.share.someone', 'someone'));
        var v = sendView(r, t, ctx, person);
        return '<li><span class="mrow-share-who" title="' + escapeHtml(person) + '">' + escapeHtml(person) + '</span>'
          + (v.progress && !v.done ? v.progress : note(v.short || v.line, v.tone)) + (v.done ? '' : v.acts || '') + '</li>';
      }).join('') + '</ul>' : '';
      if (row.state === 'ended') return block({ line: jt('settings.models.share.teamEnded', 'The offer to everyone in {team} ended.', { team: team }), acts: ok, people: people });
      return block({ line: transfers.length ? jt('settings.models.share.offeredTeamTaken', 'Offered to everyone in {team}.', { team: team })
        : jt('settings.models.share.offeredTeam', 'Offered to everyone in {team}. Nobody has taken it yet.', { team: team }),
        acts: withdraw(transfers.length ? jt('settings.models.share.withdrawOffer', 'Withdraw offer') : ''), people: people });
    }
    var t = transfers[0];
    if (t) {
      var v = sendView(r, t, ctx, who);
      return block({ line: v.line, tone: v.tone, progress: v.done ? '' : v.progress, acts: v.done ? ok : v.acts });
    }
    if (row.state === 'ended') {
      if (row.reason === 'withdrawn') return '';
      var ended = row.reason === 'declined' ? jt('settings.models.share.declined', '{name} declined.', { name: who })
        : row.reason === 'expired' ? jt('settings.models.share.expired', 'Nobody accepted the offer to {name} within 24 hours, so it ended.', { name: who }) : reasonText(row.reason);
      return block({ line: ended, tone: row.reason === 'declined' || row.reason === 'expired' ? '' : 'danger', acts: ok });
    }
    return block({ line: jt('settings.models.share.offeredOne', 'Offered to {name}. Waiting for them to accept. The offer ends after 24 hours with no answer.', { name: who }), acts: withdraw() });
  }

  // ------------------------------------------------------------------ a model on its way here

  // ctx: { teamId, teamName, hostName, online, path }. One Library-shaped row keyed `:offer:<id>`.
  function incomingRow(row, ctx) {
    var name = clean(row.display_name || jt('settings.models.share.aModel', 'A model'));
    var sender = clean(row.sender_name || jt('settings.models.share.someone', 'someone'));
    var team = clean(ctx.teamName);
    var host = clean(ctx.hostName || jt('settings.models.share.theHost', 'The host'));
    var t = row.transfer;
    var ids = { team: ctx.teamId, offer: row.offer_id };
    var key = 'in:' + row.offer_id;
    var cancel = act(jt('settings.models.share.cancel', 'Cancel'), 'receive-cancel', ids, 'danger', jt('settings.models.share.cancelInTip', 'Stop receiving {model} and remove what arrived', { model: name }));
    var dismiss = act(jt('settings.models.share.dismiss', 'Dismiss'), 'in-dismiss', ids, 'ghost', jt('settings.models.share.dismissTip', 'Remove this row and anything kept for it'));
    var retry = act(jt('settings.models.share.tryAgain', 'Try again'), 'receive-retry', ids, 'secondary', jt('settings.models.share.tryAgainTip', 'Ask {sender} for it again', { sender: sender }));
    var resume = function (action) { return act(jt('settings.models.share.resume', 'Resume'), action, ids, 'primary', jt('settings.models.share.resumeInTip', 'Carry on receiving {model}', { model: name })); };
    var bar = function (checking) { return progressHtml(key, t, name, checking); };
    var path = clean(ctx.path, 260);
    var meta = t ? (path ? jt('settings.models.share.metaArriving', 'From {sender} · {files} · arriving in {root}', { sender: sender, files: filesText(row.files, row.total_bytes), root: path })
      : jt('settings.models.share.metaFrom', 'From {sender} · {files}', { sender: sender, files: filesText(row.files, row.total_bytes) }))
      : jt('settings.models.share.metaOffer', '{sender} offers this · {files}', { sender: sender, files: filesText(row.files, row.total_bytes) });
    var o = {};
    var rowActs = '';
    if (!t) {
      rowActs = act(jt('settings.models.share.review', 'Review…'), 'review', ids, 'primary', jt('settings.models.share.reviewTip', 'See what is in it before anything downloads'))
        + act(jt('settings.models.share.decline', 'Decline'), 'decline', ids, 'ghost', jt('settings.models.share.declineTip', 'Tell {sender} you do not want it', { sender: sender }));
    } else if (t.state === 'failed') {
      var failed = {
        model_hash_mismatch: [jt('settings.models.share.failedHash', 'It did not arrive as {sender} sent it, after three tries. Nothing was kept.', { sender: sender }), true],
        model_not_gguf: [jt('settings.models.share.failedNotGguf', 'This is not a model file Jenny can use, so it was not added. Nothing was kept.'), false],
        model_exists: [jt('settings.models.share.failedExists', 'A file with the same name appeared in {folder} while this arrived. Nothing was overwritten, and what arrived was removed.', { folder: path || jt('settings.models.share.thatFolder', 'that folder') }), false],
        model_staging_failed: [jt('settings.models.share.failedWrite', 'Jenny could not write to {root}. Check the folder, then try again.', { root: path || jt('settings.models.share.thatFolder', 'that folder') }), true],
        cancelled_by_sender: [jt('settings.models.share.failedStopped', '{sender} stopped sending. Dismiss removes what had arrived.', { sender: sender }), false],
        withdrawn: [jt('settings.models.share.failedStopped', '{sender} stopped sending. Dismiss removes what had arrived.', { sender: sender }), false],
        // The offer ended without the sender choosing to (services/team/model-incoming.js OFFER_ENDS).
        expired: [jt('settings.models.share.endedExpired', 'The offer from {sender} ran out before this finished. Dismiss removes what had arrived.', { sender: sender }), false],
        member_gone: [jt('settings.models.share.endedGone', '{sender} is no longer in the team, so this stopped. Dismiss removes what had arrived.', { sender: sender }), false],
        role_changed: [jt('settings.models.share.endedRole', '{sender} can no longer share models, so this stopped. Dismiss removes what had arrived.', { sender: sender }), false],
        sender_offline: [jt('settings.models.share.endedOffline', '{sender} went offline and the offer ended. Dismiss removes what had arrived.', { sender: sender }), false],
        sharing_off: [jt('settings.models.share.endedSharingOff', 'Model sharing was turned off, so this stopped. Dismiss removes what had arrived.'), false],
        host_stopping: [jt('settings.models.share.endedHost', 'The team’s server stopped, so the offer ended. Dismiss removes what had arrived.'), false],
      }[t.reason] || [reasonText(t.reason), true];
      o = { line: failed[0], tone: 'danger', acts: (failed[1] ? retry : '') + dismiss };
    } else if (t.queued) {
      o = { line: QUEUED(), acts: cancel };
    } else if (t.state === 'verifying' || t.state === 'placing') {
      o = { line: jt('settings.models.share.checking', 'All of it has arrived. Checking the whole file before it joins your library.'), progress: bar(true), acts: cancel };
    } else if (t.state === 'paused' || t.state === 'interrupted') {
      var action = t.state === 'paused' ? 'receive-resume' : 'receive-retry';
      if (!ctx.online) o = { line: jt('settings.models.share.hostAway', 'Not connected to {team}. What has arrived is kept and carries on when you are connected.', { team: team }), tone: 'warn', acts: cancel };
      else if (t.reason === 'model_no_space') o = { line: jt('settings.models.share.noSpace', 'Paused: {drive} is nearly full. This needs {size} more. Free some space, then resume.', { drive: path || jt('settings.models.share.theDisk', 'the disk'), size: size(count(t.bytes_total) - count(t.bytes_done)) }), tone: 'danger', acts: resume(action) + cancel };
      else if (t.reason === 'sharing_off' || t.reason === 'team_model_sharing_off') o = { line: jt('settings.models.share.sharingOff', '{host} turned model sharing off, so this stopped. What has arrived is kept for 7 days.', { host: host }), tone: 'warn', acts: cancel };
      else if (t.reason === 'paused_by_sender') o = { line: jt('settings.models.share.senderPaused', '{sender} paused it. What has arrived is kept.', { sender: sender }), tone: 'warn', acts: cancel };
      else if (t.reason === 'sender_offline' || t.reason === 'team_model_sender_offline') o = { line: jt('settings.models.share.senderAway', '{sender}’s Jenny is not answering. What has arrived is kept for 7 days and carries on when they are back.', { sender: sender }), tone: 'warn', acts: cancel };
      else o = { line: jt('settings.models.share.paused', 'Paused. What has arrived is kept.'), tone: 'warn', acts: resume(action) + cancel };
      o.progress = bar(false);
    } else {
      o = { progress: bar(false), acts: act(jt('settings.models.share.pause', 'Pause'), 'receive-pause', ids, 'secondary', jt('settings.models.share.pauseInTip', 'Pause receiving {model}', { model: name })) + cancel };
    }
    if (ctx.asking && t && count(t.bytes_done) > 0) { // C22: the question in place of the buttons, the bar kept
      o = { line: removeAsk(t), tone: 'warn', progress: o.progress,
        acts: act(jt('settings.models.share.removeYes', 'Remove'), 'ask-remove', ids, 'danger', jt('settings.models.share.removeYesTip', 'Remove {model} and the {size} received', { model: name, size: size(count(t.bytes_done)) }))
          + act(t.state === 'failed' ? jt('settings.models.share.keep', 'Keep') : jt('settings.models.share.keepDownloading', 'Keep downloading'), 'ask-keep', ids, 'secondary', jt('settings.models.share.keepTip', 'Keep what has arrived')) };
    }
    var html = '<div class="mrow" data-model-key=":offer:' + escapeHtml(row.offer_id) + '" data-active="false" data-pending="false" data-load-failed="false">'
      + '<div class="mrow-main"><div class="mrow-title"><span class="mrow-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span></div>'
      + '<div class="mrow-meta">' + escapeHtml(meta) + '</div>' + block(o) + '</div>'
      + '<div class="mrow-fit"><span class="mrow-fit-num mrow-fit-num--text mrow-fit-num--none" title="' + escapeHtml(jt('settings.models.library.fitUnknownTip', 'Jenny has not measured this file yet')) + '">—</span></div>'
      + '<div class="mrow-actions">' + rowActs + '</div></div>';
    return { key: ':offer:' + row.offer_id, html: html };
  }

  // Whether an incoming offer has a row: open, or taken here (a transfer, even after its offer ended), and not dismissed.
  function showsIncoming(row) {
    return Boolean(row.transfer) || row.state === 'open';
  }

  function separator(key, text) { return { key: key, html: '<div class="mrow-sep" data-item="sep">' + escapeHtml(text) + '</div>' }; }
  function fromTeamSeparator() { return separator(':share-from', jt('settings.models.share.fromTeam', 'From your team')); }
  function onThisPcSeparator() { return separator(':share-here', jt('settings.models.share.onThisPc', 'On this PC')); }

  // ------------------------------------------------------------------ a received model

  function receivedFlag(provenance, teamName) {
    var sender = clean(provenance && provenance.sender_name || jt('settings.models.share.someone', 'someone'));
    return '<span class="mrow-flag" title="' + escapeHtml(jt('settings.models.share.flagTip', 'Sent to you by {sender} through {team}. Jenny checked that it arrived as sent, not that it is safe.', { sender: sender, team: clean(teamName) })) + '">'
      + escapeHtml(jt('settings.models.share.flag', 'From {sender}', { sender: sender })) + '</span>';
  }
  function arrivedBlock(provenance, tag) {
    var sender = clean(provenance && provenance.sender_name || jt('settings.models.share.someone', 'someone'));
    return block({ line: jt('settings.models.share.arrived', 'Arrived and checked: it is the file {sender} sent. Nothing loads the model until you press Use.', { sender: sender }),
      acts: act(jt('settings.models.share.ok', 'OK'), 'arrived-ok', { tag: tag }, 'ghost', jt('settings.models.share.okTip', 'Hide this line')) });
  }

  // ------------------------------------------------------------------ the drawers' parts (the Tune drawer's grammar)

  // One drawer per document and id (its host element keeps the id), shared by the openings that use that id. `open`
  // answers a token for this opening (0 when it did not open) after the previous opening's clean-up ran; `live(token)`
  // is true while that opening is still the one shown, so a late answer never writes into, or closes, a later drawer.
  // `cancel()` also stops openings still waiting for their read (a later `begin()` token is no longer current).
  var drawers = {};
  function sharedDrawer(doc, id) {
    var entry = drawers[id];
    if (!entry || entry.doc !== doc) {
      entry = { doc: doc, token: 0, shown: 0, asked: 0, cleanup: null, drawer: null };
      entry.drawer = lazy('inventoryDrawer', '../../inventory/drawer').createDrawer({ documentRef: doc, id: id,
        onClose: function () { var fn = entry.cleanup; entry.cleanup = null; entry.shown = 0; if (fn) fn(); } });
      drawers[id] = entry;
    }
    return {
      begin: function () { entry.asked += 1; return entry.asked; },
      current: function (asked) { return asked === entry.asked; },
      open: function (o) {
        if (!entry.drawer.open({ title: o.title, bodyHtml: o.bodyHtml, restoreFocusTo: o.restoreFocusTo })) return 0;
        entry.token += 1;
        entry.shown = entry.token;
        entry.cleanup = o.cleanup || null;
        return entry.shown;
      },
      live: function (token) { return token > 0 && token === entry.shown; },
      host: function () { return doc.getElementById(id); },
      close: function (token) { if (token === undefined || token === entry.shown) entry.drawer.close(); },
      cancel: function () { entry.asked += 1; entry.drawer.close(); },
    };
  }

  var parts = {
    row: function (o) { return lazy('rendererModelTuningRows', '../renderer-model-tuning-rows').rowHtml(Object.assign({ escapeHtml: escapeHtml, wide: true }, o)); },
    section: function (title, status, body) { return lazy('rendererModelTuningRows', '../renderer-model-tuning-rows').sectionHtml(escapeHtml, title, status, body); },
    select: function (o) { return lazy('inventorySelectField', '../../inventory/select-field')(o); },
    text: function (o) { return lazy('inventoryTextField', '../../inventory/text-field')(o); },
    checkbox: function (o) { return lazy('inventoryCheckbox', '../../inventory/checkbox').checkbox(o); },
    segmented: function () { return lazy('inventorySegmentedControl', '../../inventory/segmented-control'); },
    status: function (o) { return lazy('inventoryStatusRow', '../../inventory/status-row')(o); },
    drawer: sharedDrawer,
    // The body: the sections in the Tune drawer's scroll and grid, then its footer with a status line and the buttons.
    body: function (sections, buttons) {
      return '<div class="model-tuning-drawer-scroll"><div class="model-tuning-drawer-grid">' + sections + '</div>'
        + '<div class="model-tuning-drawer-footer"><p class="model-tuning-drawer-status" data-mshare-status aria-live="polite"></p>'
        + '<div class="model-tuning-drawer-actions">' + buttons + '</div></div></div>';
    },
    value: function (text, quote) {
      return '<p class="mshare-value' + (quote ? ' mshare-value--quote' : '') + '" dir="auto">' + escapeHtml(text) + '</p>';
    },
    escapeHtml: escapeHtml,
  };

  return {
    parts: parts, words: words, clean: clean, cleanBlock: words.cleanBlock, size: size, filesText: filesText, patchProgress: patchProgress, removeAsk: removeAsk, act: act,
    reasonText: reasonText, outgoingBlock: outgoingBlock, incomingRow: incomingRow, showsIncoming: showsIncoming,
    fromTeamSeparator: fromTeamSeparator, onThisPcSeparator: onThisPcSeparator, receivedFlag: receivedFlag, arrivedBlock: arrivedBlock,
  };
});
