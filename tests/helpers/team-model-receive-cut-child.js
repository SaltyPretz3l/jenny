'use strict';

// A child process for the receiver's placement cut tests (row 123 slice 6-4).
// It runs one whole transfer into the root it is given and, once placement has
// started, counts every file-system move the placement makes (rename, link,
// unlink, the folder rename). At move `op` it ends the process at once
// (`process.exit`: no finally block, no cleanup), before or after the move: a
// real cut. With no cut it prints how many moves the placement made.

const fs = require('node:fs');

const { renameNoReplace } = require('../../server/team/file-checks');
const { createModelReceiver } = require('../../services/team/model-receive');
const fx = require('./team-model-receive-fixture');

const args = JSON.parse(process.argv[2]);
const { offer, bytes } = fx.buildOffer(fx.FILE_SETS[args.set]);
let armed = false;
let count = 0;

function counted(work) {
  if (!armed) return work();
  count += 1;
  if (count === args.op && args.when === 'before') process.exit(0);
  const result = work();
  if (count === args.op && args.when === 'after') process.exit(0);
  return result;
}

const fsImpl = {
  ...fs,
  renameSync: (...rest) => counted(() => fs.renameSync(...rest)),
  linkSync: (...rest) => counted(() => fs.linkSync(...rest)),
  unlinkSync: (...rest) => counted(() => fs.unlinkSync(...rest)),
};

const receiver = createModelReceiver({
  roots: () => [args.root],
  transport: fx.fakeTransport(bytes),
  hasher: fx.fakeHasher(),
  fs: fsImpl,
  limits: fx.LIMITS,
  validateManifest: fx.testValidator(),
  renameFolder: async (from, to) => {
    if (!armed) return renameNoReplace(from, to);
    count += 1;
    if (count === args.op && args.when === 'before') process.exit(0);
    await renameNoReplace(from, to);
    if (count === args.op && args.when === 'after') process.exit(0);
    return undefined;
  },
  stepHook: async (name) => {
    if (name === 'placing') armed = true;
  },
});

receiver.start({ offer, root: args.root }).then((result) => {
  process.stdout.write(JSON.stringify({ state: result.state, reason: result.reason, ops: count }));
  process.exit(0);
});
