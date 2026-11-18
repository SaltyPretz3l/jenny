'use strict';

// Row 170: a member changes their own display name, the label of the device the request came from, or both.
// The caller's member id and device id come from the authenticated connection, never from a payload, so no one
// (the owner included) changes another member's name or another device's label here. The store commits it like
// every transition in member-transitions.js, which exports it from the table the store uses.

const { refuse, activeActor, nameIsFree } = require('./transition-common');
const { isInputText } = require('./member-schema');

const normalized = (value) => (typeof value === 'string' ? value.normalize('NFC') : value);

function changeProfile(doc, input) {
  const checked = activeActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  const member = checked.actor;
  const displayName = normalized(input.displayName);
  const label = normalized(input.label);
  if (displayName !== undefined && !isInputText(displayName)) return refuse('invalid', 'team_display_name_invalid');
  if (label !== undefined && !isInputText(label)) return refuse('invalid', 'team_label_invalid');
  const nameChanged = displayName !== undefined && displayName !== member.display_name;
  if (nameChanged && !nameIsFree(doc, displayName, member.member_id)) return refuse('conflict', 'team_display_name_taken');
  let device = null;
  if (label !== undefined) {
    device = doc.devices.find((entry) => entry.device_id === input.actorDeviceId);
    // A device that is not the caller's, or not active, reads like one that does not exist (as in revokeDevice).
    if (!device || device.member_id !== member.member_id || device.state !== 'active') {
      return refuse('forbidden', 'team_not_found');
    }
  }
  const labelChanged = device !== null && device.label !== label;
  if (!nameChanged && !labelChanged) return { ok: true, noop: true, result: { changed: false } };
  if (nameChanged) member.display_name = displayName;
  if (labelChanged) device.label = label;
  return {
    ok: true,
    audit: [{
      kind: 'member_profile_changed',
      actor_member_id: member.member_id,
      subject_member_id: member.member_id,
      subject_device_id: labelChanged ? device.device_id : null,
      name: nameChanged ? displayName : null,
      detail: [nameChanged ? 'name' : null, labelChanged ? 'label' : null].filter(Boolean).join(','),
    }],
    event: null,
    result: { changed: true },
  };
}

module.exports = { changeProfile };
