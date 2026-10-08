"""Read-only knowledge tools over user-registered folders.

Three tools behind ``tools_knowledge_enabled``: ``knowledge_search`` (grep-worker
reuse, plus optional search by meaning over the read-only semantic catalog,
row 41), ``knowledge_view`` (rich-file adapter reuse), ``knowledge_exec``
(bounded ls/tree/find). Without a catalog everything is live filesystem reads.
"""

from sidecar.ai.tools.builtins.knowledge.exec_ops import knowledge_exec_tool
from sidecar.ai.tools.builtins.knowledge.roots import configure_knowledge_tools
from sidecar.ai.tools.builtins.knowledge.search import knowledge_search_tool
from sidecar.ai.tools.builtins.knowledge.view import knowledge_view_tool

__all__ = [
    "configure_knowledge_tools",
    "knowledge_exec_tool",
    "knowledge_search_tool",
    "knowledge_view_tool",
]
