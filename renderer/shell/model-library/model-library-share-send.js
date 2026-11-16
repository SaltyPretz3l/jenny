/* Settings › Models › the send drawer (row 123, slice 6-7; the owner's picks, "The send drawer"). Opened by the ⋯ item
 * "Send to someone in your team…": who gets it (one person or the whole team; a Team choice first when more than one
 * team qualifies), the files (the model always, its drafter and vision files to tick), what the sender tells them (name,
 * licence, where it is from, a note) and `modelOffer`. Built once per opening: a push never redraws it, so what is typed
 * stays; a change of team, person or tick patches only its own part. Loaded with the team assets.
 *
 * Reads `modelFiles` (the files and the provenance read from the main file's header, cleaned before it is shown) and
 * `modelReceivers` for the chosen team. Picking another team greys Offer until that team's people are read; an answer
 * for a team no longer picked is dropped. The relay sentence is left out when this member hosts the team or the
 * person picked does. Answers: the drawer closes on `{ ok }`; a refusal is said in its footer. An answer that comes
 * after this opening was closed or replaced writes nothing (the shared drawer's token). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./model-library-share-rows'));
    return;
  }
  root.modelLibraryShareSend = factory(root, root.modelLibraryShareRows);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, rows) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var P = rows.parts;
  var W = rows.words;
  var esc = P.escapeHtml;
  var DRAWER_ID = 'modelShareSendDrawer';
  // The payload's own bounds (services/team/model-ipc.js; TEAM_MODEL_SHARING_SPEC "6-5 as built").
  var MAX = { name: 128, licence: 4096, source: 512, note: 1024, files: 8 };
  var lastDoc = null;

  function whatFile(file, index) {
    if (file.kind === 'drafter') return jt('settings.models.share.fileDrafter', 'Its drafter, for multi-token prediction.');
    if (file.kind === 'vision') return jt('settings.models.share.fileVision', 'Its vision file, which lets the model read images.');
    return index === 0 ? jt('settings.models.share.fileModel', 'The model. Always sent.') : jt('settings.models.share.filePart', 'A part of the model. Always sent.');
  }
  // The person choice: who can receive, and each who cannot, greyed with why.
  function personOptions(members) {
    var options = (members || []).filter(function (m) { return m && typeof m.member_id === 'string'; }).slice(0, 8).map(function (m) {
      var name = W.name(m.display_name || m.member_id);
      if (m.can_receive === true) return { value: m.member_id, label: m.role === 'owner' ? jt('settings.models.share.personOwner', '{name} (owner)', { name: name }) : name };
      return { value: m.member_id, disabled: true, label: m.role === 'read_only' ? jt('settings.models.share.personReadOnly', '{name} · read-only, cannot receive', { name: name })
        : jt('settings.models.share.personCannot', '{name} · cannot receive', { name: name }) };
    });
    return options.some(function (o) { return !o.disabled; }) ? options
      : [{ value: '', disabled: true, label: jt('settings.models.share.nobody', 'Nobody else in this team can receive models yet.') }].concat(options);
  }
  // The Person row (built again, through the inventory select, when another team is picked).
  function personRow(members) {
    var people = personOptions(members);
    var first = people.find(function (o) { return !o.disabled; });
    return P.row({ key: 'person', label: jt('settings.models.share.person', 'Person'),
      desc: jt('settings.models.share.personHelp', 'They choose whether to take it. The offer ends after 24 hours with no answer.'),
      controlHtml: P.select({ id: 'modelSharePerson', ariaLabel: jt('settings.models.share.person', 'Person'), value: first ? first.value : '', options: people }) });
  }

  /**
   * deps: { documentRef, call(method, payload), teams: [{ team_id, team_name, role }] (those this member can send in),
   *   ownerOf(teamId) -> { member_id, display_name } | null, tag, modelName, anchor, onRefused(text) }
   * Answers a promise of whether the drawer opened.
   */
  function openSend(deps) {
    var d = deps;
    var doc = d.documentRef;
    var teams = d.teams.slice(0, 4);
    var state = { teamId: teams[0].team_id, to: 'one', members: [], busy: false, reading: false };
    var dr = P.drawer(doc, DRAWER_ID);
    lastDoc = doc;
    var asked = dr.begin();
    var token = 0;
    var host = null;
    var bound = null;
    var team = function () { return teams.find(function (t) { return t.team_id === state.teamId; }) || teams[0]; };
    var q = function (selector) { return host ? host.querySelector(selector) : null; };

    function readReceivers(teamId) {
      return d.call('modelReceivers', { team_id: teamId }).then(function (answer) { return answer.ok && Array.isArray(answer.members) ? answer.members : []; });
    }

    return Promise.all([d.call('modelFiles', { team_id: state.teamId, tag: d.tag }), readReceivers(state.teamId)]).then(function (answers) {
      if (!dr.current(asked)) return false; // closed, disposed or opened again meanwhile
      var filesAnswer = answers[0];
      if (!filesAnswer.ok || !Array.isArray(filesAnswer.files) || !filesAnswer.files.length) {
        d.onRefused(rows.reasonText(filesAnswer.ok ? 'model_not_listed' : filesAnswer.error && filesAnswer.error.reason));
        return false;
      }
      state.members = answers[1];
      var files = filesAnswer.files.slice(0, MAX.files);
      var prov = filesAnswer.provenance || {};
      var name = W.clean(prov.name || d.modelName, MAX.name, true);
      var who = P.row({ key: 'to', label: jt('settings.models.share.sendTo', 'Send to'), controlHtml: P.segmented()({ id: 'modelShareTo', ariaLabel: jt('settings.models.share.sendTo', 'Send to'), value: 'one',
        options: [{ value: 'one', label: jt('settings.models.share.onePerson', 'One person') }, { value: 'team', label: jt('settings.models.share.wholeTeam', 'The whole team') }] }) })
        + '<div data-mshare-part="person">' + personRow(state.members) + '</div>'
        + '<p class="model-tuning-row-desc" data-mshare-part="team" hidden>' + esc(jt('settings.models.share.teamHelp', 'Everyone who can receive sees the offer and chooses for themselves. You see who takes it and can stop any of them. The offer stands while Jenny is running, until you withdraw it. You and full members can send and receive. Read-only members cannot.')) + '</p>';
      if (teams.length > 1) {
        who = P.row({ key: 'team', label: jt('settings.models.share.team', 'Team'), controlHtml: P.select({ id: 'modelShareTeam', ariaLabel: jt('settings.models.share.team', 'Team'), value: state.teamId,
          options: teams.map(function (t) { return { value: t.team_id, label: W.name(t.team_name || t.team_id) }; }) }) }) + who;
      }
      var fileList = '<ul class="mshare-files">' + files.map(function (file, i) {
        var label = W.clean(file.name, 200);
        var box = P.checkbox({ id: 'modelShareFile' + i, label: label, checked: file.required === true || file.kind === 'drafter', disabled: file.required === true, dataset: { 'mshare-file': String(i) } });
        return '<li>' + box + '<span class="mshare-file-size">' + esc(W.size(file.size_bytes)) + '</span><span class="mshare-file-what">' + esc(whatFile(file, i)) + '</span></li>';
      }).join('') + '</ul><p class="mshare-total" data-mshare-total></p>';
      var tell = P.row({ key: 'name', label: jt('settings.models.share.name', 'Name'), controlHtml: P.text({ id: 'modelShareName', ariaLabel: jt('settings.models.share.name', 'Name'), value: name, maxLength: MAX.name }) })
        + P.row({ key: 'licence', label: jt('settings.models.share.licence', 'Licence'), note: jt('settings.models.share.readFromFile', 'Read from the file. Correct it if you know better.'),
          controlHtml: P.text({ id: 'modelShareLicence', ariaLabel: jt('settings.models.share.licence', 'Licence'), value: W.cleanBlock(prov.licence, MAX.licence, true), multiline: true, rows: 2, maxLength: MAX.licence }) })
        + P.row({ key: 'source', label: jt('settings.models.share.source', 'Where it is from'), note: jt('settings.models.share.sourceNote', 'Read from the file. An https address, or leave it empty.'),
          controlHtml: P.text({ id: 'modelShareSource', ariaLabel: jt('settings.models.share.source', 'Where it is from'), value: W.clean(prov.source_url, MAX.source, true), placeholder: jt('settings.models.share.sourcePlaceholder', 'https://'), maxLength: MAX.source }) })
        + P.row({ key: 'note', label: jt('settings.models.share.note', 'Note'), controlHtml: P.text({ id: 'modelShareNote', ariaLabel: jt('settings.models.share.note', 'Note'), multiline: true, rows: 2,
          placeholder: jt('settings.models.share.notePlaceholder', 'Anything they should know'), maxLength: MAX.note }) });
      var sections = P.section(jt('settings.models.share.whoGetsIt', 'Who gets it'), null, who)
        + P.section(jt('settings.models.share.filesTitle', 'Files'), jt('settings.models.share.filesHelp', 'The model and the files that sit beside it.'), fileList)
        + P.section(jt('settings.models.share.tellTitle', 'What you tell them'), jt('settings.models.share.tellHelp', 'They see this before they accept, marked as your words, not checked by Jenny.'), tell)
        + '<div class="mshare-notes"><p data-mshare-part="relay"></p><p>' + esc(jt('settings.models.share.readNote', 'Jenny reads the whole file once before it offers it, which can take a few minutes. Both of you need Jenny open while it sends; it carries on where it stopped if either of you closes it.')) + '</p></div>';
      var buttons = rows.act(jt('settings.models.share.offer', 'Offer'), 'send-offer', {}, 'primary', jt('settings.models.share.offerTip', 'Read the files and offer them'))
        + rows.act(jt('settings.models.share.cancel', 'Cancel'), 'send-close', {}, 'secondary', jt('settings.models.share.closeTip', 'Close without offering'));
      token = dr.open({ title: jt('settings.models.share.sendTitle', 'Send {model}', { model: W.clean(d.modelName) }), bodyHtml: P.body(sections, buttons), restoreFocusTo: d.anchor, cleanup: unbind });
      if (!token) return false;
      host = dr.host();
      bound = { click: onClick, change: onChange, segmented: onSegmented };
      host.querySelector('.inv-drawer-panel').classList.add('mshare-drawer');
      if (!doc.__invSegmentedHandlersInstalled && typeof P.segmented().initSegmentedHandlers === 'function') P.segmented().initSegmentedHandlers(host);
      host.addEventListener('click', onClick);
      host.addEventListener('change', onChange);
      host.addEventListener('inv-segmented-change', onSegmented);
      refresh();
      return true;

      function picked() {
        return files.filter(function (_file, i) { var box = q('#modelShareFile' + i); return box && box.checked; });
      }
      // The parts that follow the choices: the total, the Offer label, the person row or the team sentence, the relay sentence.
      function refresh() {
        var chosen = picked();
        q('[data-mshare-total]').textContent = W.filesText(chosen.length, chosen.reduce(function (sum, f) { return sum + (Number(f.size_bytes) || 0); }, 0));
        q('[data-mshare-part="person"]').hidden = state.to !== 'one';
        q('[data-mshare-part="team"]').hidden = state.to !== 'team';
        var select = q('#modelSharePerson');
        var member = state.reading ? null : state.members.find(function (m) { return m.member_id === select.value; });
        var offer = q('[data-mshare-action="send-offer"]');
        offer.textContent = state.to === 'team' ? jt('settings.models.share.offerTeam', 'Offer to the team')
          : jt('settings.models.share.offerOne', 'Offer to {name}', { name: W.name(member ? member.display_name : '') });
        offer.disabled = state.busy || state.reading || (state.to === 'one' && !member);
        var owner = d.ownerOf(state.teamId);
        var hostSide = team().role === 'owner' || (state.to === 'one' && member && member.role === 'owner');
        var relay = q('[data-mshare-part="relay"]');
        relay.hidden = hostSide;
        relay.textContent = hostSide ? '' : W.relay(owner ? W.name(owner.display_name) : '');
      }
      function say(text) { q('[data-mshare-status]').textContent = text; }
      function onSegmented(event) {
        if (!event.detail || event.detail.id !== 'modelShareTo') return;
        state.to = event.detail.value === 'team' ? 'team' : 'one';
        refresh();
      }
      function onChange(event) {
        var target = event.target;
        if (target.id === 'modelShareTeam') {
          state.teamId = target.value;
          state.reading = true;
          refresh();
          var teamAsked = state.teamId;
          readReceivers(teamAsked).then(function (members) {
            if (!dr.live(token) || teamAsked !== state.teamId) return; // a later pick or a closed drawer
            state.members = members;
            state.reading = false;
            q('[data-mshare-part="person"]').innerHTML = personRow(members);
            refresh();
          });
        }
        if (target.id === 'modelSharePerson' || target.hasAttribute('data-mshare-file')) refresh();
      }
      function onClick(event) {
        var button = event.target.closest('[data-mshare-action]');
        if (!button) return;
        var action = button.getAttribute('data-mshare-action');
        if (action === 'send-close') dr.close(token);
        else if (action === 'send-offer') offer();
      }
      function offer() {
        var display = q('#modelShareName').value.trim();
        var source = q('#modelShareSource').value.trim();
        var licence = q('#modelShareLicence').value.replace(/\r/g, '').trim();
        var noteText = q('#modelShareNote').value.replace(/\r/g, '').trim();
        if (!display) { say(jt('settings.models.share.nameNeeded', 'Give the model a name.')); return; }
        if (source && !/^https:\/\/\S+$/i.test(source)) { say(jt('settings.models.share.sourceInvalid', 'Where it is from must be an https address, or empty.')); return; }
        if (noteText.length > MAX.note) { say(jt('settings.models.share.noteLong', 'The note can be at most {n} characters.', { n: MAX.note })); return; }
        var payload = { team_id: state.teamId, tag: d.tag, files: picked().map(function (f) { return f.name; }), display_name: display };
        if (state.to === 'one') payload.member_id = q('#modelSharePerson').value;
        if (licence) payload.licence = licence;
        if (source) payload.source_url = source;
        if (noteText) payload.note = noteText;
        state.busy = true;
        refresh();
        say(jt('settings.models.share.offering', 'Offering…'));
        d.call('modelOffer', payload).then(function (answer) {
          if (!dr.live(token)) return;
          state.busy = false;
          if (answer.ok) { dr.close(token); return; }
          say(rows.reasonText(answer.error && answer.error.reason));
          refresh();
        });
      }
    });

    function unbind() {
      if (host && bound) {
        host.removeEventListener('click', bound.click);
        host.removeEventListener('change', bound.change);
        host.removeEventListener('inv-segmented-change', bound.segmented);
      }
      host = null;
      bound = null;
    }
  }

  return { openSend: openSend, close: function () { if (lastDoc) P.drawer(lastDoc, DRAWER_ID).cancel(); } };
});
