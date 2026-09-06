"""LSP code-intelligence tool family.

The current slice exposes default-off read-only diagnostics, document-symbol,
definition, and reference tools backed by local language-server processes.
Rename and formatting remain out of scope.

The runtime behavior is gated by ``RuntimeConfig.tools_lsp_enabled``; the
manifest descriptors live under the ``code_intelligence`` tool family that
the foundation pass registered in ``sidecar/ai/tools/tool_families.py``.
"""

from sidecar.ai.tools.builtins.lsp.manager import (
    LSPDocumentSyncResult,
    LSPLanguage,
    LSPManager,
    LSPServerCommand,
    LSPSessionStatus,
    LSPUnavailableResult,
    detect_language_servers,
    resolve_language_for_path,
)
from sidecar.ai.tools.builtins.lsp.normalizers import (
    normalize_definitions,
    normalize_diagnostics,
    normalize_references,
    normalize_symbols,
)
from sidecar.ai.tools.builtins.lsp.protocol import (
    LSPProcessSession,
    LSPProcessSessionLimits,
    LSPProtocolError,
    LSPRequestTimeout,
    LSPServerTerminated,
)
from sidecar.ai.tools.builtins.lsp.tools import (
    configure_lsp_tools,
    lsp_definition_tool,
    lsp_diagnostics_tool,
    lsp_references_tool,
    lsp_symbols_tool,
)

__all__ = [
    "LSPLanguage",
    "LSPDocumentSyncResult",
    "LSPManager",
    "LSPProcessSession",
    "LSPProcessSessionLimits",
    "LSPProtocolError",
    "LSPRequestTimeout",
    "LSPServerCommand",
    "LSPServerTerminated",
    "LSPSessionStatus",
    "LSPUnavailableResult",
    "detect_language_servers",
    "configure_lsp_tools",
    "lsp_definition_tool",
    "lsp_diagnostics_tool",
    "lsp_references_tool",
    "lsp_symbols_tool",
    "normalize_definitions",
    "normalize_diagnostics",
    "normalize_references",
    "normalize_symbols",
    "resolve_language_for_path",
]
