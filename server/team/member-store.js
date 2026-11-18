'use strict';

// The durable team member store: <userDataPath>/team-members.json, schema 3,
// built on the host durable-json primitive. Strict closed-field validation on
// load, one serialized `mutate`, and fail-closed behaviour: an unreadable or
// invalid document marks the store broken and every call answers with the same
// failure until restart. An unknown or newer schema, or a different host key,
// fails the same way and rewrites nothing. A schema 1 or 2 document is upgraded
// in memory on open (`projects: []`, `team.model: null`) and written as schema 3
// by the first commit, after open has kept the old bytes as
// `team-members.json.v<old version>.bak`. A missing
// file is a new store only while the audit log shows no commit past the first.
//
// Commit protocol for every mutation (audit first, owner decision 2026-11-09):
//   1. run the transition on a draft copy and validate the whole draft,
//   2. append the audit entry carrying the revision the store will hold,
//   3. write the document, 4. rebuild the directory, 5. emit the event.
// If step 2 fails the mutation is refused. If step 3 fails the store is marked
// broken (the audit entry stays and is marked not applied on the next open).
// A reconcile whose write failed is owed and lands before the next commit.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { readJson: durableReadJson, writeJson: durableWriteJson } = require('../../services/host/durable-json');
const { hostFailure } = require('../api-contract');
const { AuditLog } = require('./audit-log');
const { createDirectory } = require('./directory');
const { isPublicKey, newId } = require('./ids');
const { createMembershipEvents } = require('./membership-events');
const transitions = require('./member-transitions');
const projectTransitions = require('./project-transitions');
const {
  LIMITS, emptyDocument, isCleanText, upgradeDocument, validateDocument,
} = require('./member-schema');
const { safeLogger } = require('./safe-logger');

