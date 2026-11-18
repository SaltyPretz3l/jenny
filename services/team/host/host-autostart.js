'use strict';

// "Start with Jenny": the owner's setting that starts a stopped team server when the app launches, and the launch
// start itself. Main process, no Electron.
//
// The setting is `<userData>/team-host/autostart.json`, `{ "schema_version": 1, "enabled": true }`; turning it off
// removes the file. A read never throws, creates nothing and takes only a small regular file of exactly that shape.
//
// The launch start runs once, after the saved teams loaded, and starts the server only where the Start button of the
// Team view would (renderer/team/renderer-team-start.js `restart`): a deployed server that is stopped or failed, with
// its key, a platform that can host it, and the names this PC saved with the membership. It never recovers, never
// starts a first team, never runs under Force local, and does not retry. Nothing it logs carries a name.

const fs = require('node:fs');
const path = require('node:path');

const { writeJson } = require('../../host/durable-json');
const { removeFileInside } = require('./host-files');

const AUTOSTART_FILE = 'autostart.json';
const AUTOSTART_MAX_BYTES = 4096;
const STOPPED = new Set(['stopped', 'failed']);
const LOST_KEY = new Set(['missing', 'set_aside']);
const REASON_WORD = /^[a-z][a-z0-9_]{0,79}$/u;

/** True only for a readable regular file of at most 4096 bytes that is exactly the saved shape with `enabled: true`. */
function readAutostart(userDataPath) {
  try {
    if (typeof userDataPath !== 'string' || !userDataPath) return false;
    const file = path.join(userDataPath, 'team-host', AUTOSTART_FILE);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > AUTOSTART_MAX_BYTES) return false;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = doc && typeof doc === 'object' && !Array.isArray(doc) ? Object.keys(doc) : [];
    return names.length === 2 && doc.schema_version === 1 && doc.enabled === true;
  } catch {
    return false;
  }
}

/** Saves the setting in `root` (the real `team-host` folder): the file when on, no file when off. Throws when it cannot. */
function writeAutostart(root, enabled) {
  const file = path.join(root, AUTOSTART_FILE);
  if (enabled) {
    writeJson(file, { schema_version: 1, enabled: true });
  } else if (!removeFileInside(root, file)) {
    throw new Error('autostart_remove_failed');
  }
}

const okText = (value) => { const text = String(value || '').trim(); return text.length >= 1 && text.length <= 40; };

// The word naming why the server is not started now, or null when it may start (the Start button's conditions).
function whyNot(host, teams) {
  if (!host || host.deployed !== true || !okText(host.team_name)) return 'not_deployed';
  if (host.force_local === true) return 'force_local';
  if (!STOPPED.has(host.state)) return 'not_stopped';
  if (LOST_KEY.has(host.key)) return 'key_lost';
  if (host.reason === 'team_host_platform_unavailable') return 'platform';
  const row = teams.find((team) => team?.team_id === host.team_id);
  if (!row) return 'no_membership';
  return okText(row.display_name) && okText(row.label) ? null : 'no_names';
}

/**
 * The one start at launch. `getHost()` is the lazy host controller, `getService()` the member service (its teams
 * answer holds the names the Start button reads), `log(level, event, fields)` the app's log. Never throws.
 */
async function launchStart({ getHost, getService, log }) {
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const skip = (reason) => say('INFO', 'team.host.autostart.skipped', { reason });
  try {
    const controller = getHost();
    if (!controller) return skip('unavailable');
    const hosted = await controller.handle('hostStatus', {});
    if (!hosted?.ok) return skip('status');
    const statusAnswer = await getService()?.handle('status');
    const teams = statusAnswer?.ok === true && Array.isArray(statusAnswer.teams) ? statusAnswer.teams : [];
    const host = hosted.host;
    const reason = whyNot(host, teams);
    if (reason) return skip(reason);
    const row = teams.find((team) => team?.team_id === host.team_id);
    const answer = await controller.handle('hostDeploy', { name: host.team_name, display_name: row.display_name, label: row.label },
      { sender: null });
    if (answer?.ok === true) return say('INFO', 'team.host.autostart.started');
    const failure = answer?.error?.reason;
    return say('WARN', 'team.host.autostart.failed', { reason: typeof failure === 'string' && REASON_WORD.test(failure) ? failure : 'none' });
  } catch {
    return say('WARN', 'team.host.autostart.failed', { reason: 'error' });
  }
}

module.exports = { launchStart, readAutostart, writeAutostart };
