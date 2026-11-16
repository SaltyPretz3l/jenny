'use strict';

// The node link over a team's own connection (row 123 slice 4e; spec "4e as built"). The
// connection manager lends its live link while it is online (`borrow()`: the bridge's HTTP
// client, its registered client and `ensureClient`); every node call rides it, so sharing opens
// no second connection and never touches the transport library. A call made while the team is
// not online throws a lost answer (`reset: true`), which the agent asks again after its backoff.
// Nothing here logs and nothing is kept: the client token is read for each call.

const { createNodeLink } = require('./node-link');

function lost(reason) {
  return Object.assign(new Error(reason), { reason, reset: true });
}

function createTeamLink(manager) {
  if (!manager || typeof manager.borrow !== 'function') throw new TypeError('The team link needs a connection manager.');

  function live() {
    const lent = manager.borrow();
    if (!lent || !lent.online || !lent.link) throw lost('team_not_connected');
    return lent;
  }

  const http = {
    async openRequestStream(method, path, options) {
      const lent = live();
      const blocked = await lent.ensureClient(lent.link);
      if (blocked) throw lost('team_client_missing');
      return lent.link.http.openRequestStream(method, path, options);
    },
  };

  // The registered client as the node link sends it: { client_id, client_token, boot_epoch }.
  function client() {
    const registered = manager.borrow()?.link?.client;
    if (!registered) return null;
    return { client_id: registered.client_id, client_token: registered.client_token, boot_epoch: registered.bootEpoch };
  }

  async function hello() {
    try { return await live().link.session.hello(); } catch (_error) { return { ok: false }; }
  }

  return createNodeLink({ http, client, hello });
}

module.exports = { createTeamLink };
