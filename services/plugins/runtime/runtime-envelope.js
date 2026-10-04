'use strict';

// The sidecar runtime participant's input for a compiled generation: the
// `plugin_runtime` initialize envelope plus the snapshot it was built from.
function runtimeEnvelope(compiled) {
  return {
    envelope: {
      mode: 'plugin_runtime',
      plugin_runtime: {
        snapshot: compiled.snapshot,
        declarative_content: compiled.declarative_content,
      },
    },
    snapshot: compiled.snapshot,
  };
}

module.exports = { runtimeEnvelope };
