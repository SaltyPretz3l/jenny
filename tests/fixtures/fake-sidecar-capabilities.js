function buildAvailableTools(config = {}) {
  const tools = ['read_file', 'write_file', 'list_dir', 'run_command'];
  if (config.tools_web_enabled === true) {
    tools.push('web_search', 'fetch_url');
  }
  if (config.tools_mermaid_enabled === true) {
    tools.push('mermaid_generate');
  }
  if (config.tools_python_runtime_enabled === true) {
    tools.push('python_execute');
  }
  return tools;
}

function buildToolsStatus(config = {}, availableTools = buildAvailableTools(config)) {
  const available = new Set(Array.isArray(availableTools) ? availableTools : []);
  const allTools = [
    'read_file',
    'write_file',
    'list_dir',
    'run_command',
    'web_search',
    'fetch_url',
    'mermaid_generate',
    'python_execute',
  ];
  return Object.fromEntries(allTools.map((toolName) => {
    let reason = null;
    if (!available.has(toolName)) {
      if ((toolName === 'web_search' || toolName === 'fetch_url') && config.tools_web_enabled !== true) {
        reason = 'config disabled';
      } else if (toolName === 'mermaid_generate' && config.tools_mermaid_enabled !== true) {
        reason = 'config disabled';
      } else if (toolName === 'python_execute' && config.tools_python_runtime_enabled !== true) {
        reason = 'config disabled';
      } else {
        reason = 'runtime/backend unavailable';
      }
    }
    return [toolName, {
      available: available.has(toolName),
      reason,
      display_name: toolName,
    }];
  }));
}

function buildProviderCapabilities() {
  return {
    ollama: { engine: 'ollama', available: true, requires_secret: false, secret_configured: false, reason: null, reasoning_effort_support: 'unsupported' },
    vllm: { engine: 'vllm', available: true, requires_secret: false, secret_configured: false, reason: null, reasoning_effort_support: 'supported' },
    'openai-compatible': { engine: 'openai-compatible', available: true, requires_secret: false, secret_configured: false, reason: null, reasoning_effort_support: 'supported' },
    mock: { engine: 'mock', available: true, requires_secret: false, secret_configured: false, reason: null, reasoning_effort_support: 'unsupported' },
  };
}

function buildActiveModelCapabilities(activeModel) {
  if (!String(activeModel || '').trim()) {
    return {};
  }
  // qwen3.5 and qwen3.8 are the thinking-capable Ollama families the fake
  // engine models (qwen3.8 is the one that accepts a graded effort level).
  if (/^qwen3\.[58](?::|$)/i.test(activeModel)) {
    return { text: true, thinking: true };
  }
  return { text: true };
}

function buildActiveModelReasoningSupport(activeEngine, activeModel) {
  if (!String(activeModel || '').trim()) {
    return 'unsupported';
  }
  if (buildActiveModelCapabilities(activeModel).thinking === true) {
    return 'supported';
  }
  const capability = buildProviderCapabilities()[String(activeEngine || '').trim().toLowerCase()];
  return String(capability?.reasoning_effort_support || 'unsupported');
}

module.exports = {
  buildActiveModelCapabilities,
  buildActiveModelReasoningSupport,
  buildAvailableTools,
  buildProviderCapabilities,
  buildToolsStatus,
};
