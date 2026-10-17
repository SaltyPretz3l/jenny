"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const MAX_BYTES = 4 * 1024 * 1024;
function validIdentity(value) {
  return value && ['pid', 'pgid'].every(k => Number.isSafeInteger(value[k]) && value[k] > 0)
    && Number.isSafeInteger(value.uid) && value.uid >= 0
    && ['start', 'exe', 'command_hash'].every(k => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 4096);
}
function boundedRead(file, limit = MAX_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < data.length) {
      const count = fs.readSync(fd, data, length, data.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error('owned ledger input too large');
    return data.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function readIdentity(pid, { platform = process.platform, procRoot = '/proc' } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  const root = path.join(procRoot, String(pid));
  try {
    const stat = boundedRead(path.join(root, 'stat'), 16384).toString();
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const command = boundedRead(path.join(root, 'cmdline'), 1024 * 1024);
    if (!command.length) return { state: 'unknown' };
    const identity = { pid, pgid: Number(fields[2]), uid: fs.statSync(root).uid,
      start: boundedRead(path.join(procRoot, 'sys/kernel/random/boot_id'), 128).toString().trim() + ':' + fields[19],
      exe: fs.readlinkSync(path.join(root, 'exe')), command_hash: crypto.createHash('sha256').update(command).digest('hex') };
    const after = boundedRead(path.join(root, 'stat'), 16384).toString();
    if (fields[19] !== after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)[19]) return { state: 'unknown' };
    return validIdentity(identity) ? { state: 'alive', identity } : { state: 'unknown' };
  } catch (error) {
    return { state: error.code === 'ENOENT' && !fs.existsSync(root) ? 'missing' : 'unknown' };
  }
}
// Mirrors sidecar/runtime/owned_process_handoff.py frozen_owner: a packaged onefile
// bootloader's single same-binary, same-user child is the interpreter that owns the ledger.
// Tri-state: the interpreter identity; null only for a verified childless bootloader (or
// non-Linux); UNRESOLVED when the parent, /proc or a child cannot be verified, /proc holds more
// entries than are inspected, or children are ambiguous, so callers never confirm a shutdown
// from the bootloader alone.
const UNRESOLVED = Object.freeze({ state: 'unresolved' });
function frozenInterpreter(pid, { platform = process.platform, procRoot = '/proc',
  read = p => readIdentity(p, { platform, procRoot }) } = {}) {
  if (platform !== 'linux') return null;
  const parent = read(pid).identity;
  if (!validIdentity(parent)) return UNRESOLVED;
  let names;
  try { names = fs.readdirSync(procRoot).filter(n => /^\d+$/.test(n)); } catch (_) { return UNRESOLVED; }
  if (names.length > 65536) return UNRESOLVED;
  const children = [];
  for (const name of names) {
    try {
      const stat = boundedRead(path.join(procRoot, name, 'stat'), 16384).toString();
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[1]) !== pid) continue;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
      return UNRESOLVED;
    }
    const child = read(Number(name));
    if (child.state === 'missing') continue;
    if (!validIdentity(child.identity)) return UNRESOLVED;
    if (child.identity.exe === parent.exe && child.identity.uid === parent.uid) children.push(child.identity);
  }
  return children.length > 1 ? UNRESOLVED : children[0] || null;
}
function readLedger(file, logger = () => {}) {
  try {
    const value = JSON.parse(boundedRead(file).toString());
    if (value.version !== 1 || !value.entries || Array.isArray(value.entries)
      || Object.keys(value.entries).length > 4096) throw new Error('invalid owned ledger');
    for (const [key, entry] of Object.entries(value.entries)) {
      if (entry.id !== key || !validIdentity(entry.owner) || !validIdentity(entry.process)) throw new Error('invalid ledger identity');
    }
    return value.entries;
  } catch (error) {
    if (error.code !== 'ENOENT') logger('WARN', 'owned_ledger.read_failed', {});
    return {};
  }
}
function decide(entry, owner, target, uid) {
  if (!validIdentity(entry.owner) || !validIdentity(entry.process)) return 'retain';
  if (owner.state === 'alive' && same(owner.identity, entry.owner)) return 'preserve';
  if (!['alive', 'missing'].includes(owner.state) || (owner.state === 'alive' && !validIdentity(owner.identity))
    || target.state !== 'alive' || !validIdentity(target.identity)) return 'retain';
  if (!same(target.identity, entry.process)) return 'drop';
  return target.identity.uid === uid && target.identity.pgid === target.identity.pid ? 'reap' : 'retain';
}
function recover({ snapshot, mutate, read = readIdentity, send = (pid, sig) => process.kill(-pid, sig),
  uid = process.getuid?.() ?? -1, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  now = Date.now, logger = () => {} }) {
  const counts = { preserve: 0, retain: 0, drop: 0, reap: 0 };
  const deadline = now() + 8000;
  const boundedMutate = (operation, key, entry) => {
    const remaining = deadline - now();
    if (remaining > 0) mutate(operation, key, entry, remaining);
  };
  for (const [key, entry] of Object.entries(snapshot())) {
    if (now() >= deadline) break;
    const action = decide(entry, read(entry.owner.pid), read(entry.process.pid), uid);
    if (now() >= deadline) break;
    counts[action] += 1;
    if (action === 'drop') boundedMutate('forget', key, entry);
    if (action === 'retain' && entry.state !== 'unconfirmed') boundedMutate('retain', key, entry);
    if (action !== 'reap') continue;
    reapEntry({ key, entry, snapshot, mutate: boundedMutate, read, send, uid, wait, logger, now, deadline });
  }
  return counts;
}
function reapEntry({ key, entry, snapshot, mutate, read, send, uid, wait, logger, now, deadline }) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (now() >= deadline || !same(snapshot()[key], entry)) return;
    const action = decide(entry, read(entry.owner.pid), read(entry.process.pid), uid);
    if (action !== 'reap') {
      if (action === 'drop') mutate('forget', key, entry);
      else if (action !== 'preserve') mutate('retain', key, entry);
      return;
    }
    if (now() >= deadline) return;
    try { send(entry.process.pgid, signal); } catch (_) { break; }
    if (signal === 'SIGTERM') wait(Math.min(2000, Math.max(0, deadline - now())));
  }
  mutate('retain', key, entry);
  logger('WARN', 'owned_ledger.retained', { entry: key, cleanup: 'unconfirmed' });
}
module.exports = { decide, frozenInterpreter, recover, readIdentity, readLedger };
