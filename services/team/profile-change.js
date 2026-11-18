'use strict';

// Row 170: once the host accepted `profileSet`, the saved record of that team takes the sent display name and/or
// label, then the live record the manager holds (the one adoptDevice handed over), then the state is pushed so the
// team row shows the new names at once. As for the label repair (team-service.js `repairLabel`): a refusal changes
// nothing, a failed write changes nothing in memory and leaves the answer ok, and no name is logged.

const PROFILE_FIELDS = Object.freeze(['display_name', 'label']);

// `held`: the manager that answered is still the team's and no removal of it runs. `save(record)` answers
// saveClientFile's result. Answers true when the record was written.
function keepProfile(answer, sent, { own, held, save, log, push }) {
  if (!answer || answer.ok !== true || !held) return false;
  if (!own) {
    log('WARN', 'team.profile.unsaved', { reason: 'team_record_unavailable' });
    return false;
  }
  const changes = {};
  for (const field of PROFILE_FIELDS) {
    if (typeof sent?.[field] === 'string') changes[field] = sent[field].normalize('NFC');
  }
  if (Object.keys(changes).every((field) => own[field] === changes[field])) return false;
  let saved;
  try { saved = save({ ...own, ...changes }); } catch { saved = null; }
  if (!saved || saved.ok !== true) {
    log('WARN', 'team.client_file.write_failed', { team_id: own.team_id, reason: saved?.reason || 'none' });
    return false;
  }
  Object.assign(own, changes);
  push();
  return true;
}

module.exports = { keepProfile };