const MEMBERS_FILE = 'team-members.json';
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const AUDIT_FILE = 'team-audit.json';
// A host start waits this long, bounded, for an audit log held for a moment (a
// scanner, an indexer) before it goes on without it.
const START_OPEN_TRIES = 8;
const START_OPEN_INTERVAL_MS = 250;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Review sweeps, second run (X3b-F01): the keys of the invites a commit ended other than by a redeem: revoked (by
// anyone, or in a cascade) or gone (pruned at expiry, or with a pruned member). Each is named once, by the commit
// that retired it. A redeem is left out: the join route drops its key after the answer, and a drop here would cut it.
function endedInviteKeys(before, after, now) {
  const next = new Map(after.invites.map((invite) => [invite.invite_id, invite]));
  return before.invites.filter((invite) => invite.used_at === null && invite.revoked_at === null)
    .filter((invite) => {
      const later = next.get(invite.invite_id);
      return !later || (later.used_at === null && !transitions.isLiveInvite(later, now));
    })
    .map((invite) => invite.invite_public_key);
}

// Reads a regular file with the store file's own rules: no link followed, one
// link, inside the cap.
function readRegular(filePath, maxBytes, reason) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error(reason);
    return fs.readFileSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Keeps the store file's bytes beside it as `backupPath`, once. The bytes must
// still be the document open read. The final name only ever appears complete:
// they go to `tempPath` (a left-over one is removed first; exclusive, no-follow
// create; fsync), then move into place. An existing backup is accepted only when
// it holds exactly these bytes; one that differs throws and is never
// overwritten (one process owns the profile, so nothing races the check).
// Answers true when it wrote the backup.
function writeBackupOnce(sourcePath, backupPath, { maxBytes, expected, tempPath = `${backupPath}.tmp` }) {
  const bytes = readRegular(sourcePath, maxBytes, 'backup_source_invalid');
  if (JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(expected)) {
    throw new Error('backup_source_changed');
  }
  let existing = null;
  try {
    existing = readRegular(backupPath, maxBytes, 'backup_differs');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing !== null) {
    if (!existing.equals(bytes)) throw new Error('backup_differs');
    return false;
  }
  fs.rmSync(tempPath, { force: true });
  const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, backupPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(backupPath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  return true;
}

class MemberStore {
  constructor({
    userDataPath, hostPublicKey, teamName = 'Team', clock = Date.now, randomBytes = crypto.randomBytes,
    logger = null, assertSafePath = null, readJson = durableReadJson, writeJson = durableWriteJson,
    audit = null, auditOptions = {}, writeBackup = writeBackupOnce,
  } = {}) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
      throw new TypeError('MemberStore requires an absolute userDataPath.');
    }
    if (!isPublicKey(hostPublicKey)) throw new TypeError('MemberStore requires the host public key (base64url, 32 bytes).');
    if (!isCleanText(teamName)) throw new TypeError('MemberStore requires a valid team name.');
    this.filePath = path.join(userDataPath, MEMBERS_FILE);
    this._hostPublicKey = hostPublicKey;
    this._teamName = teamName;
    this._clock = clock;
    this._randomBytes = randomBytes;
    this._log = safeLogger(logger);
    this._assertSafePath = typeof assertSafePath === 'function' ? assertSafePath : null;
    this._readJson = readJson;
    this._writeJson = writeJson;
    this._writeBackup = writeBackup;
    this._events = createMembershipEvents({ logger });
    this.directory = createDirectory({ clock, isDegraded: () => this._events.isDegraded() });
    this.audit = audit || new AuditLog({
      filePath: path.join(userDataPath, AUDIT_FILE), clock, logger, assertSafePath, ...auditOptions,
    });
    this.onMembershipChange = this._events.onMembershipChange;
    this.onProjectChange = this._events.onProjectChange;
    this._inviteEnded = new Set();
    this._doc = null;
    this._broken = null;
    this._reconcileOwed = false;
    this._chain = Promise.resolve();
  }

  _brokenFailure() {
    return hostFailure(this._broken.kind, this._broken.reason);
  }

  // Fail closed: nobody resolves, nothing mutates, and the file is left alone.
  _markBroken(kind, reason, fields = {}) {
    this._broken = { kind, reason };
    this._doc = null;
    this.directory.rebuild({ members: [], devices: [], invites: [], projects: [] });
    this._log('ERROR', 'team_store.broken', { reason, ...fields });
    return this._brokenFailure();
  }

  _guard() {
    if (this._assertSafePath) this._assertSafePath(this.filePath);
  }

  // Loads and validates the document once. Idempotent; never writes the store
  // file (an upgrade writes only its one backup). `finalTry: false` is a host
  // start's earlier try: an audit log busy for a moment, or a rename of it
  // refused for a moment, answers team_unavailable without breaking the store so
  // the start tries again. Without it (every other caller) the store opens
  // without the busy log, as it did before the set-aside existed.
  open({ finalTry = true } = {}) {
    if (this._broken) return this._brokenFailure();
    if (this._doc) return { ok: true };
    let stored;
    try {
      this._guard();
      stored = this._readJson(this.filePath, { maxBytes: LIMITS.MAX_STORE_BYTES });
    } catch (error) {
      return this._markBroken('unavailable', 'team_unavailable', { code: error?.code || null });
    }
    if (stored === null) {
      const missing = this._openMissing();
      if (missing) return missing;
    }
    const doc = stored === null
      ? emptyDocument({ hostPublicKey: this._hostPublicKey, teamName: this._teamName, now: this._clock() })
      : stored;
    const checked = upgradeDocument(doc);
    if (!checked.ok) {
      return checked.schema
        ? this._markBroken('persistence', 'team_store_schema_unsupported', { cause: checked.reason })
        : this._markBroken('unavailable', 'team_unavailable', { cause: checked.reason });
    }
    if (checked.doc.team.host_public_key !== this._hostPublicKey) {
      return this._markBroken('conflict', 'team_host_key_mismatch');
    }
    if (checked.upgraded) {
      const from = stored.schema_version;
      try {
        const backupPath = `${this.filePath}.v${from}.bak`;
        const tempPath = `${backupPath}.tmp`;
        if (this._assertSafePath) {
          this._assertSafePath(backupPath);
          this._assertSafePath(tempPath);
        }
        this._writeBackup(this.filePath, backupPath, { maxBytes: LIMITS.MAX_STORE_BYTES, expected: stored, tempPath });
      } catch (error) {
        return this._markBroken('unavailable', 'team_unavailable', { code: error?.code || null, stage: 'backup' });
      }
      this._log('INFO', 'team_store.upgraded', { from });
    }
    if (stored !== null) {
      const audit = this._auditAtStart(checked.doc.rev, finalTry);
      if (audit) return audit;
    }
    this._doc = clone(checked.doc);
    this.directory.rebuild(this._doc);
    this._reconcile();
    return { ok: true };
  }

  // A missing members file is a new store only while the audit log is readable
  // and shows nothing past a torn first commit: a refused log cannot prove that,
  // so the start stops and nothing moves. A busy log answers team_unavailable
  // and breaks nothing, so the next open reads both again.
  _openMissing() {
    const state = this.audit.startState();
    if (state === 'busy') return hostFailure('unavailable', 'team_unavailable');
    if (state !== 'ok' && state !== 'absent') {
      return this._markBroken('unavailable', 'team_unavailable', { cause: 'store_missing_audit_unreadable' });
    }
    if (this.audit.highestStoreRev() >= 2) {
      return this._markBroken('unavailable', 'team_unavailable', { cause: 'store_missing' });
    }
    return null;
  }

  // The audit log beside a members file that passed every check. A log refused
  // for its content is set aside and a fresh one says so; one missing beside a
  // committed store starts the same way. Busy, or a rename refused for a moment:
  // not now on an earlier try; on the final try the store opens and the log
  // keeps refusing audited changes while it cannot be read. A rename refused for
  // good leaves the log broken; a failed reset write stops the start, and the
  // next start finds the log missing and writes the entry then. Answers the
  // failure to return, or null to go on.
  _auditAtStart(rev, finalTry) {
    const notNow = () => hostFailure('unavailable', 'team_unavailable');
    const state = this.audit.startState();
    if (state === 'busy') {
      if (!finalTry) return notNow();
      this._log('WARN', 'team_store.started_without_audit', {});
      return null;
    }
    let reset = null;
    if (state === 'content') reset = this.audit.setAsideAndReset(rev);
    else if (state === 'absent' && rev >= 1) reset = this.audit.resetMissing(rev);
    if (!reset || reset.ok) return null;
    if (reset.stage === 'busy' && !finalTry) return notNow();
    if (reset.stage === 'write') return this._markBroken('unavailable', 'team_unavailable', { cause: 'audit_reset_failed' });
    return null;
  }

  // A host start: up to START_OPEN_TRIES opens, START_OPEN_INTERVAL_MS apart
  // through `wait` (the start's own cancellable timer), while the answer is
  // team_unavailable and the store is not broken; `alive` throws when the start
  // was stopped meanwhile. The last try opens without a busy audit log.
  async openAtStart({ wait, alive = () => {} }) {
    for (let attempt = 1; ; attempt += 1) {
      const finalTry = attempt >= START_OPEN_TRIES;
      const opened = this.open({ finalTry });
      if (opened.ok || finalTry || this._broken || opened.error.reason !== 'team_unavailable') return opened;
      await wait(START_OPEN_INTERVAL_MS);
      alive();
    }
  }

  // Marks audit entries for changes the store never committed and records
  // whether that is still owed, logging when it starts or stops failing rather
  // than per attempt. A log it cannot read owes the reconcile: open still
  // answers ok, and every audited change is refused until the reconcile lands.
  _reconcile() {
    const reconciled = this.audit.reconcile(this._doc.rev);
    if (!reconciled.ok && !this._reconcileOwed) {
      this._log('ERROR', 'team_store.audit_unavailable', { reason: reconciled.error.reason });
    } else if (reconciled.ok && this._reconcileOwed) {
      this._log('INFO', 'team_store.audit_reconciled', {});
    }
    this._reconcileOwed = !reconciled.ok;
    return reconciled;
  }

  // ---------------------------------------------------------------- reads

  rev() { return this.open().ok ? this._doc.rev : null; }

  teamId() { return this.open().ok ? this._doc.team.team_id : null; }

  hostPublicKey() { return this._hostPublicKey; }

  teamName() { return this.open().ok ? this._doc.team.name : null; }

  snapshot() { return this.open().ok ? clone(this._doc) : null; }

  // The GPU list's names (slice 4e): each device's PC name and the team model, without a copy of the document.
  poolNames() {
    if (!this.open().ok) return null;
    return { labels: new Map(this._doc.devices.map((device) => [device.device_id, device.label ?? null])),
      team_model: this._doc.team.model ?? null };
  }

  getMember(memberId) {
    if (!this.open().ok) return null;
    const member = this._doc.members.find((entry) => entry.member_id === memberId);
    return member ? clone(member) : null;
  }

  listDevices(memberId) {
    if (!this.open().ok) return [];
    return clone(this._doc.devices.filter((device) => device.member_id === memberId));
  }

  getInvite(inviteId) {
    if (!this.open().ok) return null;
    const invite = this._doc.invites.find((entry) => entry.invite_id === inviteId);
    return invite ? clone(invite) : null;
  }

  getProject(projectId) {
    if (!this.open().ok) return null;
    const project = this._doc.projects.find((entry) => entry.project_id === projectId);
    return project ? clone(project) : null;
  }

  // `listener(keys)` hears the public keys of the invites each commit ended other than by a redeem (X3b-F01), after
  // the directory stopped admitting them. Answers the unsubscribe; a listener that throws is logged and skipped.
  onInviteKeysEnded(listener) {
    if (typeof listener !== 'function') throw new TypeError('onInviteKeysEnded requires a function.');
    this._inviteEnded.add(listener);
    return () => { this._inviteEnded.delete(listener); };
  }

  isInviteLive(inviteId) {
    if (!this.open().ok) return false;
    const invite = this._doc.invites.find((entry) => entry.invite_id === inviteId);
    return Boolean(invite) && transitions.isLiveInvite(invite, this._clock());
  }

  // ------------------------------------------------------------ mutations

  createInvite(input) { return this._mutate(transitions.createInvite, input); }

  revokeInvite(input) { return this._mutate(transitions.revokeInvite, input); }

  redeem(input) { return this._mutate(transitions.redeem, input); }

  admit(input) { return this._mutate(transitions.admit, input); }

  setRole(input) { return this._mutate(transitions.setRole, input); }

  revokeMember(input) { return this._mutate(transitions.revokeMember, input); }

  leave(input) { return this._mutate(transitions.leave, input); }

  revokeDevice(input) { return this._mutate(transitions.revokeDevice, input); }

  transferOwner(input) { return this._mutate(transitions.transferOwner, input); }

  rename(input) { return this._mutate(transitions.rename, input); }

  // Row 170: the caller's own display name and the label of the device it asks from.
  changeProfile(input) { return this._mutate(transitions.changeProfile, input); }

  // Slice 4e: the owner's team model (null is Automatic).
  setTeamModel(input) { return this._mutate(transitions.setTeamModel, input); }

  // Shared projects (slice 3-1). Each takes `actorMemberId` from its caller.
  createProject(input) { return this._mutate(projectTransitions.createProject, input); }

  addProjectMember(input) { return this._mutate(projectTransitions.addProjectMember, input); }

  setProjectRole(input) { return this._mutate(projectTransitions.setProjectRole, input); }

  removeProjectMember(input) { return this._mutate(projectTransitions.removeProjectMember, input); }

  markProjectDeleting(input) { return this._mutate(projectTransitions.markProjectDeleting, input); }

  deleteProject(input) { return this._mutate(projectTransitions.deleteProject, input); }

  // The host's own repair at start (slice 3-4b): no actor, never reached from a command.
  reconcileProject(input) { return this._mutate(projectTransitions.reconcileProject, input); }

  touchDevice(deviceId) {
    // Nearly every call lands inside the one-minute window: answer it without
    // queueing or copying the document. The transition stays the authority.
    const device = this._broken ? null : this._doc?.devices.find((entry) => entry.device_id === deviceId);
    if (device && device.last_seen_at !== null
      && this._clock() - device.last_seen_at < LIMITS.LAST_SEEN_INTERVAL_MS) {
      return Promise.resolve({ ok: true, written: false });
    }
    return this._mutate(transitions.touchDevice, { deviceId });
  }

  _mutate(transition, input) {
    const run = () => this._commit(transition, input || {});
    const result = this._chain.then(run, run);
    this._chain = result.catch(() => undefined);
    return result;
  }

  _commit(transition, input) {
    const loaded = this.open();
    if (!loaded.ok) return loaded;
    const ctx = {
      now: this._clock(),
      newId: (kind) => newId(kind, this._randomBytes),
      // The application store's id shape: a dashless UUID-length hex string.
      newProjectId: () => `project_${Buffer.from(this._randomBytes(16)).toString('hex')}`,
    };
    const draft = clone(this._doc);
    const outcome = transition(draft, input, ctx);
    if (!outcome.ok) return outcome.failure;
    if (outcome.noop) return { ok: true, ...outcome.result };
    // An owed reconcile (its write failed) lands before any commit advances the
    // revision, or the lost entry would share a revision with a real one and
    // read as applied for good (R01-F03). While it cannot be written an audited
    // change is refused (E10) and a display-only one is skipped without a write
    // and without breaking the store, like a failed touch.
    if (this._reconcileOwed) {
      const reconciled = this._reconcile();
      if (!reconciled.ok) return outcome.displayOnly ? hostFailure('persistence', 'team_store_failed') : reconciled;
    }
    transitions.prune(draft, ctx.now);
    draft.rev = this._doc.rev + 1;
    const checked = validateDocument(draft);
    if (!checked.ok || Buffer.byteLength(JSON.stringify(draft), 'utf8') > LIMITS.MAX_STORE_BYTES) {
      // A transition produced a document the store would refuse to load.
      this._log('ERROR', 'team_store.draft_rejected', { reason: checked.ok ? 'too_large' : checked.reason });
      return hostFailure('persistence', 'team_store_failed');
    }
    if (outcome.audit.length > 0) {
      const appended = this.audit.append(outcome.audit.map((entry) => ({ ...entry, store_rev: draft.rev })));
      if (!appended.ok) {
        // A write that threw may still have landed (the rename done, the
        // directory sync failed): owe the reconcile, so the guard above marks
        // such an entry not applied before a commit can reuse its revision.
        this._reconcileOwed = true;
        return appended;
      }
    }
    try {
      this._guard();
      this._writeJson(this.filePath, draft);
    } catch (error) {
      if (outcome.displayOnly) {
        // Only a display fact was lost and the file still holds the last commit:
        // a busy disk must not take the team offline over "last seen".
        this._log('WARN', 'team_store.touch_failed', { code: error?.code || null });
        return hostFailure('persistence', 'team_store_failed');
      }
      this._markBroken('unavailable', 'team_unavailable', { code: error?.code || null, stage: 'write' });
      return hostFailure('persistence', 'team_store_failed');
    }
    const ended = endedInviteKeys(this._doc, draft, ctx.now);
    this._doc = draft;
    this.directory.rebuild(draft);
    this._log('INFO', 'team_store.committed', { rev: draft.rev, audit_entries: outcome.audit.length });
    if (outcome.event) this._events.emit(outcome.event);
    if (outcome.projectEvent) this._events.emitProject(outcome.projectEvent);
    if (ended.length > 0) this._emitInviteEnded(ended);
    return { ok: true, ...outcome.result };
  }

  _emitInviteEnded(keys) {
    for (const listener of [...this._inviteEnded]) {
      try {
        listener([...keys]);
      } catch {
        // Never the keys: the event name alone.
        this._log('WARN', 'team_store.invite_listener_failed', {});
      }
    }
  }
}

module.exports = { MEMBERS_FILE, AUDIT_FILE, MemberStore, writeBackupOnce };
