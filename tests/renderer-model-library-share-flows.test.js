'use strict';

// new-test-file: Settings › Models model sharing, its timing and boundary cases (row 123 slice 6-7, the fix round):
// late answers against the shared drawer, provenance answers against an open menu, focus across a repaint, several
// teams, hostile text in attributes, and the bounds. renderer-model-library-share.test.js (393 lines) would cross the
// line cap with them. Same harness: every bridge call is checked against main's real `validatePayload`.

const assert = require('node:assert/strict');
const test = require('node:test');

const { TEAM, OTHER, CARD, DISC, HASH, team, transfer, outgoing, incoming, take, stateAnswer, offerRead, RECEIVERS, openShare, flush, click } = require('./helpers/model-library-share-harness');

const SEND = 'Send to someone in your team…';
const IN1 = 'offer_IN1aaaaaaaaaaaaaaaaaaa';
const IN2 = 'offer_IN2aaaaaaaaaaaaaaaaaaa';
const sendItem = (s) => s.menuFor(CARD).find((i) => i.label === SEND);
const withState = (over) => ({ answers: { modelState: stateAnswer(over) } });
const frame = () => new Promise((resolve) => setTimeout(resolve, 40)); // a queued row repaints on the next frame
const later = () => { const list = []; const fn = (p) => new Promise((resolve) => list.push({ p, resolve })); fn.list = list; return fn; };
const PROV = { display_name: 'Qwen', sender_member_id: 'member_arjun', sender_name: 'Arjun', received_at: '2026-11-13T10:58:00.000Z', licence: '', source_url: null, note: '', checked: true,
  files: [{ name: 'Qwen3.8-27B-UD-Q6_K.gguf', size_bytes: 1, sha256: HASH }] };

// ------------------------------------------------------------------ M3: provenance answers

