'use strict';

// Removing project channels from the team chat store (owner decision E67, 2026-11-14; review X3c-F01). Methods
// installed on TeamChatStore.prototype. Deleting a team project removes its channel: the channel document, every
// segment, its read state, its attachments and its index row, so the 1,024 channel cap counts live channels only.
// Row 173: deleting an archived custom channel removes it the same way (a live one is refused
// `team_chat_channel_live`), after its audit entry. The team channel and direct conversations are never removed here.
//
// Order: index.json without the channel (the commit point), then the channel folder and the attachment folder.
// Removing files never fails the store: a file that will not go is logged and left, and the folder stays with it.
// A removal cut after its commit leaves a folder no index row names; the next removal of that channel (the project
// delete that the host start's reconcile finishes) or the start pass (`removeDeadProjectChannels`) removes it, and
// the blob open walk already empties an attachment folder no channel names. Every file passes the store's path
// guard before it is removed, and a folder that is a link or a junction, or is reached through one, is never
// entered: nothing a link points at is removed. Logs carry ids and counts; the start pass logs counts only. A custom
// channel folder no index row names (a torn create or a cut removal) is a leftover the start pass removes too.

const fs = require('node:fs');
const path = require('node:path');

const schema = require('./team-chat-schema');
const { logChannel, refuse } = require('./team-chat-files');
const { audited } = require('./team-chat-manage');
const { hostFailure } = require('../../server/api-contract');

const { LIMITS, SCHEMA_VERSION } = schema;
const INDEX_FILE = 'index.json';
const PROJECT_PREFIX = 'chan_';
// Entries of the chat folder and of the attachment folder the start pass looks at for leftovers.
const LEFTOVER_SCAN_MAX = 2 * LIMITS.CHANNELS_MAX;

const isProjectChannel = (channelId) => schema.channelKind(channelId) === 'project';
// The kinds a removal takes: a project's channel and a custom channel.
const isRemovable = (channelId) => ['project', 'channel'].includes(schema.channelKind(channelId));

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

const removeMethods = {
  // Removes one project channel, or one archived custom channel (`audit(name)` runs before anything is written; a
  // custom channel's answer also carries `channel_rev`, its revision plus one for the removal). A channel the index
  // does not list (never made, or a removal cut after its commit) answers ok with `removed: false`, after any folder
  // it left is removed.
  removeChannel(input = {}) {
    return this._mutate(() => {
      const channelId = input.channelId;
      if (!isRemovable(channelId)) refuse('forbidden', 'team_chat_not_found');
      const state = this._channels.get(channelId);
      const custom = schema.channelKind(channelId) === 'channel' && state !== undefined;
      if (custom) {
        if (state.doc.archived === null) refuse('forbidden', 'team_chat_channel_live');
        audited(input.audit, state.doc.name);
      }
      const channelRev = custom ? state.doc.rev + 1 : null;
      const removed = this._removeIndexed([channelId]);
      const left = this._removeFolders(channelId);
      if (removed > 0) this._log('INFO', 'team_chat.channel_removed', { channel_id: logChannel(channelId), left });
      return { ok: true, removed: removed > 0, ...(custom ? { channel_rev: channelRev } : {}) };
    });
  },

  // The host start's pass: every listed project channel whose project `isLive(projectId)` does not hold is removed
  // in one index write (a lookup that throws keeps the channel), then the project and custom channel folders no index
  // row names. Bounded by the channel cap and LEFTOVER_SCAN_MAX entries. Answers { ok, removed, leftovers }.
  removeDeadProjectChannels(input = {}) {
    const isLive = input.isLive;
    if (typeof isLive !== 'function') return Promise.resolve(hostFailure('invalid', 'team_chat_request_invalid'));
    return this._mutate(() => {
      const live = (channelId) => {
        try { return isLive(channelId.slice(PROJECT_PREFIX.length)) !== false; } catch { return true; }
      };
      const unlisted = this._unlistedFolders();
      const dead = this._index.channels.filter((entry) => isProjectChannel(entry.channel_id) && !live(entry.channel_id))
        .map((entry) => entry.channel_id);
      const removed = this._removeIndexed(dead);
      for (const channelId of dead) this._removeFolders(channelId, null);
      let leftovers = 0;
      for (const channelId of unlisted) if (this._removeFolders(channelId, null) === 0) leftovers += 1;
      if (removed + leftovers > 0) this._log('INFO', 'team_chat.dead_channels_removed', { removed, leftovers });
      return { ok: true, removed, leftovers };
    });
  },

  // Writes index.json without the listed ones among `channelIds`, then forgets them in memory. Answers how many.
  _removeIndexed(channelIds) {
    const gone = new Set(channelIds.filter((channelId) => this._channels.has(channelId)));
    if (gone.size === 0) return 0;
    const index = { schema_version: SCHEMA_VERSION,
      channels: this._index.channels.filter((entry) => !gone.has(entry.channel_id)) };
    this._files.write(path.join(this.dir, INDEX_FILE), index, LIMITS.INDEX_MAX_BYTES);
    this._index = index;
    for (const channelId of gone) {
      this._channels.delete(channelId);
      this._loadFailures.delete(channelId);
      this._blobs.dropChannel(channelId);
    }
    return gone.size;
  },

  // Removes a channel's folder and its attachment folder. Never throws; answers the number of entries left. A
  // warning names `logId` (null in the start pass, which logs counts only).
  _removeFolders(channelId, logId = channelId) {
    return this._removeFolder(path.join(this.dir, channelId), logId)
      + this._removeFolder(path.join(this.dir, 'blobs', channelId), logId);
  },

  // The files of one folder through the guard, then the folder. A link, a junction or a folder reached through
  // one is left whole (counted as one entry left); so is anything that is not a plain file.
  _removeFolder(directory, logId) {
    let names;
    try {
      const stat = lstatOrNull(directory);
      if (stat === null) return 0;
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw Object.assign(new Error('unsafe'), { reason: 'unsafe_path' });
      }
      names = this._files.list(directory); // the guard refuses a folder reached through a link (unsafe_path)
    } catch (error) {
      const code = error?.reason === 'unsafe_path' ? 'unsafe_path' : 'list_failed';
      this._log('WARN', 'team_chat.channel_folder_kept', { channel_id: logChannel(logId), code });
      return 1;
    }
    let left = 0;
    for (const name of names) if (!this._files.remove(path.join(directory, name), logId)) left += 1;
    if (left > 0) return left;
    try {
      this._files.list(directory); // the guard once more, right before the folder goes
      fs.rmdirSync(directory);
      return 0;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      this._log('WARN', 'team_chat.channel_folder_kept', { channel_id: logChannel(logId), code: 'rmdir_failed' });
      return 1;
    }
  },

  // Project and custom channel folders, in the chat folder or the attachment folder, that the index does not list.
  _unlistedFolders() {
    const found = new Set();
    for (const directory of [this.dir, path.join(this.dir, 'blobs')]) {
      let names = [];
      try { if (lstatOrNull(directory)?.isDirectory()) names = this._files.list(directory); } catch { names = []; }
      for (const name of names.slice(0, LEFTOVER_SCAN_MAX)) {
        if (isRemovable(name) && !this._channels.has(name)) found.add(name);
      }
    }
    return [...found];
  },
};

module.exports = { removeMethods };
