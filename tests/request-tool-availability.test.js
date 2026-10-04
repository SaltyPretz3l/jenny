'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scopedToolAvailability } = require('../services/backend/request-tool-availability');

const state = { readOnly: true, mode: 'plan', authority: { root_path: 'C:/ws', project_id: 'p1' } };
const descriptors = {
  write_file: { name: 'write_file', side_effecting: true },
  home: { name: 'home', side_effecting: true,
    actions: { calendar_list: { side_effecting: false }, event_upsert: { side_effecting: true } } },
  purge: { name: 'purge', side_effecting: true, actions: { wipe: { side_effecting: true } } },
};

test('read-only diagnostics keep mixed tools with a read action and block pure writers (HB-002)', () => {
  const status = { write_file: { available: true }, home: { available: true }, purge: { available: true } };
  const { tools_status: tools } = scopedToolAvailability(status, state, (name) => descriptors[name]);
  assert.equal(tools.home.available, true);
  assert.equal(tools.home.reason, null);
  assert.equal(tools.write_file.available, false);
  assert.equal(tools.write_file.reason, 'read-only mode blocks side-effecting tools');
  assert.equal(tools.purge.available, false);
});