test('provenance: "not received" rebuilds nothing and is not asked again; a late "received" repaints its row and keeps an open menu', async (t) => {
  const asked = later();
  const s = await openShare(t, { answers: { modelProvenance: asked } });
  assert.equal(asked.list.length, 1);
  s.menuFor('installed:1b');
  const hides = s.hidden.count;
  const nodes = [...s.host().querySelectorAll('.mrow')];
  asked.list.shift().resolve({ ok: false, error: { code: 'CMP-TEAM-0011', reason: 'model_not_listed' } });
  await flush();
  await frame();
  assert.equal(s.hidden.count, hides, 'the open menu stays');
  assert.deepEqual([...s.host().querySelectorAll('.mrow')], nodes, 'no row rebuilt');
  // A reload (another model arrived) asks for that one only: the not-received answer is kept.
  s.push({ kind: 'received', tag: 'other.gguf', root_index: 0 });
  await flush(); await flush();
  assert.deepEqual(asked.list.map((x) => x.p.tag), ['other.gguf']);
  asked.list.shift().resolve({ ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_not_found' } });
  await flush();
  assert.equal(s.sent('modelProvenance').filter((p) => p.tag === DISC).length, 1, 'the row\'s tag asked once');

  const late = later();
  const r = await openShare(t, { answers: { modelProvenance: late } });
  r.menuFor('installed:1b');
  const shown = r.hidden.count;
  const other = r.row('installed:1b');
  late.list.shift().resolve({ ok: true, provenance: PROV });
  await flush();
  await frame();
  assert.equal(r.row(CARD).querySelector('.mrow-flag[title^="Sent"]').textContent, 'From Arjun', 'its row repainted');
  assert.equal(r.row('installed:1b'), other, 'the other rows kept');
  assert.equal(r.hidden.count, shown, 'the open menu stays');
});

// ------------------------------------------------------------------ S2: late answers and the shared drawer

const twoOffers = (answers = {}) => ({ answers: { modelState: stateAnswer({ incoming: [incoming(), incoming({ offer_id: IN2, display_name: 'Gemma 4B' })] }), ...answers } });
const reviewOf = (s, offerId) => s.row(':offer:' + offerId).querySelector('[data-mshare-action="review"]');

test('accept: an offer read that comes after another Review opened never replaces it', async (t) => {
  const reads = later();
  const s = await openShare(t, twoOffers({ modelOfferRead: reads }));
  click(s.h.windowRef, reviewOf(s, IN1));
  await flush();
  click(s.h.windowRef, reviewOf(s, IN2));
  await flush();
  assert.equal(reads.list.length, 2);
  reads.list[1].resolve(offerRead({ offer_id: IN2, display_name: 'Gemma 4B' }));
  await flush();
  const drawer = s.drawer('modelShareAcceptDrawer');
  assert.ok(s.text(drawer).includes('Gemma 4B'), 'B opened');
  reads.list[0].resolve(offerRead());
  await flush();
  assert.ok(s.text(drawer).includes('Gemma 4B'), 'B stays');
  assert.equal(s.text(drawer).includes('Bonsai 12B'), false, 'A never opened over it');
});

test('accept: an answer that comes after Not now and another Review neither closes nor writes into it; the path is kept only on ok', async (t) => {
  const accepts = later();
  const s = await openShare(t, twoOffers({ modelOfferRead: (p) => offerRead(p.offer_id === IN2 ? { offer_id: IN2, display_name: 'Gemma 4B' } : {}), modelAccept: accepts }));
  await s.clickAct('review', s.row(':offer:' + IN1));
  const drawer = s.drawer('modelShareAcceptDrawer');
  await s.clickAct('accept', drawer);
  await s.clickAct('accept-close', drawer);
  click(s.h.windowRef, reviewOf(s, IN2));
  await flush();
  assert.ok(s.text(drawer).includes('Gemma 4B'));
  assert.equal(s.store.pathOf(IN1), '', 'not kept before the answer');
  accepts.list[0].resolve({ ok: true });
  await flush();
  assert.equal(drawer.hidden, false, 'B stays open');
  assert.equal(drawer.querySelector('[data-mshare-status]').textContent, '', 'nothing written into B');
  assert.equal(s.store.pathOf(IN1), 'D:\\models', 'kept once accepted');
  // A refused accept keeps no path.
  await s.clickAct('accept', drawer);
  accepts.list[1].resolve({ ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_offer_gone' } });
  await flush();
  assert.equal(s.store.pathOf(IN2), '');
  assert.ok(drawer.querySelector('[data-mshare-status]').textContent.length > 5, 'the refusal said in its own drawer');
});

test('accept: no drawer opens after the page is gone, and Review answers one click', async (t) => {
  const reads = later();
  const s = await openShare(t, twoOffers({ modelOfferRead: reads }));
  const button = reviewOf(s, IN1);
  click(s.h.windowRef, button);
  click(s.h.windowRef, button);
  await flush();
  assert.equal(reads.list.length, 1, 'a double click reads once');
  assert.equal(button.disabled, true, 'greyed while it opens');
  s.h.controller.dispose();
  reads.list[0].resolve(offerRead());
  await flush();
  const drawer = s.drawer('modelShareAcceptDrawer');
  assert.ok(!drawer || drawer.hidden, 'nothing opened after dispose');
});

// ------------------------------------------------------------------ S3 and S4

test('Dismiss keeps the row and says why when main refuses; it goes on ok', async (t) => {
  const failed = incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'model_not_gguf' }) });
  const s = await openShare(t, { answers: { modelState: stateAnswer({ incoming: [failed] }), modelReceiveCancel: { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_not_connected' } } } });
  await s.clickAct('in-dismiss');
  await s.clickAct('ask-remove');
  assert.ok(s.rows().includes(':offer:' + IN1), 'the row stays');
  assert.ok(s.status().length > 10 && !/team_/.test(s.status()), 'the reason as a sentence');
  assert.equal(s.store.isDismissed(IN1), false);
});

test('focus on a share button survives a repaint of its row', async (t) => {
  const s = await openShare(t, withState({ outgoing: [outgoing({ transfers: [transfer()] })] }));
  s.act('send-pause', s.row(CARD)).focus();
  s.push({ kind: 'state', ...stateAnswer({ outgoing: [outgoing({ transfers: [transfer({ bytes_done: 700_000_000 })] })] }) });
  await flush();
  const active = s.h.document.activeElement;
  assert.equal(active.getAttribute('data-mshare-action'), 'send-pause');
  assert.equal(active.getAttribute('data-mshare-transfer'), 'mxfer_TX1aaaaaaaaaaaaaaaaaaa');
  assert.ok(s.row(CARD).contains(active));
});

// ------------------------------------------------------------------ S10: the send drawer's team switch

test('send drawer: another team greys Offer until its people are read; an answer for a team no longer picked is dropped', async (t) => {
  let hold = false;
  const held = [];
  const people = (name) => ({ ok: true, members: [{ member_id: 'member_' + name.toLowerCase(), display_name: name, role: 'member', can_receive: true }] });
  const s = await openShare(t, { teams: [team(TEAM), team(OTHER)], answers: { modelReceivers: (p) => (hold ? new Promise((resolve) => held.push({ p, resolve })) : RECEIVERS) } });
  await sendItem(s).action();
  const drawer = s.drawer('modelShareSendDrawer');
  const q = (sel) => drawer.querySelector(sel);
  const pick = (id) => { q('#modelShareTeam').value = id; q('#modelShareTeam').dispatchEvent(new s.h.windowRef.Event('change', { bubbles: true })); };
  assert.equal(s.act('send-offer', drawer).disabled, false);
  hold = true;
  pick(OTHER);
  assert.equal(s.act('send-offer', drawer).disabled, true, 'greyed while Dot lab is read');
  pick(TEAM);
  held[0].resolve(people('Late'));
  await flush();
  assert.equal(s.act('send-offer', drawer).disabled, true, 'Dot lab\'s answer came after Studio was picked again: dropped');
  assert.equal([...q('#modelSharePerson').options].some((o) => o.textContent === 'Late'), false);
  held[1].resolve(people('Nia'));
  await flush();
  assert.equal(s.act('send-offer', drawer).disabled, false);
  assert.deepEqual([...q('#modelSharePerson').options].map((o) => o.textContent), ['Nia']);
  await s.clickAct('send-offer', drawer);
  assert.deepEqual([s.sent('modelOffer')[0].team_id, s.sent('modelOffer')[0].member_id], [TEAM, 'member_nia']);
});

// ------------------------------------------------------------------ T1, T2: the read index and several teams

test('accept: the root index sent is the one the drawer read, not its position in the list', async (t) => {
  const s = await openShare(t, { answers: { modelState: stateAnswer({ incoming: [incoming()] }), modelOfferRead: offerRead({}, [
    { index: 0, display_path: 'C:\\small', free_bytes: 1, fits: false, exists: false }, { index: 5, display_path: 'E:\\big', free_bytes: 900_000_000_000, fits: true, exists: false }]) } });
  await s.clickAct('review');
  const drawer = s.drawer('modelShareAcceptDrawer');
  assert.equal(drawer.querySelector('#modelShareRoot').value, '5', 'the first that fits is picked');
  await s.clickAct('accept', drawer);
  assert.deepEqual(s.sent('modelAccept'), [{ team_id: TEAM, offer_id: IN1, root_index: 5 }]);
});

test('several teams: greyed only when no team qualifies, with the first team\'s reason; one team that qualifies needs no Team choice', async (t) => {
  const none = await openShare(t, { teams: [team(TEAM, { role: 'read_only' }), team(OTHER, { state: 'connecting' })] });
  const item = sendItem(none);
  assert.deepEqual([item.disabled, item.description], [true, 'Read-only members cannot send or receive models. The owner can change your role.']);
  const one = await openShare(t, { teams: [team(TEAM, { role: 'read_only' }), team(OTHER)] });
  assert.equal(sendItem(one).disabled, false);
  await sendItem(one).action();
  const drawer = one.drawer('modelShareSendDrawer');
  assert.equal(drawer.querySelector('#modelShareTeam'), null, 'one team qualifies: no Team choice');
  await one.clickAct('send-offer', drawer);
  assert.equal(one.sent('modelOffer')[0].team_id, OTHER);
});

test('several teams: a received model\'s flag names the team it came through', async (t) => {
  const s = await openShare(t, { teams: [team(TEAM), team(OTHER)], answers: { modelProvenance: (p) => (p.team_id === OTHER ? { ok: true, provenance: PROV }
    : { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_not_found' } }) } });
  await flush();
  await frame();
  assert.equal(s.row(CARD).querySelector('.mrow-flag[title^="Sent"]').title, 'Sent to you by Arjun through Dot lab. Jenny checked that it arrived as sent, not that it is safe.');
});

// ------------------------------------------------------------------ T3: hostile text in attributes and every drawer

test('hostile text: quotes stay inside attributes; the send drawer, the about drawer, the receivers, a team name and a folder path are text', async (t) => {
  const evil = 'x" onmouseover="alert(1)\' <b>b</b>\u202e\u200b';
  const check = (root) => {
    assert.equal(root.querySelector('b, img, script, [onmouseover]'), null, 'no markup or attribute from a member');
    assert.equal(/[\u202a-\u202e\u200b-\u200f\u2066-\u2069]/.test(root.textContent), false, 'no bidi or zero-width characters');
  };
  const s = await openShare(t, { teams: [team(TEAM, { team_name: evil }), team(OTHER, { team_name: evil })], answers: {
    modelState: stateAnswer({ incoming: [incoming({ display_name: evil, sender_name: evil, transfer: take() })] }),
    modelReceivers: { ok: true, members: [{ member_id: 'member_owner', display_name: evil, role: 'owner', can_receive: true }, { member_id: 'member_maya', display_name: evil, role: 'member', can_receive: true }] },
    modelProvenance: { ok: true, provenance: { ...PROV, sender_name: evil, note: evil, licence: evil } },
    modelOfferRead: offerRead({}, [{ index: 0, display_path: 'D:\\' + evil, free_bytes: 900_000_000_000, fits: true, exists: false }]),
  } });
  await flush();
  await frame();
  check(s.host());
  const nameEl = s.row(':offer:' + IN1).querySelector('.mrow-name');
  assert.equal(nameEl.getAttribute('title'), nameEl.textContent, 'the quote stayed inside the title');
  assert.ok(nameEl.textContent.startsWith('x" onmouseover="alert(1)\''));
  await sendItem(s).action();
  const send = s.drawer('modelShareSendDrawer');
  check(send);
  assert.ok([...send.querySelectorAll('#modelShareTeam option, #modelSharePerson option')].every((o) => !/[\u202e\u200b]/.test(o.textContent)), 'team and person names cleaned');
  await s.clickAct('send-close', send);
  const about = s.menuFor(CARD).find((i) => i.label === 'Where it came from…');
  await about.action();
  const drawer = s.drawer('modelShareAcceptDrawer');
  check(drawer);
  assert.ok(s.text(drawer).includes('through x" onmouseover'), 'the team name as text');
  s.store.keepPath(IN1, 'D:\\' + evil);
  s.push({ kind: 'state', ...stateAnswer({ incoming: [incoming({ state: 'taken', display_name: 'B', transfer: take() })] }) });
  await flush();
  const meta = s.row(':offer:' + IN1).querySelector('.mrow-meta');
  assert.ok(meta.textContent.includes('arriving in D:\\x" onmouseover'), 'the folder path as text');
  check(s.host());
});

// ------------------------------------------------------------------ T5, S7, T7: bounds, buttons, lines

test('send drawer: the note at its bound is sent; one past is refused in the footer and nothing is sent', async (t) => {
  for (const [length, sent] of [[1024, 1], [1025, 0]]) {
    const s = await openShare(t);
    await sendItem(s).action();
    const drawer = s.drawer('modelShareSendDrawer');
    drawer.querySelector('#modelShareNote').value = 'n'.repeat(length);
    await s.clickAct('send-offer', drawer);
    assert.equal(s.sent('modelOffer').length, sent, String(length));
    if (!sent) assert.equal(drawer.querySelector('[data-mshare-status]').textContent, 'The note can be at most 1024 characters.');
  }
});

test('the sender\'s Resume calls modelSendResume; the reading row draws how much has been read', async (t) => {
  const s = await openShare(t, withState({ outgoing: [outgoing({ transfers: [transfer({ state: 'paused', reason: 'paused_by_sender' })] })] }));
  await s.clickAct('send-resume');
  assert.deepEqual(s.sent('modelSendResume'), [{ team_id: TEAM, transfer_id: 'mxfer_TX1aaaaaaaaaaaaaaaaaaa' }]);
  const r = await openShare(t, withState({ outgoing: [outgoing({ state: 'reading', read_done: 250_000_000 })] }));
  const bar = r.row(CARD).querySelector('[data-mshare-progress="read:mreq_1"]');
  assert.equal(bar.getAttribute('aria-valuenow'), '25');
  assert.equal(bar.querySelector('.inv-progress-text').textContent, '238.4 MB of 953.7 MB');
});

test('incoming: the meta line without a kept path; the accept drawer has no relay sentence on the host\'s side', async (t) => {
  const s = await openShare(t, withState({ incoming: [incoming({ state: 'taken', transfer: take() })] }));
  assert.equal(s.row(':offer:' + IN1).querySelector('.mrow-meta').textContent, 'From Arjun · 2 files · 1.9 GB');
  const host = await openShare(t, { teams: [team(TEAM, { role: 'owner' })], answers: { modelState: stateAnswer({ incoming: [incoming()] }) } });
  await host.clickAct('review');
  const drawer = host.drawer('modelShareAcceptDrawer');
  assert.equal(drawer.querySelector('[data-mshare-part="relay"]'), null);
  assert.equal(host.text(drawer).includes('computer, which can read it'), false);
});

test('a bar id with a newline never throws, and a tiny rate never prints Infinity', async (t) => {
  const s = await openShare(t, withState({ outgoing: [outgoing({ transfers: [transfer()] })] }));
  const rows = require('../renderer/shell/model-library/model-library-share-rows');
  assert.equal(rows.patchProgress(s.host(), 'out:a\nb"]', { bytes_done: 1, bytes_total: 2, rate_bps: 0 }), false);
  for (const rate of [5e-324, 1e-9]) {
    s.push({ kind: 'progress', direction: 'send', transfer_id: 'mxfer_TX1aaaaaaaaaaaaaaaaaaa', offer_id: 'offer_OUT1aaaaaaaaaaaaaaaaaa', bytes_done: 1, bytes_total: 1_000_000_000, rate_bps: rate });
    await flush();
    const text = s.host().querySelector('[data-mshare-progress="out:mxfer_TX1aaaaaaaaaaaaaaaaaaa"] .inv-progress-text').textContent;
    assert.doesNotMatch(text, /Infinity|NaN/, String(rate));
    assert.doesNotMatch(text, /min left/, 'no time when it would take more than a day');
  }
});
