'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TODO_DIRECTORY = 'todo-lists';
const TODO_DIGEST_LENGTH = 32;

// Mirrors sidecar/ai/tools/builtins/todo.py (_session_key, _todo_path): the key
// is the stripped session id, and the file is the first 32 hex characters of
// its SHA-256. Change both sides together. Returns '' for an id the sidecar
// would file under its shared default key, which no chat owns.
function todoListFileName(sessionId) {
  if (typeof sessionId !== 'string') return '';
  const key = sessionId.trim();
  if (!key || key.includes('\0')) return '';
  return `${crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, TODO_DIGEST_LENGTH)}.json`;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Removes the chat's persisted todo list. An absent directory or file is
// success; a symlink, junction or non-file in either place is refused rather
// than followed.
function purgeSessionTodoList(userDataPath, sessionId) {
  const fileName = todoListFileName(sessionId);
  if (!fileName || typeof userDataPath !== 'string' || !userDataPath) return;
  const directory = path.join(userDataPath, TODO_DIRECTORY);
  const directoryStats = lstatOrNull(directory);
  if (!directoryStats) return;
  if (!directoryStats.isDirectory()) throw new Error('todo directory is not a plain directory');
  const target = path.join(directory, fileName);
  const stats = lstatOrNull(target);
  if (!stats) return;
  if (!stats.isFile()) throw new Error('todo list is not a regular file');
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

module.exports = { purgeSessionTodoList, todoListFileName };
