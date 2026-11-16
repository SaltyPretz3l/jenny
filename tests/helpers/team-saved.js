'use strict';

// Fixtures the member-side saved-team tests share: a saved team whose first service was stopped again, a
// queued outbox entry, and a watch on the atomic writes of one file (durable-json ends each with a rename).

const fs = require('node:fs');
const path = require('node:path');

const { clientFilePath } = require('../../services/team/client-file');
const { attachTeamChat } = require('./team-chat-hook');
const { createTeamClientHost, joinAs } = require('./team-client-host');

// A team joined through the service (the first owner, or with `member` an admitted member of a direct
// owner) and online once, with that service stopped again. `chat` routes team chat on the host.
async function savedTeam(t, { member = false, chat = false } = {}) {
  const host = await createTeamClientHost(t);
  if (chat) await attachTeamChat(t, host);
  const owner = member ? await host.ownerDirect() : null;
  const first = host.createService();
  const me = await joinAs(host, first, member ? { owner } : { name: 'Olive Owner' });
  await host.waitForState(me.teamId, 'online');
  await first.stopAll();
  const file = clientFilePath(host.userData, me.teamId);
  return { host, owner, me, file, good: fs.readFileSync(file, 'utf8') };
}

// One outbox entry for the team channel, created now (so it has not expired).
const queued = (n, attempted = false) => ({ entry_id: `out_entry${String(n).padStart(16, '0')}`,
  request_id: `req_${n}`, operation: 'team.chat.post', params: { channel_id: 'chan_team', text: `queued ${n}` },
  created_at: new Date().toISOString(), attempted, failed: null });

// Counts the atomic writes of `file`; with `fail` set the next ones throw, and `onWrite(count)` runs after each.
function watchWrites(t, file, onWrite = () => {}) {
  const original = fs.renameSync;
  const watch = { count: 0, fail: false };
  fs.renameSync = (from, to) => {
    const target = path.resolve(String(to)) === path.resolve(file);
    if (target && watch.fail) throw new Error('disk says no');
    const result = original(from, to);
    if (target) { watch.count += 1; onWrite(watch.count); }
    return result;
  };
  const restore = () => { fs.renameSync = original; };
  t.after(restore);
  return Object.assign(watch, { restore });
}

// Holds the host's next redeem: `reached` resolves when it is called, `release()` lets it go on.
function holdRedeem(t, host) {
  const { invites } = host.env.context;
  const redeem = invites.redeem;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let arrive = () => {};
  const reached = new Promise((resolve) => { arrive = resolve; });
  invites.redeem = async (input) => { arrive(); await gate; return redeem(input); };
  t.after(() => { invites.redeem = redeem; release(); });
  return { reached, release: () => release() };
}

// A recovery of the host's team through `service`, as the owner on a new desk.
const recover = async (host, service) => service.ownerRecover({
  invite: (await host.invite({ kind: 'recovery' })).invite, display_name: 'Olive Owner', label: 'New desk' });

module.exports = { holdRedeem, queued, recover, savedTeam, watchWrites };
