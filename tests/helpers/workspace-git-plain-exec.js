'use strict';

// Row 103: WorkspaceGitService runs every read through workspace-git-neutralize,
// which first lists the configured keys and then prefixes `-c` overrides (and a
// few read flags) to the argv. Unit-test fakes written against the service's own
// argv wrap themselves with `plainGitReads`: the discovery is answered with an
// empty listing and never forwarded, and the fake sees each argv as the service
// built it. tests/workspace-git-neutralize.test.js pins the real prefix and flags.

const {
  DISCOVERY_ARGS,
  READ_FLAGS_BY_VERB,
  neutralizingConfigArguments,
} = require('../../services/workspace-git-neutralize');

const PREFIX = neutralizingConfigArguments([]);

function startsWith(args, prefix) {
  return prefix.every((value, index) => args[index] === value);
}

function stripReadFlags(args) {
  const flags = READ_FLAGS_BY_VERB.get(args[0]) || [];
  let index = 1;
  while (index < args.length && flags.includes(args[index])) index += 1;
  return [args[0], ...args.slice(index)];
}

function plainGitReads(exec) {
  return async (cwd, args, options) => {
    if (args.length === DISCOVERY_ARGS.length && startsWith(args, DISCOVERY_ARGS)) {
      return { success: true, stdout: '', stderr: '' };
    }
    const plain = startsWith(args, PREFIX) ? stripReadFlags(args.slice(PREFIX.length)) : args;
    return exec(cwd, plain, options);
  };
}

module.exports = { plainGitReads };
