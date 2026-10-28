'use strict';

// `jenny sessions list|show|rm` (Jenny CLI plan, decision 7). Reads go through
// the same host composition as a run (the profile lock, the session store,
// the workspace project binding) without starting the sidecar: nothing here
// talks to a model. `list` and `rm` are scoped to the workspace project the
// caller stands in; `show` reads any session of the profile and says whether
// it belongs to this workspace.

const path = require('node:path');
const { acquireCliProfile, CLI_PROFILE_ERROR_CODES } = require('../services/cli-host/profile-lock');
const { createCliHost, hostComposition } = require('../services/cli-host/host');
const { CLI_ERROR_CODES, HOST_ERROR_CODES } = require('../services/backend/error-codes');
const { hostLaunchOptions, lockOptions, resolveCliRuntime } = require('../services/cli-host/runtime-layout');
const { emit, fail } = require('./command-output');
const { EXIT_CODES } = require('./exit-codes');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MESSAGE_LIMIT = 50;
const DEFAULT_SESSION_LIMIT = 100;
const CONTENT_LIMIT = 65536;
const CLOSE_TIMEOUT_MS = 20_000;

function text(value, limit) {
  const string = typeof value === 'string' ? value : (value === null || value === undefined ? '' : JSON.stringify(value));
  return string.length > limit ? { text: string.slice(0, limit), truncated: true } : { text: string, truncated: false };
}

function summaryOf(summary, projectId) {
  return {
    id: String(summary.id),
    project_id: String(summary.project_id || ''),
    title: typeof summary.title === 'string' ? summary.title.slice(0, 512) : '',
    created_at: String(summary.created_at || ''),
    updated_at: String(summary.updated_at || ''),
    message_count: Number.isSafeInteger(summary.message_count) && summary.message_count >= 0 ? summary.message_count : 0,
    ...(typeof summary.last_model_used === 'string' && summary.last_model_used ? { last_model_used: summary.last_model_used.slice(0, 256) } : {}),
    current_workspace: String(summary.project_id || '') === projectId,
  };
}

function messageOf(message) {
  const content = text(message.content, CONTENT_LIMIT);
  return {
    id: String(message.id || ''),
    role: String(message.role || 'assistant').slice(0, 32),
    content: content.text,
    created_at: String(message.created_at || ''),
    ...(content.truncated ? { truncated: true } : {}),
  };
}

function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), guard]);
}

// The list and read views, shared with the MCP tools so both speak the
// commands-v1 shapes.
function collectSessions(store, projectId, { all = false, limit = DEFAULT_SESSION_LIMIT } = {}) {
  const every = (store.listSessions() || []).filter((summary) => summary && summary.id).map((summary) => summaryOf(summary, projectId));
  const scoped = all ? every : every.filter((summary) => summary.current_workspace);
  return { v: 1, kind: 'sessions', project_id: projectId, all: all === true, total: scoped.length, sessions: scoped.slice(0, limit) };
}

function collectSession(store, sessionId, projectId, { limit = DEFAULT_MESSAGE_LIMIT } = {}) {
  const session = store.getSession(sessionId);
  if (!session) return null;
  const every = (store.getSessionMessages(sessionId) || []).filter((message) => message && typeof message === 'object');
  const messages = every.slice(Math.max(0, every.length - limit)).map(messageOf);
  const summary = summaryOf({ ...session, message_count: Number.isSafeInteger(session.message_count) ? session.message_count : every.length }, projectId);
  return { v: 1, kind: 'session', session: summary, messages, message_total: every.length, truncated: messages.length < every.length };
}

function usageFor(verb) {
  return { list: 'jenny sessions list [--all] [--limit <n>]', show: 'jenny sessions show <session-id> [--limit <n>]', rm: 'jenny sessions rm <session-id>' }[verb];
}

