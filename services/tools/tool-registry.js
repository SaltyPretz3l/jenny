'use strict';

const REQUIRED_FIELDS = ['name', 'description', 'parameters', 'execute', 'summarize'];

class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._aliases = new Map();
  }

  registerTool(definition) {
    for (const field of REQUIRED_FIELDS) {
      if (!definition[field]) {
        throw new Error(`Tool definition missing required field: ${field}`);
      }
    }

    if (typeof definition.execute !== 'function') {
      throw new Error(`Tool "${definition.name}" execute must be a function`);
    }
    if (typeof definition.summarize !== 'function') {
      throw new Error(`Tool "${definition.name}" summarize must be a function`);
    }

    if (this._tools.has(definition.name) || this._aliases.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }

    const aliases = Array.isArray(definition.aliases)
      ? definition.aliases
        .map((value) => String(value || '').trim())
        .filter((value) => value && value !== definition.name)
      : [];

    for (const alias of aliases) {
      if (this._tools.has(alias) || this._aliases.has(alias)) {
        throw new Error(`Tool alias "${alias}" is already registered`);
      }
    }

    const normalized = {
      name: definition.name,
      description: definition.description,
      category: definition.category || 'builtin',
      readOnly: definition.readOnly === true,
      sideEffecting: definition.sideEffecting === true,
      workflowEligible: definition.workflowEligible === true,
      toolFamily: typeof definition.toolFamily === 'string' ? definition.toolFamily : '',
      sourceKind: typeof definition.sourceKind === 'string' ? definition.sourceKind : '',
      serverName: typeof definition.serverName === 'string' ? definition.serverName : '',
      workspaceRequired: definition.workspaceRequired !== false,
      planModeOnly: definition.planModeOnly === true,
      actions: definition.actions && typeof definition.actions === 'object'
        ? definition.actions
        : undefined,
      parameters: definition.parameters,
      summarize: definition.summarize,
      execute: definition.execute,
    };

    this._tools.set(definition.name, normalized);
    for (const alias of aliases) {
      this._aliases.set(alias, definition.name);
    }
  }

  getTool(name) {
    if (this._tools.has(name)) {
      return this._tools.get(name);
    }
    const canonicalName = this._aliases.get(name);
    return canonicalName ? this._tools.get(canonicalName) : undefined;
  }

  getAllTools() {
    return Array.from(this._tools.values());
  }

  getToolSchemas({ planMode = false } = {}) {
    const tools = this.getAllTools();
    const filtered = tools.filter((tool) => (
      planMode
        ? tool.readOnly
        : !tool.planModeOnly
    ));
    return filtered.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

module.exports = { ToolRegistry };
