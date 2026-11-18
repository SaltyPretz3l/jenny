'use strict';

// new-test-file: the Settings > Team section test is at the line cap; this covers a surface of its own (row 168):
// the connected owner's summary line and folded groups.

const test = require('node:test');
const assert = require('node:assert/strict');
const { flush, snapshot, memberTeam, hostState, harness } = require('./helpers/team-settings-harness');

const FOLDED = ['GPU use', 'Activity', 'Join another team', 'Ownership and shutdown', 'Delete'];
const ownerPage = (t, over = {}) => { const h = harness({ host: hostState(over.host), teams: [snapshot()], answers: over.answers }); t.after(h.restore); return h; };
const foldTitles = (h) => h.qa('details.settings-fold > summary').map((s) => s.firstChild.textContent.trim());

test('the connected owner sees a summary line under the status and the rarely used groups folded', async (t) => {
  const h = ownerPage(t, { host: { key: 'ok', direct_port: 4567, internet: null } });
  await flush();
  const facts = h.qa('ul.team-set-summary > li').map((li) => [li.querySelector('a').dataset.teamJump, li.querySelector('span').textContent, li.querySelector('b').textContent]);
  assert.deepEqual(facts, [['people', 'People', '3 of 8 · 1 waiting'], ['network', 'Joining', 'This network only'],
    ['share', 'This PC’s GPU', 'Not shared'], ['devices', 'Your devices', '1 of 3']]);
  assert.ok(h.q('.team-set-status + ul.team-set-summary'), 'directly under the status line');
  assert.deepEqual(foldTitles(h), FOLDED);
  assert.deepEqual(h.qa('details.settings-fold').map((el) => el.dataset.teamFold), ['use', 'activity', 'join', 'ownership', 'delete']);
  assert.equal(h.q('details.settings-fold .settings-fold-count').textContent, 'last 7 days');
  for (const id of ['invite', 'people', 'devices', 'share']) assert.equal(h.q(`[data-team-group="${id}"]`).closest('details'), null, `${id} stays open`);
  assert.equal(h.q('details.settings-fold').open, false, 'folds start closed');
  assert.deepEqual(h.headings().filter((x) => FOLDED.includes(x)), FOLDED, 'headings stay in the DOM, in order');
});

test('summary facts that cannot be told are left out; the Joining fact names the internet when it is on', async (t) => {
  const h = ownerPage(t, { host: { key: 'ok', direct_port: 4567, internet: { relay_url: 'https://relay.example.net', has_token: false } }, answers: { deviceList: { ok: false, error: { code: 'x', reason: 'x' } } } });
  await flush();
  const value = (id) => h.q(`[data-team-jump="${id}"] b`)?.textContent;
  assert.equal(value('network'), 'Over the internet');
  assert.equal(value('people'), '3 of 8 · 1 waiting');
  const none = ownerPage(t);
  await flush();
  assert.equal(none.q('[data-team-jump="network"]'), null, 'no Network group, no Joining fact');
});

test('a fold the person opened stays open across a store push; Stop opens its fold with the confirm', async (t) => {
  const h = ownerPage(t);
  await flush();
  const fold = h.q('details[data-team-fold="activity"]');
  fold.open = true;
  fold.dispatchEvent(new h.window.Event('toggle'));
  h.listeners.state({ teams: [snapshot({ team_name: 'Studio 2' })] });
  await flush();
  assert.equal(h.q('details[data-team-fold="activity"]').open, true);
  assert.equal(h.q('details[data-team-fold="delete"]').open, false);
  h.click('[data-team-group="ownership"] [data-team-action="stop"]');
  assert.match(h.q('details[data-team-fold="ownership"]').textContent, /Everyone else in the team is disconnected now/);
  assert.equal(h.q('details[data-team-fold="ownership"]').open, true);
  h.click('[data-team-action="confirm-cancel"]');
  assert.equal(h.sent('hostStop').length, 0);
});

test('a member of a team hosted elsewhere, a stopped server and no team keep flat groups: no summary, no fold', async (t) => {
  const pages = [harness({ teams: [memberTeam()] }), harness({ host: hostState({ state: 'stopped' }), teams: [snapshot()] }), harness()];
  for (const h of pages) { t.after(h.restore); await flush(); assert.equal(h.q('.team-set-summary'), null); assert.equal(h.q('details.settings-fold'), null); }
});

test('a summary fact focuses its group heading; a group in a closed fold opens first', async (t) => {
  const h = ownerPage(t);
  await flush();
  h.click('[data-team-jump="devices"]');
  assert.equal(h.window.document.activeElement.id, 'teamGroup-devices');
  assert.equal(h.window.document.activeElement.getAttribute('tabindex'), '-1');
  const jump = h.window.document.createElement('a');
  jump.setAttribute('data-team-jump', 'activity');
  h.q('ul.team-set-summary').appendChild(jump);
  jump.click();
  assert.equal(h.q('details[data-team-fold="activity"]').open, true);
  assert.equal(h.window.document.activeElement.id, 'teamGroup-activity');
});