async function runSessions({ verb, args, flags, settings, runtime = resolveCliRuntime({ root: ROOT }), json, stdout, stderr, logger = () => {} }) {
  const io = { json, stdout, stderr };
  if (!usageFor(verb)) return fail(io, { message: 'jenny sessions needs one of: list, show, rm.' });
  const wantsId = verb !== 'list';
  if ((wantsId && args.length !== 1) || (!wantsId && args.length)) return fail(io, { message: `Usage: ${usageFor(verb)}` });
  const sessionId = wantsId ? String(args[0]).trim() : '';
  if (wantsId && !/^[A-Za-z0-9_.:-]{1,128}$/u.test(sessionId)) return fail(io, { message: 'The session id is not valid.' });

  let held;
  try {
    held = await acquireCliProfile({ userDataPath: settings.profilePath, ...lockOptions(runtime) });
  } catch (error) {
    if (error?.code === CLI_PROFILE_ERROR_CODES.BUSY) return fail(io, { code: error.code, message: error.message, exitCode: EXIT_CODES.PROFILE_BUSY });
    if (error?.code === HOST_ERROR_CODES.CONFLICT) return fail(io, { code: error.code, message: error.message });
    return fail(io, { code: CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE, message: error?.message, exitCode: EXIT_CODES.ENGINE_UNAVAILABLE });
  }
  let host;
  try {
    // The sidecar is never started here; the executable only has to be a path.
    host = createCliHost({ profilePath: settings.profilePath, workspaceRoot: settings.workspaceRoot,
      ...hostLaunchOptions(runtime, { placeholderPython: true }), engine: { type: settings.engine, model: settings.model },
      permissions: { allowedTools: settings.allowedTools, disallowedTools: settings.disallowedTools, permissionMode: settings.permissionMode },
      logger });
  } catch (error) {
    held.release();
    return fail(io, { code: typeof error?.code === 'string' ? error.code : CLI_ERROR_CODES.INVALID_OPTION, message: error?.message });
  }
  try {
    const { backend } = hostComposition(host);
    const { project_id: projectId } = host.workspaceProject(`cli_sessions_${verb}`);
    const store = backend.sessionStore;
    if (verb === 'list') {
      const listed = collectSessions(store, projectId, { all: flags.all === true, limit: flags.limit ?? DEFAULT_SESSION_LIMIT });
      return emit(io, listed, listed.sessions.length
        ? listed.sessions.map((s) => `${s.id}  ${s.updated_at}  ${String(s.message_count).padStart(4)} msgs  ${s.current_workspace ? '' : '(other workspace) '}${s.title}`)
        : [flags.all ? 'No sessions in this profile.' : 'No sessions in this workspace (use --all for every workspace).']);
    }
    const session = store.getSession(sessionId);
    if (!session) return fail(io, { message: `Session ${sessionId} does not exist in this profile.` });
    if (verb === 'show') {
      const read = collectSession(store, sessionId, projectId, { limit: flags.limit ?? DEFAULT_MESSAGE_LIMIT });
      const { session: summary, messages } = read;
      return emit(io, read, [
        `${summary.id}  ${summary.title}${summary.current_workspace ? '' : '  (other workspace)'}`,
        `created ${summary.created_at}, updated ${summary.updated_at}, ${read.message_total} messages${read.truncated ? ` (last ${messages.length})` : ''}`,
        '',
        ...messages.flatMap((message) => [`[${message.role}] ${message.content}${message.truncated ? ' …' : ''}`, '']),
      ]);
    }
    if (String(session.project_id || '') !== projectId) {
      return fail(io, { message: `Session ${sessionId} belongs to another workspace; run from that workspace to remove it.` });
    }
    const result = await backend.deleteSession(sessionId, { onlyIfIdle: true, expectedUpdatedAt: session.updated_at });
    if (!result?.deleted) {
      return fail(io, { code: CLI_ERROR_CODES.HOST_STATE, message: `Session ${sessionId} was not removed (${result?.reason || 'refused'}).`, exitCode: EXIT_CODES.RUNTIME_ERROR });
    }
    return emit(io, { v: 1, kind: 'session_removed', id: sessionId, deleted: true }, [`Removed session ${sessionId}.`]);
  } catch (error) {
    return fail(io, { code: typeof error?.code === 'string' ? error.code : CLI_ERROR_CODES.HOST_STATE, message: error?.message || 'The command failed.', exitCode: EXIT_CODES.RUNTIME_ERROR });
  } finally {
    await withTimeout(host.close(), CLOSE_TIMEOUT_MS);
    held.release();
  }
}

module.exports = { collectSession, collectSessions, runSessions };
