'use strict';

// Output for the noun-verb commands (Jenny CLI plan, decision 7): `--json`
// prints exactly one object per invocation, validated against the versioned
// commands schema before it leaves the process, so an agent never parses a
// shape this file did not promise. Text output is for people and is never
// parsed by anything.

const Ajv = require('ajv');
const schema = require('./schemas/commands-v1.json');
const { CLI_ERROR_CODES } = require('../services/backend/error-codes');
const { EXIT_CODES } = require('./exit-codes');

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map();

function validateCommandOutput(payload) {
  const kind = payload && typeof payload === 'object' ? payload.kind : undefined;
  if (typeof kind !== 'string' || !Object.hasOwn(schema.definitions, kind)) return { ok: false, errors: [`unknown kind ${String(kind)}`] };
  if (!validators.has(kind)) validators.set(kind, ajv.compile({ $ref: `#/definitions/${kind}`, definitions: schema.definitions }));
  const validate = validators.get(kind);
  return validate(payload) ? { ok: true } : { ok: false, errors: (validate.errors || []).map((entry) => `${entry.instancePath} ${entry.message}`) };
}

function write(stream, text) {
  try { stream.write(text); } catch (_error) { /* a closed pipe must not fail the command */ }
}

// One result: the object on stdout in json mode, the lines otherwise.
function emit({ json, stdout }, payload, lines) {
  const verdict = validateCommandOutput(payload);
  if (!verdict.ok) throw new Error(`command output violates commands-v1: ${verdict.errors.join('; ')}`);
  if (json) write(stdout, `${JSON.stringify(payload)}\n`);
  else if (lines.length) write(stdout, `${lines.join('\n')}\n`);
  return EXIT_CODES.OK;
}

// One failure: the message on stderr always, and in json mode an error object
// on stdout so the caller's parser still sees one line.
function fail({ json, stdout, stderr }, { code = CLI_ERROR_CODES.INVALID_OPTION, message, exitCode = EXIT_CODES.USAGE }) {
  const text = String(message || 'The command failed.').slice(0, 4000);
  write(stderr, `${text}\n`);
  if (json) {
    const payload = { v: 1, kind: 'error', code, message: text, exit_code: exitCode };
    const verdict = validateCommandOutput(payload);
    if (!verdict.ok) throw new Error(`error output violates commands-v1: ${verdict.errors.join('; ')}`);
    write(stdout, `${JSON.stringify(payload)}\n`);
  }
  return exitCode;
}

module.exports = { emit, fail, validateCommandOutput };
