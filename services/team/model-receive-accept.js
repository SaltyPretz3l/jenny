'use strict';

// The model receiver's accept checks (row 123 slice 6-4, TEAM_MODEL_SHARING_SPEC
// "6-4 as built"): in order, before anything is written, then the staging
// folder made or adopted from its journal. Split out of model-receive.js,
// which passes its own state in.

const path = require('node:path');

const { removeTree } = require('../fs-remove-no-follow');
const { ownDirectory } = require('../../server/team/file-checks');
const checks = require('./model-receive-checks');
const journals = require('./model-receive-journal');

/** `prepare({ offer, root })` answers `{ refused }` or `{ transfer }` (the transfer state model-receive.js runs). */
function createAcceptor({ roots, fsImpl, clock, limits, validateManifest, spaceHolds, save }) {
  // A staging folder found for this offer: its journal (its folder already passed the folder rule), or a refusal.
  async function adoptStaging(t) {
    if (!checks.ownFolder(t.stagingDir)) return 'model_destination_invalid';
    const read = journals.readJournal(t.stagingDir, {
      id: t.id, segmentBytes: limits.segmentBytes, maxBytes: limits.journalBytes, validate: validateManifest,
    });
    if (read.ok && read.journal === null) {
      await removeTree(t.stagingDir);
      return '';
    }
    const journal = read.ok ? read.journal : null;
    if (!journal || journal.team_id !== t.offer.teamId || journal.sender.member_id !== t.offer.sender.memberId
      || !journals.sameFiles(journal.manifest, t.offer.manifest)) {
      await removeTree(t.stagingDir);
      return 'model_journal_invalid';
    }
    t.journal = {
      ...journal, offer_id: t.offer.offerId, manifest: t.offer.manifest,
      sender: { member_id: t.offer.sender.memberId, display_name: t.offer.sender.displayName },
    };
    return '';
  }

  // The accept checks, in order, before anything is written; answers a refusal or the new transfer.
  async function prepare({ offer, root }) {
    const checked = checks.checkOffer(offer, validateManifest);
    if (!checked.ok) return { refused: 'model_manifest_invalid' };
    if (checks.provenanceBytes(checked.offer) > limits.provenanceFileBytes) return { refused: 'model_manifest_invalid' };
    const realRoot = checks.resolveRoot(root, roots);
    if (!realRoot) return { refused: 'model_destination_invalid' };
    // The folder rule: the first folder with nothing at its name (a resumed transfer keeps its journal's).
    const picked = checks.pickReceiveFolder(realRoot, checked.main, fsImpl);
    if (picked.refused === 'model_destination_invalid') return picked;
    const id = journals.transferIdFor({ teamId: checked.offer.teamId, senderId: checked.offer.sender.memberId, manifest: checked.offer.manifest });
    const incoming = path.join(realRoot, journals.INCOMING_DIR);
    if (checks.present(incoming, fsImpl) && !checks.ownFolder(incoming)) return { refused: 'model_destination_invalid' };
    const stagingDir = path.join(incoming, id);
    const t = {
      id, offer: checked.offer, main: checked.main, root: realRoot, stagingDir, journal: null,
      state: 'accepting', reason: null, doneBytes: 0, stopping: null, accepted: false, lastProgress: 0,
    };
    if (checks.present(stagingDir, fsImpl)) {
      const refused = await adoptStaging(t);
      if (refused) return { refused };
    }
    // A placement cut part way finishes in placeAll, which tells this transfer's own files from a newcomer's.
    const placing = Boolean(t.journal) && t.journal.phase !== 'pulling';
    // The same model already in one of its folders, or every folder taken.
    if (!placing && (checks.placedAnywhere(realRoot, t.offer.manifest, t.main, fsImpl) || (!t.journal && picked.refused))) {
      if (t.journal) await removeTree(stagingDir);
      return { refused: 'model_exists' };
    }
    if (!t.journal) {
      // Every child counts, stray files included, until the sweep removes them (no closed "staging full" reason exists).
      const others = checks.ownFolder(incoming) ? fsImpl.readdirSync(incoming).length : 0;
      if (others >= limits.stagingFolders) return { refused: 'model_staging_failed' };
      t.journal = journals.newJournal({ id, offer: t.offer, folder: picked.folder, segmentBytes: limits.segmentBytes, now: clock() });
      if (!spaceHolds(t)) return { refused: 'model_no_space' };
      if (!checks.ownFolder(incoming, { create: true, fsImpl })) return { refused: 'model_destination_invalid' };
      try {
        fsImpl.mkdirSync(stagingDir);
      } catch (_error) {
        return { refused: 'model_staging_failed' };
      }
      if (!ownDirectory(stagingDir)) return { refused: 'model_destination_invalid' };
    } else if (!placing && !spaceHolds(t)) {
      return { refused: 'model_no_space' };
    }
    save(t);
    return { transfer: t };
  }

  return { prepare };
}

module.exports = { createAcceptor };
