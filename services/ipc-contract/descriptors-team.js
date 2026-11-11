/**
 * The desktop team client (row 123, slices 1f-1 and 1f-2): joining a team, its connection
 * state and the owner and member commands the Settings Team page needs. Main
 * validates every payload and maps each method onto one host operation
 * (services/team/ipc-methods.js). No method hands out a key, a secret or an
 * address; only inviteReveal and deviceInvite answer with an invite string,
 * because the user must copy it.
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  'team.join': invokeMethod('team:join'),
  'team.status': invokeMethod('team:status'),
  'team.leave': invokeMethod('team:leave'),
  'team.removeTeam': invokeMethod('team:remove-team'),
  'team.members': invokeMethod('team:members'),
  'team.inviteCreate': invokeMethod('team:invite-create'),
  'team.inviteReveal': invokeMethod('team:invite-reveal'),
  'team.inviteRevoke': invokeMethod('team:invite-revoke'),
  'team.inviteList': invokeMethod('team:invite-list'),
  'team.deviceInvite': invokeMethod('team:device-invite'),
  'team.deviceList': invokeMethod('team:device-list'),
  'team.deviceRevoke': invokeMethod('team:device-revoke'),
  'team.memberAdmit': invokeMethod('team:member-admit'),
  'team.memberSetRole': invokeMethod('team:member-set-role'),
  'team.memberRevoke': invokeMethod('team:member-revoke'),
  'team.ownerTransfer': invokeMethod('team:owner-transfer'),
  'team.auditRead': invokeMethod('team:audit-read'),
  'team.rename': invokeMethod('team:rename'),
  'team.onState': subscribeMethod('team:state'),
  // Slice 1f-2: the team host this Jenny runs. Its state never carries a key, an invite or an address.
  'team.hostDeploy': invokeMethod('team:host-deploy'),
  'team.hostStop': invokeMethod('team:host-stop'),
  'team.hostStatus': invokeMethod('team:host-status'),
  'team.hostRecover': invokeMethod('team:host-recover'),
  'team.onHostState': subscribeMethod('team:host-state'),
});
