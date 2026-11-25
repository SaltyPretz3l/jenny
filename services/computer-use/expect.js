'use strict';

/* services/computer-use/expect.js: the guard every input request carries to the helper (row 196).
 *
 * The helper refuses, at the moment of input, anything this object does not cover: another program,
 * a process in `deny_pids`, a program in `deny_programs`, an administrator's window
 * (native/jenny-computer/PROTOCOL.md, "The guard"). Only a granted program that allows input
 * (grant-gate.js) may be named in `program`; Jenny's own processes and program files are always denied,
 * so even a wrong grant cannot reach an approval card. */

const { allowsInput } = require('./program-rules');

const MAX_DENY = 256;
const MAX_PID = 0xffffffff;

function pidList(values) {
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (Number.isSafeInteger(value) && value > 0 && value <= MAX_PID) seen.add(value);
  }
  return [...seen].slice(0, MAX_DENY);
}

function programList(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) continue;
    const key = value.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out.slice(0, MAX_DENY);
}

/**
 * @param {object} args
 * @param {number} args.hwnd the granted window
 * @param {{ program: string, kind: string }} args.grant a grant from grant-gate.js
 * @param {{ pids?: number[], programs?: string[] }} args.jenny every process and program file of Jenny
 * @returns {{ hwnd: number, program: string, deny_pids: number[], deny_programs: string[] }}
 * @throws {TypeError} when the window or the grant cannot carry input; callers refuse the step
 */
function buildExpect({ hwnd, grant, jenny = {} } = {}) {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new TypeError('expect needs a window handle');
  if (!grant || typeof grant.program !== 'string' || !grant.program.trim()) throw new TypeError('expect needs a granted program');
  if (!allowsInput(grant.kind)) throw new TypeError('that grant does not allow input');
  const programs = programList(jenny.programs);
  if (programs.length === 0) throw new TypeError('expect needs Jenny\'s own program file to deny');
  return {
    hwnd,
    program: grant.program,
    deny_pids: pidList(jenny.pids),
    deny_programs: programs,
  };
}

module.exports = { MAX_DENY, buildExpect };
