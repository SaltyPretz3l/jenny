'use strict';

// The member's unsent text in a shared project's conversation box, kept on this PC (row 175 F6, owner decision D3).
// <userData>/team/<team_id>/project-drafts.json holds at most 64 conversations of at most 32,000 characters each, the
// oldest dropped; the text goes nowhere else: not to the host, not to a log (a log line carries the team id, a count and
// a fixed reason only). Writes wait about a second behind the last change and are flushed when the service stops; a
// write is atomic (services/host/durable-json.js). A team whose directory is gone (removed) keeps nothing and is never
// given a directory back. A damaged file is read as empty and replaced by the next write; a file of a newer schema is
// left as it is and refuses writes. The queue of unsent messages is renderer memory and is not kept here.

const fs = require('node:fs');
const path = require('node:path');

const { removeFileSync } = require('../fs-remove-no-follow');
const { logCode, readJson, writeJson } = require('../host/durable-json');
const { isId, isSessionId } = require('../../server/team/ids');
const { isPlainObject } = require('../../server/team/member-schema');
const { invalidRequest } = require('./team-errors');

const SCHEMA_VERSION = 1;
const FILE_NAME = 'project-drafts.json';
const MAX_CONVERSATIONS = 64;
const MAX_CHARS = 32_000;
const WRITE_DELAY_MS = 1000;
// 64 drafts of 32,000 UTF-16 units are at most 4 bytes a unit in JSON, plus room for the keys.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const wellFormed = (text) => (typeof text.isWellFormed === 'function' ? text.isWellFormed() : !/\p{Cs}/u.test(text));
// The text kept: at most MAX_CHARS units, never cut inside a surrogate pair.
function fit(text) {
  if (text.length <= MAX_CHARS) return text;
  const code = text.charCodeAt(MAX_CHARS - 1);
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? MAX_CHARS - 1 : MAX_CHARS);
}
const isEntry = (value) => isPlainObject(value) && Object.keys(value).length === 2 && isSessionId(value.session_id)
  && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= MAX_CHARS && wellFormed(value.text);

function createProjectDrafts({ userDataPath, log = () => {}, timers = { setTimeout, clearTimeout }, writeDelayMs = WRITE_DELAY_MS }) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new TypeError('The drafts need an absolute user data path.');
  // team id -> { list: Map(session id -> text, oldest first), writable, dirty, timer }
  const teams = new Map();
  const say = (event, fields) => { try { log('WARN', event, fields); } catch { /* best effort */ } };
  const dirOf = (teamId) => path.join(userDataPath, 'team', teamId);
  const fileOf = (teamId) => path.join(dirOf(teamId), FILE_NAME);

  function dirExists(teamId) {
    try {
      const stat = fs.lstatSync(dirOf(teamId));
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch { return false; }
  }

  function readList(teamId) {
    const entry = { list: new Map(), writable: true, dirty: false, timer: null };
    let value;
    try { value = readJson(fileOf(teamId), { maxBytes: MAX_FILE_BYTES }); } catch (error) {
      say('team.project_drafts.unreadable', { team_id: teamId, reason: logCode(error) });
      return entry;
    }
    if (!value) return entry;
    if (value.schema_version !== SCHEMA_VERSION) { entry.writable = false; say('team.project_drafts.version_refused', { team_id: teamId }); return entry; }
    const kept = Array.isArray(value.drafts) ? value.drafts.filter(isEntry) : [];
    for (const draft of kept) { entry.list.delete(draft.session_id); entry.list.set(draft.session_id, draft.text); }
    while (entry.list.size > MAX_CONVERSATIONS) entry.list.delete(entry.list.keys().next().value);
    return entry;
  }

  // The team's drafts, read on first use; null when the team has no directory on this PC (its drafts are forgotten).
  function stateOf(teamId) {
    if (!dirExists(teamId)) { forget(teamId); return null; }
    if (!teams.has(teamId)) teams.set(teamId, readList(teamId));
    return teams.get(teamId);
  }

  function forget(teamId) {
    const entry = teams.get(teamId);
    if (entry && entry.timer !== null) timers.clearTimeout(entry.timer);
    teams.delete(teamId);
  }

  function write(teamId, entry) {
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    entry.timer = null;
    if (!entry.dirty || !entry.writable) return;
    if (!dirExists(teamId)) { forget(teamId); return; }
    try {
      if (entry.list.size === 0) removeFileSync(fileOf(teamId));
      else writeJson(fileOf(teamId), { schema_version: SCHEMA_VERSION, drafts: [...entry.list].map(([session_id, text]) => ({ session_id, text })) });
      entry.dirty = false;
    } catch (error) {
      say('team.project_drafts.write_failed', { team_id: teamId, reason: logCode(error) });
    }
  }

  function schedule(teamId, entry) {
    entry.dirty = true;
    if (entry.timer !== null) return;
    entry.timer = timers.setTimeout(() => { entry.timer = null; write(teamId, entry); }, writeDelayMs);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  function set(teamId, sessionId, text) {
    const entry = stateOf(teamId);
    if (!entry) return invalidRequest('team_not_found');
    if (!entry.writable) return invalidRequest('team_project_drafts_unavailable');
    if (text === '') {
      if (entry.list.delete(sessionId)) schedule(teamId, entry);
      return { ok: true };
    }
    entry.list.delete(sessionId);
    entry.list.set(sessionId, fit(text));
    while (entry.list.size > MAX_CONVERSATIONS) entry.list.delete(entry.list.keys().next().value);
    schedule(teamId, entry);
    return { ok: true };
  }

  return {
    /** `value` is a payload main already checked: { team_id, session_id } or with `text`. */
    call(method, value) {
      if (!isId('team', value.team_id) || !isSessionId(value.session_id)) return invalidRequest();
      if (method === 'projectDraftGet') {
        const entry = stateOf(value.team_id);
        return entry ? { ok: true, text: entry.list.get(value.session_id) || '' } : invalidRequest('team_not_found');
      }
      if (method === 'projectDraftSet' && typeof value.text === 'string') return set(value.team_id, value.session_id, value.text);
      return invalidRequest();
    },
    /** Every write that waits is made now (the service stopping). */
    flush() { for (const [teamId, entry] of [...teams]) write(teamId, entry); },
    forget,
    resources: () => ({ teams: teams.size, drafts: [...teams.values()].reduce((sum, entry) => sum + entry.list.size, 0) }),
  };
}

module.exports = { MAX_CHARS, MAX_CONVERSATIONS, createProjectDrafts };
