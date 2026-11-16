'use strict';

// The model receiver's 7-day sweep (row 123 slice 6-4, TEAM_MODEL_SHARING_SPEC
// "6-4 as built"). No timer: slice 6-5 drives it. Split out of
// model-receive.js, which passes its own state in.

const path = require('node:path');

const { removeTree } = require('../fs-remove-no-follow');
const { mainModelName } = require('../../server/team/model-manifest');
const { ownDirectory } = require('../../server/team/file-checks');
const checks = require('./model-receive-checks');
const journals = require('./model-receive-journal');

// The newest change of a staging child whose journal cannot be judged: its journal file's mtime, or the folder's when
// the journal cannot be stat'd (lstat, so a link is read as itself). `null` when neither can be read (kept: fail closed).
function lastChangeOf(fsImpl, child) {
  for (const target of [path.join(child, journals.JOURNAL_NAME), child]) {
    try {
      const { mtimeMs } = fsImpl.lstatSync(target);
      if (Number.isFinite(mtimeMs)) return mtimeMs;
    } catch (_error) { /* try the folder */ }
  }
  return null;
}

function createSweeper({ roots, fsImpl, clock, limits, validateManifest, placer, log, saveTo, activeStagingDir }) {
  // An expired (or discarded) staging folder: a placement in hand is rolled back from its journal first; one that
  // cannot be is kept. A set already renamed into place leaves only its journal: the staging goes, the set stays.
  async function sweepChild(realRoot, child, journal) {
    const placed = journal?.placement?.stages.every((stage) => stage === 2) === true;
    if (journal && journal.phase !== 'pulling' && !placed) {
      // The journal's folder passed the folder rule when it was read (R14-F07).
      const ctx = { manifest: journal.manifest, main: mainModelName(journal.manifest), stagingDir: child, root: realRoot };
      if (!await placer.rollBack(ctx, journal, () => saveTo(child, journal))) {
        log('WARN', 'team.model.receive_sweep_kept', { code: 'rollback' });
        return false;
      }
    }
    await removeTree(child);
    return true;
  }

  /**
   * Removes staging folders idle `stagingIdleMs` (by the journal's last write; a stamp in the future counts as
   * expired) and any child with no valid journal (absent, or read and broken). A journal that cannot be read now or
   * is newer keeps its child until its staging folder's newest change (`lastChangeOf`) is `stagingKeptMs` (30 days,
   * E74) behind now (a stamp ahead of the clock keeps it); then the child is removed, no rollback. Roots no longer
   * configured are not visited.
   */
  async function sweep(now = clock()) {
    let removed = 0;
    let listed = [];
    try {
      listed = roots() || [];
    } catch (_error) { /* no roots */ }
    for (const root of Array.isArray(listed) ? listed : []) {
      const realRoot = checks.resolveRoot(root, roots);
      const incoming = realRoot ? path.join(realRoot, journals.INCOMING_DIR) : '';
      if (!incoming || !ownDirectory(incoming)) continue;
      for (const entry of fsImpl.readdirSync(incoming, { withFileTypes: true })) {
        const child = path.join(incoming, entry.name);
        if (activeStagingDir() === child) continue;
        let journal = null;
        if (entry.isDirectory() && journals.TRANSFER_ID.test(entry.name)) {
          let read;
          try {
            read = journals.readJournal(child, {
              id: entry.name, segmentBytes: limits.segmentBytes, maxBytes: limits.journalBytes, validate: validateManifest,
            });
          } catch (error) {
            // Not readable now, or newer: kept for a later sweep (X4b-F05), until it is 30 days old (E74).
            let code = error?.code || 'unknown';
            const changed = lastChangeOf(fsImpl, child);
            if (changed !== null && now - changed >= limits.stagingKeptMs) {
              try {
                await removeTree(child);
                removed += 1;
                continue;
              } catch (removeError) { code = removeError?.code || 'unknown'; }
            }
            log('WARN', 'team.model.receive_sweep_kept', { code });
            continue;
          }
          journal = read.ok ? read.journal : null;
        }
        const age = journal ? now - journal.updated_at : Infinity;
        if (age >= 0 && age < limits.stagingIdleMs) continue;
        try {
          if (await sweepChild(realRoot, child, journal)) removed += 1;
        } catch (error) {
          log('WARN', 'team.model.receive_sweep_kept', { code: error?.code || 'unknown' });
        }
      }
    }
    if (removed > 0) log('INFO', 'team.model.receive_swept', { removed });
    return { ok: true, removed };
  }

  /**
   * The staging folder and journal of one offer that is not in hand (Cancel or Decline of a take found after a
   * restart, review round two R14-F02), as the current-take path removes them: `{ ok: true }` when nothing of it is
   * left (or there was none), else a refusal. A journal that is not this offer's, or not valid, is not trusted: only
   * the folder goes, as at accept. One that cannot be read now or is newer throws, and the receiver's catch answers
   * `model_staging_failed` with the folder kept (X4b-F05). Nothing is sent to the host.
   */
  async function discard({ offer, root }) {
    const checked = checks.checkOffer(offer, validateManifest);
    if (!checked.ok) return { ok: false, reason: 'model_manifest_invalid' };
    const realRoot = checks.resolveRoot(root, roots);
    if (!realRoot) return { ok: false, reason: 'model_destination_invalid' };
    const { teamId, sender, manifest } = checked.offer;
    const id = journals.transferIdFor({ teamId, senderId: sender.memberId, manifest });
    const incoming = path.join(realRoot, journals.INCOMING_DIR);
    const child = path.join(incoming, id);
    if (!checks.present(child, fsImpl)) return { ok: true };
    if (!ownDirectory(incoming) || !checks.ownFolder(child)) return { ok: false, reason: 'model_destination_invalid' };
    const read = journals.readJournal(child, { id, segmentBytes: limits.segmentBytes, maxBytes: limits.journalBytes, validate: validateManifest });
    const journal = read.ok && read.journal && read.journal.team_id === teamId && read.journal.sender.member_id === sender.memberId
      && journals.sameFiles(read.journal.manifest, manifest) ? read.journal : null;
    if (!await sweepChild(realRoot, child, journal)) return { ok: false, reason: 'model_staging_failed' };
    log('INFO', 'team.model.receive_discarded', { transferId: id });
    return { ok: true };
  }

  return { sweep, discard };
}

module.exports = { createSweeper };
