'use strict';

// The durable team member store: <userDataPath>/team-members.json, schema 2,
// built on the host durable-json primitive. Strict closed-field validation on
// load, one serialized `mutate`, and fail-closed behaviour: an unreadable or
// invalid document marks the store broken and every call answers with the same
// failure until restart. An unknown or newer schema, or a different host key,
// fails the same way and rewrites nothing. A schema 1 document is upgraded in
// memory on open (`projects: []`) and written as schema 2 by the first commit.
//
// Commit protocol for every mutation (audit first, owner decision 2026-11-09):
//   1. run the transition on a draft copy and validate the whole draft,
//   2. append the audit entry carrying the revision the store will hold,
//   3. write the document, 4. rebuild the directory, 5. emit the event.
// If step 2 fails the mutation is refused. If step 3 fails the store is marked
// broken (the audit entry stays and is marked not applied on the next open).

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
const AUDIT_FILE = 'team-audit.json';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class MemberStore {
  constructor({
    userDataPath, hostPublicKey, teamName = 'Team', clock = Date.now, randomBytes = crypto.randomBytes,
    logger = null, assertSafePath = null, readJson = durableReadJson, writeJson = durableWriteJson,
    audit = null, auditOptions = {},
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
    this._events = createMembershipEvents({ logger });
    this.directory = createDirectory({ clock, isDegraded: () => this._events.isDegraded() });
    this.audit = audit || new AuditLog({
      filePath: path.join(userDataPath, AUDIT_FILE), clock, logger, assertSafePath, ...auditOptions,
    });
    this.onMembershipChange = this._events.onMembershipChange;
    this.onProjectChange = this._events.onProjectChange;
    this._doc = null;
    this._broken = null;
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

  // Loads and validates the document once. Idempotent; never writes.
  open() {
    if (this._broken) return this._brokenFailure();
    if (this._doc) return { ok: true };
    let stored;
    try {
      this._guard();
      stored = this._readJson(this.filePath, { maxBytes: LIMITS.MAX_STORE_BYTES });
    } catch (error) {
      return this._markBroken('unavailable', 'team_unavailable', { code: error?.code || null });
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
    if (checked.upgraded) this._log('INFO', 'team_store.upgraded', { from: 1 });
    this._doc = clone(checked.doc);
    this.directory.rebuild(this._doc);
    const reconciled = this.audit.reconcile(this._doc.rev);
    if (!reconciled.ok) this._log('ERROR', 'team_store.audit_unavailable', { reason: reconciled.error.reason });
    return { ok: true };
  }

  // ---------------------------------------------------------------- reads

  rev() { return this.open().ok ? this._doc.rev : null; }

  teamId() { return this.open().ok ? this._doc.team.team_id : null; }

  hostPublicKey() { return this._hostPublicKey; }

  teamName() { return this.open().ok ? this._doc.team.name : null; }

  snapshot() { return this.open().ok ? clone(this._doc) : null; }

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

  // Shared projects (slice 3-1). Each takes `actorMemberId` from its caller.
  createProject(input) { return this._mutate(projectTransitions.createProject, input); }

  addProjectMember(input) { return this._mutate(projectTransitions.addProjectMember, input); }

  setProjectRole(input) { return this._mutate(projectTransitions.setProjectRole, input); }

  removeProjectMember(input) { return this._mutate(projectTransitions.removeProjectMember, input); }

  markProjectDeleting(input) { return this._mutate(projectTransitions.markProjectDeleting, input); }

  deleteProject(input) { return this._mutate(projectTransitions.deleteProject, input); }

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
      if (!appended.ok) return appended;
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
    this._doc = draft;
    this.directory.rebuild(draft);
    this._log('INFO', 'team_store.committed', { rev: draft.rev, audit_entries: outcome.audit.length });
    if (outcome.event) this._events.emit(outcome.event);
    if (outcome.projectEvent) this._events.emitProject(outcome.projectEvent);
    return { ok: true, ...outcome.result };
  }
}

module.exports = { MEMBERS_FILE, AUDIT_FILE, MemberStore };
