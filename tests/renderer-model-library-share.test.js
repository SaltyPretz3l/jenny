'use strict';

// new-test-file: Settings › Models model sharing (row 123 slice 6-7: the ⋯ item, the send, accept and "Where it came
// from" drawers, the sender's and the incoming rows) is a new surface in four new modules; the section test file is at
// 764 lines. Every bridge call is checked against main's real `validatePayload` (tests/helpers/model-library-share-harness.js).

const assert = require('node:assert/strict');
const test = require('node:test');

const { TEAM, OTHER, CARD, DISC, HASH, team, transfer, outgoing, incoming, take, stateAnswer, offerRead, FILES, openShare, flush, click } = require('./helpers/model-library-share-harness');

const SEND = 'Send to someone in your team…';
const sendItem = (s, key = CARD) => s.menuFor(key).find((i) => i.label === SEND);
const withState = (over) => ({ answers: { modelState: stateAnswer(over) } });

// ------------------------------------------------------------------ 2. the ⋯ item

test('the ⋯ item: enabled for a sendable GGUF row, greyed with its reason everywhere else', async (t) => {
  const ok = await openShare(t);
  assert.deepEqual(ok.menuFor(CARD).map((i) => (i.separator ? '---' : i.label)), ['Set as default', '---', SEND, 'Remove from library', 'Copy tag'], 'Set as default first; no Where it came from… on a model not received');
  assert.equal(sendItem(ok).disabled, false);
  const ollama = sendItem(ok, 'installed:1b');
  assert.deepEqual([ollama.disabled, ollama.description], [true, 'Only GGUF files in your model folders can be sent. This one is Ollama’s copy.']);
  const cases = [
    ['read-only', { teams: [team(TEAM, { role: 'read_only' })] }, 'Read-only members cannot send or receive models. The owner can change your role.'],
    ['sharing off', withState({ sharing: 'off', sharing_reason: 'team_model_sharing_off' }), 'Brendan has turned model sharing off for this team.'],
    ['kill switch', { answers: { modelState: { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_sharing_off' } } } },
      'Turned off when Jenny started (JENNY_ENABLE_TEAM_MODEL_SHARING=0). Remove that setting and restart Jenny to use model sharing.'],
    ['not connected', { teams: [team(TEAM, { state: 'connecting' })] }, 'Not connected to Studio.'],
    ['no team', { teams: [] }, 'Join or host a team to send models.'],
    ['no team assets', { withShare: false }, 'Join or host a team to send models.'],
    ['not sendable', { answers: { modelSendable: { ok: true, models: [{ tag: DISC, name: DISC, size_bytes: 1, sendable: false, reason: 'model_ollama_copy' }] } } }, null],
  ];
  for (const [name, options, sentence] of cases) {
    const s = await openShare(t, options);
    const item = sendItem(s);
    assert.equal(item.disabled, true, name);
    if (sentence) assert.equal(item.description, sentence, name);
    else assert.ok(item.description.length > 10, name);
  }
});

test('Where it came from… only on a received model, and its drawer says who, when, through which team', async (t) => {
  const prov = { display_name: 'Qwen', sender_member_id: 'member_arjun', sender_name: 'Arjun', received_at: '2026-11-13T10:58:00.000Z', licence: 'apache-2.0',
    source_url: 'https://example.invalid/q', note: 'Good at code review.', checked: true, files: [{ name: 'Qwen3.8-27B-UD-Q6_K.gguf', size_bytes: 20_900_000_000, sha256: HASH }] };
  const s = await openShare(t, { answers: { modelProvenance: { ok: true, provenance: prov } } });
  assert.deepEqual(s.sent('modelProvenance'), [{ team_id: TEAM, tag: DISC }], 'the discovery tag, matched by path, once per load');
  const flag = s.row(CARD).querySelector('.mrow-flag[title^="Sent to you"]');
  assert.equal(flag.textContent, 'From Arjun');
  assert.equal(flag.title, 'Sent to you by Arjun through Studio. Jenny checked that it arrived as sent, not that it is safe.');
  const items = s.menuFor(CARD);
  assert.deepEqual(items.map((i) => (i.separator ? '---' : i.label)), ['Set as default', '---', SEND, 'Where it came from…', 'Remove from library', 'Copy tag']);
  await items.find((i) => i.label === 'Where it came from…').action();
  const drawer = s.drawer('modelShareAcceptDrawer');
  const text = s.text(drawer);
  for (const part of ['Where qwen3.8-27b-ud-q6_k came from', 'From Arjun', 'through Studio.', 'Qwen3.8-27B-UD-Q6_K.gguf', '1 file', 'Checksum (SHA-256)',
    'Jenny checked every part against it as it arrived.', 'What Arjun said about it', 'apache-2.0', '“Good at code review.”',
    'Licence and source as Arjun described them. Jenny has not checked them.', 'Jenny checked that the file arrived exactly as Arjun sent it, not that it is safe.']) {
    assert.ok(text.includes(part), part);
  }
  assert.equal(drawer.querySelector('a'), null, 'a source is text, never a link');
  await s.clickAct('about-close', drawer);
  assert.equal(drawer.hidden, true);
});

// ------------------------------------------------------------------ 3. the send drawer

test('the send drawer: who, files with the total, what you tell them, the relay sentence and a payload main accepts', async (t) => {
  const s = await openShare(t);
  await sendItem(s).action();
  const drawer = s.drawer('modelShareSendDrawer');
  const q = (sel) => drawer.querySelector(sel);
  assert.equal(q('h2').textContent, 'Send qwen3.8-27b-ud-q6_k');
  assert.deepEqual([...q('[data-inv-segmented="modelShareTo"]').querySelectorAll('[role="radio"]')].map((b) => b.textContent.trim()), ['One person', 'The whole team']);
  const options = [...q('#modelSharePerson').options].map((o) => [o.textContent, o.disabled]);
  assert.deepEqual(options, [['Brendan (owner)', false], ['Maya', false], ['Tomas · read-only, cannot receive', true]]);
  assert.ok(s.text(drawer).includes('They choose whether to take it. The offer ends after 24 hours with no answer.'));
  const boxes = [0, 1, 2].map((i) => q('#modelShareFile' + i));
  assert.deepEqual(boxes.map((b) => [b.checked, b.disabled]), [[true, true], [true, false], [false, false]], 'the model always, the drafter ticked, vision not');
  assert.deepEqual([...drawer.querySelectorAll('.mshare-file-what')].map((el) => el.textContent),
    ['The model. Always sent.', 'Its drafter, for multi-token prediction.', 'Its vision file, which lets the model read images.']);
  assert.equal(q('[data-mshare-total]').textContent, '2 files · 20.8 GB');
  boxes[2].checked = true;
  boxes[2].dispatchEvent(new s.h.windowRef.Event('change', { bubbles: true }));
  assert.equal(q('[data-mshare-total]').textContent, '3 files · 21.6 GB');
  assert.equal(q('#modelShareName').value, 'Qwen3.8-27B-UD-Q6_K');
  assert.equal(q('#modelShareLicence').value, 'apache-2.0');
  assert.equal(q('#modelShareSource').value, 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF');
  // Brendan hosts the team: picked, the relay sentence is left out; Maya: it is said.
  assert.equal(q('[data-mshare-part="relay"]').hidden, true);
  assert.equal(s.act('send-offer', drawer).textContent, 'Offer to Brendan');
  q('#modelSharePerson').value = 'member_maya';
  q('#modelSharePerson').dispatchEvent(new s.h.windowRef.Event('change', { bubbles: true }));
  assert.equal(q('[data-mshare-part="relay"]').hidden, false);
  assert.equal(q('[data-mshare-part="relay"]').textContent, 'This goes through Brendan’s computer, which can read it on the way and keeps none of it.');
  assert.ok(s.text(drawer).includes('Jenny reads the whole file once before it offers it, which can take a few minutes.'));
  q('#modelShareNote').value = 'Good at code review.';
  await s.clickAct('send-offer', drawer);
  assert.deepEqual(s.sent('modelOffer'), [{ team_id: TEAM, tag: DISC, files: ['Qwen3.8-27B-UD-Q6_K.gguf', 'mtp-Qwen3.8-27B-Q4_0.gguf', 'mmproj-Qwen3.8-27B-F16.gguf'],
    display_name: 'Qwen3.8-27B-UD-Q6_K', member_id: 'member_maya', licence: 'apache-2.0', source_url: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF', note: 'Good at code review.' }]);
  assert.equal(drawer.hidden, true, 'closed on ok');
});

test('the send drawer: the whole team, a refusal in its footer, a bad address, and the Team choice with two teams', async (t) => {
  const s = await openShare(t, { teams: [team(TEAM), team(OTHER, { role: 'owner' })], answers: { modelOffer: { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_offer_limit' } } } });
  await sendItem(s).action();
  const drawer = s.drawer('modelShareSendDrawer');
  const q = (sel) => drawer.querySelector(sel);
  assert.deepEqual([...q('#modelShareTeam').options].map((o) => o.textContent), ['Studio', 'Dot lab']);
  click(s.h.windowRef, q('[data-inv-segmented="modelShareTo"] [data-value="team"]'));
  assert.equal(q('[data-mshare-part="person"]').hidden, true);
  assert.equal(q('[data-mshare-part="team"]').hidden, false);
  assert.equal(s.act('send-offer', drawer).textContent, 'Offer to the team');
  q('#modelShareSource').value = 'http://plain.invalid';
  await s.clickAct('send-offer', drawer);
  assert.equal(q('[data-mshare-status]').textContent, 'Where it is from must be an https address, or empty.');
  q('#modelShareSource').value = '';
  q('#modelShareTeam').value = OTHER;
  q('#modelShareTeam').dispatchEvent(new s.h.windowRef.Event('change', { bubbles: true }));
  await flush();
  assert.equal(q('[data-mshare-part="relay"]').hidden, true, 'this member hosts Dot lab');
  await s.clickAct('send-offer', drawer);
  const sent = s.sent('modelOffer').at(-1);
  assert.equal(sent.team_id, OTHER);
  assert.equal(Object.hasOwn(sent, 'member_id'), false, 'no member: the whole team');
  assert.equal(Object.hasOwn(sent, 'source_url'), false);
  assert.equal(q('[data-mshare-status]').textContent, 'You can have 16 offers open at most. Withdraw one first.');
  assert.equal(drawer.hidden, false, 'a refusal keeps the drawer');
});

test('the send drawer: the provenance prefill at its bounds, at the edge and one past', async (t) => {
  for (const [length, kept] of [[128, 128], [129, 128]]) {
    const name = 'n'.repeat(length);
    const licence = 'l'.repeat(length * 32);
    const s = await openShare(t, { answers: { modelFiles: { ...FILES, provenance: { name, licence, source_url: 'https://x.invalid/' + 'u'.repeat(length * 4 - 18) } } } });
    await sendItem(s).action();
    const drawer = s.drawer('modelShareSendDrawer');
    assert.equal(drawer.querySelector('#modelShareName').value.length, kept);
    assert.equal(drawer.querySelector('#modelShareLicence').value.length, Math.min(length * 32, 4096));
    assert.equal(drawer.querySelector('#modelShareSource').value.length, Math.min(length * 4, 512));
    await s.clickAct('send-offer', drawer); // the harness fails the test if main would refuse the payload
    assert.equal(s.sent('modelOffer').length, 1);
  }
});

// ------------------------------------------------------------------ 4. the sender's row

test('the sender\'s row in every state, with its buttons and their calls', async (t) => {
  const cases = [
    [outgoing({ state: 'reading', read_done: false }), 'Reading the file before offering it to Maya.', ['Cancel']],
    [outgoing({ audience: 'team', member_id: null, member_name: null, state: 'reading' }), 'Reading the file before offering it to everyone in Studio.', ['Cancel']],
    [outgoing({ state: 'offering' }), 'Offering to Maya. Waiting to reach Studio.', ['Cancel']],
    [outgoing({ state: 'offering', audience: 'team', member_id: null, member_name: null }), 'Offering to everyone in Studio. Waiting to reach the host.', ['Cancel']],
    [outgoing({ state: 'offering', read_done: 400_000_000 }), 'Reading the file before offering it to Maya.', ['Cancel']],
    [outgoing(), 'Offered to Maya. Waiting for them to accept. The offer ends after 24 hours with no answer.', ['Withdraw']],
    [outgoing({ audience: 'team', member_id: null, member_name: null }), 'Offered to everyone in Studio. Nobody has taken it yet.', ['Withdraw']],
    [outgoing({ transfers: [transfer({ state: 'accepted', queued: true })] }), 'Maya accepted. Waiting for a turn: the team moves only a few models at a time.', ['Stop']],
    [outgoing({ transfers: [transfer()] }), 'Sending to Maya.', ['Pause', 'Stop']],
    [outgoing({ transfers: [transfer({ state: 'paused', reason: 'paused_by_sender' })] }), 'Paused. Maya keeps what has arrived.', ['Resume', 'Stop']],
    [outgoing({ transfers: [transfer({ state: 'paused', reason: 'paused_by_receiver' })] }), 'Maya paused it. It carries on when they resume.', ['Stop']],
    [outgoing({ transfers: [transfer({ state: 'paused', reason: 'idle' })] }), 'Maya’s Jenny is not answering. It carries on when they are back, for up to an hour.', ['Stop']],
    [outgoing({ state: 'ended', reason: 'fulfilled', transfers: [transfer({ state: 'done' })] }), 'Maya has it, checked.', ['OK']],
    [outgoing({ state: 'ended', reason: 'declined' }), 'Maya declined.', ['OK']],
    [outgoing({ state: 'failed', reason: 'model_source_changed' }), 'This file changed while it was being sent, so sending stopped. Offer it again to send the new file.', ['OK']],
    [outgoing({ state: 'failed', reason: 'team_model_offer_limit' }), 'You have 16 offers open, the most there can be. Withdraw one, then offer this again.', ['OK']],
  ];
  for (const [row, line, buttons] of cases) {
    const s = await openShare(t, withState({ outgoing: [row] }));
    const block = s.row(CARD).querySelector('.mrow-share');
    assert.equal(block.querySelector('.model-card-note').textContent, line);
    assert.deepEqual([...block.querySelectorAll('button')].map((b) => b.textContent.trim()), buttons, line);
    for (const b of block.querySelectorAll('button')) assert.ok(b.title, 'every button has a tooltip');
  }
  const offering = await openShare(t, withState({ outgoing: [outgoing({ state: 'offering' })] }));
  assert.equal(offering.act('withdraw').title, 'Withdraw this offer', 'the Cancel of an offer already read withdraws it');
  const reading = await openShare(t, withState({ outgoing: [outgoing({ state: 'reading', read_done: 5 })] }));
  assert.equal(reading.act('withdraw').title, 'Stop reading and offer nothing');
  const people = await openShare(t, withState({ outgoing: [outgoing({ audience: 'team', member_id: null, member_name: null, transfers: [transfer(),
    transfer({ transfer_id: 'mxfer_TX2aaaaaaaaaaaaaaaaaaa', member_name: 'Arjun', state: 'accepted', queued: true }), transfer({ transfer_id: 'mxfer_TX3aaaaaaaaaaaaaaaaaaa', member_name: 'Brendan', state: 'done' })] })] }));
  const list = people.row(CARD).querySelector('.mrow-share-people');
  assert.deepEqual([...list.children].map((li) => people.text(li)), ['Maya381.5 MB of 953.7 MB · 2.0 MB/s · about 5 min leftPauseStop', 'Arjunwaiting for a turnStop', 'Brendanhas it']);
  assert.equal(people.act('withdraw').textContent, 'Withdraw offer');
  // Each button calls its method; a refusal says its sentence on the status line.
  const s = await openShare(t, { answers: { modelState: stateAnswer({ outgoing: [outgoing({ transfers: [transfer()] })] }), modelSendPause: { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_transfer_stale' } } } });
  await s.clickAct('send-pause');
  await s.clickAct('send-stop');
  assert.deepEqual(s.sent('modelSendPause'), [{ team_id: TEAM, transfer_id: 'mxfer_TX1aaaaaaaaaaaaaaaaaaa' }]);
  assert.deepEqual(s.sent('modelSendStop'), [{ team_id: TEAM, transfer_id: 'mxfer_TX1aaaaaaaaaaaaaaaaaaa' }]);
  assert.ok(s.status().length > 10 && !/team_model/.test(s.status()), 'a sentence, never the reason word');
  const w = await openShare(t, withState({ outgoing: [outgoing()] }));
  await w.clickAct('withdraw');
  assert.deepEqual(w.sent('modelWithdraw'), [{ team_id: TEAM, request_id: 'mreq_1' }]);
  const done = await openShare(t, withState({ outgoing: [outgoing({ state: 'ended', reason: 'declined' })] }));
  await done.clickAct('out-dismiss');
  assert.equal(done.row(CARD).querySelector('.mrow-share'), null, 'OK hides the line');
});

// ------------------------------------------------------------------ 5. incoming rows

test('incoming rows in every state, the two lines only while something is incoming, and each button\'s call', async (t) => {
  const none = await openShare(t);
  assert.equal(none.rows().some((r) => r.startsWith('sep:')), false);
  const cases = [
    [incoming(), null, ['Review…', 'Decline']],
    [incoming({ transfer: take({ queued: true }) }), 'Waiting for a turn: the team moves only a few models at a time.', ['Cancel']],
    [incoming({ transfer: take() }), null, ['Pause', 'Cancel']],
    [incoming({ transfer: take({ state: 'paused', reason: 'paused_by_receiver' }) }), 'Paused. What has arrived is kept.', ['Resume', 'Cancel']],
    [incoming({ transfer: take({ state: 'paused', reason: 'paused_by_sender' }) }), 'Arjun paused it. What has arrived is kept.', ['Cancel']],
    [incoming({ transfer: take({ state: 'interrupted', reason: 'sender_offline' }) }), 'Arjun’s Jenny is not answering. What has arrived is kept for 7 days and carries on when they are back.', ['Cancel']],
    [incoming({ transfer: take({ state: 'interrupted', reason: 'model_no_space' }) }), 'Paused: the disk is nearly full. This needs 1.4 GB more. Free some space, then resume.', ['Resume', 'Cancel']],
    [incoming({ transfer: take({ state: 'verifying' }) }), 'All of it has arrived. Checking the whole file before it joins your library.', ['Cancel']],
    [incoming({ transfer: take({ state: 'paused', reason: 'sharing_off' }) }), 'Brendan turned model sharing off, so this stopped. What has arrived is kept for 7 days.', ['Cancel']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'model_hash_mismatch' }) }), 'It did not arrive as Arjun sent it, after three tries. Nothing was kept.', ['Try again', 'Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'model_not_gguf' }) }), 'This is not a model file Jenny can use, so it was not added. Nothing was kept.', ['Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'cancelled_by_sender' }) }), 'Arjun stopped sending. Dismiss removes what had arrived.', ['Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'withdrawn' }) }), 'Arjun stopped sending. Dismiss removes what had arrived.', ['Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'expired' }) }), 'The offer from Arjun ran out before this finished. Dismiss removes what had arrived.', ['Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'member_gone' }) }), 'Arjun is no longer in the team, so this stopped. Dismiss removes what had arrived.', ['Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'host_stopping' }) }), 'The team’s server stopped, so the offer ended. Dismiss removes what had arrived.', ['Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'paused', reason: 'paused_by_receiver' }) }), 'Paused. What has arrived is kept.', ['Resume', 'Cancel']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'model_exists' }) }), 'A file with the same name appeared in that folder while this arrived. Nothing was overwritten, and what arrived was removed.', ['Dismiss']],
    [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'model_staging_failed' }) }), 'Jenny could not write to that folder. Check the folder, then try again.', ['Try again', 'Dismiss']],
  ];
  for (const [row, line, buttons] of cases) {
    const s = await openShare(t, withState({ incoming: [row] }));
    assert.deepEqual(s.rows().slice(0, 3), ['sep:From your team', ':offer:offer_IN1aaaaaaaaaaaaaaaaaaa', 'sep:On this PC']);
    const el = s.row(':offer:offer_IN1aaaaaaaaaaaaaaaaaaa');
    const note = el.querySelector('.model-card-note');
    assert.equal(note ? note.textContent : null, line);
    assert.deepEqual([...el.querySelectorAll('button')].map((b) => b.textContent.trim()), buttons, String(line));
    assert.equal(el.querySelector('.mrow-fit-num').textContent, '—');
  }
  const offered = await openShare(t, withState({ incoming: [incoming()] }));
  assert.equal(offered.row(':offer:offer_IN1aaaaaaaaaaaaaaaaaaa').querySelector('.mrow-meta').textContent, 'Arjun offers this · 2 files · 1.9 GB');
  const away = await openShare(t, { teams: [team(TEAM)], answers: { modelState: stateAnswer({ online: false, incoming: [incoming({ transfer: take({ state: 'interrupted', reason: 'sender_offline' }) })] }) } });
  assert.equal(away.row(':offer:offer_IN1aaaaaaaaaaaaaaaaaaa').querySelector('.model-card-note').textContent, 'Not connected to Studio. What has arrived is kept and carries on when you are connected.');
  const calls = [['receive-pause', 'modelReceivePause', take()], ['receive-cancel', 'modelReceiveCancel', take({ bytes_done: 0 })], ['receive-resume', 'modelReceiveResume', take({ state: 'paused', reason: 'paused_by_receiver' })],
    ['receive-retry', 'modelReceiveRetry', take({ state: 'failed', reason: 'model_hash_mismatch' })], ['decline', 'modelDecline', null]];
  for (const [action, method, transferRow] of calls) {
    const s = await openShare(t, withState({ incoming: [incoming({ transfer: transferRow })] }));
    await s.clickAct(action);
    assert.deepEqual(s.sent(method), [{ team_id: TEAM, offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa' }], action);
  }
  const gone = await openShare(t, withState({ incoming: [incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'model_not_gguf', bytes_done: 0 }) })] }));
  await gone.clickAct('in-dismiss');
  assert.deepEqual(gone.sent('modelReceiveCancel'), [{ team_id: TEAM, offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa' }]);
  assert.equal(gone.rows().includes(':offer:offer_IN1aaaaaaaaaaaaaaaaaaa'), false, 'dismissed, and the two lines with it');
});

// ------------------------------------------------------------------ C22: the question before removing received data

const IN1 = 'offer_IN1aaaaaaaaaaaaaaaaaaa';
const asking = (s) => s.row(':offer:' + IN1).querySelector('.model-card-note').textContent;
const labels = (s) => [...s.row(':offer:' + IN1).querySelectorAll('button')].map((b) => b.textContent.trim());
const press = (s, el, key) => el.dispatchEvent(new s.h.windowRef.KeyboardEvent('keydown', { key, bubbles: true }));

test('Cancel on a transfer with data asks first: Keep downloading restores the row and the focus, Remove cancels', async (t) => {
  const s = await openShare(t, withState({ incoming: [incoming({ transfer: take() })] }));
  s.act('receive-cancel').focus();
  await s.clickAct('receive-cancel');
  assert.deepEqual(s.sent('modelReceiveCancel'), [], 'nothing is cancelled yet');
  assert.equal(asking(s), 'Remove the 476.8 MB received so far?');
  assert.deepEqual(labels(s), ['Remove', 'Keep downloading']);
  assert.equal(s.row(':offer:' + IN1).querySelector('[data-mshare-progress]') !== null, true, 'the bar stays');
  // A progress push and a state push keep the question.
  s.push({ kind: 'progress', direction: 'receive', transfer_id: 'mxfer_TXINaaaaaaaaaaaaaaaaaa', offer_id: IN1, bytes_done: 1_000_000_000, bytes_total: 2_000_000_000, rate_bps: 0 });
  await flush();
  assert.equal(asking(s), 'Remove the 953.7 MB received so far?', 'a push patches the bar and the size asked about');
  s.push({ kind: 'state', ...stateAnswer({ incoming: [incoming({ transfer: take({ bytes_done: 1_000_000_000 }) })] }) });
  await flush();
  assert.equal(asking(s), 'Remove the 953.7 MB received so far?', 'a repaint keeps the question and uses the bytes now');
  await s.clickAct('ask-keep');
  assert.deepEqual(labels(s), ['Pause', 'Cancel']);
  assert.equal(s.h.document.activeElement.getAttribute('data-mshare-action'), 'receive-cancel', 'focus is back on the button that asked');
  await s.clickAct('receive-cancel');
  await s.clickAct('ask-remove');
  assert.deepEqual(s.sent('modelReceiveCancel'), [{ team_id: TEAM, offer_id: IN1 }]);
});

test('Dismiss on a failed row with data asks first; Escape keeps it; a transfer with nothing received cancels at once', async (t) => {
  const failed = incoming({ state: 'ended', transfer: take({ state: 'failed', reason: 'model_not_gguf' }) });
  const s = await openShare(t, withState({ incoming: [failed] }));
  s.act('in-dismiss').focus();
  await s.clickAct('in-dismiss');
  assert.deepEqual(s.sent('modelReceiveCancel'), []);
  assert.equal(asking(s), 'Remove the 476.8 MB received so far?');
  assert.deepEqual(labels(s), ['Remove', 'Keep']);
  assert.equal(s.h.document.activeElement.getAttribute('data-mshare-action'), 'ask-keep', 'focus lands on the safe choice');
  press(s, s.act('ask-keep'), 'Escape');
  await flush();
  assert.deepEqual(labels(s), ['Dismiss']);
  assert.equal(s.h.document.activeElement.getAttribute('data-mshare-action'), 'in-dismiss');
  await s.clickAct('in-dismiss');
  await s.clickAct('ask-remove');
  assert.deepEqual(s.sent('modelReceiveCancel'), [{ team_id: TEAM, offer_id: IN1 }]);
  assert.equal(s.rows().includes(':offer:' + IN1), false, 'dismissed once the data is gone');
  const none = await openShare(t, withState({ incoming: [incoming({ transfer: take({ bytes_done: 0, queued: true }) })] }));
  await none.clickAct('receive-cancel');
  assert.deepEqual(none.sent('modelReceiveCancel'), [{ team_id: TEAM, offer_id: IN1 }], 'nothing received: no question');
});

test('a progress push repaints one bar: no row or list rebuilt, an open menu and drawer stay', async (t) => {
  const s = await openShare(t, withState({ outgoing: [outgoing({ transfers: [transfer()] })], incoming: [incoming({ transfer: take() })] }));
  const nodes = [...s.host().querySelectorAll('.mrow')];
  const listHtml = () => [...s.host().querySelectorAll('.mrow')].map((el) => el.outerHTML.replace(/style="[^"]*"|aria-valuenow="[^"]*"|<span class="inv-progress-text">[^<]*<\/span>/g, ''));
  const before = listHtml();
  s.menuFor('installed:1b');
  const hides = s.hidden.count;
  await sendItem(s).action();
  const drawer = s.drawer('modelShareSendDrawer');
  let replaced = 0;
  const observer = new s.h.windowRef.MutationObserver((records) => { for (const r of records) replaced += r.removedNodes.length; });
  observer.observe(s.host(), { childList: true, subtree: true });
  s.push({ kind: 'progress', direction: 'send', transfer_id: 'mxfer_TX1aaaaaaaaaaaaaaaaaaa', offer_id: 'offer_OUT1aaaaaaaaaaaaaaaaaa', bytes_done: 900_000_000, bytes_total: 1_000_000_000, rate_bps: 4_000_000 });
  s.push({ kind: 'progress', direction: 'receive', transfer_id: 'mxfer_TXINaaaaaaaaaaaaaaaaaa', offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa', bytes_done: 1_000_000_000, bytes_total: 2_000_000_000, rate_bps: 0 });
  await flush();
  const bar = s.host().querySelector('[data-mshare-progress="out:mxfer_TX1aaaaaaaaaaaaaaaaaaa"]');
  assert.equal(bar.getAttribute('aria-valuenow'), '90');
  assert.equal(bar.querySelector('.inv-progress-text').textContent, '858.3 MB of 953.7 MB · 4.0 MB/s · about 1 min left');
  assert.equal(s.host().querySelector('[data-mshare-progress="in:offer_IN1aaaaaaaaaaaaaaaaaaa"] .inv-progress-text').textContent, '953.7 MB of 1.9 GB', 'no rate or minutes while the rate is 0');
  assert.deepEqual([...s.host().querySelectorAll('.mrow')], nodes, 'the same row nodes');
  assert.deepEqual(listHtml(), before, 'nothing but the bars changed');
  assert.equal(replaced, 2, 'only the two bars\' own text nodes were swapped');
  assert.equal(s.hidden.count, hides, 'the menu was not closed');
  assert.equal(drawer.hidden, false, 'the drawer stays');
  observer.disconnect();
});

// ------------------------------------------------------------------ 6. the accept drawer

test('Review… on the card in the Team tab: the review id it set opens the accept drawer here, once, and is cleared', async (t) => {
  const s = await openShare(t, withState({ incoming: [incoming()] }));
  s.store.setReview(TEAM, 'offer_IN1aaaaaaaaaaaaaaaaaaa');
  await flush();
  assert.deepEqual(s.sent('modelOfferRead'), [{ team_id: TEAM, offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa' }]);
  assert.equal(s.drawer('modelShareAcceptDrawer').hidden, false);
  assert.equal(s.store.peekReview(), null, 'taken, so a later render does not open it again');
});


test('the accept drawer: every part, Show all and Show less, roots with free space, and Accept with the read index', async (t) => {
  const s = await openShare(t, withState({ incoming: [incoming()] }));
  await s.clickAct('review');
  assert.deepEqual(s.sent('modelOfferRead'), [{ team_id: TEAM, offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa' }]);
  const drawer = s.drawer('modelShareAcceptDrawer');
  const q = (sel) => drawer.querySelector(sel);
  const text = s.text(drawer);
  for (const part of ['Arjun offers you a model', 'Bonsai 12B', 'Arjun offered this today at', 'Bonsai-12B-Q8_0.gguf', 'The model.', 'Its vision file, which lets the model read images.',
    '2 files · 1.9 GB', 'Checksum (SHA-256)', 'Jenny checks every part against it as it arrives.', 'Save to', 'What Arjun says about it', '“The Q8 I mentioned.”',
    'Licence and source as Arjun described them. Jenny has not checked them.', 'Only accept models from people you trust.', 'This goes through Brendan’s computer',
    'Nothing loads the model until you press Use.']) assert.ok(text.includes(part), part);
  assert.equal(q('[data-mshare-hash]').textContent, HASH.slice(0, 16) + '…');
  await s.clickAct('hash-toggle', drawer);
  assert.equal(q('[data-mshare-hash]').textContent, HASH);
  assert.equal(s.act('hash-toggle', drawer).textContent, 'Show less');
  await s.clickAct('hash-toggle', drawer);
  assert.equal(s.act('hash-toggle', drawer).textContent, 'Show all');
  assert.deepEqual([...q('#modelShareRoot').options].map((o) => o.textContent), ['D:\\models · 383.7 GB free', 'C:\\Users\\dot\\models · 858.3 MB free']);
  assert.equal(q('[data-model-tuning-row="root"] [data-model-tuning-note]').textContent, 'Needs 2.9 GB: the files, plus 1 GB to spare. It lands in D:\\models.');
  q('#modelShareRoot').value = '3';
  q('#modelShareRoot').dispatchEvent(new s.h.windowRef.Event('change', { bubbles: true }));
  assert.equal(q('[data-model-tuning-row="root"] [data-model-tuning-note]').textContent, 'Not enough room: this needs 2.9 GB and C:\\Users\\dot\\models has 858.3 MB free. Pick another folder, or free some space.');
  assert.equal(s.act('accept', drawer).disabled, true);
  assert.equal(q('[data-mshare-status]').textContent, 'Pick a folder this fits in to accept.');
  q('#modelShareRoot').value = '0';
  q('#modelShareRoot').dispatchEvent(new s.h.windowRef.Event('change', { bubbles: true }));
  await s.clickAct('accept', drawer);
  assert.deepEqual(s.sent('modelAccept'), [{ team_id: TEAM, offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa', root_index: 0 }]);
  assert.equal(drawer.hidden, true);
  assert.equal(s.store.pathOf('offer_IN1aaaaaaaaaaaaaaaaaaa'), 'D:\\models', 'kept for the row\'s "arriving in"');
  s.push({ kind: 'state', ...stateAnswer({ incoming: [incoming({ state: 'taken', transfer: take() })] }) });
  await flush();
  assert.equal(s.row(':offer:offer_IN1aaaaaaaaaaaaaaaaaaa').querySelector('.mrow-meta').textContent, 'From Arjun · 2 files · 1.9 GB · arriving in D:\\models');
});

test('the accept drawer: already there greys Accept; Decline and Not now', async (t) => {
  const s = await openShare(t, { answers: { modelState: stateAnswer({ incoming: [incoming()] }), modelOfferRead: offerRead({}, [{ index: 2, display_path: 'E:\\gguf', free_bytes: 900_000_000_000, fits: true, exists: true }]) } });
  await s.clickAct('review');
  const drawer = s.drawer('modelShareAcceptDrawer');
  assert.equal(drawer.querySelector('[data-model-tuning-row="root"] [data-model-tuning-note]').textContent, 'You already have Bonsai-12B-Q8_0.gguf in E:\\gguf. Jenny never overwrites a model. Pick another folder, or remove yours first.');
  assert.equal(s.act('accept', drawer).disabled, true);
  assert.equal(drawer.querySelector('[data-mshare-status]').textContent, 'Pick a folder this fits in to accept.');
  await s.clickAct('accept-close', drawer);
  assert.equal(drawer.hidden, true);
  assert.equal(s.sent('modelDecline').length, 0, 'Not now sends nothing');
  assert.ok(s.row(':offer:offer_IN1aaaaaaaaaaaaaaaaaaa'), 'the offer keeps its row');
  await s.clickAct('review');
  await s.clickAct('accept-decline', s.drawer('modelShareAcceptDrawer'));
  assert.deepEqual(s.sent('modelDecline'), [{ team_id: TEAM, offer_id: 'offer_IN1aaaaaaaaaaaaaaaaaaa' }]);
});

// ------------------------------------------------------------------ 7. a received model

test('a received push: the arrived line with OK, then the flag stays', async (t) => {
  let received = false;
  const s = await openShare(t, { answers: { modelProvenance: () => (received ? { ok: true, provenance: { sender_name: 'Arjun', checked: true, files: [] } }
    : { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_not_found' } }) } });
  assert.equal(s.row(CARD).querySelector('.mrow-flag[title^="Sent"]'), null);
  received = true;
  s.push({ kind: 'received', tag: DISC, root_index: 0 });
  await flush(); await flush();
  const note = s.row(CARD).querySelector('.mrow-share .model-card-note');
  assert.equal(note.textContent, 'Arrived and checked: it is the file Arjun sent. Nothing loads the model until you press Use.');
  await s.clickAct('arrived-ok');
  assert.equal(s.row(CARD).querySelector('.mrow-share'), null);
  assert.equal(s.row(CARD).querySelector('.mrow-flag[title^="Sent"]').textContent, 'From Arjun');
});

// ------------------------------------------------------------------ 11. hostile text

test('hostile names, file names, licences, addresses and notes are text: cleaned, cut, never markup', async (t) => {
  const evil = '<img src=x onerror=alert(1)><b>bold</b>\u202eevil\u200b' + 'x'.repeat(500);
  const s = await openShare(t, { answers: {
    modelState: stateAnswer({ incoming: [incoming({ display_name: evil, sender_name: evil })], outgoing: [outgoing({ member_name: evil, display_name: evil })] }),
    modelOfferRead: offerRead({ display_name: evil, sender_name: evil, files: [{ name: evil, size_bytes: 1, sha256: HASH }], provenance: { licence: evil, source_url: evil, note: evil } }),
  } });
  const check = (root) => {
    assert.equal(root.querySelector('img, b, script'), null, 'no markup from a member');
    assert.equal(/[\u202a-\u202e\u200b-\u200f\u2066-\u2069]/.test(root.textContent), false, 'no bidi or zero-width characters');
  };
  check(s.host());
  const name = s.row(':offer:offer_IN1aaaaaaaaaaaaaaaaaaa').querySelector('.mrow-name').textContent;
  assert.equal(Array.from(name).length, 129, '128 characters and the cut mark');
  assert.ok(name.startsWith('<img src=x'), 'shown as the text it is');
  await s.clickAct('review');
  const drawer = s.drawer('modelShareAcceptDrawer');
  check(drawer);
  assert.equal(drawer.querySelector('a'), null);
  for (const value of drawer.querySelectorAll('.mshare-value')) assert.ok(Array.from(value.textContent).length <= 4100);
});

// ------------------------------------------------------------------ 12. typing survives a push

test('typing survives pushes: the same fields, values and selection; the drawer and the list are not rebuilt', async (t) => {
  const s = await openShare(t, withState({ outgoing: [outgoing({ transfers: [transfer()] })] }));
  await sendItem(s).action();
  const drawer = s.drawer('modelShareSendDrawer');
  const name = drawer.querySelector('#modelShareName');
  const note = drawer.querySelector('#modelShareNote');
  const scroll = drawer.querySelector('.model-tuning-drawer-scroll');
  name.value = 'My name';
  note.value = 'Half a sentence';
  note.focus();
  note.setSelectionRange(2, 6);
  scroll.scrollTop = 120;
  const library = s.host();
  library.scrollTop = 80;
  const listNodes = [...s.host().querySelectorAll('.mrow')];
  s.push({ kind: 'progress', direction: 'send', transfer_id: 'mxfer_TX1aaaaaaaaaaaaaaaaaaa', offer_id: 'offer_OUT1aaaaaaaaaaaaaaaaaa', bytes_done: 950_000_000, bytes_total: 1_000_000_000, rate_bps: 1 });
  s.push({ kind: 'state', ...stateAnswer({ outgoing: [outgoing({ transfers: [transfer({ bytes_done: 960_000_000 })] })] }) });
  await flush();
  assert.equal(drawer.querySelector('#modelShareName'), name);
  assert.equal(drawer.querySelector('#modelShareNote'), note);
  assert.deepEqual([name.value, note.value, note.selectionStart, note.selectionEnd], ['My name', 'Half a sentence', 2, 6]);
  assert.equal(s.h.document.activeElement, note);
  assert.equal(drawer.querySelector('.model-tuning-drawer-scroll'), scroll);
  assert.equal(scroll.scrollTop, 120);
  assert.equal(s.host(), library);
  assert.equal(library.scrollTop, 80, 'the Library behind the drawer keeps its scroll');
  assert.deepEqual([...s.host().querySelectorAll('.mrow')].filter((el, i) => el !== listNodes[i] && el.getAttribute('data-model-key') !== CARD), [], 'only the changed row was replaced');
});
