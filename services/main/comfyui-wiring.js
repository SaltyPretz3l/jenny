'use strict';

// Row 127: the ComfyUI process owner as backendService.comfyui, built on first
// use so boot pays nothing for a backend most installs never pick.
const METHODS = Object.freeze(['start', 'stop', 'missingNodes', 'loaderValues']);

function lazyComfyOwner(options, create = (opts) => require('../comfyui-process').createComfyProcessOwner(opts)) {
  let owner = null;
  return Object.freeze(Object.fromEntries(METHODS.map((name) => [name, (...args) => {
    owner ??= create(options);
    return owner[name](...args);
  }])));
}

module.exports = { lazyComfyOwner };
