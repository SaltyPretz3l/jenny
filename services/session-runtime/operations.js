'use strict';

const { InferenceOperations } = require('./inference-operations');
const { ToolResourceOperations } = require('./resource-operations');

// Request-owned admission projects both producers through the same terminal
// barrier. Neither a returned chat response nor a stopped reader releases tools.
class RuntimeOperations {
  constructor({ inference, tools, children = null }) {
    this.children = children;
    this.inference = new InferenceOperations(inference);
    this.tools = new ToolResourceOperations(tools);
  }

  handle(params) {
    return params?.kind === 'tool'
      ? this.tools.handle(params) : this.inference.handle(params);
  }

  reserveInitial() { return this.inference.reserveInitial(); }

  enableContinuation() { return this.tools.enableContinuation(); }

  snapshot() {
    const inference = this.inference.snapshot();
    const tools = this.tools.snapshot();
    return Object.freeze({
      closed: inference.closed && tools.closed,
      active: inference.active + tools.active,
      reserved: (inference.reserved || 0) + (tools.reserved || 0),
      quarantined: inference.quarantined + tools.quarantined,
      inference,
      tools,
    });
  }

  close(options) {
    this.children?.close();
    this.inference.close(options);
    this.tools.close(options);
    return this.snapshot();
  }
}

module.exports = { RuntimeOperations };
